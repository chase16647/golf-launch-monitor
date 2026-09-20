//
//  ClubProfile.swift
//  GolfLaunchMonitor
//
//  Per-club priors. These do two jobs:
//
//   1. Seed the spin estimate. A side-on camera cannot measure back-spin at
//      all (see SpinAnalyzer), so total spin comes from a loft-based model
//      anchored on measured ball speed and launch angle.
//   2. Constrain the side-spin solver. Knowing a wedge lives near 9 000 rpm
//      is what lets us un-alias a marker-rotation measurement that has wrapped
//      past Nyquist at 240 fps.
//
//  Spin/launch figures are Trackman tour averages, with the amateur skew
//  applied through `SwingProfile`.
//

import Foundation

enum Club: String, CaseIterable, Identifiable, Codable, Sendable {
    case driver, threeWood, fiveWood, hybrid
    case fourIron, fiveIron, sixIron, sevenIron, eightIron, nineIron
    case pitchingWedge, gapWedge, sandWedge, lobWedge

    var id: String { rawValue }

    var shortName: String {
        switch self {
        case .driver: "Dr"
        case .threeWood: "3W"
        case .fiveWood: "5W"
        case .hybrid: "Hy"
        case .fourIron: "4i"
        case .fiveIron: "5i"
        case .sixIron: "6i"
        case .sevenIron: "7i"
        case .eightIron: "8i"
        case .nineIron: "9i"
        case .pitchingWedge: "PW"
        case .gapWedge: "GW"
        case .sandWedge: "SW"
        case .lobWedge: "LW"
        }
    }

    var displayName: String {
        switch self {
        case .driver: "Driver"
        case .threeWood: "3 Wood"
        case .fiveWood: "5 Wood"
        case .hybrid: "Hybrid"
        case .fourIron: "4 Iron"
        case .fiveIron: "5 Iron"
        case .sixIron: "6 Iron"
        case .sevenIron: "7 Iron"
        case .eightIron: "8 Iron"
        case .nineIron: "9 Iron"
        case .pitchingWedge: "Pitching Wedge"
        case .gapWedge: "Gap Wedge"
        case .sandWedge: "Sand Wedge"
        case .lobWedge: "Lob Wedge"
        }
    }

    var symbolName: String {
        switch self {
        case .driver, .threeWood, .fiveWood, .hybrid: "figure.golf"
        default: "figure.golf"
        }
    }

    /// Static loft, degrees.
    var loft: Double {
        switch self {
        case .driver: 10.5
        case .threeWood: 15
        case .fiveWood: 18
        case .hybrid: 21
        case .fourIron: 24
        case .fiveIron: 27
        case .sixIron: 31
        case .sevenIron: 35
        case .eightIron: 39
        case .nineIron: 43
        case .pitchingWedge: 47
        case .gapWedge: 52
        case .sandWedge: 56
        case .lobWedge: 60
        }
    }

    /// Expected total spin window, rpm. The solver uses this to resolve
    /// marker-rotation aliasing and to sanity-clamp the model estimate.
    var spinRange: ClosedRange<Double> {
        switch self {
        case .driver: 1800...3600
        case .threeWood: 2600...4600
        case .fiveWood: 3200...5400
        case .hybrid: 3600...5800
        case .fourIron: 3800...5600
        case .fiveIron: 4300...6300
        case .sixIron: 5000...7000
        case .sevenIron: 5800...8000
        case .eightIron: 6600...8800
        case .nineIron: 7400...9600
        case .pitchingWedge: 8000...10500
        case .gapWedge: 8600...11000
        case .sandWedge: 9000...11500
        case .lobWedge: 9200...12000
        }
    }

    /// Fraction of the way from club path toward face angle that the ball
    /// actually starts. Lower-lofted clubs push the ball closer to the face
    /// angle; high loft drags start direction toward the path. This is the
    /// gear-effect/D-plane ratio the fallback side-spin estimator inverts.
    var startDirectionFaceBias: Double {
        // Empirically ~0.85 for driver falling to ~0.70 for wedges.
        let t = (loft - 10.5) / (60.0 - 10.5)
        return 0.85 - 0.15 * t
    }

    /// Typical smash factor (ball speed / club speed), for reporting club
    /// speed back from measured ball speed.
    var smashFactor: Double {
        switch self {
        case .driver: 1.48
        case .threeWood, .fiveWood: 1.46
        case .hybrid: 1.44
        case .fourIron, .fiveIron: 1.40
        case .sixIron, .sevenIron: 1.36
        case .eightIron, .nineIron: 1.30
        case .pitchingWedge: 1.25
        case .gapWedge, .sandWedge, .lobWedge: 1.18
        }
    }

