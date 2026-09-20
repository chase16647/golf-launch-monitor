//
//  ShotPipeline.swift
//  GolfLaunchMonitor
//
//  The orchestrator. Owns the camera, the trigger, the tracker and the models,
//  and turns "a swing happened" into a ShotResult.
//
//  Concurrency shape:
//    * CameraManager + trigger live on the capture queue (no actor hops).
//    * Tracking and physics run in a detached task at .userInitiated.
//    * UI state is @MainActor published.
//
//  The capture queue never awaits anything.
//

import Foundation
import AVFoundation
import CoreMedia
import simd
import os

@MainActor
final class ShotPipeline: ObservableObject {

    // MARK: Published state

    enum Phase: Equatable {
        case idle
        case calibrating
        case searching
        case armed
        case capturing
        case analyzing
        case result(ShotResult)
        case failed(String)
    }

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var calibration: Calibration?
    @Published private(set) var lastShot: ShotResult?
    @Published private(set) var capturedFrames: [ScrubFrame] = []
    @Published var club: Club = .driver
    @Published var swingProfile: SwingProfile = .midHandicap
    @Published var atmosphere: Atmosphere = .standard
    @Published var captureMode: CaptureMode = .highSpeed1080p240
    @Published var triggerSensitivity: Sensitivity = .normal

    enum Sensitivity: String, CaseIterable, Identifiable {
        case sensitive, normal, conservative
        var id: String { rawValue }
        var displayName: String {
            switch self {
            case .sensitive: "High"
            case .normal: "Normal"
            case .conservative: "Low"
            }
        }
        var config: TriggerConfig {
            switch self {
            case .sensitive: .sensitive
            case .normal: .default
            case .conservative: .conservative
            }
        }
    }

    // MARK: Collaborators

    let camera = CameraManager()
    let leveler = MotionLeveler()
    private let calibrator = LiDARCalibrator()
    private let tracker = BallTracker()
    private let trigger = ImpactTrigger()
    private let voice = VoiceCoach()

    /// Frame-rate meter, deliberately NOT actor isolated - see `begin()`.
    private let frameMeter = FrameRateMeter()
    private let log = Logger(subsystem: "GolfLaunchMonitor", category: "Pipeline")

    /// Normalized tee-box point the user aims at.
    @Published var teePoint = CGPoint(x: 0.5, y: 0.55)

    private var searchTask: Task<Void, Never>?

    var onShotRecorded: ((ShotResult) -> Void)?

    // MARK: Lifecycle

    func begin() async {
        leveler.start()
        trigger.setConfig(triggerSensitivity.config)

        trigger.onShotReady = { [weak self] impact, end in
            Task { @MainActor in await self?.handleShotReady(impact: impact, end: end) }
        }
        trigger.onStateChange = { [weak self] state in
            Task { @MainActor in self?.reflect(state) }
        }

        // Hoist the two collaborators out BEFORE building the closure, so the
        // callback captures them directly and never touches `self`.
        //
        // This runs on the capture queue at 240 Hz. Reaching through a
        // @MainActor `self` from there is both a compile error under strict
        // concurrency and, were it allowed, an executor hop per frame - which
        // would blow the 4.16 ms budget on its own.
        let trigger = self.trigger
        let meter = self.frameMeter

        await camera.start(mode: captureMode, onFrame: { pb, pts, seq in
            // CAPTURE QUEUE. Nothing here may await or allocate.
            trigger.process(pixelBuffer: pb, sequence: seq)
            meter.note(pts)
        })

        await camera.lockExposure(targetShutter: 2000)
        await camera.lockFocus(atNormalizedPoint: teePoint)
        await calibrate()
    }

    func end() {
        searchTask?.cancel()
        camera.stop()
        leveler.stop()
        phase = .idle
    }

    // MARK: Calibration

    func calibrate() async {
        phase = .calibrating
        do {
            let cal = try await calibrator.calibrate(atNormalizedPoint: teePoint)
            calibration = cal
            startSearching()
        } catch {
            // No LiDAR, or depth failed. We can still work off the ball's own
            // 42.67 mm diameter, but say so plainly rather than pretending.
            log.warning("Calibration fallback: \(error.localizedDescription)")
            await calibrator.setManualDistance(feet: 5.5, focalLengthPixels: 1450)
            calibration = await calibrator.current
            startSearching()
        }
    }

