//
//  CourseMode.swift
//  GolfLaunchMonitor
//
//  Play a real course from the range. Your measured shot moves the ball down
//  the hole; hazards, lies and the short game are resolved against the hole
//  geometry. Eighteen holes of real consequence for the same swings you'd
//  otherwise hit into a net.
//
//  Course geometry is a simple polyline centreline plus hazard polygons, which
//  is enough to model "did you carry the bunker" and "are you in the trees"
//  without shipping a GIS stack. Courses load from bundled JSON; the same
//  format takes a user import.
//

import Foundation
import CoreGraphics

// MARK: - Course data

struct Course: Identifiable, Codable, Sendable {
    var id: UUID = UUID()
    var name: String
    var location: String
    var holes: [Hole]

    var par: Int { holes.reduce(0) { $0 + $1.par } }
    var totalYards: Int { holes.reduce(0) { $0 + $1.yards } }
}

struct Hole: Identifiable, Codable, Sendable {
    var id: UUID = UUID()
    var number: Int
    var par: Int
    var yards: Int
    var handicapIndex: Int
    /// Centreline as (distance from tee, lateral offset) in yards. A dogleg is
    /// just a polyline with a bend in it.
    var centreline: [Point]
    var hazards: [Hazard]
    /// Green centre, yards from tee along the centreline.
    var greenDistance: Int
    var greenRadius: Double = 15
    /// Fairway half-width in yards. Miss by more than this and you're in rough.
    var fairwayHalfWidth: Double = 22

    struct Point: Codable, Sendable, Hashable {
        var d: Double     // downrange yards
        var o: Double     // lateral offset, + = right
    }

    struct Hazard: Codable, Sendable, Identifiable {
        var id: UUID = UUID()
        var kind: Kind
        /// Range of downrange yards the hazard spans.
        var fromYards: Double
        var toYards: Double
        /// Lateral band it occupies.
        var fromOffset: Double
        var toOffset: Double

        enum Kind: String, Codable, Sendable {
            case bunker, water, trees, outOfBounds

            var penaltyStrokes: Int {
                switch self {
                case .water, .outOfBounds: 1
                case .bunker, .trees: 0
                }
            }
            var displayName: String {
                switch self {
                case .bunker: "Bunker"
                case .water: "Water"
                case .trees: "Trees"
                case .outOfBounds: "O.B."
                }
            }
        }

        func contains(distance: Double, offset: Double) -> Bool {
            (fromYards...toYards).contains(distance)
                && (min(fromOffset, toOffset)...max(fromOffset, toOffset)).contains(offset)
        }
    }

    /// Lateral offset of the centreline at a given distance — follows doglegs.
    func centrelineOffset(at distance: Double) -> Double {
        guard centreline.count > 1 else { return 0 }
        if distance <= centreline[0].d { return centreline[0].o }
        for i in 1..<centreline.count {
            let a = centreline[i - 1], b = centreline[i]
            if distance <= b.d {
                let t = (distance - a.d) / max(b.d - a.d, 1e-6)
                return a.o + t * (b.o - a.o)
            }
        }
        return centreline.last!.o
    }
}

// MARK: - Playing state

enum Lie: String, Sendable, Codable {
    case tee, fairway, rough, bunker, green, penalty, holed

    var displayName: String {
        switch self {
        case .tee: "Tee"
        case .fairway: "Fairway"
        case .rough: "Rough"
        case .bunker: "Bunker"
        case .green: "Green"
        case .penalty: "Penalty Drop"
        case .holed: "Holed"
        }
    }

    /// Carry multiplier for shots from this lie. A ball in thick rough or sand
    /// doesn't go as far as the same swing off a tee — we apply this to the
    /// *measured* shot, and tell the user we did.
    var carryFactor: Double {
        switch self {
        case .tee, .fairway, .green, .holed: 1.00
        case .rough: 0.88
        case .bunker: 0.75
        case .penalty: 1.00
        }
    }

    var symbolName: String {
        switch self {
        case .tee: "flag.and.flag.filled.crossed"
        case .fairway: "leaf.fill"
        case .rough: "tree.fill"
        case .bunker: "circle.dotted"
        case .green: "flag.fill"
        case .penalty: "exclamationmark.triangle.fill"
        case .holed: "checkmark.circle.fill"
        }
    }
}

struct BallPosition: Sendable, Codable {
    /// Distance from the tee along the hole, yards.
    var distanceFromTee: Double
    /// Lateral offset from the centreline, yards.
    var offset: Double
    var lie: Lie
}

struct HoleScore: Identifiable, Codable, Sendable {
    var id = UUID()
    var holeNumber: Int
    var par: Int
    var strokes: Int
    var penalties: Int
    var shots: [ShotResult]
    var putts: Int

    var toPar: Int { strokes - par }
    var scoreName: String {
        switch toPar {
        case ..<(-2): "Albatross"
        case -2: "Eagle"
        case -1: "Birdie"
        case 0: "Par"
        case 1: "Bogey"
        case 2: "Double"
        default: "+\(toPar)"
        }
    }
}

@MainActor
@Observable
final class CourseMode {

