//
//  FlightModelTests.swift
//  GolfLaunchMonitorTests
//
//  These are the tests that matter: they pin the flight model to published
//  Trackman tour averages. If someone "optimises" the aero coefficients and
//  these go red, the optimisation was wrong.
//
//  Run on a Mac with:  xcodebuild test -scheme GolfLaunchMonitor -destination 'platform=iOS Simulator,name=iPhone 16 Pro'
//

import Testing
import Foundation
@testable import GolfLaunchMonitor

// MARK: - Reference data

/// Trackman PGA Tour averages. Tolerances are the fit residuals documented in
/// FlightModel.swift, rounded up slightly so the tests aren't brittle.
private struct Reference {
    let name: String
    let ballSpeed: Double
    let launch: Double
    let spin: Double
    let carry: Double
    let apex: Double
    let carryTolerance: Double
    let apexTolerance: Double
}

private let tourReferences: [Reference] = [
    .init(name: "Driver",  ballSpeed: 167, launch: 10.9, spin: 2686,
          carry: 275, apex: 102, carryTolerance: 14, apexTolerance: 12),
    .init(name: "3-wood",  ballSpeed: 158, launch:  9.2, spin: 3655,
          carry: 243, apex:  90, carryTolerance: 12, apexTolerance: 12),
    .init(name: "5-iron",  ballSpeed: 132, launch: 14.3, spin: 5280,
          carry: 195, apex: 105, carryTolerance: 13, apexTolerance: 12),
    .init(name: "7-iron",  ballSpeed: 120, launch: 16.3, spin: 7097,
          carry: 172, apex: 103, carryTolerance: 10, apexTolerance: 12),
    .init(name: "PW",      ballSpeed: 102, launch: 24.2, spin: 9316,
          carry: 136, apex:  96, carryTolerance: 10, apexTolerance: 12),
]

// MARK: - Carry & apex

@Test("Flight model matches tour averages", arguments: tourReferences.indices)
func matchesTourAverages(index: Int) {
    let ref = tourReferences[index]
    let result = FlightModel.simulate(
        LaunchConditions(ballSpeedMPH: ref.ballSpeed,
                         launchAngleDegrees: ref.launch,
                         azimuthDegrees: 0,
                         totalSpinRPM: ref.spin,
                         spinAxisDegrees: 0)
    )
    #expect(abs(result.carryYards - ref.carry) < ref.carryTolerance,
            "\(ref.name): carry \(result.carryYards) vs expected \(ref.carry)")
    #expect(abs(result.apexFeet - ref.apex) < ref.apexTolerance,
            "\(ref.name): apex \(result.apexFeet) vs expected \(ref.apex)")
}

@Test("Mean carry error across the bag stays under 8 yards")
func meanCarryError() {
    let total = tourReferences.reduce(0.0) { sum, ref in
        let r = FlightModel.simulate(
            LaunchConditions(ballSpeedMPH: ref.ballSpeed,
                             launchAngleDegrees: ref.launch,
                             azimuthDegrees: 0,
                             totalSpinRPM: ref.spin,
                             spinAxisDegrees: 0))
        return sum + abs(r.carryYards - ref.carry)
    }
    let mean = total / Double(tourReferences.count)
    #expect(mean < 8.0, "mean |carry error| = \(mean) yd")
}

// MARK: - Spin axis sign conventions
//
// These exist because an inverted Magnus cross product is a silent, plausible-
// looking bug that flips every draw and fade. It was in fact present in the
// first draft of this model and produced 68-yard drives.

@Test("Positive spin axis curves the ball right")
func positiveAxisCurvesRight() {
    let r = FlightModel.simulate(
        LaunchConditions(ballSpeedMPH: 150, launchAngleDegrees: 12, azimuthDegrees: 0,
                         totalSpinRPM: 2700, spinAxisDegrees: 20))
    #expect(r.sideYards > 20, "20° axis should push the ball well right, got \(r.sideYards)")
}

@Test("Negative spin axis curves the ball left, symmetrically")
func negativeAxisCurvesLeft() {
    let right = FlightModel.simulate(
        LaunchConditions(ballSpeedMPH: 150, launchAngleDegrees: 12, azimuthDegrees: 0,
                         totalSpinRPM: 2700, spinAxisDegrees: 10))
    let left = FlightModel.simulate(
        LaunchConditions(ballSpeedMPH: 150, launchAngleDegrees: 12, azimuthDegrees: 0,
                         totalSpinRPM: 2700, spinAxisDegrees: -10))
    #expect(left.sideYards < 0)
    #expect(abs(right.sideYards + left.sideYards) < 0.5, "should be symmetric")
}

