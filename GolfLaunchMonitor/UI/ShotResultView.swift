//
//  ShotResultView.swift
//  GolfLaunchMonitor
//
//  Full shot breakdown: metrics, shape, both trajectory views, scrub reel, and
//  an honest provenance panel telling you which numbers were measured and
//  which were modelled.
//

import SwiftUI

struct ShotResultView: View {
    let shot: ShotResult
    var frames: [ScrubFrame] = []
    @State private var showDetails = false

    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                heroMetrics
                shapeCard
                TrajectoryCard(shot: shot)
                if !frames.isEmpty { ScrubReelView(frames: frames, shot: shot) }
                secondaryMetrics
                provenanceCard
            }
            .padding(16)
        }
        .background(Color.lmBackground)
        .scrollIndicators(.hidden)
    }

    // MARK: Hero

    private var heroMetrics: some View {
        VStack(spacing: 10) {
            HStack(spacing: 10) {
                MetricTile(label: "Carry",
                           value: "\(Int(shot.carryYards.rounded()))",
                           unit: "yd", tint: .lmPrimary, emphasis: .hero)
                MetricTile(label: "Total",
                           value: "\(Int(shot.totalYards.rounded()))",
                           unit: "yd", emphasis: .hero)
            }
            HStack(spacing: 10) {
                MetricTile(label: "Ball Speed",
                           value: String(format: "%.1f", shot.ballSpeedMPH), unit: "mph")
                MetricTile(label: "Launch",
                           value: String(format: "%.1f", shot.launchAngleDegrees), unit: "°")
            }
        }
    }

    // MARK: Shape

    private var shapeCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Image(systemName: shot.shape.symbolName)
                    .font(.system(size: 17, weight: .bold))
                    .foregroundStyle(Color.shapeColor(shot.shape))
                Text(shot.shape.displayName)
                    .font(.lmTitle)
                    .foregroundStyle(.white)
                Spacer()
                Text(String(format: "%@%.0f yd",
                            shot.curveYards > 0 ? "→ " : "← ", abs(shot.curveYards)))
                    .font(.system(size: 15, weight: .semibold, design: .rounded))
                    .foregroundStyle(Color.shapeColor(shot.shape))
            }

            CurveVisual(curveYards: shot.curveYards,
                        azimuth: shot.azimuthDegrees,
                        tint: Color.shapeColor(shot.shape))
                .frame(height: 78)

            HStack(spacing: 18) {
                labelled("Spin axis",
                         String(format: "%+.1f°", shot.spinAxisDegrees))
                labelled("Side spin",
                         "\(Int(abs(shot.sideSpinRPM))) rpm \(shot.sideSpinRPM > 0 ? "R" : "L")")
                labelled("Back spin", "\(Int(shot.backSpinRPM)) rpm")
            }

            ConfidenceBar(confidence: shot.spinConfidence,
                          label: confidenceLabel)
        }
        .lmCard()
    }

    private var confidenceLabel: String {
        switch shot.spinConfidence {
        case 0.7...: "Shape confidence: high — measured from flight curvature"
        case 0.4..<0.7: "Shape confidence: moderate — partly inferred"
        default: "Shape confidence: low — mostly inferred from start direction"
        }
    }

    private func labelled(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label.uppercased())
                .font(.system(size: 10, weight: .semibold))
                .tracking(0.5)
                .foregroundStyle(Color.lmTextTertiary)
            Text(value)
                .font(.system(size: 14, weight: .semibold, design: .rounded))
                .foregroundStyle(.white)
        }
    }

    // MARK: Secondary

    private var secondaryMetrics: some View {
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
            MetricTile(label: "Apex", value: "\(Int(shot.apexFeet.rounded()))",
                       unit: "ft", emphasis: .compact)
            MetricTile(label: "Hang Time", value: String(format: "%.1f", shot.hangTimeSeconds),
                       unit: "s", emphasis: .compact)
            MetricTile(label: "Descent", value: String(format: "%.0f", shot.descentAngleDegrees),
                       unit: "°", emphasis: .compact)
            MetricTile(label: "Club Speed",
                       value: String(format: "%.0f", shot.estimatedClubSpeedMPH),
                       unit: "mph", emphasis: .compact, footnote: "estimated")
            MetricTile(label: "Offline",
                       value: String(format: "%+.0f", shot.sideYards),
                       unit: "yd", emphasis: .compact)
            MetricTile(label: "Smash",
                       value: String(format: "%.2f", shot.club.smashFactor),
                       emphasis: .compact, footnote: "assumed")
        }
    }

    // MARK: Provenance

    /// The part most launch-monitor apps hide. Ours says plainly what it
    /// measured and what it modelled.
    private var provenanceCard: some View {
        DisclosureGroup(isExpanded: $showDetails) {
            VStack(alignment: .leading, spacing: 10) {
                row("Measured", "Ball speed, launch angle, flight curvature",
                    icon: "checkmark.seal.fill", tint: .lmPrimary)
                row("Modelled", "Total spin (from club + speed + launch)",
                    icon: "function", tint: .lmWarning)
                row("Simulated", "Carry, apex, descent, roll-out (RK4 flight)",
                    icon: "chart.xyaxis.line", tint: .lmAccent)

                Divider().overlay(Color.lmSeparator)

                grid([
                    ("Frames tracked", "\(shot.trackedFrameCount)"),
                    ("Frame rate", String(format: "%.0f fps", shot.measuredFrameRate)),
                    ("Shutter", "1/\(shot.shutterDenominator)"),
                    ("ISO", "\(Int(shot.iso))"),
                    ("Motion blur", String(format: "%.2f× ball", shot.meanSmearRatio)),
                    ("Scale source", shot.calibrationSource),
                    ("Scale agreement", String(format: "%.0f%%", shot.calibrationCrossCheck * 100)),
                    ("Air density", String(format: "%.3f kg/m³", shot.atmosphere.density)),
                ])

                Text("""
                     Back spin is not directly measurable from a side-on camera at \
                     this range. It is estimated from club, ball speed and launch \
                     angle. Side spin — the part that decides draw or fade — IS \
                     measured, from how much the ball bends off its launch line \
                     across the tracked frames.
                     """)
                    .font(.lmCaption)
                    .foregroundStyle(Color.lmTextTertiary)
                    .padding(.top, 2)
            }
            .padding(.top, 12)
        } label: {
            HStack {
                Text("How this was measured")
                    .font(.system(size: 14, weight: .semibold, design: .rounded))
                Spacer()
                Text(shot.qualityLabel)
                    .font(.lmCaption)
                    .foregroundStyle(Color.confidenceColor(shot.quality))
            }
            .foregroundStyle(.white)
        }
        .tint(.lmTextSecondary)
        .lmCard()
    }

    private func row(_ title: String, _ detail: String, icon: String, tint: Color) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(tint)
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.system(size: 13, weight: .semibold)).foregroundStyle(.white)
                Text(detail).font(.lmCaption).foregroundStyle(Color.lmTextSecondary)
            }
        }
    }

    private func grid(_ pairs: [(String, String)]) -> some View {
        VStack(spacing: 6) {
            ForEach(pairs, id: \.0) { pair in
                HStack {
                    Text(pair.0).font(.lmCaption).foregroundStyle(Color.lmTextTertiary)
                    Spacer()
                    Text(pair.1)
                        .font(.system(size: 12, weight: .medium, design: .monospaced))
                        .foregroundStyle(Color.lmTextSecondary)
                }
            }
        }
    }
}