    static var bagDefault: [Club] {
        [.driver, .threeWood, .hybrid, .fiveIron, .sixIron, .sevenIron,
         .eightIron, .nineIron, .pitchingWedge, .gapWedge, .sandWedge]
    }
}

/// Player archetype. Shifts spin and launch expectations off the tour baseline —
/// a 90 mph driver swing spins far more than a tour player's.
enum SwingProfile: String, CaseIterable, Codable, Sendable, Identifiable {
    case tour, lowHandicap, midHandicap, highHandicap

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .tour: "Tour"
        case .lowHandicap: "Low (0–5)"
        case .midHandicap: "Mid (6–15)"
        case .highHandicap: "High (16+)"
        }
    }

    /// Multiplier on modelled spin.
    var spinMultiplier: Double {
        switch self {
        case .tour: 1.00
        case .lowHandicap: 1.08
        case .midHandicap: 1.18
        case .highHandicap: 1.32
        }
    }
}

enum SpinModel {

    /// Estimate total spin from what we can actually measure.
    ///
    /// Honest framing: this is a *model*, not a measurement. A camera looking
    /// at the ball from the side sees the ball's surface rotating about an axis
    /// that is nearly perpendicular to the image plane for back-spin, so
    /// back-spin is very poorly observable — which is exactly why every
    /// phone-only launch monitor models it rather than measuring it.
    ///
    /// Anchored on three real relationships:
    ///   * spin rises steeply with dynamic loft
    ///   * spin rises with impact speed
    ///   * for a given club, higher launch usually means more loft delivered,
    ///     hence more spin
    static func estimateTotalSpin(club: Club,
                                  ballSpeedMPH: Double,
                                  launchAngleDegrees: Double,
                                  profile: SwingProfile) -> Double {
        // Baseline spin for the club at its reference speed.
        let loft = club.loft
        // Linear in loft at ~180 rpm/degree. Verified against tour averages:
        //   Driver 10.5° → 2710 (real 2686), 7-iron 35° → 7120 (real 7097),
        //   PW 47° → 9280 (real 9316).
        // An earlier quadratic form gave a PW 19,834 rpm, which clamped every
        // lofted club to its range ceiling. Keep it linear.
        let base = 820.0 + 180.0 * loft

        // Speed scaling — spin is roughly proportional to impact speed.
        let refSpeed = referenceBallSpeed(for: club)
        let speedScale = (ballSpeedMPH / refSpeed).clamped(to: 0.6...1.4)

        // Launch-angle residual: if the ball launched higher than this club
        // usually does at this speed, more loft was delivered → more spin.
        let expectedLaunch = expectedLaunchAngle(for: club)
        let launchResidual = (launchAngleDegrees - expectedLaunch)
        let launchScale = (1.0 + launchResidual * 0.030).clamped(to: 0.70...1.35)

        let raw = base * speedScale * launchScale * profile.spinMultiplier
        return raw.clamped(to: club.spinRange)
    }

    static func referenceBallSpeed(for club: Club) -> Double {
        switch club {
        case .driver: 167
        case .threeWood: 158
        case .fiveWood: 152
        case .hybrid: 146
        case .fourIron: 137
        case .fiveIron: 132
        case .sixIron: 127
        case .sevenIron: 120
        case .eightIron: 115
        case .nineIron: 109
        case .pitchingWedge: 102
        case .gapWedge: 95
        case .sandWedge: 88
        case .lobWedge: 80
        }
    }

    static func expectedLaunchAngle(for club: Club) -> Double {
        switch club {
        case .driver: 10.9
        case .threeWood: 9.2
        case .fiveWood: 9.4
        case .hybrid: 10.2
        case .fourIron: 11.0
        case .fiveIron: 14.3
        case .sixIron: 15.5
        case .sevenIron: 16.3
        case .eightIron: 18.1
        case .nineIron: 20.4
        case .pitchingWedge: 24.2
        case .gapWedge: 26.5
        case .sandWedge: 28.5
        case .lobWedge: 31.0
        }
    }
}

extension Double {
    func clamped(to r: ClosedRange<Double>) -> Double {
        Swift.min(Swift.max(self, r.lowerBound), r.upperBound)
    }
}
