//
//  LiDARCalibrator.swift
//  GolfLaunchMonitor
//
//  Turns "pixels" into "millimetres" using the LiDAR scanner, so ball speed is
//  a real measurement instead of a guess scaled by a number the user typed in.
//
//  Two independent scale sources, cross-checked against each other:
//
//   A. LiDAR depth at the tee point + the camera's intrinsic matrix. This is
//      the primary. Given focal length in pixels and distance in metres, the
//      projected size of anything at that distance is exact:
//
//          pixelsPerMetre = focalLengthPixels / distanceMetres
//
//   B. The ball's own apparent diameter. A golf ball is 42.67 mm by rule, so
//      measuring its radius in pixels gives scale for free — no LiDAR needed.
//      Used as a sanity check and as the fallback when depth is unavailable
//      (high-frame-rate formats usually don't carry a depth stream).
//
//  If the two disagree by more than ~8 % something is wrong — usually the
//  LiDAR locked onto the mat instead of the ball, or the "ball" the tracker
//  found is a daisy. We surface that rather than silently averaging them.
//
//  Why this matters: every millimetre of scale error is a proportional error
//  in ball speed, which then compounds through the flight model. A 5 % scale
//  error on a 150 mph drive is 7.5 mph, which is about 14 yards of carry.
//

import Foundation
import ARKit
import AVFoundation
import CoreVideo
import simd
import os

// MARK: - Result

struct Calibration: Sendable, Equatable {
    /// Distance from the lens to the tee plane, metres.
    var teeDistanceMetres: Double
    /// Scale at the tee plane.
    var pixelsPerMetre: Double
    /// Camera focal length in pixels for the active format.
    var focalLengthPixels: Double
    /// How the number was obtained.
    var source: Source
    /// Agreement between the LiDAR and ball-size estimates, 0…1. 1 = perfect.
    var crossCheck: Double
    /// Image-space radius the ball *should* have at this scale, in pixels.
    /// The tracker uses it to reject blobs of the wrong size.
    var expectedBallRadiusPixels: Double
    var timestamp: Date

    enum Source: String, Sendable {
        case lidar             // depth + intrinsics, cross-checked
        case lidarUnverified   // depth only, no ball seen yet
        case ballDiameter      // fallback: scale from the 42.67 mm rule
        case manual            // user typed the distance
    }

    var millimetresPerPixel: Double { 1000.0 / pixelsPerMetre }

    var distanceFeet: Double { teeDistanceMetres * 3.280839895 }

    /// Setup guidance: the rig is designed for 4–7 ft.
    var isDistanceInRecommendedRange: Bool {
        (1.2...2.2).contains(teeDistanceMetres)
    }

    var isTrustworthy: Bool {
        crossCheck > 0.92 && isDistanceInRecommendedRange
    }
}

enum CalibrationError: LocalizedError {
    case lidarUnavailable
    case noDepthAtPoint
    case implausibleDistance(Double)

    var errorDescription: String? {
        switch self {
        case .lidarUnavailable:
            "This device has no LiDAR scanner. Falling back to ball-size scaling."
        case .noDepthAtPoint:
            "Couldn't read depth at the tee. Make sure the tee box is in view and well lit."
        case .implausibleDistance(let d):
            String(format: "Measured %.2f m to the tee — expected 1.2–2.2 m (4–7 ft).", d)
        }
    }
}

// MARK: - Calibrator

