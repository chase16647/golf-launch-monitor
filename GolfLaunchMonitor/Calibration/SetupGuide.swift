//
//  SetupGuide.swift
//  GolfLaunchMonitor
//
//  Makes the rig repeatable, and makes "lean it against a headcover" a real
//  answer rather than a compromise.
//
//  ── The principle ───────────────────────────────────────────────────────────
//  A launch monitor does not need a PERFECT phone position. It needs a KNOWN
//  one. Every way a phone can be misplaced is a measurable degree of freedom,
//  and measured error is correctable error.
//
//  Costs measured against the flight model (driver, 150 mph — see
//  pwa/tools/dof-analysis.mjs, which shares these constants):
//
//      axis          misplaced by   if ignored          if measured
//      ------------  -------------  ------------------  ---------------
//      pitch (lean)  20°            0.9° launch          exact
//      roll (tilt)   10°            10° launch           ~0.3° (sensor noise)
//      yaw (square)  20°            6.4% speed (19 yd)   1.3% (3.8 yd)
//      distance      5%             5% speed (14 yd)     NOT correctable
//
//  Which gives the three rules the whole UI is built around:
//
//   1. LEAN FREELY. Pitch is nearly free and corrects exactly.
//   2. YAW MUST BE MEASURED. Gravity is blind to rotation about the vertical
//      axis, so an accelerometer physically cannot detect being off-square.
//      That is what `captureTargetLine()` is for.
//   3. DISTANCE IS SACRED. It goes 1:1 into ball speed and nothing downstream
//      can recover it.
//

import Foundation
import ARKit
import CoreMotion
import simd
import os

// MARK: - Reading

/// A complete description of where the phone is, right now.
struct SetupReading: Sendable, Equatable {
    /// Lens above(+)/below(-) horizontal, degrees.
    var pitchDegrees: Double = 0
    /// Rotation about the lens axis, degrees. Raw — see `rollDeviation`.
    var rollDegrees: Double = 0
    /// Compass/ARKit bearing the lens points, degrees.
    var headingDegrees: Double?
    /// Degrees off perpendicular to the target line. `nil` until captured.
    var yawFromSquareDegrees: Double?
    var yawUncertaintyDegrees: Double = 3
    var distanceMetres: Double?
    var distanceUncertaintyPercent: Double = 3
    /// Lens height minus ball height, metres.
    var heightDeltaMetres: Double?
    var isStable: Bool = false

    /// Deviation of roll from the nearest quarter turn.
    ///
    /// The phone is USED IN LANDSCAPE — the ball flies across the frame, so a
    /// roll of ±90° is the intended orientation, not an error. Measuring raw
    /// roll against a tolerance around zero tells every correctly-placed user
    /// to "straighten up". Portrait and inverted landscape are equally valid,
    /// so we compare against whichever quarter turn is nearest.
    var rollDeviationDegrees: Double {
        let nearest = (rollDegrees / 90).rounded() * 90
        return rollDegrees - nearest
    }

    /// True when the phone is nowhere near square, which immediately after
    /// capturing the target line means it is still in the user's hand — not
    /// that their rig is 90° wrong. Conflating those produces an alarming and
    /// useless error at the exact moment the user is doing the right thing.
    var isProbablyInHand: Bool {
        guard let yaw = yawFromSquareDegrees else { return false }
        return abs(yaw) > 45
    }
}

// MARK: - Evaluation

struct SetupAxis: Identifiable, Sendable {
    enum Status: Sendable { case ok, warn, blocked }
    var id: String
    var label: String
    var display: String
    var status: Status
    var message: String
    var speedErrorPercent: Double
    var launchErrorDegrees: Double
}

struct SetupEvaluation: Sendable {
    enum Overall: Sendable { case ready, adjust, blocked, inHand }
    var overall: Overall
    var headline: String
    var axes: [SetupAxis]
    var speedErrorPercent: Double
    var launchErrorDegrees: Double
    var carryErrorYards: Double
}