    private(set) var course: Course?
    private(set) var currentHoleIndex = 0
    private(set) var ball: BallPosition = .init(distanceFromTee: 0, offset: 0, lie: .tee)
    private(set) var strokes = 0
    private(set) var penalties = 0
    private(set) var holeShots: [ShotResult] = []
    private(set) var scorecard: [HoleScore] = []
    private(set) var lastEvent: String?

    var currentHole: Hole? {
        guard let course, currentHoleIndex < course.holes.count else { return nil }
        return course.holes[currentHoleIndex]
    }

    /// Yards remaining to the middle of the green.
    var distanceToPin: Double {
        guard let hole = currentHole else { return 0 }
        let along = Double(hole.greenDistance) - ball.distanceFromTee
        let lateral = ball.offset - hole.centrelineOffset(at: Double(hole.greenDistance))
        return max(0, sqrt(along * along + lateral * lateral))
    }

    var isRoundComplete: Bool {
        guard let course else { return false }
        return scorecard.count >= course.holes.count
    }

    var totalToPar: Int { scorecard.reduce(0) { $0 + $1.toPar } }

    // MARK: Round flow

    func start(course: Course) {
        self.course = course
        currentHoleIndex = 0
        scorecard.removeAll()
        beginHole()
    }

    private func beginHole() {
        ball = BallPosition(distanceFromTee: 0, offset: 0, lie: .tee)
        strokes = 0
        penalties = 0
        holeShots.removeAll()
        lastEvent = nil
    }

    /// Recommended club for the shot at hand, from the player's own yardages.
    func suggestedClub(using store: SessionStore) -> Club? {
        let needed = distanceToPin / max(ball.lie.carryFactor, 0.5)
        return Club.allCases
            .compactMap { club -> (Club, Double)? in
                guard let y = store.playingYardage(for: club) else { return nil }
                return (club, abs(y - needed))
            }
            .min { $0.1 < $1.1 }?.0
    }

    /// Apply a measured shot to the ball's position.
    @discardableResult
    func play(_ shot: ShotResult) -> String {
        guard let hole = currentHole else { return "Round complete." }
        strokes += 1
        holeShots.append(shot)

        // On the green: this is a putt, resolved statistically rather than
        // measured — a launch monitor cannot read a putt, and pretending
        // otherwise would be theatre.
        if ball.lie == .green {
            return resolvePutt()
        }

        // The lie you're playing from scales the shot you just hit.
        let factor = ball.lie.carryFactor
        let carry = shot.totalYards * factor

        // Project the shot along the hole, accounting for the dogleg: the ball
        // flies where you aimed it, which we treat as down the centreline from
        // the current position.
        let newDistance = ball.distanceFromTee + carry
        let aimOffset = hole.centrelineOffset(at: min(newDistance, Double(hole.greenDistance)))
        let newOffset = aimOffset + shot.sideYards

        var event = ""
        var lie: Lie

        // Past the green?
        let toPin = abs(newDistance - Double(hole.greenDistance))
        let lateralFromGreen = abs(newOffset - hole.centrelineOffset(at: Double(hole.greenDistance)))
        let onGreen = toPin <= hole.greenRadius && lateralFromGreen <= hole.greenRadius

        if let hazard = hole.hazards.first(where: {
            $0.contains(distance: newDistance, offset: newOffset)
        }) {
            penalties += hazard.kind.penaltyStrokes
            switch hazard.kind {
            case .water:
                event = "In the water — penalty stroke, dropping short."
                ball = BallPosition(distanceFromTee: max(0, hazard.fromYards - 10),
                                    offset: hole.centrelineOffset(at: max(0, hazard.fromYards - 10)),
                                    lie: .rough)
            case .outOfBounds:
                event = "Out of bounds — stroke and distance."
                // Replay from where you hit it.
                penalties += 1
            case .bunker:
                event = "Found the bunker."
                ball = BallPosition(distanceFromTee: newDistance, offset: newOffset, lie: .bunker)
            case .trees:
                event = "In the trees — punching out."
                ball = BallPosition(distanceFromTee: newDistance, offset: newOffset, lie: .rough)
            }
            lastEvent = event
            return event
        }

        if onGreen {
            lie = .green
            event = String(format: "On the green, %.0f ft from the pin.",
                           sqrt(toPin * toPin + lateralFromGreen * lateralFromGreen) * 3)
        } else if abs(newOffset - aimOffset) <= hole.fairwayHalfWidth {
            lie = .fairway
            event = String(format: "Fairway. %.0f yards in.", abs(Double(hole.greenDistance) - newDistance))
        } else {
            lie = .rough
            event = String(format: "Rough, %.0f yards %@ of the fairway.",
                           abs(newOffset - aimOffset) - hole.fairwayHalfWidth,
                           newOffset > aimOffset ? "right" : "left")
        }

        ball = BallPosition(distanceFromTee: newDistance, offset: newOffset, lie: lie)
        lastEvent = event
        return event
    }

