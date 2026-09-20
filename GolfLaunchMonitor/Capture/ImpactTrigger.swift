//
//  ImpactTrigger.swift
//  GolfLaunchMonitor
//
//  The state machine that decides when a shot happened.
//
//  Runs on the capture queue at 240 Hz, so the per-frame work is deliberately
//  tiny: a luma variance over an ~80×80 px ROI is ~6 400 samples, which is
//  nothing. The expensive Vision contour check only runs while we're hunting
//  for the ball, at ~30 Hz, and stops entirely once we're locked.
//
//  Detection principle: a ball sitting on a tee produces an extremely stable
//  patch. The instant the club arrives, that patch changes completely — the
//  ball leaves and usually a club head sweeps through. So we track a running
//  mean/variance of the ROI and fire on a large single-frame deviation. That
//  is far more robust than trying to *see* the ball leave, because at 240 fps
//  the ball is simply gone in one frame.
//

import Foundation
import CoreVideo
import CoreMedia
import os

enum TriggerState: Equatable, Sendable {
    /// Not looking for anything.
    case idle
    /// Hunting for a stationary ball in the tee box.
    case searching
    /// Ball found and stable; watching for impact.
    case armed(stableFrames: Int)
    /// Impact detected at this sequence; collecting the tail.
    case triggered(atSequence: Int, collected: Int)
    /// Enough frames captured; hand off to the analyzer.
    case complete(impactSequence: Int, endSequence: Int)

    var isArmed: Bool { if case .armed = self { true } else { false } }
    var isCapturing: Bool { if case .triggered = self { true } else { false } }
}

/// Tuning knobs, exposed so the settings screen can expose a sensitivity slider.
struct TriggerConfig: Sendable {
    /// Frames to keep after impact. 12 at 240 fps = 50 ms, during which a
    /// 150 mph ball travels ~3.3 m — well past the edge of frame.
    var postImpactFrames = 12
    /// Frames the ball must sit still before we consider ourselves armed.
    /// 24 frames = 100 ms.
    var requiredStableFrames = 24
    /// How many standard deviations of change constitutes impact.
    var triggerSigma: Double = 7.0
    /// Absolute floor so a very low-variance scene can't be triggered by noise.
    var minimumDeltaLuma: Double = 14.0
    /// Ignore triggers within this many frames of arming, to avoid firing on
    /// the user's hand withdrawing after placing the ball.
    var armingGraceFrames = 48

    static let `default` = TriggerConfig()
    static let sensitive = TriggerConfig(triggerSigma: 4.5, minimumDeltaLuma: 9)
    static let conservative = TriggerConfig(triggerSigma: 10, minimumDeltaLuma: 22)
}

/// Not an actor: this is called from the capture queue at 240 Hz and must not
/// hop executors. It is confined to that queue by convention and documented
/// as such.
final class ImpactTrigger: @unchecked Sendable {

    private(set) var state: TriggerState = .idle
    private var config: TriggerConfig
    private let log = Logger(subsystem: "GolfLaunchMonitor", category: "Trigger")

    /// Ball ROI in image pixels, set when the tracker locks on.
    private var roi: (x: Int, y: Int, w: Int, h: Int)?

    /// Welford running statistics of the ROI mean luma.
    private var n = 0
    private var mean = 0.0
    private var m2 = 0.0
    private var framesSinceArmed = 0

    /// Called on the main actor when a shot is ready.
    var onShotReady: (@Sendable (_ impactSequence: Int, _ endSequence: Int) -> Void)?
    var onStateChange: (@Sendable (TriggerState) -> Void)?

    init(config: TriggerConfig = .default) {
        self.config = config
    }

    func setConfig(_ c: TriggerConfig) { config = c }

    func beginSearching() {
        state = .searching
        resetStatistics()
        onStateChange?(state)
    }

    func disarm() {
        state = .idle
        roi = nil
        resetStatistics()
        onStateChange?(state)
    }

    /// Tracker found the ball — lock the ROI around it and start accumulating.
    func lockOn(ballCentre: SIMD2<Double>, radiusPixels: Double) {
        // ROI a little larger than the ball so the club entering the frame
        // also registers, which makes the trigger fire a touch earlier.
        let half = Int(max(radiusPixels * 2.2, 18))
        roi = (x: Int(ballCentre.x) - half,
               y: Int(ballCentre.y) - half,
               w: half * 2,
               h: half * 2)
        resetStatistics()
        framesSinceArmed = 0
        state = .armed(stableFrames: 0)
        onStateChange?(state)
    }

    private func resetStatistics() { n = 0; mean = 0; m2 = 0 }

    // MARK: Per-frame, on the capture queue

    /// Returns true when this frame completed a shot capture.
    @discardableResult
    func process(pixelBuffer: CVPixelBuffer, sequence: Int) -> Bool {
        switch state {
        case .idle, .searching, .complete:
            return false

        case .armed(let stable):
            guard let roi else { return false }
            let value = meanLuma(pixelBuffer, roi: roi)
            framesSinceArmed += 1

            // Welford update.
            n += 1
            let delta = value - mean
            mean += delta / Double(n)
            m2 += delta * (value - mean)

            guard n > 8 else {
                state = .armed(stableFrames: stable + 1)
                return false
            }

            let variance = m2 / Double(n - 1)
            let sigma = max(sqrt(max(variance, 0)), 1.0)
            let deviation = abs(value - mean)

            let past = framesSinceArmed > config.armingGraceFrames
            let stableEnough = stable >= config.requiredStableFrames

            if past, stableEnough,
               deviation > sigma * config.triggerSigma,
               deviation > config.minimumDeltaLuma {
                log.info("IMPACT at seq \(sequence) — Δ\(deviation, format: .fixed(precision: 1)) vs σ\(sigma, format: .fixed(precision: 2))")
                state = .triggered(atSequence: sequence, collected: 0)
                onStateChange?(state)
                return false
            }

            state = .armed(stableFrames: stable + 1)
            return false

        case .triggered(let at, let collected):
            let next = collected + 1
            if next >= config.postImpactFrames {
                state = .complete(impactSequence: at, endSequence: sequence)
                onStateChange?(state)
                onShotReady?(at, sequence)
                return true
            }
            state = .triggered(atSequence: at, collected: next)
            return false
        }
    }

    /// Mean luma over the ROI. The only per-frame cost at 240 Hz.
    private func meanLuma(_ pixelBuffer: CVPixelBuffer,
                          roi: (x: Int, y: Int, w: Int, h: Int)) -> Double {
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0) else { return 0 }

        let stride = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0)
        let width = CVPixelBufferGetWidthOfPlane(pixelBuffer, 0)
        let height = CVPixelBufferGetHeightOfPlane(pixelBuffer, 0)
        let luma = base.assumingMemoryBound(to: UInt8.self)

        let x0 = max(0, roi.x), y0 = max(0, roi.y)
        let x1 = min(width - 1, roi.x + roi.w)
        let y1 = min(height - 1, roi.y + roi.h)
        guard x1 > x0, y1 > y0 else { return 0 }

        var sum = 0
        // Step by 2 in both axes: quarter the work for a mean that is
        // statistically indistinguishable, and we have 4 ms per frame.
        var y = y0
        var count = 0
        while y <= y1 {
            let row = luma + y * stride
            var x = x0
            while x <= x1 {
                sum += Int(row[x]); count += 1
                x += 2
            }
            y += 2
        }
        return count > 0 ? Double(sum) / Double(count) : 0
    }
}

import simd