    // MARK: Arming

    func startSearching() {
        trigger.beginSearching()
        phase = .searching
        camera.resumeDelivery()

        searchTask?.cancel()
        searchTask = Task { [weak self] in
            // Hunt for the ball at ~20 Hz. Cheap enough to run alongside the
            // 240 fps stream, and the user isn't swinging yet.
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(50))
                guard let self else { return }
                guard case .searching = self.phase else {
                    if self.trigger.state.isArmed { continue } else { return }
                }
                await self.attemptLock()
            }
        }
    }

    private func attemptLock() async {
        guard let cal = calibration else { return }
        let seq = camera.ring.latestSequence - 1
        guard seq >= 0, let slice = camera.ring.snapshot(endingAt: seq, count: 1),
              let frame = slice.first else { return }

        // Tee-box ROI around the aiming point, in Vision's bottom-left space.
        let roiSize: CGFloat = 0.28
        let roi = CGRect(x: max(0, teePoint.x - roiSize / 2),
                         y: max(0, (1 - teePoint.y) - roiSize / 2),
                         width: roiSize, height: roiSize)

        guard let ball = await tracker.detectRestingBall(
            in: frame.pixelBuffer,
            roi: roi,
            expectedRadiusPixels: cal.expectedBallRadiusPixels,
            frameSequence: frame.sequence,
            timestamp: CMTimeGetSeconds(frame.presentationTime)
        ) else { return }

        // Use the ball's known diameter to cross-check the LiDAR scale.
        await calibrator.refine(withBallRadiusPixels: ball.radiusPixels)
        calibration = await calibrator.current

        trigger.lockOn(ballCentre: ball.centre, radiusPixels: ball.radiusPixels)
        searchTask?.cancel()
    }

    private func reflect(_ state: TriggerState) {
        switch state {
        case .idle: phase = .idle
        case .searching: phase = .searching
        case .armed: if phase != .armed { phase = .armed }
        case .triggered: phase = .capturing
        case .complete: phase = .analyzing
        }
    }

    // MARK: Analysis

    private func handleShotReady(impact: Int, end: Int) async {
        phase = .analyzing
        // Stop streaming immediately: the ring now holds the shot and we want
        // every cycle for analysis, not for frames we'll throw away.
        camera.pauseDelivery()

        guard let cal = calibration else {
            phase = .failed("Not calibrated."); return
        }

        // Grab 8 pre-impact + the post-impact tail.
        let preRoll = 8
        let count = min(end - impact + preRoll + 1, camera.ring.capacity)
        guard let frames = camera.ring.snapshot(endingAt: end, count: count) else {
            phase = .failed("Frame buffer overran — the analyzer fell behind.")
            resetAfterFailure(); return
        }

        let impactIndex = frames.firstIndex { $0.sequence == impact } ?? preRoll
        let levelling = leveler.snapshot()
        let fps = measuredFrameRate()
        let exposure = camera.exposure
        let club = self.club
        let profile = self.swingProfile
        let atmos = self.atmosphere
        let mode = self.captureMode

        // Keep the frames for the scrub reel before we hand off.
        capturedFrames = ScrubFrame.build(from: frames, impactIndex: impactIndex)

        do {
            let track = try await tracker.track(frames: frames,
                                                impactIndex: impactIndex,
                                                calibration: cal,
                                                levelling: levelling)

            let shot = try Self.computeShot(track: track,
                                            club: club,
                                            profile: profile,
                                            atmosphere: atmos,
                                            calibration: cal,
                                            frameRate: fps,
                                            captureMode: mode,
                                            exposure: exposure)
            lastShot = shot
            phase = .result(shot)
            onShotRecorded?(shot)
            voice.announce(shot)
        } catch {
            phase = .failed(error.localizedDescription)
        }
        resetAfterFailure()
    }

    private func resetAfterFailure() {
        Task {
            try? await Task.sleep(for: .seconds(1))
            await tracker.clearRestingBall()
            startSearching()
        }
    }

    /// Pure function: track → metrics. Static so it's trivially testable
    /// without a camera.
    static func computeShot(track: BallTrack,
                            club: Club,
                            profile: SwingProfile,
                            atmosphere: Atmosphere,
                            calibration: Calibration,
                            frameRate: Double,
                            captureMode: CaptureMode,
                            exposure: ExposureState) throws -> ShotResult {

        guard track.isUsable else {
            throw TrackingError.tooFewFrames(track.observations.count)
        }

        // ── Ball speed from the first 4 post-impact frames ────────────────
        // Least-squares slope rather than a first/last difference: with 4+
        // points the fit rejects a single bad centroid, which a two-point
        // difference cannot.
        let n = min(4, track.worldPositions.count)
        let t0 = track.times[0]
        var sumT = 0.0, sumT2 = 0.0
        var sumX = 0.0, sumTX = 0.0
        var sumY = 0.0, sumTY = 0.0
        for i in 0..<n {
            let t = track.times[i] - t0
            let p = track.worldPositions[i]
            sumT += t; sumT2 += t * t
            sumX += p.x; sumTX += t * p.x
            sumY += p.y; sumTY += t * p.y
        }
        let nd = Double(n)
        let denom = nd * sumT2 - sumT * sumT
        guard abs(denom) > 1e-12 else { throw TrackingError.tooFewFrames(n) }
        let vx = (nd * sumTX - sumT * sumX) / denom
        let vy = (nd * sumTY - sumT * sumY) / denom

        // Gravity has already acted a little by the time we sample, so add it
        // back to recover the launch velocity. Over ~16 ms this is ~0.16 m/s —
        // small, but it's a free correction and it biases launch angle low.
        let meanT = sumT / nd
        let vyLaunch = vy + Aero.gravity * meanT

        let speed = sqrt(vx * vx + vyLaunch * vyLaunch)
        let ballSpeedMPH = speed / 0.44704
        guard ballSpeedMPH > 20, ballSpeedMPH < 250 else {
            throw TrackingError.noBallFound
        }

        let launchAngle = atan2(vyLaunch, vx) * 180 / .pi

        // ── Azimuth ──
        // From the side, lateral motion is along the optical axis and barely
        // observable. We derive azimuth from the weak depth-shift signal and
        // give it a wide error bar; the D-plane prior in SpinAnalyzer leans on
        // it only lightly for exactly this reason.
        var azimuth = 0.0
        if track.worldPositions.count >= 4 {
            let dz = track.worldPositions[min(3, track.worldPositions.count - 1)].z
                   - track.worldPositions[0].z
            let dx = track.worldPositions[min(3, track.worldPositions.count - 1)].x
                   - track.worldPositions[0].x
            if abs(dx) > 1e-4 {
                azimuth = (atan2(dz, dx) * 180 / .pi).clamped(to: -12...12)
            }
        }

        // ── Spin ──
        let spin = SpinAnalyzer.analyze(track: track.worldPositions,
                                        times: track.times,
                                        ballSpeedMPH: ballSpeedMPH,
                                        launchAngleDegrees: launchAngle,
                                        azimuthDegrees: azimuth,
                                        club: club,
                                        profile: profile,
                                        frameRate: frameRate,
                                        pixelsPerMetre: calibration.pixelsPerMetre,
                                        markerRotation: nil,
                                        atmosphere: atmosphere)

        // ── Flight ──
        let conditions = LaunchConditions(ballSpeedMPH: ballSpeedMPH,
                                          launchAngleDegrees: launchAngle,
                                          azimuthDegrees: azimuth,
                                          totalSpinRPM: spin.totalSpinRPM,
                                          spinAxisDegrees: spin.spinAxisDegrees,
                                          atmosphere: atmosphere)
        let flight = FlightModel.simulate(conditions)

        let shape = ShotShape.classify(azimuthDegrees: azimuth,
                                       curveYards: flight.curveYards)

        let meanSmear = track.observations.map(\.smearRatio).reduce(0, +)
            / Double(track.observations.count)

        return ShotResult(club: club,
                          ballSpeedMPH: ballSpeedMPH,
                          launchAngleDegrees: launchAngle,
                          azimuthDegrees: azimuth,
                          totalSpinRPM: spin.totalSpinRPM,
                          spinAxisDegrees: spin.spinAxisDegrees,
                          sideSpinRPM: spin.sideSpinRPM,
                          backSpinRPM: spin.backSpinRPM,
                          spinConfidence: spin.confidence,
                          spinIsModelled: spin.backSpinIsModelled,
                          carryYards: flight.carryYards,
                          totalYards: flight.totalYards,
                          sideYards: flight.sideYards,
                          curveYards: flight.curveYards,
                          apexFeet: flight.apexFeet,
                          hangTimeSeconds: flight.hangTimeSeconds,
                          descentAngleDegrees: flight.descentAngleDegrees,
                          shape: shape,
                          trackedFrameCount: track.observations.count,
                          calibrationSource: calibration.source.rawValue,
                          calibrationCrossCheck: calibration.crossCheck,
                          captureMode: captureMode,
                          measuredFrameRate: frameRate,
                          shutterDenominator: exposure.shutterDenominator,
                          iso: Double(exposure.iso),
                          meanSmearRatio: meanSmear,
                          atmosphere: atmosphere,
                          trajectory: flight.trajectory)
    }

    // MARK: Frame timing

    /// Real frame rate from PTS deltas. Under thermal throttling the sensor
    /// quietly drops below nominal, and assuming 240 while actually receiving
    /// 197 inflates every measured speed by 22 %.
    func measuredFrameRate() -> Double {
        frameMeter.median() ?? captureMode.targetFrameRate
    }

    var isFrameRateHealthy: Bool {
        measuredFrameRate() > captureMode.targetFrameRate * 0.90
    }
}

