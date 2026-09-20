//
//  MotionLeveler.swift
//  GolfLaunchMonitor
//
//  CoreMotion gives us true vertical. Without it, "launch angle" is measured
//  relative to however the phone happened to be leaning against a range
//  bucket, and a 3° tilt is a 3° launch-angle error — worth about 8 yards of
//  carry on a 7-iron.
//
//  We take gravity in the device frame and build the rotation that maps the
//  camera's image axes onto a world frame whose +y is truly up.
//

import Foundation
import CoreMotion
import simd

/// Rotation applied to camera-frame vectors to produce gravity-levelled
/// world-frame vectors.
struct LevellingTransform: Sendable, Equatable {
    /// Roll of the device about the optical axis, radians. This is the one
    /// that rotates the image.
    var rollRadians: Double
    /// Pitch — how far the camera is tilted up or down from horizontal.
    var pitchRadians: Double
    /// True when we actually have a motion reading; otherwise identity.
    var isValid: Bool

    static let identity = LevellingTransform(rollRadians: 0, pitchRadians: 0, isValid: false)

    var rollDegrees: Double { rollRadians * 180 / .pi }
    var pitchDegrees: Double { pitchRadians * 180 / .pi }

    /// Is the phone level enough to shoot? Beyond a few degrees we ask the
    /// user to straighten up rather than silently correcting a large angle,
    /// because a big tilt also means the ball's path is no longer in the
    /// image plane and the planar-scale assumption starts to break.
    var isLevelEnough: Bool {
        isValid && abs(rollDegrees) < 6 && abs(pitchDegrees) < 10
    }

    /// Apply to a camera-frame vector (x right, y up, z toward scene).
    func apply(_ v: SIMD3<Double>) -> SIMD3<Double> {
        guard isValid else { return v }
        // Undo roll about the optical axis, then pitch about the horizontal.
        let cr = cos(-rollRadians), sr = sin(-rollRadians)
        let unrolled = SIMD3(v.x * cr - v.y * sr,
                             v.x * sr + v.y * cr,
                             v.z)
        let cp = cos(-pitchRadians), sp = sin(-pitchRadians)
        return SIMD3(unrolled.x,
                     unrolled.y * cp - unrolled.z * sp,
                     unrolled.y * sp + unrolled.z * cp)
    }
}

@MainActor
final class MotionLeveler: ObservableObject {

    @Published private(set) var transform: LevellingTransform = .identity
    @Published private(set) var isRunning = false

    private let manager = CMMotionManager()

    func start() {
        guard manager.isDeviceMotionAvailable, !isRunning else { return }
        // 30 Hz is ample — we only need the orientation at arm time, and a
        // faster rate just burns power next to a 240 fps capture session.
        manager.deviceMotionUpdateInterval = 1.0 / 30.0
        manager.startDeviceMotionUpdates(using: .xArbitraryZVertical, to: .main) { [weak self] motion, _ in
            guard let self, let m = motion else { return }
            let g = m.gravity

            // Device held in landscape, camera on the back, looking sideways
            // at the ball. Gravity's components give roll and pitch directly.
            //
            // roll: rotation about the optical axis (z in device coords)
            let roll = atan2(g.x, -g.y)
            // pitch: how far the optical axis is off horizontal
            let pitch = asin(max(-1, min(1, g.z)))

            self.transform = LevellingTransform(rollRadians: roll,
                                                pitchRadians: pitch,
                                                isValid: true)
        }
        isRunning = true
    }

    func stop() {
        manager.stopDeviceMotionUpdates()
        isRunning = false
    }

    /// Freeze the current orientation for the duration of a shot, so a bump
    /// mid-swing doesn't change the reference frame between frames.
    func snapshot() -> LevellingTransform { transform }
}