enum SetupTolerance {
    static let idealDistance: Double = 1.524          // 5 ft
    static let distanceRange: ClosedRange<Double> = 1.2...2.15
    static let heightTolerance: Double = 0.25
    static let maxRollDeviation: Double = 25
    static let maxPitch: Double = 20
    static let maxYaw: Double = 20

    /// Carry sensitivity from the flight model at driver conditions.
    /// Launch sensitivity is NOT constant — it is 4.16 yd/° at 8° launch and
    /// effectively zero above 18° — so this is an honest middle value rather
    /// than a claim of linearity.
    static let yardsPerSpeedPercent: Double = 3.01
    static let yardsPerLaunchDegree: Double = 2.28

    static let orientationNoiseDegrees: Double = 0.3
}

enum SetupEvaluator {

    static func evaluate(_ r: SetupReading) -> SetupEvaluation {
        var axes: [SetupAxis] = []

        // ── Distance ─────────────────────────────────────────────────────────
        if let d = r.distanceMetres {
            let feet = d * 3.280839895
            let inRange = SetupTolerance.distanceRange.contains(d)
            let err = r.distanceUncertaintyPercent
            axes.append(SetupAxis(
                id: "distance",
                label: "Distance to ball",
                display: String(format: "%.1f ft", feet),
                status: inRange ? (err <= 4 ? .ok : .warn) : .blocked,
                message: inRange
                    ? (err <= 4 ? "Good."
                       : String(format: "Scale only known to ±%.0f%% — hold still while it settles.", err))
                    : d < SetupTolerance.distanceRange.lowerBound
                        ? "Too close — the ball leaves frame too fast. Back up to about 5 ft."
                        : "Too far — the ball is too small to centroid. Move in to about 5 ft.",
                speedErrorPercent: err,
                launchErrorDegrees: 0))
        } else {
            axes.append(SetupAxis(id: "distance", label: "Distance to ball",
                                  display: "not measured", status: .blocked,
                                  message: "Measure distance first — it goes straight into ball speed.",
                                  speedErrorPercent: 0, launchErrorDegrees: 0))
        }

        // ── Yaw ──────────────────────────────────────────────────────────────
        if let yaw = r.yawFromSquareDegrees {
            let mag = abs(yaw)
            // Residual after correction: d/dyaw of (1/cos) times how well we know yaw.
            let residual = abs(tan(mag * .pi / 180)) * (r.yawUncertaintyDegrees * .pi / 180) * 100
            let over = mag > SetupTolerance.maxYaw
            axes.append(SetupAxis(
                id: "yaw",
                label: "Square to target",
                display: mag < 1 ? "square" : String(format: "%.0f° off", mag),
                status: over ? .blocked : (mag > 10 ? .warn : .ok),
                message: over
                    ? "More than \(Int(SetupTolerance.maxYaw))° off square — rotate the phone \(yaw > 0 ? "left" : "right")."
                    : mag > 10
                        ? String(format: "%.0f° off square, corrected in software. Squaring up tightens it further.", mag)
                        : "Square enough.",
                speedErrorPercent: residual,
                launchErrorDegrees: 0))
        } else {
            // Assuming square. The error is however wrong that assumption is —
            // and by construction we cannot know.
            let worst = (1 / cos(5 * .pi / 180) - 1) * 100
            axes.append(SetupAxis(
                id: "yaw", label: "Square to target", display: "assumed", status: .warn,
                message: "Target line not set. Speed could read low and nothing can detect it.",
                speedErrorPercent: worst, launchErrorDegrees: 0))
        }

        // ── Roll ─────────────────────────────────────────────────────────────
        let rollDev = abs(r.rollDeviationDegrees)
        axes.append(SetupAxis(
            id: "roll", label: "Tilt",
            display: String(format: "%.1f°", rollDev),
            status: rollDev > SetupTolerance.maxRollDeviation ? .blocked : (rollDev > 12 ? .warn : .ok),
            message: rollDev > SetupTolerance.maxRollDeviation
                ? "Past \(Int(SetupTolerance.maxRollDeviation))° the ball tracks diagonally out of frame."
                : rollDev > 12 ? "Corrected, but the ball may clip the frame edge."
                : rollDev > 3 ? "Measured and corrected — no accuracy cost."
                : "Level.",
            speedErrorPercent: 0,
            launchErrorDegrees: SetupTolerance.orientationNoiseDegrees))

        // ── Pitch ────────────────────────────────────────────────────────────
        let pitch = abs(r.pitchDegrees)
        let over = pitch > SetupTolerance.maxPitch
        axes.append(SetupAxis(
            id: "pitch", label: "Lean",
            display: String(format: "%.1f°", pitch),
            status: over ? .warn : .ok,
            message: over
                ? "Steep lean. Still corrected, but keep it under \(Int(SetupTolerance.maxPitch))°."
                : pitch > 5 ? "Leaning is fine — this is measured and corrected exactly."
                : "Upright.",
            speedErrorPercent: 0,
            launchErrorDegrees: over ? 2.0 : (pitch / SetupTolerance.maxPitch) * 0.35))

        // ── Height ───────────────────────────────────────────────────────────
        if let dh = r.heightDeltaMetres {
            let mag = abs(dh)
            axes.append(SetupAxis(
                id: "height", label: "Camera height",
                display: String(format: "%.0f in vs ball", dh * 39.3701),
                status: mag > 0.5 ? .blocked : (mag > SetupTolerance.heightTolerance ? .warn : .ok),
                message: mag > 0.5
                    ? "Too far off ball height — the ball climbs out of frame."
                    : mag > SetupTolerance.heightTolerance
                        ? "A little high or low. Ball height gives more usable frames."
                        : "At ball height.",
                speedErrorPercent: 0, launchErrorDegrees: 0))
        }

        // ── Stability ────────────────────────────────────────────────────────
        axes.append(SetupAxis(
            id: "stability", label: "Steady",
            display: r.isStable ? "holding" : "moving",
            status: r.isStable ? .ok : .blocked,
            message: r.isStable ? "Not moving."
                : "Phone is moving. Anything measured now is void once it settles elsewhere.",
            speedErrorPercent: 0, launchErrorDegrees: 0))

        // ── Roll up ──────────────────────────────────────────────────────────
        // Independent axes add in quadrature; summing them would overstate.
        let speedErr = sqrt(axes.reduce(0) { $0 + $1.speedErrorPercent * $1.speedErrorPercent })
        let launchErr = sqrt(axes.reduce(0) { $0 + $1.launchErrorDegrees * $1.launchErrorDegrees })
        let carryErr = speedErr * SetupTolerance.yardsPerSpeedPercent
                     + launchErr * SetupTolerance.yardsPerLaunchDegree

        let sorted = axes.sorted { rank($0.status) < rank($1.status) }

        if r.isProbablyInHand {
            return SetupEvaluation(
                overall: .inHand,
                headline: "Target line saved. Now set the phone down beside the ball.",
                axes: sorted, speedErrorPercent: speedErr,
                launchErrorDegrees: launchErr, carryErrorYards: carryErr)
        }

        let blocked = sorted.first { $0.status == .blocked }
        let warn = sorted.first { $0.status == .warn }
        return SetupEvaluation(
            overall: blocked != nil ? .blocked : (warn != nil ? .adjust : .ready),
            headline: blocked?.message ?? warn?.message
                ?? "Setup is good. Numbers will be as accurate as this rig gets.",
            axes: sorted,
            speedErrorPercent: speedErr,
            launchErrorDegrees: launchErr,
            carryErrorYards: carryErr)
    }

