//
//  CameraManager.swift
//  GolfLaunchMonitor
//
//  AVCaptureSession owner. Responsible for:
//    * picking the highest-temporal-resolution format the device will give us
//    * pinning exposure short enough to freeze a 150 mph ball
//    * locking focus at the tee plane
//    * pushing every frame into the lock-free ring with zero copies
//
//  Everything that touches AVCaptureSession runs on `sessionQueue`. Everything
//  that touches per-frame data runs on `videoQueue`. The class is an actor at
//  its public surface but the capture delegate deliberately is *not* actor
//  isolated — hopping to an actor executor per frame at 240 FPS would blow the
//  4.16 ms budget. See `FrameCaptureDelegate`.
//

import AVFoundation
import CoreMedia
import CoreVideo
import UIKit
import os

// MARK: - Configuration

enum CaptureMode: String, CaseIterable, Sendable, Codable {
    /// 1080p240 — the default. Temporal resolution wins for launch monitoring:
    /// 4.16 ms between samples means a 150 mph ball moves ~280 mm per frame,
    /// which still gives us 6–8 usable frames before it leaves the field.
    case highSpeed1080p240

    /// 4K120 — half the temporal resolution but 4× the pixels on the ball.
    /// Worth it for spin-marker tracking, where angular resolution on the
    /// ball's surface is the limiting factor. iPhone 15 Pro and later.
    case highDefinition4K120

    var dimensions: CMVideoDimensions {
        switch self {
        case .highSpeed1080p240:   CMVideoDimensions(width: 1920, height: 1080)
        case .highDefinition4K120: CMVideoDimensions(width: 3840, height: 2160)
        }
    }

    var targetFrameRate: Double {
        switch self {
        case .highSpeed1080p240:   240
        case .highDefinition4K120: 120
        }
    }

    var displayName: String {
        switch self {
        case .highSpeed1080p240:   "1080p · 240 fps"
        case .highDefinition4K120: "4K · 120 fps"
        }
    }
}

enum CameraError: LocalizedError {
    case noDevice
    case noFormat(CaptureMode)
    case accessDenied
    case configurationFailed(String)

    var errorDescription: String? {
        switch self {
        case .noDevice: "No rear wide-angle camera available."
        case .noFormat(let m): "This device can't do \(m.displayName)."
        case .accessDenied: "Camera access denied. Enable it in Settings."
        case .configurationFailed(let s): "Capture setup failed: \(s)"
        }
    }
}

/// Snapshot of what the sensor is actually doing, for the HUD.
struct ExposureState: Sendable, Equatable {
    var shutterDenominator: Int   // e.g. 2000 for 1/2000 s
    var iso: Float
    var isLocked: Bool
    var targetOffsetEV: Float     // how far off the meter thinks we are

    /// Motion blur smear of the ball in millimetres at a given speed, which is
    /// the number that actually matters. A 42.67 mm ball smearing more than
    /// about half its own diameter makes sub-pixel centroiding unreliable.
    func smearMillimetres(atBallSpeedMPH mph: Double) -> Double {
        (mph * 0.44704) / Double(shutterDenominator) * 1000.0
    }
}

// MARK: - Manager

@MainActor
final class CameraManager: ObservableObject {

    @Published private(set) var isRunning = false
    @Published private(set) var mode: CaptureMode = .highSpeed1080p240
    @Published private(set) var exposure = ExposureState(shutterDenominator: 2000,
                                                         iso: 100,
                                                         isLocked: false,
                                                         targetOffsetEV: 0)
    @Published private(set) var actualFrameRate: Double = 0
    @Published var lastError: CameraError?

    let session = AVCaptureSession()
    let ring = FrameRingBuffer(capacity: 30)

    /// Set by LiDARCalibrator once it knows the tee distance; the tracker needs
    /// it and the delegate reads it without locking (it's a plain Double).
    private(set) var device: AVCaptureDevice?

    private let sessionQueue = DispatchQueue(label: "lm.session")
    private let videoQueue = DispatchQueue(label: "lm.video",
                                           qos: .userInteractive,
                                           autoreleaseFrequency: .workItem)
    private let videoOutput = AVCaptureVideoDataOutput()
    private let depthOutput = AVCaptureDepthDataOutput()
    private var delegate: FrameCaptureDelegate?

    private let log = Logger(subsystem: "GolfLaunchMonitor", category: "Camera")

    /// Highest ISO we'll let the auto-exposure loop reach before it starts
    /// giving back shutter speed. Above roughly 1600 the A19's pipeline noise
    /// starts eating the ball's edge gradient, which is exactly the signal the
    /// sub-pixel centroid depends on.
    private let maxUsableISO: Float = 1600

    // MARK: Lifecycle

