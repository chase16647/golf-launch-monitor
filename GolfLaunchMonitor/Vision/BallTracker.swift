//
//  BallTracker.swift
//  GolfLaunchMonitor
//
//  Finds the ball and measures where it goes. Two distinct jobs with very
//  different constraints:
//
//   A. ARMED — is a stationary ball sitting in the tee box? Runs at ~30 Hz on
//      a small ROI, allowed to be relatively expensive (Vision contours).
//      Also measures the ball's radius, which feeds LiDARCalibrator's
//      cross-check.
//
//   B. POST-IMPACT — where is the ball in each of the 12 captured frames?
//      Runs once per shot, off the capture queue, over a small predicted
//      search window per frame. Must produce SUB-PIXEL centroids, because
//      the whole side-spin measurement lives or dies on ~1 px of precision
//      (see SpinAnalyzer's error budget).
//
//  The centroid estimator is intensity-weighted over a thresholded blob, which
//  is unbiased for a symmetric object and degrades gracefully as the ball
//  smears. Motion blur is the dominant error: at 1/2000 s a 150 mph ball
//  smears 33 mm — 0.79 ball diameters — into a streak. We handle that by
//  fitting the streak's principal axis and taking the centroid along it, which
//  is the correct estimate of the ball's position at the exposure midpoint.
//

import Foundation
import Vision
import CoreVideo
import CoreImage
import Accelerate
import simd
import os

// MARK: - Types

/// A ball observation in one frame.
struct BallObservation: Sendable, Equatable {
    /// Sub-pixel centroid in image coordinates (origin top-left, pixels).
    var centre: SIMD2<Double>
    /// Apparent radius in pixels. For a blurred ball this is the minor axis of
    /// the fitted ellipse — the axis motion blur does NOT stretch.
    var radiusPixels: Double
    /// Principal-axis length of the blob, pixels. Ratio to radius tells us how
    /// smeared this frame is.
    var majorAxisPixels: Double
    /// Mean luma of the blob, 0…255. Used to reject shadows and highlights.
    var intensity: Double
    /// 0…1 quality of this observation.
    var confidence: Double
    var frameSequence: Int
    var timestamp: Double

    /// How blurred, as a multiple of ball diameter.
    var smearRatio: Double { majorAxisPixels / max(radiusPixels * 2, 1) }
}

/// The full post-impact track, resolved into world units.
struct BallTrack: Sendable {
    var observations: [BallObservation]
    /// Positions in metres, world frame: x downrange, y up, z right.
    var worldPositions: [SIMD3<Double>]
    var times: [Double]

    var isUsable: Bool { observations.count >= 3 }
}

enum TrackingError: LocalizedError {
    case noBallFound
    case tooFewFrames(Int)
    case notCalibrated

    var errorDescription: String? {
        switch self {
        case .noBallFound: "Lost the ball. Check lighting and that the tee box is framed."
        case .tooFewFrames(let n): "Only tracked the ball across \(n) frames — need at least 3."
        case .notCalibrated: "Not calibrated. Run setup first."
        }
    }
}

// MARK: - Tracker