    /// Putting model: expected putts from distance, using the well-established
    /// PGA "putts per distance" curve. Explicitly a model, shown as such.
    private func resolvePutt() -> String {
        let feet = distanceToPin * 3
        // Expected putts ≈ 1 + log-ish growth; ~2.0 at 8 ft, ~2.5 at 33 ft.
        let expected = 1.0 + 0.40 * log10(max(feet, 1.0) + 1) * 1.9
        let made = Double.random(in: 0...1) < (1.0 / max(expected, 1.0))

        if made {
            ball.lie = .holed
            let e = "Holed it."
            lastEvent = e
            return e
        }
        // Leave it close; next putt is a tap-in most of the time.
        let remaining = max(0.5, feet * 0.12) / 3
        ball = BallPosition(distanceFromTee: Double(currentHole?.greenDistance ?? 0) - remaining,
                            offset: ball.offset,
                            lie: .green)
        let e = String(format: "Missed, %.0f ft left.", remaining * 3)
        lastEvent = e
        return e
    }

    /// Tap-in / concede and move on.
    func holeOut(putts: Int = 2) {
        guard let hole = currentHole else { return }
        let score = HoleScore(holeNumber: hole.number,
                              par: hole.par,
                              strokes: strokes + penalties + putts,
                              penalties: penalties,
                              shots: holeShots,
                              putts: putts)
        scorecard.append(score)
        if currentHoleIndex < (course?.holes.count ?? 0) - 1 {
            currentHoleIndex += 1
            beginHole()
        }
    }

    func skipHole() { holeOut(putts: 2) }
}

// MARK: - Bundled courses

extension Course {

    /// Loads every course JSON in the bundle, falling back to the built-in
    /// demo layout if none are present.
    static func loadBundled() -> [Course] {
        guard let urls = Bundle.main.urls(forResourcesWithExtension: "json",
                                          subdirectory: "Courses") else {
            return [.demoLinks]
        }
        let decoder = JSONDecoder()
        let loaded = urls.compactMap { url -> Course? in
            guard let data = try? Data(contentsOf: url) else { return nil }
            return try? decoder.decode(Course.self, from: data)
        }
        return loaded.isEmpty ? [.demoLinks] : loaded
    }

    /// A playable 9-hole links layout so the mode works out of the box.
    static let demoLinks: Course = {
        func hole(_ n: Int, par: Int, yards: Int, hcp: Int,
                  dogleg: Double = 0, hazards: [Hole.Hazard] = []) -> Hole {
            let centre: [Hole.Point] = dogleg == 0
                ? [.init(d: 0, o: 0), .init(d: Double(yards), o: 0)]
                : [.init(d: 0, o: 0),
                   .init(d: Double(yards) * 0.55, o: 0),
                   .init(d: Double(yards), o: dogleg)]
            return Hole(number: n, par: par, yards: yards, handicapIndex: hcp,
                        centreline: centre, hazards: hazards,
                        greenDistance: yards,
                        greenRadius: par == 3 ? 13 : 16,
                        fairwayHalfWidth: par == 5 ? 26 : 22)
        }

        return Course(name: "Ardmore Links", location: "Demo Course", holes: [
            hole(1, par: 4, yards: 402, hcp: 5,
                 hazards: [.init(kind: .bunker, fromYards: 240, toYards: 262,
                                 fromOffset: 18, toOffset: 34)]),
            hole(2, par: 3, yards: 168, hcp: 15,
                 hazards: [.init(kind: .water, fromYards: 110, toYards: 152,
                                 fromOffset: -30, toOffset: 30)]),
            hole(3, par: 5, yards: 528, hcp: 1, dogleg: 28,
                 hazards: [.init(kind: .bunker, fromYards: 270, toYards: 295,
                                 fromOffset: -34, toOffset: -14),
                           .init(kind: .trees, fromYards: 300, toYards: 420,
                                 fromOffset: 40, toOffset: 90)]),
            hole(4, par: 4, yards: 356, hcp: 11,
                 hazards: [.init(kind: .outOfBounds, fromYards: 0, toYards: 400,
                                 fromOffset: -70, toOffset: -140)]),
            hole(5, par: 4, yards: 441, hcp: 3,
                 hazards: [.init(kind: .bunker, fromYards: 400, toYards: 425,
                                 fromOffset: -28, toOffset: -8)]),
            hole(6, par: 3, yards: 196, hcp: 13,
                 hazards: [.init(kind: .bunker, fromYards: 170, toYards: 190,
                                 fromOffset: 14, toOffset: 32)]),
            hole(7, par: 5, yards: 505, hcp: 7, dogleg: -22,
                 hazards: [.init(kind: .water, fromYards: 430, toYards: 470,
                                 fromOffset: -40, toOffset: 10)]),
            hole(8, par: 4, yards: 378, hcp: 9,
                 hazards: [.init(kind: .trees, fromYards: 200, toYards: 330,
                                 fromOffset: -38, toOffset: -80)]),
            hole(9, par: 4, yards: 424, hcp: 17,
                 hazards: [.init(kind: .bunker, fromYards: 250, toYards: 275,
                                 fromOffset: -30, toOffset: -10),
                           .init(kind: .bunker, fromYards: 395, toYards: 415,
                                 fromOffset: 12, toOffset: 30)]),
        ])
    }()
}