    /// Wires up the session. Safe to call once; subsequent calls just restart.
    func start(mode: CaptureMode = .highSpeed1080p240,
               onFrame: @escaping @Sendable (CVPixelBuffer, CMTime, Int) -> Void,
               onDepth: (@Sendable (AVDepthData, CMTime) -> Void)? = nil) async {
        guard await requestAccess() else {
            lastError = .accessDenied
            return
        }
        self.mode = mode

        let delegate = FrameCaptureDelegate(ring: ring, onFrame: onFrame, onDepth: onDepth)
        self.delegate = delegate

        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            sessionQueue.async { [weak self] in
                guard let self else { cont.resume(); return }
                do {
                    try self.configureSession(mode: mode, delegate: delegate)
                    self.session.startRunning()
                    Task { @MainActor in
                        self.isRunning = true
                        self.startExposureLoop()
                    }
                } catch let e as CameraError {
                    Task { @MainActor in self.lastError = e }
                } catch {
                    Task { @MainActor in
                        self.lastError = .configurationFailed(error.localizedDescription)
                    }
                }
                cont.resume()
            }
        }
    }

    func stop() {
        sessionQueue.async { [session] in
            if session.isRunning { session.stopRunning() }
        }
        isRunning = false
        ring.reset()
    }

    /// Stops delivering frames without tearing down the session, so re-arming
    /// after a shot is instant rather than a ~400 ms session restart.
    func pauseDelivery() { delegate?.isDelivering = false }
    func resumeDelivery() { ring.reset(); delegate?.isDelivering = true }

    private func requestAccess() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return true
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: .video)
        default: return false
        }
    }

    // MARK: Session configuration

    private func configureSession(mode: CaptureMode, delegate: FrameCaptureDelegate) throws {
        session.beginConfiguration()
        defer { session.commitConfiguration() }

        // `.inputPriority` tells AVFoundation to leave activeFormat alone —
        // without it, setting a sessionPreset stomps the high-frame-rate format
        // we are about to pick.
        session.sessionPreset = .inputPriority

        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera,
                                                   for: .video,
                                                   position: .back) else {
            throw CameraError.noDevice
        }
        self.device = device

        session.inputs.forEach { session.removeInput($0) }
        let input = try AVCaptureDeviceInput(device: device)
        guard session.canAddInput(input) else {
            throw CameraError.configurationFailed("input rejected")
        }
        session.addInput(input)

        guard let format = bestFormat(for: device, mode: mode) else {
            throw CameraError.noFormat(mode)
        }

        try device.lockForConfiguration()
        device.activeFormat = format
        let duration = CMTime(value: 1, timescale: CMTimeScale(mode.targetFrameRate))
        device.activeVideoMinFrameDuration = duration
        device.activeVideoMaxFrameDuration = duration

        // Kill every automatic system that would fight us mid-swing.
        if device.isLowLightBoostSupported { device.automaticallyEnablesLowLightBoostWhenAvailable = false }
        if device.isSubjectAreaChangeMonitoringEnabled { device.isSubjectAreaChangeMonitoringEnabled = false }
        // HDR lives on the FORMAT, not the device — `device.isVideoHDRSupported`
        // does not exist. HDR bracketing doubles effective exposure time, which
        // is exactly what we are trying to avoid.
        if device.activeFormat.isVideoHDRSupported {
            device.automaticallyAdjustsVideoHDREnabled = false
            device.isVideoHDREnabled = false
        }
        device.unlockForConfiguration()

        // Video output — BGRA would cost us a conversion; the tracker works
        // directly on the luma plane of 420f, which is what the sensor gives us.
        session.outputs.forEach { session.removeOutput($0) }
        videoOutput.videoSettings = [
            kCVPixelBufferPixelFormatTypeKey as String:
                kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
        ]
        // Critical at 240 FPS: if we can't keep up we want the *new* frame
        // dropped, not a backlog building behind us.
        videoOutput.alwaysDiscardsLateVideoFrames = true
        videoOutput.setSampleBufferDelegate(delegate, queue: videoQueue)
        guard session.canAddOutput(videoOutput) else {
            throw CameraError.configurationFailed("video output rejected")
        }
        session.addOutput(videoOutput)

        if let conn = videoOutput.connection(with: .video) {
            // Rotation costs a GPU pass per frame. We keep the native sensor
            // orientation and rotate only the *preview*, correcting coordinates
            // analytically in BallTracker instead.
            conn.isVideoMirrored = false
            if conn.isVideoRotationAngleSupported(0) { conn.videoRotationAngle = 0 }
            // Stabilisation warps the image non-rigidly between frames, which
            // would corrupt the very displacement we're trying to measure.
            if conn.isVideoStabilizationSupported {
                conn.preferredVideoStabilizationMode = .off
            }
        }

        // Depth, when the format supports it. Used once at arm time for scale,
        // not per-frame — high-frame-rate formats generally don't carry depth,
        // so LiDARCalibrator falls back to an ARKit session. See that file.
        if !format.supportedDepthDataFormats.isEmpty,
           session.canAddOutput(depthOutput) {
            session.addOutput(depthOutput)
            depthOutput.isFilteringEnabled = false   // we want raw, unsmoothed metres
            depthOutput.setDelegate(delegate, callbackQueue: videoQueue)
        }

        log.info("Configured \(mode.displayName, privacy: .public) — \(format.description, privacy: .public)")
    }

    /// Picks the format matching the requested dimensions that supports the
    /// requested frame rate, preferring the one with the shortest achievable
    /// exposure (that's the whole ballgame for motion blur).
    private func bestFormat(for device: AVCaptureDevice, mode: CaptureMode) -> AVCaptureDevice.Format? {
        let want = mode.dimensions
        let candidates = device.formats.filter { f in
            let d = CMVideoFormatDescriptionGetDimensions(f.formatDescription)
            guard d.width == want.width, d.height == want.height else { return false }
            guard f.videoSupportedFrameRateRanges.contains(where: {
                $0.maxFrameRate >= mode.targetFrameRate - 0.5
            }) else { return false }
            // Binned formats trade spatial detail for read-out speed. At 1080p240
            // that trade is already made for us; at 4K we want unbinned.
            return true
        }
        return candidates.min { a, b in
            if a.minExposureDuration != b.minExposureDuration {
                return a.minExposureDuration < b.minExposureDuration
            }
            return a.maxISO > b.maxISO
        }
    }

    // MARK: Exposure

    /// Drives the sensor to the shortest exposure that still meters correctly,
    /// then locks it.
    ///
    /// The ordering matters and is not obvious: we *fix* shutter at the target
    /// and let ISO float to make the exposure, rather than the usual reverse.
    /// A launch monitor would rather have a noisy sharp ball than a clean
    /// smeared one — the centroid estimator can average out sensor noise, but
    /// it cannot un-smear a 33 mm streak.
    func lockExposure(targetShutter denominator: Int = 2000) async {
        guard let device else { return }
        // AVCaptureDevice is not Sendable, and Swift 6 cannot see that every
        // access to it is serialised onto sessionQueue. That invariant is real
        // and enforced by construction, so we assert it here rather than
        // dropping the whole target to minimal concurrency checking.
        nonisolated(unsafe) let device = device
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            sessionQueue.async { [weak self] in
                guard let self else { cont.resume(); return }
                defer { cont.resume() }
                do {
                    try device.lockForConfiguration()
                    defer { device.unlockForConfiguration() }

                    // Clamp to what this format can physically do.
                    var wanted = CMTime(value: 1, timescale: CMTimeScale(denominator))
                    let minD = device.activeFormat.minExposureDuration
                    let maxD = device.activeFormat.maxExposureDuration
                    if CMTimeCompare(wanted, minD) < 0 { wanted = minD }
                    if CMTimeCompare(wanted, maxD) > 0 { wanted = maxD }

                    // Seed ISO from wherever auto-exposure had settled, scaled
                    // by how much light we just took away. exposureTargetOffset
                    // is in EV; each stop is a doubling of ISO.
                    let currentDur = CMTimeGetSeconds(device.exposureDuration)
                    let wantedDur = CMTimeGetSeconds(wanted)
                    let stopsLost = log2(max(currentDur, 1e-6) / max(wantedDur, 1e-6))
                    var iso = device.iso * powf(2, Float(stopsLost))
                    iso = min(max(iso, device.activeFormat.minISO),
                              min(device.activeFormat.maxISO, self.maxUsableISO))

                    device.setExposureModeCustom(duration: wanted, iso: iso)

                    if device.isWhiteBalanceModeSupported(.locked) {
                        // A drifting white balance changes the ball's apparent
                        // luma between frames and upsets the variance trigger.
                        device.whiteBalanceMode = .locked
                    }

                    let actualDen = Int((1.0 / CMTimeGetSeconds(wanted)).rounded())
                    Task { @MainActor in
                        self.exposure = ExposureState(shutterDenominator: actualDen,
                                                      iso: iso,
                                                      isLocked: true,
                                                      targetOffsetEV: device.exposureTargetOffset)
                    }
                } catch {
                    Task { @MainActor in
                        self.lastError = .configurationFailed("exposure: \(error.localizedDescription)")
                    }
                }
            }
        }
    }

    /// Closed loop that nudges ISO to bring the meter to zero while shutter
    /// stays pinned. Runs at 4 Hz while armed — fast enough to track a cloud
    /// crossing the sun, slow enough that it never fights the trigger.
    private var exposureTask: Task<Void, Never>?

    private func startExposureLoop() {
        exposureTask?.cancel()
        exposureTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(250))
                guard let self, let dev = self.device, self.exposure.isLocked else { continue }
                nonisolated(unsafe) let device = dev
                let offset = device.exposureTargetOffset
                self.exposure.targetOffsetEV = offset
                // Deadband: don't chase noise.
                guard abs(offset) > 0.35 else { continue }

                let proposed = device.iso * powf(2, offset)
                let clamped = min(max(proposed, device.activeFormat.minISO),
                                  min(device.activeFormat.maxISO, self.maxUsableISO))
                guard abs(clamped - device.iso) / max(device.iso, 1) > 0.05 else { continue }

                self.sessionQueue.async {
                    guard (try? device.lockForConfiguration()) != nil else { return }
                    device.setExposureModeCustom(duration: device.exposureDuration, iso: clamped)
                    device.unlockForConfiguration()
                }
                self.exposure.iso = clamped
            }
        }
    }

    // MARK: Focus

    /// Locks focus on the tee box.
    ///
    /// Note on the LiDAR: iOS exposes no distance→lensPosition mapping, so we
    /// cannot drive focus from the measured metres directly. What we do instead
    /// is run one autofocus cycle aimed at the tee point, wait for it to settle,
    /// then lock. The LiDAR distance is used for *scale*, which is the thing it
    /// is actually good for. Claiming otherwise would be hand-waving.
    func lockFocus(atNormalizedPoint point: CGPoint) async {
        guard let device else { return }
        nonisolated(unsafe) let device = device
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            sessionQueue.async {
                guard (try? device.lockForConfiguration()) != nil else { cont.resume(); return }
                if device.isFocusPointOfInterestSupported {
                    device.focusPointOfInterest = point
                }
                if device.isFocusModeSupported(.autoFocus) {
                    device.focusMode = .autoFocus
                }
                device.unlockForConfiguration()

                // Poll for the AF cycle to finish, then pin it.
                DispatchQueue.global().async {
                    let deadline = Date().addingTimeInterval(1.5)
                    while device.isAdjustingFocus && Date() < deadline {
                        Thread.sleep(forTimeInterval: 0.02)
                    }
                    if (try? device.lockForConfiguration()) != nil {
                        if device.isFocusModeSupported(.locked) { device.focusMode = .locked }
                        device.unlockForConfiguration()
                    }
                    cont.resume()
                }
            }
        }
    }

    func updateMeasuredFrameRate(_ fps: Double) { actualFrameRate = fps }
}