// MARK: - Curve visual

/// Top-down mini view of the shot's shape: start line plus the bend.
struct CurveVisual: View {
    var curveYards: Double
    var azimuth: Double
    var tint: Color

    var body: some View {
        Canvas { context, size in
            let bottom = CGPoint(x: size.width / 2, y: size.height - 4)
            // Scale so a 45 yd slice fills the available width.
            let scale = (size.width / 2 - 12) / 45.0
            let startDrift = CGFloat(azimuth) * 1.2 * scale
            let endX = bottom.x + startDrift + CGFloat(curveYards) * scale

            // Dashed straight reference.
            var reference = Path()
            reference.move(to: bottom)
            reference.addLine(to: CGPoint(x: bottom.x, y: 4))
            context.stroke(reference,
                           with: .color(.white.opacity(0.18)),
                           style: StrokeStyle(lineWidth: 1, dash: [4, 5]))

            // The shot: a quadratic that leaves on the start line and bends.
            var path = Path()
            path.move(to: bottom)
            let control = CGPoint(x: bottom.x + startDrift, y: size.height * 0.30)
            path.addQuadCurve(to: CGPoint(x: endX, y: 6), control: control)
            context.stroke(path,
                           with: .linearGradient(
                               Gradient(colors: [tint.opacity(0.35), tint]),
                               startPoint: bottom,
                               endPoint: CGPoint(x: endX, y: 6)),
                           style: StrokeStyle(lineWidth: 2.5, lineCap: .round))

            // Landing dot.
            context.fill(Path(ellipseIn: CGRect(x: endX - 4, y: 2, width: 8, height: 8)),
                         with: .color(tint))
        }
    }
}