    private static func rank(_ s: SetupAxis.Status) -> Int {
        switch s { case .blocked: 0; case .warn: 1; case .ok: 2 }
    }
}

// MARK: - Saved profiles

struct SetupProfile: Identifiable, Codable, Sendable {
    var id = UUID()
    var name: String
    var savedAt = Date()
    var pitchDegrees: Double
    var rollDegrees: Double
    var yawFromSquareDegrees: Double?
    var distanceMetres: Double
    var heightDeltaMetres: Double?
}

struct ProfileDelta: Identifiable, Sendable {
    var id: String
    var label: String
    var instruction: String
    var isMatched: Bool
}

extension SetupProfile {
    /// Live "move 4 inches back, rotate 3° left" guidance.
    ///
    /// Repeatability is a separate problem from validity: two setups can both
    /// be inside tolerance and still produce different numbers, which makes
    /// week-to-week comparisons meaningless. Matching a saved profile is what
    /// makes sessions comparable.
    func deltas(to r: SetupReading) -> [ProfileDelta] {
        var out: [ProfileDelta] = []

        if let d = r.distanceMetres {
            let delta = d - distanceMetres
            let inches = delta * 39.3701
            out.append(ProfileDelta(
                id: "distance", label: "Distance",
                instruction: abs(delta) < 0.03 ? "matched"
                    : delta > 0 ? String(format: "move %.0f in closer", inches)
                                : String(format: "move %.0f in back", -inches),
                isMatched: abs(delta) < 0.03))
        }

        // Compare roll DEVIATIONS so a profile saved in one landscape
        // orientation still matches when the phone is flipped the other way up.
        let savedDev = rollDegrees - (rollDegrees / 90).rounded() * 90
        let rollDelta = r.rollDeviationDegrees - savedDev
        out.append(ProfileDelta(
            id: "roll", label: "Tilt",
            instruction: abs(rollDelta) < 1 ? "matched"
                : String(format: "rotate %.0f° %@", abs(rollDelta), rollDelta > 0 ? "left" : "right"),
            isMatched: abs(rollDelta) < 1))

        let pitchDelta = r.pitchDegrees - pitchDegrees
        out.append(ProfileDelta(
            id: "pitch", label: "Lean",
            instruction: abs(pitchDelta) < 1 ? "matched"
                : String(format: "tilt %.0f° %@", abs(pitchDelta), pitchDelta > 0 ? "forward" : "back"),
            isMatched: abs(pitchDelta) < 1))

        if let saved = yawFromSquareDegrees, let now = r.yawFromSquareDegrees {
            let d = now - saved
            out.append(ProfileDelta(
                id: "yaw", label: "Square",
                instruction: abs(d) < 2 ? "matched"
                    : String(format: "swing the phone %.0f° %@", abs(d), d > 0 ? "left" : "right"),
                isMatched: abs(d) < 2))
        }
        return out
    }
}