// MARK: - Capture delegate (NOT actor isolated — runs on videoQueue)

/// Deliberately a plain final class. At 240 FPS we cannot afford an executor
/// hop per frame, so this runs synchronously on `videoQueue` and communicates
/// with the rest of the app through the lock-free ring and a Sendable closure.
final class FrameCaptureDelegate: NSObject,
                                  AVCaptureVideoDataOutputSampleBufferDelegate,
                                  AVCaptureDepthDataOutputDelegate {

    private let ring: FrameRingBuffer
    private let onFrame: @Sendable (CVPixelBuffer, CMTime, Int) -> Void
    private let onDepth: (@Sendable (AVDepthData, CMTime) -> Void)?

    /// Written from MainActor, read from videoQueue. A plain Bool is fine here:
    /// a one-frame delay in observing the flip is harmless and atomicity of a
    /// single Bool is guaranteed on ARM64.
    var isDelivering = true

    private var droppedCount = 0

    init(ring: FrameRingBuffer,
         onFrame: @escaping @Sendable (CVPixelBuffer, CMTime, Int) -> Void,
         onDepth: (@Sendable (AVDepthData, CMTime) -> Void)?) {
        self.ring = ring
        self.onFrame = onFrame
        self.onDepth = onDepth
    }

    func captureOutput(_ output: AVCaptureOutput,
                       didOutput sampleBuffer: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        guard isDelivering,
              let pb = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let seq = ring.write(pb, pts: pts)
        onFrame(pb, pts, seq)
    }

    func captureOutput(_ output: AVCaptureOutput,
                       didDrop sampleBuffer: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        droppedCount += 1
        // A steady drip of drops means we're thermally throttled or the
        // analyzer is stealing the GPU. Surfaced in the HUD as a warning.
        if droppedCount % 30 == 0 {
            Logger(subsystem: "GolfLaunchMonitor", category: "Camera")
                .warning("Dropped \(self.droppedCount) frames — check thermal state")
        }
    }

    func depthDataOutput(_ output: AVCaptureDepthDataOutput,
                         didOutput depthData: AVDepthData,
                         timestamp: CMTime,
                         connection: AVCaptureConnection) {
        onDepth?(depthData, timestamp)
    }
}
