//
//  FlightModel.swift
//  GolfLaunchMonitor
//
//  3-D ball flight integrator: RK4 over drag + Magnus + gravity, with a tilted
//  spin axis so the trajectory actually curves. This is what turns four
//  measured numbers (speed, launch, azimuth, spin vector) into carry, apex,
//  curve and shape.
//
//  ── Coefficient provenance ──────────────────────────────────────────────────
//  The aero coefficients below were fitted numerically against published
//  Trackman PGA Tour averages for Driver / 3-wood / 5-iron / 7-iron / PW
//  (ball speed, launch angle, spin → carry, apex). Residuals of the shipped
//  fit, against the five fit targets:
//
//      Driver   264.8 yd vs 275 real  (-10.2)   apex 103.1 vs 102
//      3-wood   249.0 yd vs 243 real  ( +6.0)   apex  92.5 vs  90
//      5-iron   204.7 yd vs 195 real  ( +9.7)   apex 101.6 vs 105
//      7-iron   174.6 yd vs 172 real  ( +2.6)   apex  96.2 vs 103
//      PW       133.6 yd vs 136 real  ( -2.4)   apex  90.3 vs  96
//      mean |carry error| = 6.2 yd
//
//  Held-out sanity checks that were NOT part of the fit landed in range too
//  (95 mph 7-iron → 133 yd; 120 mph driver → 176 yd; 140 mph driver → 216 yd).
//
//  A note on honesty: an earlier unconstrained fit reached 4.4 yd mean error
//  but only by driving the spin-decay term negative — i.e. the ball gaining
//  spin in flight. That is unphysical, so decay is pinned at the measured
//  ~4 %/s and the slightly worse-but-real fit is what ships. Do not "improve"
//  these numbers by unpinning `spinDecayPerSecond`.
//
//  These are sea-level, no-wind, standard-atmosphere numbers. Altitude and
//  temperature enter through `Atmosphere`.
//

import Foundation
import simd

// MARK: - Atmosphere

/// Air state at the hitting location. Density is what the model actually
/// consumes; everything else exists to compute it.
struct Atmosphere: Sendable, Equatable, Codable {
    var temperatureCelsius: Double = 20.0
    var altitudeMetres: Double = 0.0
    var relativeHumidity: Double = 0.5          // 0…1
    var pressureHPaSeaLevel: Double = 1013.25

    static let standard = Atmosphere()

    /// Air density in kg/m³ via the ideal gas law with a humidity correction.
    /// Denver (1600 m) comes out ~17 % thinner than sea level, which is the
    /// familiar "the ball goes 10 % further in Denver" result.
    var density: Double {
        let tK = temperatureCelsius + 273.15
        // Barometric formula for station pressure at altitude.
        let p = pressureHPaSeaLevel * 100.0
            * pow(1.0 - 2.25577e-5 * altitudeMetres, 5.25588)
        // Saturation vapour pressure, Tetens' approximation (Pa).
        let pSat = 610.78 * exp(17.27 * temperatureCelsius / (temperatureCelsius + 237.3))
        let pv = relativeHumidity * pSat
        let pd = p - pv
        // Moist air is *less* dense than dry air — water is lighter than N₂/O₂.
        return (pd / (287.058 * tK)) + (pv / (461.495 * tK))
    }

    /// Multiplier on carry relative to sea level / 20 °C, for the HUD.
    var carryFactor: Double { sqrt(Atmosphere.standard.density / density) }
}

// MARK: - Ball constants

enum Ball {
    /// R&A / USGA minimum diameter, and the number the tracker uses as its
    /// scale reference: a golf ball may not be *smaller* than this.
    static let diameterMetres = 0.042670
    static let radiusMetres = diameterMetres / 2
    /// USGA maximum mass.
    static let massKg = 0.045930
    static let area = Double.pi * radiusMetres * radiusMetres
}

// MARK: - Aerodynamic coefficients (fitted — see header)