/// Actor because calibration is genuinely shared mutable state — the tracker,
/// the analyzer and the UI all read the current scale, and it can be refreshed
/// mid-session.
actor LiDARCalibrator {

    private(set) var current: Calibration?
    private let log = Logger(subsystem: "GolfLaunchMonitor", category: "Calibration")

    /// ARKit session used purely as a depth source. We run it briefly at arm
    /// time and stop it — leaving ARKit running alongside a 240 fps
    /// AVCaptureSession fights for the camera and wastes power.
    private var arSession: ARSession?
    private var arDelegate: DepthProbeDelegate?

    static var isLiDARAvailable: Bool {
        ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
            || ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth)
    }

    // MARK: Primary path — ARKit scene depth

    /// Sample depth at the tee point and derive scale.
    ///
    /// - Parameter normalizedPoint: where the tee is in the frame, 0…1 in
    ///   image coordinates. The UI supplies this from the aiming reticle.
    func calibrate(atNormalizedPoint normalizedPoint: CGPoint) async throws -> Calibration {
        guard Self.isLiDARAvailable else { throw CalibrationError.lidarUnavailable }

        let probe = try await sampleSceneDepth(at: normalizedPoint)

        guard (0.3...6.0).contains(probe.distance) else {
            throw CalibrationError.implausibleDistance(probe.distance)
        }

        let ppm = probe.focalLengthPixels / probe.distance
        let radiusPx = ppm * Ball.radiusMetres

        let cal = Calibration(teeDistanceMetres: probe.distance,
                              pixelsPerMetre: ppm,
                              focalLengthPixels: probe.focalLengthPixels,
                              source: .lidarUnverified,
                              crossCheck: 1.0,
                              expectedBallRadiusPixels: radiusPx,
                              timestamp: Date())
        current = cal
        log.info("""
                 LiDAR calibration: \(probe.distance, format: .fixed(precision: 3)) m, \
                 f=\(probe.focalLengthPixels, format: .fixed(precision: 1)) px, \
                 \(ppm, format: .fixed(precision: 1)) px/m, \
                 ball r≈\(radiusPx, format: .fixed(precision: 1)) px
                 """)
        return cal
    }

    /// Runs a short ARKit session, grabs one good depth frame, shuts it down.
    private func sampleSceneDepth(at point: CGPoint) async throws -> DepthProbe {
        let config = ARWorldTrackingConfiguration()
        guard ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) else {
            throw CalibrationError.lidarUnavailable
        }
        config.frameSemantics = .sceneDepth
        config.planeDetection = []      // we only want depth; skip the plane solver

        let session = ARSession()
        let delegate = DepthProbeDelegate(samplePoint: point)
        session.delegate = delegate
        arSession = session
        arDelegate = delegate
        session.run(config, options: [.resetTracking, .removeExistingAnchors])
        defer {
            session.pause()
            arSession = nil
            arDelegate = nil
        }

        // Average several frames — a single LiDAR return on a small white ball
        // is noisy, and the confidence map lets us throw out the bad ones.
        return try await delegate.awaitStableProbe(timeout: 2.5)
    }

    // MARK: Secondary path — the ball itself is a ruler

    /// Refine (or establish) scale from the ball's measured radius in pixels.
    ///
    /// A golf ball's minimum legal diameter is 42.67 mm and balls are made to
    /// that minimum, so this is reliable to a fraction of a percent *if* the
    /// radius measurement is good. The catch is that a motion-blurred or
    /// partially shadowed ball measures small, so we only accept this from a
    /// stationary, well-segmented ball during the armed phase.
    func refine(withBallRadiusPixels radiusPx: Double) {
        guard radiusPx > 3 else { return }
        let ppmFromBall = radiusPx / Ball.radiusMetres

        guard var cal = current else {
            // No LiDAR — this is now our only scale.
            let focal = 1400.0   // unused in this path; recorded for the record
            current = Calibration(teeDistanceMetres: focal / ppmFromBall,
                                  pixelsPerMetre: ppmFromBall,
                                  focalLengthPixels: focal,
                                  source: .ballDiameter,
                                  crossCheck: 1.0,
                                  expectedBallRadiusPixels: radiusPx,
                                  timestamp: Date())
            return
        }

        let ratio = ppmFromBall / cal.pixelsPerMetre
        let agreement = 1.0 - min(abs(1 - ratio), 1.0)

        cal.crossCheck = agreement
        cal.expectedBallRadiusPixels = radiusPx

        if agreement > 0.92 {
            // They agree. Blend, weighting LiDAR slightly higher because the
            // ball radius is the noisier of the two at this range.
            cal.pixelsPerMetre = cal.pixelsPerMetre * 0.65 + ppmFromBall * 0.35
            cal.teeDistanceMetres = cal.focalLengthPixels / cal.pixelsPerMetre
            cal.source = .lidar
            log.info("Cross-check OK (\(agreement, format: .fixed(precision: 3)))")
        } else {
            // They don't. Do NOT average — one of them is measuring the wrong
            // thing, and averaging a good number with a bad one just gives a
            // confidently wrong number. Keep LiDAR, flag low confidence.
            log.warning("""
                        Scale disagreement: LiDAR says \(cal.pixelsPerMetre, format: .fixed(precision: 1)) px/m, \
                        ball says \(ppmFromBall, format: .fixed(precision: 1)) px/m \
                        (agreement \(agreement, format: .fixed(precision: 3)))
                        """)
        }
        current = cal
    }

    /// Manual override for devices without LiDAR, or when the user knows better.
    func setManualDistance(feet: Double, focalLengthPixels: Double) {
        let metres = feet / 3.280839895
        let ppm = focalLengthPixels / metres
        current = Calibration(teeDistanceMetres: metres,
                              pixelsPerMetre: ppm,
                              focalLengthPixels: focalLengthPixels,
                              source: .manual,
                              crossCheck: 1.0,
                              expectedBallRadiusPixels: ppm * Ball.radiusMetres,
                              timestamp: Date())
    }

    func invalidate() { current = nil }

    // MARK: Projection helpers

    /// Convert an image-space displacement to metres at the tee plane.
    ///
    /// This is a planar approximation: it assumes the ball stays at the tee
    /// distance. Over the ~30 ms we track it the ball moves under a metre
    /// downrange, so at 1.5 m camera distance the depth changes by a few
    /// percent at most for a shot hit away from the camera. For a shot hit
    /// *toward* or *away from* the camera the error is larger, which is why
    /// the app instructs the user to set up perpendicular to the target line.
    func metres(fromPixels px: Double) -> Double? {
        guard let cal = current else { return nil }
        return px / cal.pixelsPerMetre
    }

    /// Back-project an image point plus a known depth into camera-frame metres.
    func worldPoint(imageX: Double, imageY: Double,
                    principalX: Double, principalY: Double,
                    depth: Double) -> SIMD3<Double>? {
        guard let cal = current else { return nil }
        let f = cal.focalLengthPixels
        return SIMD3((imageX - principalX) * depth / f,
                     (imageY - principalY) * depth / f,
                     depth)
    }
}

