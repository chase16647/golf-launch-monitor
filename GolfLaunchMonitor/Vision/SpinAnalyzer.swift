//
//  SpinAnalyzer.swift
//  GolfLaunchMonitor
//
//  Estimates the spin AXIS — the thing that decides draw vs fade vs slice vs
//  hook — from the handful of frames where the ball is still in view.
//
//  ── Read this before trusting any number this file produces ────────────────
//
//  A phone 5 ft to the side of the ball gets a brutally short look at it. Some
//  numbers I worked out for this geometry (1080p, ~68° horizontal FOV, ball
//  starting centred, 240 fps):
//
//      ball speed    frames until it exits the frame
//         90 mph          12.3
//        120 mph           9.2
//        150 mph           7.4
//        175 mph           6.3
//
//  So we have roughly 6–9 usable frames, ~30 ms of flight. Three consequences
//  drive this entire file:
//
//  1. BACK-SPIN IS NOT MEASURABLE from the side, and we do not pretend it is.
//     It comes from `SpinModel.estimateTotalSpin`. Said plainly in the UI.
//
//  2. SIDE-SPIN *IS* MEASURABLE, via curvature. Magnus side-force bends the
//     ball off its launch line, and over 8 frames that bend is:
//
//        axis tilt    lateral deviation      at 5 ft, 1080p
//           5°            3.64 mm               3.4 px
//          10°            4.79 mm               4.5 px
//          20°            6.28 mm               5.9 px
//          35°            7.72 mm               7.2 px
//
//     Against ~1 px centroid noise that is a real signal for anything from a
//     firm fade upward, and marginal for a 5° baby draw. Hence confidence
//     scoring rather than false precision.
//
//  3. MARKER ROTATION aliases. At 240 fps a ball rotating faster than
//     7 200 rpm turns more than 180° between frames and the measured angle
//     wraps:
//
//        2 700 rpm →  67.5°/frame   unambiguous
//        6 000 rpm → 150.0°/frame   unambiguous
//        7 200 rpm → 180.0°/frame   Nyquist limit
//        9 500 rpm → 237.5°/frame   ALIASED — reads as -122.5°/frame
//
//     So when a marked ball is detected we still need the club's spin prior to
//     pick the right wrap count. That's what `unwrapRotation` does.
//
//  The three estimators are fused by inverse-variance weighting, which is the
//  right thing to do with independent estimates of differing quality, and the
//  fused confidence is reported honestly to the user.
//

import Foundation
import simd
import CoreGraphics

// MARK: - Shot shape

enum ShotShape: String, Codable, Sendable, CaseIterable {
    case straight
    case draw, fade
    case hook, slice
    case pullDraw, pullStraight, pullFade
    case pushDraw, pushStraight, pushFade

    var displayName: String {
        switch self {
        case .straight: "Straight"
        case .draw: "Draw"
        case .fade: "Fade"
        case .hook: "Hook"
        case .slice: "Slice"
        case .pullDraw: "Pull Draw"
        case .pullStraight: "Pull"
        case .pullFade: "Pull Fade"
        case .pushDraw: "Push Draw"
        case .pushStraight: "Push"
        case .pushFade: "Push Fade"
        }
    }

    /// SF Symbol suggesting the curve direction.
    var symbolName: String {
        switch self {
        case .straight, .pullStraight, .pushStraight: "arrow.up"
        case .draw, .pullDraw, .pushDraw, .hook: "arrow.turn.up.left"
        case .fade, .pullFade, .pushFade, .slice: "arrow.turn.up.right"
        }
    }

    /// Curves left in the air?
    var curvesLeft: Bool {
        switch self {
        case .draw, .hook, .pullDraw, .pushDraw: true
        default: false
        }
    }