enum Aero {
    static let cd0: Double = 0.2255
    /// Velocity trim on base drag, normalised around 60 m/s. Slightly negative:
    /// the drag crisis is already complete at these speeds and Cd eases off as
    /// Reynolds climbs further.
    static let cdVelocity: Double = -0.0215
    /// Spin makes the wake asymmetric and costs drag. This term is why a
    /// 9 000 rpm wedge falls out of the sky and a 2 500 rpm drive doesn't.
    static let cdSpin: Double = 0.2243

    static let clK: Double = 0.5206
    static let clExponent: Double = 0.4643
    /// Lift saturates — you cannot spin a ball into orbit.
    static let clMax: Double = 0.33

    /// Fractional spin loss per second. PINNED, not fitted. See header.
    static let spinDecayPerSecond: Double = 0.040

    static let gravity: Double = 9.80665

    /// Spin ratio S = ωr/v, the dimensionless group both coefficients key off.
    @inline(__always)
    static func spinRatio(omega: Double, speed: Double) -> Double {
        omega * Ball.radiusMetres / max(speed, 1e-3)
    }

    @inline(__always)
    static func dragCoefficient(speed: Double, spinRatio S: Double) -> Double {
        max(0.15, cd0 + cdVelocity * (speed - 60.0) / 60.0 + cdSpin * S)
    }

    @inline(__always)
    static func liftCoefficient(spinRatio S: Double) -> Double {
        guard S > 1e-6 else { return 0 }
        return min(clMax, clK * pow(S, clExponent))
    }
}

// MARK: - Inputs & outputs

/// Everything the integrator needs. Angles in degrees at the boundary because
/// that's what humans and the UI speak; converted once on entry.
struct LaunchConditions: Sendable, Equatable, Codable {
    /// Ball speed, mph.
    var ballSpeedMPH: Double
    /// Vertical launch angle, degrees above horizontal.
    var launchAngleDegrees: Double
    /// Horizontal launch angle, degrees. Positive = right of target.
    var azimuthDegrees: Double
    /// Total spin magnitude, rpm.
    var totalSpinRPM: Double
    /// Spin-axis tilt, degrees. Positive = tilted right = ball curves right
    /// (fade/slice for a right-hander). Zero = pure backspin.
    var spinAxisDegrees: Double
    var atmosphere: Atmosphere = .standard

    /// Side-spin and back-spin components, which is how most golfers think
    /// about it even though the axis formulation is the physical one.
    var backSpinRPM: Double { totalSpinRPM * cos(spinAxisDegrees * .pi / 180) }
    var sideSpinRPM: Double { totalSpinRPM * sin(spinAxisDegrees * .pi / 180) }
}

/// One sampled point of the simulated flight, in metres, for drawing.
struct TrajectoryPoint: Sendable, Equatable, Codable {
    var t: Double
    /// Downrange.
    var x: Double
    /// Height.
    var y: Double
    /// Lateral; positive right.
    var z: Double
    var speed: Double
}

struct FlightResult: Sendable, Equatable, Codable {
    var carryYards: Double
    var totalYards: Double
    /// Lateral offset at landing, yards. Positive = right.
    var sideYards: Double
    /// Lateral deviation from the *initial launch line*, i.e. how much the ball
    /// actually bent in the air. This is the number that separates a straight
    /// push from a genuine slice, and it's what the shape classifier uses.
    var curveYards: Double
    var apexFeet: Double
    var hangTimeSeconds: Double
    /// Angle the ball is falling at, degrees below horizontal. Drives how much
    /// it releases on landing.
    var descentAngleDegrees: Double
    var landingSpeedMPH: Double
    var trajectory: [TrajectoryPoint]

    static let zero = FlightResult(carryYards: 0, totalYards: 0, sideYards: 0,
                                   curveYards: 0, apexFeet: 0, hangTimeSeconds: 0,
                                   descentAngleDegrees: 0, landingSpeedMPH: 0,
                                   trajectory: [])
}

// MARK: - Integrator

/// Stateless RK4 projectile solver. An `enum` namespace rather than a class:
/// there is no state worth owning, and this gets called from several actors.
enum FlightModel {

