//
//  RangeMode.swift
//  GolfLaunchMonitor
//
//  Virtual driving range: aim at targets, get scored on proximity, and build
//  a dispersion picture over the session.
//

import Foundation
import SwiftUI

struct RangeTarget: Identifiable, Hashable, Sendable {
    let id = UUID()
    var name: String
    /// Carry distance to the flag, yards.
    var distanceYards: Double
    /// Lateral offset from straight ahead, yards. Negative = left.
    var offsetYards: Double = 0
    /// Radius of the green, yards. Inside this counts as a hit.
    var radiusYards: Double = 12

    static let standard: [RangeTarget] = [
        .init(name: "Near", distanceYards: 75, offsetYards: -20, radiusYards: 10),
        .init(name: "Short", distanceYards: 110, offsetYards: 15, radiusYards: 11),
        .init(name: "Mid", distanceYards: 150, offsetYards: -10, radiusYards: 12),
        .init(name: "Long", distanceYards: 190, offsetYards: 18, radiusYards: 14),
        .init(name: "Deep", distanceYards: 240, offsetYards: 0, radiusYards: 18),
    ]
}

/// How a single shot scored against a target.
struct TargetResult: Identifiable, Sendable {
    let id = UUID()
    var shot: ShotResult
    var target: RangeTarget
    /// Straight-line miss distance from the pin, yards.
    var proximityYards: Double
    var isHit: Bool
    /// 0–100.
    var points: Int

    var missDescription: String {
        let long = shot.carryYards - target.distanceYards
        let side = shot.sideYards - target.offsetYards
        var parts: [String] = []
        if abs(long) >= 4 { parts.append("\(Int(abs(long))) yd \(long > 0 ? "long" : "short")") }
        if abs(side) >= 4 { parts.append("\(Int(abs(side))) yd \(side > 0 ? "right" : "left")") }
        return parts.isEmpty ? "Stiff" : parts.joined(separator: ", ")
    }
}

@MainActor
@Observable
final class RangeMode {

    var targets: [RangeTarget] = RangeTarget.standard
    var selectedTarget: RangeTarget?
    private(set) var results: [TargetResult] = []

    /// Challenge mode cycles targets automatically so you can't groove one club.
    var isChallengeMode = false
    private var challengeIndex = 0

    var totalPoints: Int { results.reduce(0) { $0 + $1.points } }
    var hitCount: Int { results.filter(\.isHit).count }
    var hitRate: Double {
        results.isEmpty ? 0 : Double(hitCount) / Double(results.count)
    }
    var averageProximity: Double {
        results.isEmpty ? 0 : results.map(\.proximityYards).reduce(0, +) / Double(results.count)
    }

    func begin() {
        results.removeAll()
        challengeIndex = 0
        selectedTarget = targets.first
    }

    /// Score a shot against the active target.
    @discardableResult
    func score(_ shot: ShotResult) -> TargetResult? {
        guard let target = selectedTarget else { return nil }

        let dLong = shot.carryYards - target.distanceYards
        let dSide = shot.sideYards - target.offsetYards
        let proximity = sqrt(dLong * dLong + dSide * dSide)
        let hit = proximity <= target.radiusYards

        // Points decay smoothly with proximity so a near miss still rewards —
        // a cliff-edge scoring function makes the range feel arbitrary.
        let normalized = proximity / max(target.radiusYards * 4, 1)
        let points = Int((100 * max(0, 1 - normalized)).rounded())

        let result = TargetResult(shot: shot,
                                  target: target,
                                  proximityYards: proximity,
                                  isHit: hit,
                                  points: points)
        results.append(result)

        if isChallengeMode {
            challengeIndex = (challengeIndex + 1) % targets.count
            selectedTarget = targets[challengeIndex]
        }
        return result
    }

    /// Suggested club for the active target, from the player's own numbers.
    func suggestedClub(using store: SessionStore) -> Club? {
        guard let target = selectedTarget else { return nil }
        return Club.allCases
            .compactMap { club -> (Club, Double)? in
                guard let y = store.playingYardage(for: club) else { return nil }
                return (club, abs(y - target.distanceYards))
            }
            .min { $0.1 < $1.1 }?.0
    }
}