// MARK: - Live guide

/// Owns the sensors and produces a live `SetupReading`.
///
/// Yaw comes from ARKit rather than the magnetometer. ARKit's visual-inertial
/// tracking maintains a consistent world frame as you walk the phone from the
/// aiming position to its resting spot, so the relative rotation between those
/// two moments is good to a degree or two — far better than a compass, which
/// is easily pulled several degrees off by a golf bag full of steel shafts.
@MainActor
final class SetupGuide: ObservableObject {

    @Published private(set) var reading = SetupReading()
    @Published private(set) var evaluation: SetupEvaluation?
    @Published private(set) var isTargetLineSet = false
    @Published private(set) var profiles: [SetupProfile] = []
    @Published var activeProfile: SetupProfile?
    @Published private(set) var deltas: [ProfileDelta] = []

    private let motion = CMMotionManager()
    private var arSession: ARSession?
    private let log = Logger(subsystem: "GolfLaunchMonitor", category: "SetupGuide")

    /// Lens direction, in ARKit's world frame, while aiming down the target line.
    private var targetLineDirection: SIMD3<Float>?

    /// Rolling window of ball-radius measurements. Averaging matters more than
    /// it looks: a single frame at 5 ft gives distance to ±3.8% (≈11 yd of
    /// carry), but 60 averaged frames give ±0.6% (≈2 yd). This is the cheapest
    /// accuracy in the whole app, and it is why arming waits for the ball to
    /// settle rather than locking on to the first frame that looks like one.
    private var radiusSamples: [Double] = []