// MARK: - Depth probe

private struct DepthProbe: Sendable {
    var distance: Double
    var focalLengthPixels: Double
    var confidence: Double
}

/// Collects depth samples until it has enough high-confidence ones to average.
private final class DepthProbeDelegate: NSObject, ARSessionDelegate, @unchecked Sendable {

    private let samplePoint: CGPoint
    private var samples: [Double] = []
    private var focal: Double = 0
    private var continuation: CheckedContinuation<DepthProbe, Error>?
    private let lock = NSLock()

    /// Radius in depth-map pixels to average over. The depth map is far lower
    /// resolution than the image (256×192 on current hardware), so a golf ball
    /// occupies well under one depth pixel at 1.5 m — we are really measuring
    /// the plane the ball is sitting on, which is what we want anyway.
    private let window = 2

    init(samplePoint: CGPoint) {
        self.samplePoint = samplePoint
    }

    func awaitStableProbe(timeout: TimeInterval) async throws -> DepthProbe {
        try await withThrowingTaskGroup(of: DepthProbe.self) { group in
            group.addTask {
                try await withCheckedThrowingContinuation { cont in
                    self.lock.lock()
                    self.continuation = cont
                    self.lock.unlock()
                }
            }
            group.addTask {
                try await Task.sleep(for: .seconds(timeout))
                throw CalibrationError.noDepthAtPoint
            }
            guard let first = try await group.next() else {
                throw CalibrationError.noDepthAtPoint
            }
            group.cancelAll()
            return first
        }
    }

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        guard let depth = frame.sceneDepth else { return }

        let map = depth.depthMap
        CVPixelBufferLockBaseAddress(map, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(map, .readOnly) }

        let w = CVPixelBufferGetWidth(map)
        let h = CVPixelBufferGetHeight(map)
        guard let base = CVPixelBufferGetBaseAddress(map) else { return }
        let stride = CVPixelBufferGetBytesPerRow(map)
        let ptr = base.assumingMemoryBound(to: Float32.self)

        // Confidence map lets us discard returns the sensor itself distrusts —
        // important on a small, bright, curved target like a golf ball.
        var confPtr: UnsafeMutablePointer<UInt8>?
        var confStride = 0
        if let conf = depth.confidenceMap {
            CVPixelBufferLockBaseAddress(conf, .readOnly)
            confStride = CVPixelBufferGetBytesPerRow(conf)
            confPtr = CVPixelBufferGetBaseAddress(conf)?.assumingMemoryBound(to: UInt8.self)
        }
        defer {
            if let conf = depth.confidenceMap {
                CVPixelBufferUnlockBaseAddress(conf, .readOnly)
            }
        }

        let cx = Int((Double(w) * samplePoint.x).rounded())
        let cy = Int((Double(h) * samplePoint.y).rounded())

        var valid: [Double] = []
        for dy in -window...window {
            for dx in -window...window {
                let x = cx + dx, y = cy + dy
                guard x >= 0, x < w, y >= 0, y < h else { continue }
                let d = Double(ptr[y * (stride / MemoryLayout<Float32>.size) + x])
                guard d.isFinite, d > 0.1, d < 8 else { continue }
                if let cp = confPtr {
                    // ARConfidenceLevel: 0 low, 1 medium, 2 high.
                    let c = cp[y * confStride + x]
                    guard c >= 1 else { continue }
                }
                valid.append(d)
            }
        }
        guard !valid.isEmpty else { return }

        // Median is the right statistic here: the window straddles the ball
        // edge and the mat behind it, and a mean would split the difference.
        valid.sort()
        let median = valid[valid.count / 2]

        lock.lock()
        samples.append(median)
        // Intrinsics are per-frame because they change with the active format.
        focal = Double(frame.camera.intrinsics[0][0])

        // Scale the ARKit intrinsics to the capture format's resolution — the
        // AR frame and the 240 fps video stream are different sizes, and using
        // AR's focal length against video pixels would be a silent scale bug.
        let arWidth = Double(CVPixelBufferGetWidth(frame.capturedImage))
        if arWidth > 0 {
            let videoWidth = 1920.0
            focal *= videoWidth / arWidth
        }

        let enough = samples.count >= 8
        let cont = continuation
        var result: DepthProbe?
        if enough, let _ = cont {
            var s = samples
            s.sort()
            let m = s[s.count / 2]
            // Spread as a confidence proxy.
            let spread = (s.last! - s.first!) / max(m, 1e-6)
            result = DepthProbe(distance: m,
                                focalLengthPixels: focal,
                                confidence: max(0, 1 - spread))
            continuation = nil
        }
        lock.unlock()

        if let r = result { cont?.resume(returning: r) }
    }

    func session(_ session: ARSession, didFailWithError error: Error) {
        lock.lock()
        let cont = continuation
        continuation = nil
        lock.unlock()
        cont?.resume(throwing: error)
    }
}