    /// Classify from start direction and how much the ball bent.
    ///
    /// Thresholds in yards of curve at landing, which is what a golfer
    /// perceives — not degrees of axis, which they don't.
    ///   < 6 yd    straight
    ///   6–22 yd   draw / fade
    ///   > 22 yd   hook / slice
    /// Start direction beyond ±3° counts as a push or pull.
    static func classify(azimuthDegrees: Double, curveYards: Double) -> ShotShape {
        let curve = curveYards
        let absCurve = abs(curve)
        let start = azimuthDegrees

        let curveBand: Int = absCurve < 6 ? 0 : (absCurve <= 22 ? 1 : 2)
        let rightCurve = curve > 0

        // Shots started essentially on line get the simple names.
        if abs(start) <= 3.0 {
            switch curveBand {
            case 0: return .straight
            case 1: return rightCurve ? .fade : .draw
            default: return rightCurve ? .slice : .hook
            }
        }

        let pushed = start > 0
        switch (pushed, curveBand) {
        case (true, 0):  return .pushStraight
        case (true, 1):  return rightCurve ? .pushFade : .pushDraw
        case (true, _):  return rightCurve ? .slice : .pushDraw
        case (false, 0): return .pullStraight
        case (false, 1): return rightCurve ? .pullFade : .pullDraw
        case (false, _): return rightCurve ? .pullFade : .hook
        }
    }
}

// MARK: - Estimate plumbing

/// A single estimate of spin-axis tilt with its uncertainty, in degrees.
/// `sigma` is a 1σ standard deviation; smaller means trust it more.
struct AxisEstimate: Sendable {
    var degrees: Double
    var sigma: Double
    var source: Source

    enum Source: String, Sendable {
        case curvature      // measured bend of the flight path
        case marker         // tracked rotation of a marked ball
        case dPlane         // inferred from start direction + club model
    }

    var isUsable: Bool { sigma.isFinite && sigma > 0 && degrees.isFinite }
}

/// What the analyzer hands back.
struct SpinEstimate: Sendable {
    var totalSpinRPM: Double
    var spinAxisDegrees: Double
    var sideSpinRPM: Double
    var backSpinRPM: Double
    /// 0…1. Below ~0.35 the UI shows the shape as "unconfirmed".
    var confidence: Double
    /// Which estimators actually contributed, for the details panel.
    var contributions: [AxisEstimate]
    /// True when back-spin came from the club model rather than measurement,
    /// which is essentially always. Surfaced in the UI so we never imply we
    /// measured something we didn't.
    var backSpinIsModelled: Bool

    var totalSpinIsModelled: Bool { backSpinIsModelled }
}

// MARK: - Analyzer

/// Stateless. Fed the tracked ball path plus context; returns a fused estimate.
enum SpinAnalyzer {

    /// Nyquist limit for marker tracking, rpm, at a given frame rate.
    static func nyquistSpinRPM(frameRate: Double) -> Double {
        // 180° per frame is the wrap point: rpm = (180/360) * fps * 60
        frameRate * 30.0
    }

    // MARK: Entry point

    /// - Parameters:
    ///   - track: post-impact ball positions in METRES in the world frame,
    ///            already scale-corrected by LiDARCalibrator and levelled by
    ///            MotionLeveler. x = downrange, y = up, z = right.
    ///   - times: presentation timestamps in seconds, same count as `track`.
    ///   - ballSpeedMPH: measured from the first frames.
    ///   - azimuthDegrees: measured horizontal launch angle.
    ///   - markerRotation: optional per-frame rotation in degrees from
    ///                     `MarkerTracker`, if a marked ball was found.
    static func analyze(track: [SIMD3<Double>],
                        times: [Double],
                        ballSpeedMPH: Double,
                        launchAngleDegrees: Double,
                        azimuthDegrees: Double,
                        club: Club,
                        profile: SwingProfile,
                        frameRate: Double,
                        pixelsPerMetre: Double,
                        markerRotation: MarkerRotationSample? = nil,
                        atmosphere: Atmosphere = .standard) -> SpinEstimate {

        // Back-spin magnitude is modelled, full stop.
        let totalSpin = SpinModel.estimateTotalSpin(club: club,
                                                    ballSpeedMPH: ballSpeedMPH,
                                                    launchAngleDegrees: launchAngleDegrees,
                                                    profile: profile)

        var estimates: [AxisEstimate] = []

        if let c = curvatureEstimate(track: track,
                                     times: times,
                                     ballSpeedMPH: ballSpeedMPH,
                                     totalSpinRPM: totalSpin,
                                     pixelsPerMetre: pixelsPerMetre,
                                     atmosphere: atmosphere) {
            estimates.append(c)
        }

        if let m = markerRotation,
           let e = markerEstimate(sample: m,
                                  club: club,
                                  frameRate: frameRate,
                                  totalSpinRPM: totalSpin) {
            estimates.append(e)
        }

        // Always available, always weakest. Acts as the prior that keeps the
        // answer sane when the measured signal is thin.
        estimates.append(dPlaneEstimate(azimuthDegrees: azimuthDegrees,
                                        club: club,
                                        totalSpinRPM: totalSpin))

        let (axis, sigma) = fuse(estimates)

        // Confidence maps the fused σ onto 0…1. σ of 3° or better is a
        // confident read; 15° or worse is basically a guess.
        let confidence = (1.0 - (sigma - 3.0) / 12.0).clamped(to: 0...1)

        let axisRad = axis * .pi / 180
        return SpinEstimate(totalSpinRPM: totalSpin,
                            spinAxisDegrees: axis,
                            sideSpinRPM: totalSpin * sin(axisRad),
                            backSpinRPM: totalSpin * cos(axisRad),
                            confidence: confidence,
                            contributions: estimates,
                            backSpinIsModelled: true)
    }