    private let profilesURL: URL = {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return dir.appendingPathComponent("setup-profiles.json")
    }()

    init() { loadProfiles() }

    // MARK: Sensors

    func start() {
        guard motion.isDeviceMotionAvailable else { return }
        motion.deviceMotionUpdateInterval = 1.0 / 30.0
        motion.startDeviceMotionUpdates(using: .xArbitraryZVertical, to: .main) { [weak self] m, _ in
            guard let self, let m else { return }
            self.ingest(m)
        }
        startARIfNeeded()
    }

    func stop() {
        motion.stopDeviceMotionUpdates()
        arSession?.pause()
        arSession = nil
    }

    private func startARIfNeeded() {
        guard ARWorldTrackingConfiguration.isSupported, arSession == nil else { return }
        let session = ARSession()
        let config = ARWorldTrackingConfiguration()
        config.planeDetection = [.horizontal]   // gives us ground height for free
        session.run(config, options: [])
        arSession = session
    }

    private func ingest(_ m: CMDeviceMotion) {
        let g = m.gravity
        // Lens elevation above the horizon, and rotation about the lens axis.
        let pitch = asin(max(-1, min(1, g.z))) * 180 / .pi
        let roll = atan2(g.x, -g.y) * 180 / .pi

        var r = reading
        r.pitchDegrees = pitch
        r.rollDegrees = roll
        r.isStable = m.userAcceleration.magnitude < 0.02

        if let dir = currentLensDirection() {
            r.headingDegrees = Double(atan2(dir.x, -dir.z)) * 180 / .pi
            if let target = targetLineDirection {
                r.yawFromSquareDegrees = Self.yawFromSquare(lens: dir, targetLine: target)
                // ARKit's relative rotation is good to about a degree while
                // tracking is normal; degrade the figure when it is not.
                r.yawUncertaintyDegrees = arTrackingIsGood ? 2 : 8
            }
        }

        reading = r
        evaluation = SetupEvaluator.evaluate(r)
        if let p = activeProfile { deltas = p.deltas(to: r) }
    }

    private var arTrackingIsGood: Bool {
        guard let frame = arSession?.currentFrame else { return false }
        if case .normal = frame.camera.trackingState { return true }
        return false
    }

    private func currentLensDirection() -> SIMD3<Float>? {
        guard let frame = arSession?.currentFrame else { return nil }
        // The camera looks down its own -z axis.
        let t = frame.camera.transform
        return simd_normalize(SIMD3(-t.columns.2.x, -t.columns.2.y, -t.columns.2.z))
    }

    // MARK: Target line

    /// Call while the user points the BACK of the phone down the target line.
    func captureTargetLine() -> Bool {
        guard let dir = currentLensDirection() else {
            log.warning("No ARKit frame — cannot capture target line")
            return false
        }
        targetLineDirection = dir
        isTargetLineSet = true
        log.info("Target line captured")
        return true
    }

    func clearTargetLine() {
        targetLineDirection = nil
        isTargetLineSet = false
        var r = reading
        r.yawFromSquareDegrees = nil
        reading = r
    }