actor BallTracker {

    private let log = Logger(subsystem: "GolfLaunchMonitor", category: "Tracker")
    private let ciContext = CIContext(options: [.useSoftwareRenderer: false,
                                                .cacheIntermediates: false])

    /// Last confirmed stationary ball, in image pixels. Seeds the post-impact
    /// search and defines "the ball region" for the impact trigger.
    private(set) var restingBall: BallObservation?

    // MARK: A — Armed detection

    /// Look for a stationary, correctly-sized ball inside the tee-box ROI.
    ///
    /// - Parameter roi: normalized rect (Vision convention: origin bottom-left).
    /// - Parameter expectedRadiusPixels: from calibration. We reject anything
    ///   more than 35 % off, which is what stops the tracker locking onto a
    ///   daisy, a ball marker, or the user's shoe.
    func detectRestingBall(in pixelBuffer: CVPixelBuffer,
                           roi: CGRect,
                           expectedRadiusPixels: Double,
                           frameSequence: Int,
                           timestamp: Double) async -> BallObservation? {

        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)

        // Vision's contour detector is the cheapest reliable circle finder that
        // doesn't need a model. We run it on the ROI only.
        let request = VNDetectContoursRequest()
        request.contrastAdjustment = 1.6
        request.detectsDarkOnLight = false   // white ball on darker turf
        request.maximumImageDimension = 512  // plenty for a ~40 px ball in an ROI
        request.regionOfInterest = roi

        let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, options: [:])
        do {
            try handler.perform([request])
        } catch {
            log.error("Contour request failed: \(error.localizedDescription)")
            return nil
        }

        guard let observation = request.results?.first else { return nil }

        var best: (obs: BallObservation, score: Double)?

        for i in 0..<observation.contourCount {
            guard let contour = try? observation.contour(at: i) else { continue }
            let pts = contour.normalizedPoints
            guard pts.count >= 8 else { continue }

            // Circularity: 4πA / P². 1.0 is a perfect circle. A golf ball
            // silhouette reliably lands above 0.80; grass and shadows don't.
            let metrics = contourMetrics(pts, imageWidth: width, imageHeight: height)
            guard metrics.circularity > 0.78 else { continue }

            let radius = sqrt(metrics.area / .pi)
            let sizeError = abs(radius - expectedRadiusPixels) / max(expectedRadiusPixels, 1)
            guard sizeError < 0.35 else { continue }

            // Vision's normalized points are bottom-left origin; flip to the
            // image convention the rest of the pipeline uses.
            let centre = SIMD2(metrics.centroid.x, Double(height) - metrics.centroid.y)

            let intensity = meanLuma(pixelBuffer,
                                     centre: centre,
                                     radius: radius * 0.6)
            // A golf ball in daylight is bright. Rejecting dark blobs kills
            // most shadow false-positives for free.
            guard intensity > 90 else { continue }

            let score = metrics.circularity * (1 - sizeError) * (intensity / 255)
            let obs = BallObservation(centre: centre,
                                      radiusPixels: radius,
                                      majorAxisPixels: radius * 2,
                                      intensity: intensity,
                                      confidence: min(1, score * 1.2),
                                      frameSequence: frameSequence,
                                      timestamp: timestamp)
            if best == nil || score > best!.score { best = (obs, score) }
        }

        if let b = best { restingBall = b.obs }
        return best?.obs
    }

    func clearRestingBall() { restingBall = nil }

    // MARK: B — Post-impact tracking

    /// Track the ball through the captured slice.
    ///
    /// Strategy: start from the known resting position, then for each
    /// subsequent frame predict forward using the velocity estimated so far
    /// and search a window around the prediction. The window grows when we
    /// miss and shrinks when we hit, which keeps the search cheap while
    /// tolerating the ball accelerating out of frame.
    func track(frames: [FrameSlot],
               impactIndex: Int,
               calibration: Calibration,
               levelling: LevellingTransform) async throws -> BallTrack {

        guard let resting = restingBall else { throw TrackingError.noBallFound }

        var observations: [BallObservation] = []
        var velocity = SIMD2<Double>(0, 0)
        var last = resting.centre
        var searchRadius = max(resting.radiusPixels * 6, 40)
        var lastTime = CMTimeGetSeconds(frames[max(impactIndex - 1, 0)].presentationTime)

        // Only frames strictly after impact carry the launch.
        for slot in frames[impactIndex...] {
            let t = CMTimeGetSeconds(slot.presentationTime)
            let dt = max(t - lastTime, 1e-4)
            let predicted = last + velocity * dt

            guard let obs = findBall(in: slot.pixelBuffer,
                                     near: predicted,
                                     searchRadius: searchRadius,
                                     expectedRadius: resting.radiusPixels,
                                     frameSequence: slot.sequence,
                                     timestamp: t) else {
                // Miss — widen and keep going. The ball usually leaves the
                // frame entirely, at which point we're just done.
                searchRadius *= 1.6
                if searchRadius > 400 { break }
                continue
            }

            if let previous = observations.last {
                let pdt = max(t - previous.timestamp, 1e-4)
                velocity = (obs.centre - previous.centre) / pdt
            }
            observations.append(obs)
            last = obs.centre
            lastTime = t
            // Tighten once we're locked on; the ball is predictable now.
            searchRadius = max(resting.radiusPixels * 4, 30)
        }

        guard observations.count >= 3 else {
            throw TrackingError.tooFewFrames(observations.count)
        }

        // Resolve to world metres.
        let scale = 1.0 / calibration.pixelsPerMetre
        let origin = resting.centre

        var world: [SIMD3<Double>] = []
        var times: [Double] = []
        world.reserveCapacity(observations.count)

        for obs in observations {
            // Image displacement from the tee, in metres, at the tee plane.
            let dxPx = obs.centre.x - origin.x
            // Image Y grows downward; world Y grows up.
            let dyPx = origin.y - obs.centre.y

            let right = dxPx * scale
            let up = dyPx * scale

            // The camera looks perpendicular to the target line, so the image
            // X axis is DOWNRANGE and the image Y axis is UP. Lateral (z)
            // motion is along the optical axis and is NOT directly visible —
            // it shows up as the ball's apparent size changing, which is far
            // too weak to use over 8 frames.
            //
            // So: z comes from the ball's apparent scale change, with a large
            // uncertainty, and the curvature estimator works in the image
            // plane where the signal actually is. `apparentDepthShift` is
            // documented as an approximation, not a measurement.
            let depthShift = apparentDepthShift(observed: obs.radiusPixels,
                                                reference: resting.radiusPixels,
                                                distance: calibration.teeDistanceMetres)

            // Apply the gravity-levelling rotation so "up" is true vertical
            // rather than however the phone happened to be tilted.
            let levelled = levelling.apply(SIMD3(right, up, depthShift))
            world.append(levelled)
            times.append(obs.timestamp)
        }

        log.info("Tracked \(observations.count) frames, mean smear \(observations.map(\.smearRatio).reduce(0,+) / Double(observations.count), format: .fixed(precision: 2))×")

        return BallTrack(observations: observations, worldPositions: world, times: times)
    }

    /// Estimated change in distance-from-camera from the ball's apparent size.
    ///
    /// Honest limitation: at 1.5 m with a ~19 px ball radius, a 1 px radius
    /// error is a ~8 cm depth error. This is a weak signal and is treated as
    /// such everywhere downstream — it is NOT what the side-spin estimate is
    /// built on.
    private func apparentDepthShift(observed: Double,
                                    reference: Double,
                                    distance: Double) -> Double {
        guard observed > 1, reference > 1 else { return 0 }
        // r ∝ 1/d  ⇒  d' = d · r_ref / r_obs
        let d = distance * reference / observed
        return (d - distance).clamped(to: -1.0...1.0)
    }

    // MARK: Detection core

    /// Locate the ball within a search window using a threshold + weighted
    /// centroid, with an ellipse fit to handle motion streaks.
    private func findBall(in pixelBuffer: CVPixelBuffer,
                          near predicted: SIMD2<Double>,
                          searchRadius: Double,
                          expectedRadius: Double,
                          frameSequence: Int,
                          timestamp: Double) -> BallObservation? {

        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }

        // Luma plane of the 420f buffer — full resolution, no conversion.
        guard let base = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0) else { return nil }
        let stride = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0)
        let width = CVPixelBufferGetWidthOfPlane(pixelBuffer, 0)
        let height = CVPixelBufferGetHeightOfPlane(pixelBuffer, 0)
        let luma = base.assumingMemoryBound(to: UInt8.self)

        let x0 = max(0, Int(predicted.x - searchRadius))
        let x1 = min(width - 1, Int(predicted.x + searchRadius))
        let y0 = max(0, Int(predicted.y - searchRadius))
        let y1 = min(height - 1, Int(predicted.y + searchRadius))
        guard x1 > x0 + 4, y1 > y0 + 4 else { return nil }

        // Otsu-style split would be ideal but is overkill here: the ball is the
        // brightest thing in a small window by a wide margin. Take a high
        // percentile of the window as the threshold.
        var histogram = [Int](repeating: 0, count: 256)
        for y in y0...y1 {
            let row = luma + y * stride
            for x in x0...x1 { histogram[Int(row[x])] += 1 }
        }
        let total = (x1 - x0 + 1) * (y1 - y0 + 1)
        // The ball occupies a small fraction of the window, so threshold near
        // the top of the distribution — but never below a hard floor, which
        // stops us "finding" a ball in an empty patch of grass.
        var cumulative = 0
        var threshold = 200
        let targetCount = max(Int(Double(total) * 0.030), 12)
        for v in stride2(from: 255, through: 0, by: -1) {
            cumulative += histogram[v]
            if cumulative >= targetCount { threshold = v; break }
        }
        threshold = max(threshold, 110)

        // First moments over the thresholded pixels, intensity-weighted.
        var m00 = 0.0, m10 = 0.0, m01 = 0.0
        var count = 0
        for y in y0...y1 {
            let row = luma + y * stride
            for x in x0...x1 {
                let v = Double(row[x])
                guard v >= Double(threshold) else { continue }
                // Weight above threshold, so edge pixels contribute
                // proportionally — this is what buys sub-pixel accuracy.
                let w = v - Double(threshold)
                m00 += w
                m10 += w * Double(x)
                m01 += w * Double(y)
                count += 1
            }
        }
        guard m00 > 0, count >= 6 else { return nil }

        let cx = m10 / m00
        let cy = m01 / m00

        // Second moments → ellipse axes. Motion blur stretches one axis; the
        // other stays close to the true ball radius.
        var mu20 = 0.0, mu02 = 0.0, mu11 = 0.0
        var sumLuma = 0.0
        for y in y0...y1 {
            let row = luma + y * stride
            for x in x0...x1 {
                let v = Double(row[x])
                guard v >= Double(threshold) else { continue }
                let w = v - Double(threshold)
                let dx = Double(x) - cx
                let dy = Double(y) - cy
                mu20 += w * dx * dx
                mu02 += w * dy * dy
                mu11 += w * dx * dy
                sumLuma += v
            }
        }
        mu20 /= m00; mu02 /= m00; mu11 /= m00

        // Eigenvalues of the 2×2 covariance.
        let trace = mu20 + mu02
        let det = mu20 * mu02 - mu11 * mu11
        let disc = max(trace * trace / 4 - det, 0)
        let l1 = trace / 2 + sqrt(disc)
        let l2 = trace / 2 - sqrt(disc)

        // For a uniform ellipse, semi-axis = 2·sqrt(eigenvalue).
        let major = 2 * sqrt(max(l1, 0))
        let minor = 2 * sqrt(max(l2, 0))

        // The minor axis is our radius estimate — blur doesn't widen it.
        let radius = max(minor, 1.5)

        // Reject obvious non-balls: wrong size on the unblurred axis.
        let sizeError = abs(radius - expectedRadius) / max(expectedRadius, 1)
        guard sizeError < 0.6 else { return nil }

        let intensity = sumLuma / Double(count)

        // Confidence falls off with size error and extreme smear.
        let smear = major / max(radius, 1)
        let smearPenalty = smear > 6 ? 0.4 : 1.0
        let confidence = ((1 - sizeError) * smearPenalty * min(intensity / 180, 1))
            .clamped(to: 0...1)

        return BallObservation(centre: SIMD2(cx, cy),
                               radiusPixels: radius,
                               majorAxisPixels: major * 2,
                               intensity: intensity,
                               confidence: confidence,
                               frameSequence: frameSequence,
                               timestamp: timestamp)
    }

    // MARK: Helpers

    private struct ContourMetrics {
        var area: Double
        var perimeter: Double
        var centroid: SIMD2<Double>
        var circularity: Double
    }

    private func contourMetrics(_ normalized: [CGPoint],
                                imageWidth: Int,
                                imageHeight: Int) -> ContourMetrics {
        let w = Double(imageWidth), h = Double(imageHeight)
        var pts = normalized.map { SIMD2(Double($0.x) * w, Double($0.y) * h) }
        guard pts.count >= 3 else {
            return ContourMetrics(area: 0, perimeter: 1, centroid: .zero, circularity: 0)
        }
        pts.append(pts[0])

        // Shoelace area and centroid.
        var a = 0.0, cx = 0.0, cy = 0.0, perim = 0.0
        for i in 0..<(pts.count - 1) {
            let p = pts[i], q = pts[i + 1]
            let cross = p.x * q.y - q.x * p.y
            a += cross
            cx += (p.x + q.x) * cross
            cy += (p.y + q.y) * cross
            perim += simd_distance(p, q)
        }
        a *= 0.5
        let area = abs(a)
        guard area > 1e-6, perim > 1e-6 else {
            return ContourMetrics(area: 0, perimeter: 1, centroid: .zero, circularity: 0)
        }
        cx /= (6 * a); cy /= (6 * a)

        return ContourMetrics(area: area,
                              perimeter: perim,
                              centroid: SIMD2(cx, cy),
                              circularity: min(1, 4 * .pi * area / (perim * perim)))
    }

    private func meanLuma(_ pixelBuffer: CVPixelBuffer,
                          centre: SIMD2<Double>,
                          radius: Double) -> Double {
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0) else { return 0 }
        let stride = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0)
        let w = CVPixelBufferGetWidthOfPlane(pixelBuffer, 0)
        let h = CVPixelBufferGetHeightOfPlane(pixelBuffer, 0)
        let luma = base.assumingMemoryBound(to: UInt8.self)

        let r = Int(max(radius, 1))
        let cx = Int(centre.x), cy = Int(centre.y)
        var sum = 0.0, n = 0
        for y in max(0, cy - r)...min(h - 1, cy + r) {
            let row = luma + y * stride
            for x in max(0, cx - r)...min(w - 1, cx + r) {
                sum += Double(row[x]); n += 1
            }
        }
        return n > 0 ? sum / Double(n) : 0
    }
}

/// `stride(from:through:by:)` shadowed by the local `stride` variables above.
private func stride2(from: Int, through: Int, by: Int) -> StrideThrough<Int> {
    Swift.stride(from: from, through: through, by: by)
}

// MARK: - CMTime bridging

import CoreMedia
private func CMTimeGetSeconds(_ t: CMTime) -> Double {
    CoreMedia.CMTimeGetSeconds(t)
}