    // MARK: 1. Curvature — the real measurement

    /// Fit the lateral track and read the Magnus acceleration off the
    /// second-order term, then invert the lift equation for the axis tilt.
    ///
    /// The ball's lateral position follows z(t) = z₀ + v_z·t + ½·a_z·t², and
    /// a_z is *directly* the side-force acceleration. Over our short window the
    /// speed barely changes so treating a_z as constant is accurate to well
    /// under the noise floor.
    private static func curvatureEstimate(track: [SIMD3<Double>],
                                          times: [Double],
                                          ballSpeedMPH: Double,
                                          totalSpinRPM: Double,
                                          pixelsPerMetre: Double,
                                          atmosphere: Atmosphere) -> AxisEstimate? {
        // Need at least 5 points to separate a quadratic from noise with any
        // confidence; 4 would fit exactly and tell us nothing about residuals.
        guard track.count >= 5, times.count == track.count else { return nil }

        let t0 = times[0]
        let ts = times.map { $0 - t0 }
        let zs = track.map { $0.z }

        guard let fit = quadraticFit(x: ts, y: zs) else { return nil }
        // z = c0 + c1 t + c2 t²  ⇒  lateral acceleration = 2·c2
        let aLateral = 2 * fit.c2

        let v = ballSpeedMPH * 0.44704
        guard v > 5 else { return nil }

        // Invert  a = (½ρA·v²·C_L·sin(axis)) / m  for sin(axis).
        //
        // C_L itself depends on the spin ratio, which depends on the side-spin
        // component we're solving for — so this is implicit. Two fixed-point
        // iterations converge well inside our error bars.
        let rho = atmosphere.density
        let omegaTotal = totalSpinRPM * 2 * .pi / 60
        var axisRad = 0.0
        for _ in 0..<3 {
            let omegaSide = omegaTotal * sin(abs(axisRad))
            // Seed the first pass with a mid-range side component so C_L isn't
            // zero on iteration one.
            let omegaEff = max(omegaSide, omegaTotal * 0.05)
            let S = Aero.spinRatio(omega: omegaEff, speed: v)
            let cl = Aero.liftCoefficient(spinRatio: S)
            guard cl > 1e-6 else { break }
            let denom = 0.5 * rho * Ball.area * v * v * cl / Ball.massKg
            guard denom > 1e-9 else { break }
            let s = (aLateral / denom).clamped(to: -1...1)
            axisRad = asin(s)
        }

        let degrees = axisRad * 180 / .pi

        // ── Uncertainty ──
        // Propagate the centroid noise through the quadratic fit. `fit.sigmaC2`
        // is the standard error on the t² coefficient, which maps linearly to
        // the acceleration and (locally) to the axis angle.
        //
        // Centroid noise: a motion-blurred ball centroids to roughly 1 px at
        // this scale. Convert to metres via the LiDAR scale.
        let centroidNoiseM = 1.0 / max(pixelsPerMetre, 1)
        let sigmaA = 2 * fit.sigmaC2 * centroidNoiseM / max(fit.residualScale, 1e-9)

        // dAxis/da at the current operating point.
        let omegaSide = max(omegaTotal * sin(abs(axisRad)), omegaTotal * 0.05)
        let S = Aero.spinRatio(omega: omegaSide, speed: v)
        let cl = max(Aero.liftCoefficient(spinRatio: S), 1e-6)
        let scale = 0.5 * rho * Ball.area * v * v * cl / Ball.massKg
        let sigmaDeg = (sigmaA / max(scale, 1e-9)) * 180 / .pi

        // Floor the uncertainty: even a clean fit can't beat the systematic
        // error in our modelled total spin, which is what converts curvature
        // to axis. ±4° is an honest floor.
        let sigma = max(4.0, min(sigmaDeg, 60.0))
        guard sigma < 45 else { return nil }   // too noisy to be worth fusing

        return AxisEstimate(degrees: degrees.clamped(to: -60...60),
                            sigma: sigma,
                            source: .curvature)
    }