// MARK: - Trajectory

struct TrajectoryCard: View {
    let shot: ShotResult
    @State private var mode: Mode = .side

    enum Mode: String, CaseIterable, Identifiable {
        case side = "Side", top = "Top"
        var id: String { rawValue }
    }

    var body: some View {
        VStack(spacing: 12) {
            HStack {
                Text("Flight").font(.system(size: 14, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white)
                Spacer()
                Picker("", selection: $mode) {
                    ForEach(Mode.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .frame(width: 130)
            }

            ZStack {
                if mode == .side {
                    SideProfile(points: shot.trajectory,
                                apexFeet: shot.apexFeet,
                                carryYards: shot.carryYards)
                } else {
                    TopDown(points: shot.trajectory,
                            curveYards: shot.curveYards,
                            tint: Color.shapeColor(shot.shape))
                }
            }
            .frame(height: 170)
            .animation(.spring(duration: 0.35), value: mode)
        }
        .lmCard()
    }
}

private struct SideProfile: View {
    let points: [TrajectoryPoint]
    let apexFeet: Double
    let carryYards: Double

    var body: some View {
        Canvas { context, size in
            guard points.count > 1 else { return }
            let maxX = points.map(\.x).max() ?? 1
            let maxY = max(points.map(\.y).max() ?? 1, 1)

            func project(_ p: TrajectoryPoint) -> CGPoint {
                CGPoint(x: 8 + (p.x / maxX) * (size.width - 16),
                        y: size.height - 18 - (p.y / maxY) * (size.height - 34))
            }

            // Ground line.
            var ground = Path()
            ground.move(to: CGPoint(x: 0, y: size.height - 18))
            ground.addLine(to: CGPoint(x: size.width, y: size.height - 18))
            context.stroke(ground, with: .color(.white.opacity(0.16)), lineWidth: 1)

            // Flight path with a soft fill beneath.
            var path = Path()
            path.move(to: project(points[0]))
            for p in points.dropFirst() { path.addLine(to: project(p)) }

            var fill = path
            fill.addLine(to: CGPoint(x: project(points.last!).x, y: size.height - 18))
            fill.addLine(to: CGPoint(x: project(points[0]).x, y: size.height - 18))
            fill.closeSubpath()
            context.fill(fill, with: .linearGradient(
                Gradient(colors: [Color.lmPrimary.opacity(0.22), .clear]),
                startPoint: CGPoint(x: 0, y: 0),
                endPoint: CGPoint(x: 0, y: size.height)))

            context.stroke(path, with: .color(.lmPrimary),
                           style: StrokeStyle(lineWidth: 2.5, lineCap: .round, lineJoin: .round))

            // Apex marker.
            if let apex = points.max(by: { $0.y < $1.y }) {
                let pt = project(apex)
                context.fill(Path(ellipseIn: CGRect(x: pt.x - 3.5, y: pt.y - 3.5,
                                                    width: 7, height: 7)),
                             with: .color(.white))
                context.draw(Text("\(Int(apexFeet)) ft")
                                .font(.system(size: 10, weight: .semibold, design: .rounded))
                                .foregroundStyle(.white.opacity(0.85)),
                             at: CGPoint(x: pt.x, y: pt.y - 14))
            }

            context.draw(Text("\(Int(carryYards)) yd")
                            .font(.system(size: 10, weight: .semibold, design: .rounded))
                            .foregroundStyle(.white.opacity(0.7)),
                         at: CGPoint(x: size.width - 26, y: size.height - 7))
        }
    }
}

private struct TopDown: View {
    let points: [TrajectoryPoint]
    let curveYards: Double
    let tint: Color

    var body: some View {
        Canvas { context, size in
            guard points.count > 1 else { return }
            let maxX = points.map(\.x).max() ?? 1
            let maxZ = max(points.map { abs($0.z) }.max() ?? 1, 8)

            func project(_ p: TrajectoryPoint) -> CGPoint {
                CGPoint(x: size.width / 2 + (p.z / maxZ) * (size.width / 2 - 20),
                        y: size.height - 10 - (p.x / maxX) * (size.height - 24))
            }

            // Target line.
            var centre = Path()
            centre.move(to: CGPoint(x: size.width / 2, y: size.height - 10))
            centre.addLine(to: CGPoint(x: size.width / 2, y: 10))
            context.stroke(centre, with: .color(.white.opacity(0.18)),
                           style: StrokeStyle(lineWidth: 1, dash: [4, 5]))

            var path = Path()
            path.move(to: project(points[0]))
            for p in points.dropFirst() { path.addLine(to: project(p)) }
            context.stroke(path, with: .color(tint),
                           style: StrokeStyle(lineWidth: 2.5, lineCap: .round, lineJoin: .round))

            if let last = points.last {
                let pt = project(last)
                context.fill(Path(ellipseIn: CGRect(x: pt.x - 4.5, y: pt.y - 4.5,
                                                    width: 9, height: 9)),
                             with: .color(tint))
                context.draw(Text(String(format: "%+.0f yd", curveYards))
                                .font(.system(size: 10, weight: .semibold, design: .rounded))
                                .foregroundStyle(tint),
                             at: CGPoint(x: pt.x, y: pt.y - 14))
            }
        }
    }
}

// MARK: - Scrub reel

/// Frame-by-frame scrubber across impact, with the traced ball path.
struct ScrubReelView: View {
    let frames: [ScrubFrame]
    let shot: ShotResult
    @State private var index: Double = 0
    @State private var isPlaying = false

    private var current: ScrubFrame? {
        let i = Int(index.rounded())
        return frames.indices.contains(i) ? frames[i] : frames.first
    }

    var body: some View {
        VStack(spacing: 10) {
            HStack {
                Text("Impact").font(.system(size: 14, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white)
                Spacer()
                if let f = current {
                    Text(f.offsetFromImpact == 0
                         ? "Impact"
                         : String(format: "%+d frames (%+.1f ms)",
                                  f.offsetFromImpact,
                                  Double(f.offsetFromImpact) * 1000 / shot.measuredFrameRate))
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                        .foregroundStyle(f.isImpact ? Color.lmWarning : Color.lmTextSecondary)
                }
            }

            ZStack {
                if let f = current {
                    Image(decorative: f.image, scale: 1)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .clipShape(.rect(cornerRadius: 12))
                        .overlay(alignment: .topLeading) {
                            if f.isImpact {
                                Text("IMPACT")
                                    .font(.system(size: 10, weight: .heavy, design: .rounded))
                                    .padding(.horizontal, 7).padding(.vertical, 3)
                                    .background(Color.lmWarning, in: Capsule())
                                    .foregroundStyle(.black)
                                    .padding(8)
                            }
                        }
                }
            }
            .frame(height: 190)
            .background(Color.black, in: .rect(cornerRadius: 12))

            HStack(spacing: 12) {
                Button {
                    isPlaying.toggle()
                    if isPlaying { play() }
                } label: {
                    Image(systemName: isPlaying ? "pause.fill" : "play.fill")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(.black)
                        .frame(width: 32, height: 32)
                        .background(Color.lmPrimary, in: Circle())
                }
                .buttonStyle(.plain)

                Slider(value: $index, in: 0...Double(max(frames.count - 1, 1)), step: 1)
                    .tint(.lmPrimary)
            }
        }
        .lmCard()
    }

    private func play() {
        Task {
            while isPlaying {
                try? await Task.sleep(for: .milliseconds(140))
                guard isPlaying else { break }
                index = index >= Double(frames.count - 1) ? 0 : index + 1
            }
        }
    }
}