/// A frame kept for the slow-motion scrubber.
struct ScrubFrame: Identifiable, Sendable {
    let id = UUID()
    let image: CGImage
    let isImpact: Bool
    let offsetFromImpact: Int
    /// Tracked ball position in image coords, if we found it here.
    var ballPoint: CGPoint?

    @MainActor
    static func build(from frames: [FrameSlot], impactIndex: Int) -> [ScrubFrame] {
        // Keep 10 frames centred on impact, per the scrub-reel spec.
        let lower = max(0, impactIndex - 4)
        let upper = min(frames.count - 1, impactIndex + 5)
        guard lower <= upper else { return [] }

        let ctx = CIContext(options: [.useSoftwareRenderer: false])
        return frames[lower...upper].enumerated().compactMap { offset, slot in
            let ci = CIImage(cvPixelBuffer: slot.pixelBuffer)
            guard let cg = ctx.createCGImage(ci, from: ci.extent) else { return nil }
            let idx = lower + offset
            return ScrubFrame(image: cg,
                              isImpact: idx == impactIndex,
                              offsetFromImpact: idx - impactIndex,
                              ballPoint: nil)
        }
    }
}

import CoreImage


// MARK: - Frame rate meter

/// Measures the real delivery rate from presentation timestamps.
///
/// Written from the capture queue at up to 240 Hz and read from the main actor
/// once per shot, so it takes a lock rather than being actor isolated: an
/// executor hop per frame would cost far more than the measurement is worth.
final class FrameRateMeter: @unchecked Sendable {
    private var lastPTS: CMTime = .invalid
    private var intervals: [Double] = []
    private let lock = NSLock()

    func note(_ pts: CMTime) {
        lock.lock()
        defer { lock.unlock() }
        guard lastPTS.isValid else { lastPTS = pts; return }
        let dt = CMTimeGetSeconds(pts) - CMTimeGetSeconds(lastPTS)
        lastPTS = pts
        guard dt > 0, dt < 0.1 else { return }
        intervals.append(dt)
        if intervals.count > 120 { intervals.removeFirst() }
    }

    /// Median rate in fps, or nil until there is enough data to mean anything.
    func median() -> Double? {
        lock.lock()
        defer { lock.unlock() }
        guard intervals.count > 20 else { return nil }
        let sorted = intervals.sorted()
        let m = sorted[sorted.count / 2]
        return m > 0 ? 1.0 / m : nil
    }

    func reset() {
        lock.lock()
        defer { lock.unlock() }
        lastPTS = .invalid
        intervals.removeAll()
    }
}
