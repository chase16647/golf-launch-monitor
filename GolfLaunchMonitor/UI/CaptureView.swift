//
//  CaptureView.swift
//  GolfLaunchMonitor
//
//  The shooting screen: live feed, aiming guide, arming state, live metrics.
//

import SwiftUI
import AVFoundation

// MARK: - Preview layer

struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession

    func makeUIView(context: Context) -> PreviewView {
        let v = PreviewView()
        v.videoPreviewLayer.session = session
        v.videoPreviewLayer.videoGravity = .resizeAspectFill
        return v
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {}

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var videoPreviewLayer: AVCaptureVideoPreviewLayer {
            layer as! AVCaptureVideoPreviewLayer
        }
    }
}

// MARK: - Capture screen

struct CaptureView: View {
    @ObservedObject var pipeline: ShotPipeline
    @Environment(SessionStore.self) private var store
    @State private var showClubPicker = false
    @State private var showSettings = false

    var body: some View {
        ZStack {
            CameraPreview(session: pipeline.camera.session)
                .ignoresSafeArea()

            // Dim everything outside the tee box so the eye goes where it should.
            TeeBoxMask(point: pipeline.teePoint,
                       isArmed: pipeline.phase == .armed)
                .ignoresSafeArea()
                .allowsHitTesting(false)

            VStack(spacing: 0) {
                topBar
                Spacer()
                statusBanner
                bottomPanel
            }
            .padding(.horizontal, 16)
        }
        .background(Color.lmBackground)
        .sheet(isPresented: $showClubPicker) {
            ClubPickerSheet(selected: $pipeline.club)
                .presentationDetents([.medium])
                .presentationBackground(.thinMaterial)
        }
        .sheet(isPresented: $showSettings) {
            CaptureSettingsSheet(pipeline: pipeline)
                .presentationDetents([.medium, .large])
                .presentationBackground(.thinMaterial)
        }
        .task { await pipeline.begin() }
        .onDisappear { pipeline.end() }
    }

    // MARK: Top

