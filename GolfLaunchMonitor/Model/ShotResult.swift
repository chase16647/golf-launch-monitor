//
//  ShotResult.swift
//  GolfLaunchMonitor
//

import Foundation
import simd

/// One measured shot. Codable so sessions persist.
struct ShotResult: Identifiable, Codable, Sendable, Equatable {
    var id = UUID()
    var date = Date()
    var club: Club

    // ── Measured ──────────────────────────────────────────────────────────
    var ballSpeedMPH: Double
    var launchAngleDegrees: Double
    var azimuthDegrees: Double

    // ── Modelled / derived ────────────────────────────────────────────────
    var totalSpinRPM: Double
    var spinAxisDegrees: Double
    var sideSpinRPM: Double
    var backSpinRPM: Double
    var spinConfidence: Double
    var spinIsModelled: Bool

    var carryYards: Double
    var totalYards: Double
    var sideYards: Double
    var curveYards: Double
    var apexFeet: Double
    var hangTimeSeconds: Double
    var descentAngleDegrees: Double

    var shape: ShotShape

    // ── Provenance ────────────────────────────────────────────────────────
    var trackedFrameCount: Int
    var calibrationSource: String
    var calibrationCrossCheck: Double
    var captureMode: CaptureMode
    var measuredFrameRate: Double
    var shutterDenominator: Int
    var iso: Double
    /// Mean motion-blur smear as a fraction of ball diameter.
    var meanSmearRatio: Double
    var atmosphere: Atmosphere

    var trajectory: [TrajectoryPoint]

    /// Derived club-head speed from smash factor. Explicitly an estimate —
    /// we never see the club.
    var estimatedClubSpeedMPH: Double { ballSpeedMPH / club.smashFactor }

    /// Overall trust in this shot, 0…1, combining calibration quality, how
    /// many frames we tracked, and blur.
    var quality: Double {
        let frames = (Double(trackedFrameCount) / 6.0).clamped(to: 0...1)
        let blur = (1.2 - meanSmearRatio / 2.0).clamped(to: 0...1)
        let cal = calibrationCrossCheck.clamped(to: 0...1)
        return (frames * 0.35 + blur * 0.25 + cal * 0.40).clamped(to: 0...1)
    }

    var qualityLabel: String {
        switch quality {
        case 0.8...: "Excellent"
        case 0.6..<0.8: "Good"
        case 0.4..<0.6: "Fair"
        default: "Low"
        }
    }
}

// MARK: - Session

struct PracticeSession: Identifiable, Codable, Sendable {
    var id = UUID()
    var date = Date()
    var name: String
    var shots: [ShotResult] = []
    var mode: SessionMode = .range

    enum SessionMode: String, Codable, Sendable { case range, course, gapping }

    var shotCount: Int { shots.count }

    func shots(for club: Club) -> [ShotResult] { shots.filter { $0.club == club } }

    /// Per-club summary used by the bag view and the course caddie.
    func average(for club: Club) -> ClubAverage? {
        let s = shots(for: club)
        guard !s.isEmpty else { return nil }
        func mean(_ kp: KeyPath<ShotResult, Double>) -> Double {
            s.map { $0[keyPath: kp] }.reduce(0, +) / Double(s.count)
        }
        let carries = s.map(\.carryYards).sorted()
        let sides = s.map(\.sideYards)
        let sideMean = sides.reduce(0, +) / Double(sides.count)
        let sideVar = sides.map { ($0 - sideMean) * ($0 - sideMean) }.reduce(0, +)
            / Double(max(sides.count - 1, 1))

        return ClubAverage(club: club,
                           count: s.count,
                           carryYards: mean(\.carryYards),
                           totalYards: mean(\.totalYards),
                           ballSpeedMPH: mean(\.ballSpeedMPH),
                           launchAngleDegrees: mean(\.launchAngleDegrees),
                           spinRPM: mean(\.totalSpinRPM),
                           apexFeet: mean(\.apexFeet),
                           // Median is the number to trust for gapping — one
                           // thinned 7-iron shouldn't move your yardage book.
                           medianCarryYards: carries[carries.count / 2],
                           carrySpreadYards: (carries.last ?? 0) - (carries.first ?? 0),
                           lateralStdDevYards: sqrt(sideVar),
                           dominantShape: Self.mode(of: s.map(\.shape)))
    }

    var clubsUsed: [Club] {
        Array(Set(shots.map(\.club))).sorted { $0.loft < $1.loft }
    }

    private static func mode(of shapes: [ShotShape]) -> ShotShape {
        var counts: [ShotShape: Int] = [:]
        for s in shapes { counts[s, default: 0] += 1 }
        return counts.max { $0.value < $1.value }?.key ?? .straight
    }
}

struct ClubAverage: Identifiable, Sendable {
    var id: String { club.rawValue }
    var club: Club
    var count: Int
    var carryYards: Double
    var totalYards: Double
    var ballSpeedMPH: Double
    var launchAngleDegrees: Double
    var spinRPM: Double
    var apexFeet: Double
    var medianCarryYards: Double
    var carrySpreadYards: Double
    /// Standard deviation of lateral landing position — your dispersion.
    var lateralStdDevYards: Double
    var dominantShape: ShotShape

    /// 68 % of shots land within this lateral band.
    var oneSigmaBandYards: Double { lateralStdDevYards }
    /// Conventional "this is my number" yardage: median carry, trimmed low.
    var playingYardage: Double { medianCarryYards }
}