    /// Degrees off perpendicular, projected onto the horizontal plane.
    ///
    /// The phone sits to the SIDE of the ball, so a correct setup has the lens
    /// 90° from the target line — either +90 or -90 depending on which side the
    /// user stands. We take whichever is nearer so it works from both, and the
    /// sign tells the user which way to rotate.
    static func yawFromSquare(lens: SIMD3<Float>, targetLine: SIMD3<Float>) -> Double {
        // Flatten both onto the ground plane; elevation is irrelevant to squareness.
        let a = simd_normalize(SIMD2(lens.x, lens.z))
        let b = simd_normalize(SIMD2(targetLine.x, targetLine.z))
        guard a.x.isFinite, b.x.isFinite else { return 0 }

        let angle = Double(atan2(a.y, a.x) - atan2(b.y, b.x)) * 180 / .pi
        let diff = normalize180(angle)
        let plus = normalize180(diff - 90)
        let minus = normalize180(diff + 90)
        return abs(plus) <= abs(minus) ? plus : minus
    }

    static func normalize180(_ deg: Double) -> Double {
        var d = deg.truncatingRemainder(dividingBy: 360)
        if d > 180 { d -= 360 }
        if d <= -180 { d += 360 }
        return d
    }

    // MARK: Distance

    /// Feed a ball-radius measurement from the tracker.
    ///
    /// A golf ball is 42.67 mm by rule, so its size on screen IS a distance
    /// measurement — which is how a non-LiDAR phone still gets scale, and how
    /// the LiDAR reading gets cross-checked.
    func addBallRadiusSample(_ radiusPixels: Double, focalLengthPixels: Double) {
        guard radiusPixels > 2 else { return }
        radiusSamples.append(radiusPixels)
        if radiusSamples.count > 120 { radiusSamples.removeFirst() }
        guard radiusSamples.count >= 5 else { return }

        let mean = radiusSamples.reduce(0, +) / Double(radiusSamples.count)
        var r = reading
        r.distanceMetres = focalLengthPixels * Ball.radiusMetres / mean
        r.distanceUncertaintyPercent = Self.distanceUncertainty(
            ballRadiusPixels: mean, sampleCount: radiusSamples.count)
        reading = r
        evaluation = SetupEvaluator.evaluate(r)
    }

    func resetDistanceSamples() { radiusSamples.removeAll() }

    static func distanceUncertainty(ballRadiusPixels: Double,
                                    sampleCount: Int,
                                    edgeNoisePixels: Double = 1.5) -> Double {
        guard ballRadiusPixels > 1 else { return 100 }
        let single = (edgeNoisePixels / (ballRadiusPixels * 2)) * 100
        let averaged = single / sqrt(Double(max(sampleCount, 1)))
        // Floor it: averaging kills random noise, not systematic bias such as
        // bright light bleeding the ball's edge.
        return min(max(averaged, 0.6), 100)
    }

    // MARK: Profiles

    func saveProfile(named name: String) {
        guard let d = reading.distanceMetres else { return }
        var p = SetupProfile(name: name,
                             pitchDegrees: reading.pitchDegrees,
                             rollDegrees: reading.rollDegrees,
                             yawFromSquareDegrees: reading.yawFromSquareDegrees,
                             distanceMetres: d,
                             heightDeltaMetres: reading.heightDeltaMetres)
        profiles.removeAll { $0.name == name }
        profiles.append(p)
        p.name = name
        persistProfiles()
    }

    func deleteProfile(_ profile: SetupProfile) {
        profiles.removeAll { $0.id == profile.id }
        if activeProfile?.id == profile.id { activeProfile = nil; deltas = [] }
        persistProfiles()
    }

    private func persistProfiles() {
        guard let data = try? JSONEncoder().encode(profiles) else { return }
        try? data.write(to: profilesURL, options: .atomic)
    }

    private func loadProfiles() {
        guard let data = try? Data(contentsOf: profilesURL),
              let decoded = try? JSONDecoder().decode([SetupProfile].self, from: data)
        else { return }
        profiles = decoded
    }
}

private extension CMAcceleration {
    var magnitude: Double { sqrt(x * x + y * y + z * z) }
}