    private var topBar: some View {
        HStack(spacing: 8) {
            StatusPill(text: pipeline.captureMode.displayName,
                       systemImage: "video.fill",
                       tint: pipeline.isFrameRateHealthy ? .lmPrimary : .lmWarning)

            if let cal = pipeline.calibration {
                StatusPill(text: String(format: "%.1f ft", cal.distanceFeet),
                           systemImage: cal.source == .lidar || cal.source == .lidarUnverified
                               ? "sensor.tag.radiowaves.forward.fill" : "ruler.fill",
                           tint: cal.isTrustworthy ? .lmPrimary : .lmWarning)
            }

            StatusPill(text: "1/\(pipeline.camera.exposure.shutterDenominator)",
                       systemImage: "camera.aperture",
                       tint: pipeline.camera.exposure.shutterDenominator >= 2000
                           ? .lmPrimary : .lmWarning)

            Spacer()

            Button { showSettings = true } label: {
                Image(systemName: "slider.horizontal.3")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 34, height: 34)
                    .background(.ultraThinMaterial, in: Circle())
            }
        }
        .padding(.top, 8)
    }

    // MARK: Status

    @ViewBuilder
    private var statusBanner: some View {
        Group {
            switch pipeline.phase {
            case .calibrating:
                banner("Measuring distance to the tee…", icon: "sensor.tag.radiowaves.forward", tint: .lmAccent)
            case .searching:
                banner("Place a ball in the box", icon: "circle.dashed", tint: .lmTextSecondary)
            case .armed:
                banner("Armed — take your swing", icon: "checkmark.circle.fill", tint: .lmPrimary)
            case .capturing:
                banner("Capturing…", icon: "bolt.fill", tint: .lmWarning)
            case .analyzing:
                banner("Analyzing", icon: "cpu.fill", tint: .lmAccent)
            case .failed(let message):
                banner(message, icon: "exclamationmark.triangle.fill", tint: .lmDanger)
            case .idle, .result:
                EmptyView()
            }
        }
        .animation(.spring(duration: 0.35), value: pipeline.phase)
        .padding(.bottom, 12)
    }

    private func banner(_ text: String, icon: String, tint: Color) -> some View {
        HStack(spacing: 9) {
            Image(systemName: icon).font(.system(size: 13, weight: .bold))
            Text(text).font(.system(size: 14, weight: .semibold, design: .rounded))
        }
        .foregroundStyle(tint)
        .padding(.horizontal, 15)
        .padding(.vertical, 11)
        .frame(maxWidth: .infinity)
        .background(.ultraThinMaterial, in: .rect(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(tint.opacity(0.3), lineWidth: 0.5))
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }

    // MARK: Bottom

    private var bottomPanel: some View {
        VStack(spacing: 12) {
            if case .result(let shot) = pipeline.phase {
                liveResult(shot)
            }

            HStack(spacing: 10) {
                Button { showClubPicker = true } label: {
                    HStack(spacing: 7) {
                        Text(pipeline.club.shortName)
                            .font(.system(size: 17, weight: .bold, design: .rounded))
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.system(size: 10, weight: .bold))
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 13)
                    .background(.ultraThinMaterial, in: Capsule())
                }

                if let yardage = store.playingYardage(for: pipeline.club) {
                    StatusPill(text: "\(Int(yardage)) yd avg",
                               systemImage: "chart.bar.fill",
                               tint: .lmTextSecondary)
                }

                Spacer()

                if !pipeline.leveler.transform.isLevelEnough,
                   pipeline.leveler.transform.isValid {
                    StatusPill(text: String(format: "%.0f° tilt",
                                            abs(pipeline.leveler.transform.rollDegrees)),
                               systemImage: "level.fill",
                               tint: .lmWarning)
                }
            }
        }
        .padding(.bottom, 12)
    }

    private func liveResult(_ shot: ShotResult) -> some View {
        HStack(spacing: 10) {
            MetricTile(label: "Carry",
                       value: "\(Int(shot.carryYards.rounded()))",
                       unit: "yd",
                       tint: .lmPrimary,
                       emphasis: .hero)
            VStack(spacing: 10) {
                MetricTile(label: "Ball", value: String(format: "%.1f", shot.ballSpeedMPH),
                           unit: "mph", emphasis: .compact)
                MetricTile(label: "Launch", value: String(format: "%.1f", shot.launchAngleDegrees),
                           unit: "°", emphasis: .compact)
            }
            .frame(width: 118)
        }
        .transition(.scale(scale: 0.94).combined(with: .opacity))
    }
}

// MARK: - Tee box overlay

/// Cut-out shape: the whole frame minus the tee box, filled with the even-odd
/// rule so only the surround darkens.
private struct TeeBoxCutout: Shape {
    var point: CGPoint

    func path(in rect: CGRect) -> Path {
        var p = Path(rect)
        let size = min(rect.width, rect.height) * 0.30
        let box = CGRect(x: rect.width * point.x - size / 2,
                         y: rect.height * point.y - size / 2,
                         width: size, height: size)
        p.addRoundedRect(in: box, cornerSize: CGSize(width: 22, height: 22))
        return p
    }
}

/// Dimmed surround plus the aiming reticle and its corner ticks.
private struct TeeBoxMask: View {
    var point: CGPoint
    var isArmed: Bool = false

    var body: some View {
        GeometryReader { geo in
            let size = min(geo.size.width, geo.size.height) * 0.30
            let box = CGRect(x: geo.size.width * point.x - size / 2,
                             y: geo.size.height * point.y - size / 2,
                             width: size, height: size)

            ZStack {
                TeeBoxCutout(point: point)
                    .fill(Color.black.opacity(0.42), style: FillStyle(eoFill: true))

                RoundedRectangle(cornerRadius: 22)
                    .strokeBorder(isArmed ? Color.lmPrimary : Color.white.opacity(0.65),
                                  style: StrokeStyle(lineWidth: isArmed ? 2 : 1.2,
                                                     dash: isArmed ? [] : [7, 6]))
                    .frame(width: box.width, height: box.height)
                    .position(x: box.midX, y: box.midY)
                    .animation(.spring(duration: 0.3), value: isArmed)
            }
        }
    }
}