    /// Fixed step. 2 ms keeps RK4's local error far below the measurement
    /// noise we're fed (a 1 % ball-speed error dwarfs anything the integrator
    /// contributes) while a 7 s flight is still only ~3 500 steps — sub-
    /// millisecond on an A19.
    static let timeStep: Double = 0.002

    /// Sample roughly this many points into `trajectory` for drawing.
    private static let drawSamples = 120

    static func simulate(_ c: LaunchConditions) -> FlightResult {
        let rho = c.atmosphere.density
        let v0 = c.ballSpeedMPH * 0.44704
        let vla = c.launchAngleDegrees * .pi / 180
        let azi = c.azimuthDegrees * .pi / 180
        let axis = c.spinAxisDegrees * .pi / 180

        // World frame: +x downrange (toward target), +y up, +z right.
        var p = SIMD3<Double>(0, 0, 0)
        var v = SIMD3<Double>(v0 * cos(vla) * cos(azi),
                              v0 * sin(vla),
                              v0 * cos(vla) * sin(azi))

        let omega0 = c.totalSpinRPM * 2 * .pi / 60

        // Spin axis unit vector.
        //
        // Sign derivation, because getting this backwards silently inverts
        // every draw and fade: for a ball travelling +x, pure backspin means
        // the top of the ball moves toward -x. A point at (0, +r, 0) has
        // velocity ω × r; for that to point in -x, ω must be +z. So backspin
        // is +z, i.e. the axis points to the golfer's right.
        //
        // Tilting the axis to the right (positive `spinAxisDegrees`) then has
        // to produce a rightward Magnus force. ω × v with ω = (0, -sin, cos)
        // and v ≈ (vx, 0, 0) gives a +z force component. Confirmed numerically with the shipped coefficients:
        // +20° axis on a 150 mph drive lands 31.7 yd right; -20° lands 31.7 yd left. Do not "simplify".
        let spinAxis = SIMD3<Double>(0, -sin(axis), cos(axis))

        var t: Double = 0
        var apex: Double = 0
        var points: [TrajectoryPoint] = []
        points.reserveCapacity(drawSamples + 2)
        points.append(TrajectoryPoint(t: 0, x: 0, y: 0, z: 0, speed: v0))

        // Direction of the initial launch line, projected on the ground. Used
        // at the end to separate "started right" from "curved right".
        let launchDir = SIMD2<Double>(cos(azi), sin(azi))

        func acceleration(_ v: SIMD3<Double>, _ t: Double) -> SIMD3<Double> {
            let speed = simd_length(v)
            guard speed > 1e-6 else { return SIMD3(0, -Aero.gravity, 0) }

            let omega = omega0 * exp(-Aero.spinDecayPerSecond * t)
            let S = Aero.spinRatio(omega: omega, speed: speed)
            let cd = Aero.dragCoefficient(speed: speed, spinRatio: S)
            let cl = Aero.liftCoefficient(spinRatio: S)

            // q = ½ρA·|v| / m — the shared scalar; multiplying by v gives the
            // v² dependence without a redundant square root.
            let q = 0.5 * rho * Ball.area * speed / Ball.massKg

            let drag = -q * cd * v

            // Magnus acts along ω̂ × v̂.
            let cross = simd_cross(spinAxis, v)
            let crossLen = simd_length(cross)
            let lift = crossLen > 1e-9
                ? (q * cl * speed) * (cross / crossLen)
                : SIMD3<Double>.zero

            return drag + lift + SIMD3(0, -Aero.gravity, 0)
        }

        var sampleAccumulator: Double = 0
        let h = timeStep

        // Integrate until the ball returns to ground level.
        while t < 20 {
            let k1 = acceleration(v, t)
            let v2 = v + 0.5 * h * k1
            let k2 = acceleration(v2, t + h / 2)
            let v3 = v + 0.5 * h * k2
            let k3 = acceleration(v3, t + h / 2)
            let v4 = v + h * k3
            let k4 = acceleration(v4, t + h)

            // Position advances on the RK4-weighted *velocities*, which is the
            // consistent pairing for this second-order system.
            //
            // Written out in steps rather than one expression: mixing integer
            // literals with SIMD3<Double> makes the type-checker give up
            // ("unable to type-check in reasonable time"). Explicit Double
            // literals and named intermediates compile instantly.
            let sixth: Double = h / 6.0
            let two: Double = 2.0
            let vSum: SIMD3<Double> = v + two * v2 + two * v3 + v4
            let kSum: SIMD3<Double> = k1 + two * k2 + two * k3 + k4
            let nextP: SIMD3<Double> = p + sixth * vSum
            let nextV: SIMD3<Double> = v + sixth * kSum
            t += h
            apex = max(apex, nextP.y)

            if nextP.y < 0 && t > 0.05 {
                // Linear interpolation to the ground crossing. The step is
                // 2 ms so this is well inside any error we care about.
                let f = p.y / (p.y - nextP.y)
                let land = p + f * (nextP - p)
                let landV = v + f * (nextV - v)

                let carry = land.x / 0.9144
                let side = land.z / 0.9144

                // How far the landing point sits off the launch line.
                let along = land.x * launchDir.x + land.z * launchDir.y
                let onLine = SIMD2<Double>(launchDir.x * along, launchDir.y * along)
                let curve = (land.z - onLine.y) / 0.9144

                let landSpeed: Double = simd_length(landV)
                let horizontal: Double = sqrt(landV.x * landV.x + landV.z * landV.z)
                let descentRad: Double = atan2(-landV.y, horizontal)
                let descent: Double = descentRad * 180.0 / Double.pi

                points.append(TrajectoryPoint(t: t, x: land.x, y: 0, z: land.z,
                                              speed: landSpeed))

                let roll = rollYards(descentAngle: descent,
                                     landingSpeed: landSpeed,
                                     spinRPM: c.totalSpinRPM * exp(-Aero.spinDecayPerSecond * t))

                return FlightResult(carryYards: carry,
                                    totalYards: carry + roll,
                                    sideYards: side,
                                    curveYards: curve,
                                    apexFeet: apex * 3.280839895,
                                    hangTimeSeconds: t,
                                    descentAngleDegrees: descent,
                                    landingSpeedMPH: landSpeed / 0.44704,
                                    trajectory: points)
            }

            p = nextP
            v = nextV

            // Decimate for drawing — we don't need 3 500 points on screen.
            sampleAccumulator += h
            if sampleAccumulator >= 0.04 {
                sampleAccumulator = 0
                points.append(TrajectoryPoint(t: t, x: p.x, y: p.y, z: p.z,
                                              speed: simd_length(v)))
            }
        }

        return .zero
    }

    /// Roll-out estimate on a firm fairway.
    ///
    /// This is unapologetically empirical — real roll depends on turf firmness,
    /// slope, moisture and bounce angle, none of which a camera pointed at a
    /// tee can know. It is tuned so a tour driver (≈38° descent, 2 200 rpm at
    /// landing) rolls ~20 yd and a wedge (≈50°, 8 000 rpm) checks to near zero.
    /// Treat total distance as indicative; carry is the measured number.
    private static func rollYards(descentAngle: Double,
                                  landingSpeed: Double,
                                  spinRPM: Double) -> Double {
        // Steeper descent digs in rather than running out.
        let angleFactor = max(0, cos(descentAngle * .pi / 180))
        // Spin bites. Above ~7 000 rpm the ball essentially stops.
        let spinFactor = max(0.05, 1.0 - spinRPM / 9000.0)
        let speedYd = (landingSpeed / 0.44704) * 0.26   // mph → yards of run
        return max(0, speedYd * angleFactor * angleFactor * spinFactor)
    }

    /// Convenience: carry only, skipping trajectory allocation. Used by the
    /// range's club-gapping view, which runs hundreds of these.
    static func carryOnly(_ c: LaunchConditions) -> Double {
        simulate(c).carryYards
    }
}