    // MARK: 2. Marker rotation — best when it works

    /// Rotation measured between consecutive frames by tracking a marked ball.
    struct MarkerRotationSample: Sendable {
        /// Apparent in-plane rotation per frame, degrees, already wrapped into
        /// (-180, 180] by the phase-correlation step.
        var wrappedDegreesPerFrame: Double
        /// Tilt of the rotation axis in the image plane, degrees. This is the
        /// part we actually want — it maps to spin axis directly.
        var axisTiltDegrees: Double
        /// Quality of the log-polar phase correlation peak, 0…1.
        var correlationQuality: Double
        /// How many frame pairs contributed.
        var sampleCount: Int
    }

    private static func markerEstimate(sample: MarkerRotationSample,
                                       club: Club,
                                       frameRate: Double,
                                       totalSpinRPM: Double) -> AxisEstimate? {
        guard sample.correlationQuality > 0.45, sample.sampleCount >= 3 else { return nil }

        // Resolve aliasing against the club prior. If the unwrapped rotation
        // can't be reconciled with any plausible spin for this club, the
        // marker read is untrustworthy — bail rather than invent a number.
        guard unwrapRotation(wrapped: sample.wrappedDegreesPerFrame,
                             frameRate: frameRate,
                             plausible: club.spinRange) != nil else {
            return nil
        }

        // The axis tilt is read directly off the rotation plane, and unlike
        // the magnitude it does NOT alias — a wrapped magnitude still rotates
        // about the same visible axis.
        let degrees = sample.axisTiltDegrees.clamped(to: -60...60)

        // Good correlation on a marked ball is the most direct measurement we
        // have. σ from 2.5° (crisp) to 9° (marginal).
        let sigma = 2.5 + (1.0 - sample.correlationQuality) * 6.5
        return AxisEstimate(degrees: degrees, sigma: sigma, source: .marker)
    }

    /// Undo Nyquist wrapping using the club's plausible spin window.
    ///
    /// Returns the true rpm, or nil when no wrap count lands in range.
    static func unwrapRotation(wrapped: Double,
                               frameRate: Double,
                               plausible: ClosedRange<Double>) -> Double? {
        // Candidate true rotations are wrapped + k·360 for integer k.
        // rpm = degPerFrame / 360 * frameRate * 60
        var best: (rpm: Double, distance: Double)?
        for k in -1...6 {
            let deg = wrapped + Double(k) * 360.0
            guard deg > 0 else { continue }
            let rpm = deg / 360.0 * frameRate * 60.0
            guard plausible.contains(rpm) else { continue }
            let mid = (plausible.lowerBound + plausible.upperBound) / 2
            let d = abs(rpm - mid)
            if best == nil || d < best!.distance { best = (rpm, d) }
        }
        return best?.rpm
    }

    // MARK: 3. D-plane prior — always available, weakest

    /// Infer axis from where the ball started relative to the target.
    ///
    /// The relationship: the ball starts most of the way toward the face angle,
    /// and curves according to face-to-path. With only the start direction
    /// measured we must assume a path, so we assume the golfer was swinging at
    /// the target (path ≈ 0). That assumption is wrong often enough that this
    /// estimator carries a deliberately large σ — it is a prior, not a
    /// measurement, and the fusion treats it as such.
    private static func dPlaneEstimate(azimuthDegrees: Double,
                                       club: Club,
                                       totalSpinRPM: Double) -> AxisEstimate {
        let bias = club.startDirectionFaceBias
        // start ≈ bias·face + (1-bias)·path, path assumed 0 ⇒ face ≈ start/bias
        let face = azimuthDegrees / max(bias, 0.5)
        let faceToPath = face   // since path assumed 0

        // Spin axis tilt is roughly proportional to face-to-path. The constant
        // (~0.8°/° for a driver, less for wedges whose higher backspin resists
        // tilting) comes from the standard D-plane construction: the axis tilt
        // is atan(sideSpin/backSpin), and side spin scales with face-to-path.
        let loftDamping = 1.0 - (club.loft - 10.5) / (60.0 - 10.5) * 0.45
        let degrees = (faceToPath * 0.80 * loftDamping).clamped(to: -60...60)

        // Large σ, and larger still when the ball started near straight, since
        // then the path assumption dominates entirely.
        let sigma = 11.0 + abs(azimuthDegrees) * 0.4
        return AxisEstimate(degrees: degrees, sigma: min(sigma, 22), source: .dPlane)
    }