// MARK: - Sheets

struct ClubPickerSheet: View {
    @Binding var selected: Club
    @Environment(\.dismiss) private var dismiss

    private let columns = [GridItem(.adaptive(minimum: 74), spacing: 10)]

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVGrid(columns: columns, spacing: 10) {
                    ForEach(Club.bagDefault) { club in
                        Button {
                            selected = club
                            dismiss()
                        } label: {
                            VStack(spacing: 3) {
                                Text(club.shortName)
                                    .font(.system(size: 20, weight: .bold, design: .rounded))
                                Text("\(Int(club.loft))°")
                                    .font(.system(size: 11, weight: .medium))
                                    .foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .background(selected == club ? Color.lmPrimary.opacity(0.22)
                                                         : Color.lmSurface,
                                        in: .rect(cornerRadius: 14))
                            .overlay(
                                RoundedRectangle(cornerRadius: 14)
                                    .strokeBorder(selected == club ? Color.lmPrimary
                                                                   : Color.lmSeparator,
                                                  lineWidth: selected == club ? 1.5 : 0.5)
                            )
                            .foregroundStyle(.white)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(16)
            }
            .navigationTitle("Club")
            .navigationBarTitleDisplayMode(.inline)
            .scrollContentBackground(.hidden)
        }
    }
}

struct CaptureSettingsSheet: View {
    @ObservedObject var pipeline: ShotPipeline
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("Capture") {
                    Picker("Mode", selection: $pipeline.captureMode) {
                        ForEach(CaptureMode.allCases, id: \.self) { m in
                            Text(m.displayName).tag(m)
                        }
                    }
                    Picker("Trigger sensitivity", selection: $pipeline.triggerSensitivity) {
                        ForEach(ShotPipeline.Sensitivity.allCases) { s in
                            Text(s.displayName).tag(s)
                        }
                    }
                }

                Section("Player") {
                    Picker("Swing profile", selection: $pipeline.swingProfile) {
                        ForEach(SwingProfile.allCases) { p in
                            Text(p.displayName).tag(p)
                        }
                    }
                    Text("Sets the spin model. Higher handicaps generate more spin at the same speed.")
                        .font(.lmCaption)
                        .foregroundStyle(.secondary)
                }

                Section("Conditions") {
                    LabeledContent("Altitude") {
                        Text("\(Int(pipeline.atmosphere.altitudeMetres)) m")
                    }
                    Slider(value: $pipeline.atmosphere.altitudeMetres, in: 0...2500, step: 50)
                    LabeledContent("Temperature") {
                        Text("\(Int(pipeline.atmosphere.temperatureCelsius)) °C")
                    }
                    Slider(value: $pipeline.atmosphere.temperatureCelsius, in: -5...45, step: 1)
                    LabeledContent("Carry factor") {
                        Text(String(format: "%.1f%%",
                                    (pipeline.atmosphere.carryFactor - 1) * 100))
                            .foregroundStyle(pipeline.atmosphere.carryFactor > 1
                                             ? Color.lmPrimary : Color.lmTextSecondary)
                    }
                }

                Section {
                    Button("Recalibrate") {
                        Task { await pipeline.calibrate() }
                    }
                } footer: {
                    if let cal = pipeline.calibration {
                        Text("""
                             \(cal.source.rawValue) · \(String(format: "%.0f", cal.pixelsPerMetre)) px/m · \
                             ball ≈ \(String(format: "%.1f", cal.expectedBallRadiusPixels)) px radius · \
                             cross-check \(String(format: "%.0f%%", cal.crossCheck * 100))
                             """)
                        .font(.lmCaption)
                    }
                }
            }
            .navigationTitle("Setup")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}