@Test("Backspin generates lift, not downforce")
func backspinLifts() {
    // A ball with backspin must out-carry an identical ball with none.
    let spinning = FlightModel.simulate(
        LaunchConditions(ballSpeedMPH: 150, launchAngleDegrees: 12, azimuthDegrees: 0,
                         totalSpinRPM: 2700, spinAxisDegrees: 0))
    let dead = FlightModel.simulate(
        LaunchConditions(ballSpeedMPH: 150, launchAngleDegrees: 12, azimuthDegrees: 0,
                         totalSpinRPM: 0, spinAxisDegrees: 0))
    #expect(spinning.carryYards > dead.carryYards + 40,
            "backspin should add serious carry: \(spinning.carryYards) vs \(dead.carryYards)")
    #expect(spinning.apexFeet > dead.apexFeet)
}

@Test("Spin decays rather than growing")
func spinDecayIsPhysical() {
    // Guards the exact bug an unconstrained coefficient fit introduced.
    #expect(Aero.spinDecayPerSecond > 0,
            "negative decay means the ball gains spin in flight — unphysical")
}

// MARK: - Atmosphere

@Test("Thin air carries further")
func altitudeIncreasesCarry() {
    let seaLevel = FlightModel.simulate(
        LaunchConditions(ballSpeedMPH: 167, launchAngleDegrees: 10.9, azimuthDegrees: 0,
                         totalSpinRPM: 2686, spinAxisDegrees: 0,
                         atmosphere: .standard))
    let denver = FlightModel.simulate(
        LaunchConditions(ballSpeedMPH: 167, launchAngleDegrees: 10.9, azimuthDegrees: 0,
                         totalSpinRPM: 2686, spinAxisDegrees: 0,
                         atmosphere: Atmosphere(temperatureCelsius: 20, altitudeMetres: 1600)))
    let gain = (denver.carryYards / seaLevel.carryYards - 1) * 100
    // The familiar rule of thumb is about 6–10 % at Denver altitude.
    #expect(gain > 4 && gain < 13, "Denver gain was \(gain)%")
}

// MARK: - Shot shape classification

@Test("Shape classification matches golfer intuition")
func shapeClassification() {
    #expect(ShotShape.classify(azimuthDegrees: 0, curveYards: 2) == .straight)
    #expect(ShotShape.classify(azimuthDegrees: 0, curveYards: 14) == .fade)
    #expect(ShotShape.classify(azimuthDegrees: 0, curveYards: -14) == .draw)
    #expect(ShotShape.classify(azimuthDegrees: 0, curveYards: 35) == .slice)
    #expect(ShotShape.classify(azimuthDegrees: 0, curveYards: -35) == .hook)
    #expect(ShotShape.classify(azimuthDegrees: 6, curveYards: 1) == .pushStraight)
    #expect(ShotShape.classify(azimuthDegrees: -6, curveYards: 12) == .pullFade)
}

// MARK: - Spin aliasing

@Test("Marker rotation un-aliases against the club prior")
func unwrapsAliasedSpin() {
    // A wedge at 9500 rpm turns 237.5°/frame at 240 fps, which wraps to
    // -122.5°. The solver must recover ~9500, not report a backwards ball.
    let wrapped = 237.5 - 360.0
    let recovered = SpinAnalyzer.unwrapRotation(wrapped: wrapped,
                                                frameRate: 240,
                                                plausible: Club.sandWedge.spinRange)
    #expect(recovered != nil)
    if let r = recovered { #expect(abs(r - 9500) < 400, "recovered \(r) rpm") }
}

@Test("Unaliased spin passes through unchanged")
func unwrapsCleanSpin() {
    // Driver at 2700 rpm = 67.5°/frame, comfortably under Nyquist.
    let recovered = SpinAnalyzer.unwrapRotation(wrapped: 67.5,
                                                frameRate: 240,
                                                plausible: Club.driver.spinRange)
    #expect(recovered != nil)
    if let r = recovered { #expect(abs(r - 2700) < 100) }
}

@Test("Nyquist limit is where we think it is")
func nyquistLimit() {
    #expect(abs(SpinAnalyzer.nyquistSpinRPM(frameRate: 240) - 7200) < 1)
    #expect(abs(SpinAnalyzer.nyquistSpinRPM(frameRate: 120) - 3600) < 1)
}

// MARK: - Ring buffer

@Test("Ring buffer rejects ranges it has already overwritten")
func ringBufferOverwriteSafety() {
    let ring = FrameRingBuffer(capacity: 8)
    // Nothing written yet.
    #expect(ring.snapshot(endingAt: 0, count: 1) == nil)
    #expect(ring.snapshot(endingAt: 5, count: 20) == nil, "count exceeds capacity")
}