    // MARK: Fusion

    /// Inverse-variance weighted mean — the maximum-likelihood combination for
    /// independent Gaussian estimates.
    private static func fuse(_ estimates: [AxisEstimate]) -> (degrees: Double, sigma: Double) {
        let usable = estimates.filter(\.isUsable)
        guard !usable.isEmpty else { return (0, 30) }

        var wSum = 0.0
        var wxSum = 0.0
        for e in usable {
            let w = 1.0 / (e.sigma * e.sigma)
            wSum += w
            wxSum += w * e.degrees
        }
        guard wSum > 0 else { return (0, 30) }
        let mean = wxSum / wSum
        var sigma = sqrt(1.0 / wSum)

        // Disagreement penalty: if the estimators genuinely conflict, the
        // naive combined σ is over-confident. Inflate by the χ²-style scatter.
        if usable.count > 1 {
            var chi2 = 0.0
            for e in usable {
                let d = (e.degrees - mean) / e.sigma
                chi2 += d * d
            }
            let reduced = chi2 / Double(usable.count - 1)
            if reduced > 1 { sigma *= sqrt(reduced) }
        }
        return (mean, sigma)
    }

    // MARK: Least squares

    private struct QuadFit {
        var c0, c1, c2: Double
        /// Standard error on c2, in units of the y-noise.
        var sigmaC2: Double
        /// RMS residual, used to scale sigmaC2 into real units.
        var residualScale: Double
    }

    /// Ordinary least squares for y = c0 + c1·x + c2·x², solved via the normal
    /// equations. n is tiny (≤ 12) and the design matrix is well conditioned
    /// once x is shifted to start at zero, so this is fine — no need for QR.
    private static func quadraticFit(x: [Double], y: [Double]) -> QuadFit? {
        let n = Double(x.count)
        guard x.count >= 4 else { return nil }

        var s0 = n, s1 = 0.0, s2 = 0.0, s3 = 0.0, s4 = 0.0
        var t0 = 0.0, t1 = 0.0, t2 = 0.0
        for i in 0..<x.count {
            let xi = x[i], yi = y[i]
            let x2 = xi * xi
            s1 += xi; s2 += x2; s3 += x2 * xi; s4 += x2 * x2
            t0 += yi; t1 += xi * yi; t2 += x2 * yi
        }

        // 3×3 solve by Cramer's rule.
        let a = [[s0, s1, s2],
                 [s1, s2, s3],
                 [s2, s3, s4]]
        let b = [t0, t1, t2]

        func det3(_ m: [[Double]]) -> Double {
            m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
          - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
          + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
        }
        let D = det3(a)
        guard abs(D) > 1e-18 else { return nil }

        func replaceColumn(_ m: [[Double]], _ col: Int, _ v: [Double]) -> [[Double]] {
            var out = m
            for r in 0..<3 { out[r][col] = v[r] }
            return out
        }
        let c0 = det3(replaceColumn(a, 0, b)) / D
        let c1 = det3(replaceColumn(a, 1, b)) / D
        let c2 = det3(replaceColumn(a, 2, b)) / D

        // Residuals → noise estimate.
        var ss = 0.0
        for i in 0..<x.count {
            let pred = c0 + c1 * x[i] + c2 * x[i] * x[i]
            let r = y[i] - pred
            ss += r * r
        }
        let dof = max(n - 3, 1)
        let variance = ss / dof
        let rms = sqrt(max(variance, 0))

        // Var(c2) = σ²·(A⁻¹)₂₂ ; (A⁻¹)₂₂ = cofactor₂₂ / det
        let cof22 = s0 * s2 - s1 * s1
        let sigmaC2 = sqrt(max(variance * abs(cof22 / D), 0))

        return QuadFit(c0: c0, c1: c1, c2: c2,
                       sigmaC2: sigmaC2 > 0 ? sigmaC2 : 1e-6,
                       residualScale: max(rms, 1e-6))
    }
}
