//
//  RangeView.swift
//  GolfLaunchMonitor
//
//  Driving range: targets, scoring, dispersion, and the yardage book.
//

import SwiftUI

struct RangeView: View {
    @Bindable var range: RangeMode
    @Environment(SessionStore.self) private var store
    @ObservedObject var pipeline: ShotPipeline

    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                targetStrip
                if !range.results.isEmpty { scoreCard }
                DispersionMap(results: range.results)
                if let last = range.results.last { lastShotCard(last) }
            }
            .padding(16)
        }
        .background(Color.lmBackground)
        .scrollIndicators(.hidden)
        .navigationTitle("Range")
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Toggle(isOn: Bindable(range).isChallengeMode) {
                    Image(systemName: "target")
                }
                .toggleStyle(.button)
                .tint(.lmPrimary)
            }
        }
        .onAppear { if range.selectedTarget == nil { range.begin() } }
    }

    private var targetStrip: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "Target") {
                if let club = range.suggestedClub(using: store) {
                    Text("Suggested: \(club.shortName)")
                        .font(.lmCaption)
                        .foregroundStyle(Color.lmPrimary)
                }
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(range.targets) { target in
                        let selected = range.selectedTarget?.id == target.id
                        Button { range.selectedTarget = target } label: {
                            VStack(spacing: 2) {
                                Text("\(Int(target.distanceYards))")
                                    .font(.system(size: 22, weight: .bold, design: .rounded))
                                Text("yd").font(.system(size: 10, weight: .medium))
                                    .foregroundStyle(.secondary)
                            }
                            .frame(width: 76, height: 66)
                            .background(selected ? Color.lmPrimary.opacity(0.2) : Color.lmSurface,
                                        in: .rect(cornerRadius: 16))
                            .overlay(RoundedRectangle(cornerRadius: 16)
                                .strokeBorder(selected ? Color.lmPrimary : Color.lmSeparator,
                                              lineWidth: selected ? 1.5 : 0.5))
                            .foregroundStyle(.white)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private var scoreCard: some View {
        HStack(spacing: 10) {
            MetricTile(label: "Points", value: "\(range.totalPoints)", emphasis: .compact,
                       tint: .lmPrimary)
            MetricTile(label: "Greens",
                       value: "\(range.hitCount)/\(range.results.count)", emphasis: .compact)
            MetricTile(label: "Avg Miss",
                       value: String(format: "%.0f", range.averageProximity),
                       unit: "yd", emphasis: .compact)
        }
    }

    private func lastShotCard(_ result: TargetResult) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text(result.missDescription)
                    .font(.system(size: 17, weight: .bold, design: .rounded))
                    .foregroundStyle(result.isHit ? Color.lmPrimary : .white)
                Text("\(result.shot.club.displayName) · \(Int(result.shot.carryYards)) yd carry")
                    .font(.lmCaption).foregroundStyle(Color.lmTextSecondary)
            }
            Spacer()
            Text("+\(result.points)")
                .font(.system(size: 26, weight: .bold, design: .rounded))
                .foregroundStyle(Color.lmPrimary)
        }
        .lmCard()
    }
}

// MARK: - Dispersion

/// Landing pattern with a one-sigma ellipse. This is the picture that actually
/// changes how people practise — most golfers badly misjudge their own spread.
struct DispersionMap: View {
    let results: [TargetResult]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader("Dispersion")
            Canvas { context, size in
                guard !results.isEmpty else { return }
                let maxD = max(results.map(\.shot.carryYards).max() ?? 200, 50)
                let maxS = max(results.map { abs($0.shot.sideYards) }.max() ?? 20, 20)

                func project(_ carry: Double, _ side: Double) -> CGPoint {
                    CGPoint(x: size.width / 2 + (side / maxS) * (size.width / 2 - 24),
                            y: size.height - 14 - (carry / maxD) * (size.height - 28))
                }

                // Centre line + distance rings.
                var line = Path()
                line.move(to: CGPoint(x: size.width / 2, y: size.height - 14))
                line.addLine(to: CGPoint(x: size.width / 2, y: 10))
                context.stroke(line, with: .color(.white.opacity(0.15)),
                               style: StrokeStyle(lineWidth: 1, dash: [4, 5]))

                // Targets as translucent greens.
                for r in results.map(\.target).uniqued() {
                    let c = project(r.distanceYards, r.offsetYards)
                    let rad = (r.radiusYards / maxS) * (size.width / 2 - 24)
                    context.fill(Path(ellipseIn: CGRect(x: c.x - rad, y: c.y - rad * 0.55,
                                                        width: rad * 2, height: rad * 1.1)),
                                 with: .color(Color.lmPrimary.opacity(0.13)))
                }

                // Shots.
                for r in results {
                    let p = project(r.shot.carryYards, r.shot.sideYards)
                    let color = Color.shapeColor(r.shot.shape)
                    context.fill(Path(ellipseIn: CGRect(x: p.x - 3.5, y: p.y - 3.5,
                                                        width: 7, height: 7)),
                                 with: .color(r.isHit ? Color.lmPrimary : color))
                }

                // One-sigma ellipse.
                let carries = results.map(\.shot.carryYards)
                let sides = results.map(\.shot.sideYards)
                if carries.count > 2 {
                    let mc = carries.reduce(0,+) / Double(carries.count)
                    let ms = sides.reduce(0,+) / Double(sides.count)
                    let sc = sqrt(carries.map { pow($0 - mc, 2) }.reduce(0,+) / Double(carries.count - 1))
                    let ss = sqrt(sides.map { pow($0 - ms, 2) }.reduce(0,+) / Double(sides.count - 1))
                    let centre = project(mc, ms)
                    let w = (ss / maxS) * (size.width - 48)
                    let h = (sc / maxD) * (size.height - 28)
                    context.stroke(Path(ellipseIn: CGRect(x: centre.x - w, y: centre.y - h,
                                                          width: w * 2, height: h * 2)),
                                   with: .color(.white.opacity(0.32)),
                                   style: StrokeStyle(lineWidth: 1.2, dash: [5, 4]))
                }
            }
            .frame(height: 220)

            if results.count > 2 {
                let sides = results.map(\.shot.sideYards)
                let ms = sides.reduce(0,+) / Double(sides.count)
                let ss = sqrt(sides.map { pow($0 - ms, 2) }.reduce(0,+) / Double(sides.count - 1))
                Text(String(format: "68%% of your shots land within ±%.0f yd laterally.", ss))
                    .font(.lmCaption).foregroundStyle(Color.lmTextTertiary)
            }
        }
        .lmCard()
    }
}

// MARK: - Yardage book

struct BagView: View {
    @Environment(SessionStore.self) private var store

    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                if store.yardageBook.isEmpty {
                    ContentUnavailableView("No shots yet",
                                           systemImage: "bag",
                                           description: Text("Hit a few balls and your yardages will build here."))
                        .padding(.top, 60)
                } else {
                    gappingChart
                    ForEach(store.yardageBook) { avg in clubRow(avg) }
                    gapWarnings
                }
            }
            .padding(16)
        }
        .background(Color.lmBackground)
        .navigationTitle("My Bag")
        .scrollIndicators(.hidden)
    }

    private var gappingChart: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader("Carry Gapping")
            let maxCarry = store.yardageBook.map(\.carryYards).max() ?? 250
            VStack(spacing: 6) {
                ForEach(store.yardageBook) { avg in
                    HStack(spacing: 8) {
                        Text(avg.club.shortName)
                            .font(.system(size: 12, weight: .bold, design: .rounded))
                            .frame(width: 30, alignment: .leading)
                            .foregroundStyle(.white)
                        GeometryReader { geo in
                            ZStack(alignment: .leading) {
                                Capsule().fill(Color.lmSeparator.opacity(0.4))
                                Capsule()
                                    .fill(LinearGradient(
                                        colors: [Color.lmPrimary.opacity(0.55), Color.lmPrimary],
                                        startPoint: .leading, endPoint: .trailing))
                                    .frame(width: geo.size.width * (avg.carryYards / maxCarry))
                            }
                        }
                        .frame(height: 16)
                        Text("\(Int(avg.carryYards))")
                            .font(.system(size: 12, weight: .semibold, design: .monospaced))
                            .frame(width: 32, alignment: .trailing)
                            .foregroundStyle(Color.lmTextSecondary)
                    }
                }
            }
        }
        .lmCard()
    }

    private func clubRow(_ avg: ClubAverage) -> some View {
        HStack(spacing: 14) {
            VStack(spacing: 1) {
                Text(avg.club.shortName)
                    .font(.system(size: 19, weight: .bold, design: .rounded))
                Text("\(avg.count)")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(Color.lmTextTertiary)
            }
            .frame(width: 46)
            .foregroundStyle(.white)

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 5) {
                    Text("\(Int(avg.playingYardage)) yd")
                        .font(.system(size: 17, weight: .semibold, design: .rounded))
                        .foregroundStyle(.white)
                    Image(systemName: avg.dominantShape.symbolName)
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(Color.shapeColor(avg.dominantShape))
                }
                Text(String(format: "%.0f mph · %.1f° · %d rpm · ±%.0f yd",
                            avg.ballSpeedMPH, avg.launchAngleDegrees,
                            Int(avg.spinRPM), avg.lateralStdDevYards))
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Color.lmTextTertiary)
            }
            Spacer()
        }
        .lmCard(padding: 13)
    }

    @ViewBuilder
    private var gapWarnings: some View {
        let problems = store.gapping.filter { $0.gap > 18 || $0.gap < 6 }
        if !problems.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader("Gaps worth a look")
                ForEach(problems, id: \.from.id) { p in
                    HStack(spacing: 9) {
                        Image(systemName: p.gap > 18
                              ? "arrow.up.and.down" : "arrow.down.right.and.arrow.up.left")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(p.gap > 18 ? Color.lmWarning : Color.lmAccent)
                        Text("\(p.from.club.shortName) → \(p.to.club.shortName)")
                            .font(.system(size: 13, weight: .semibold, design: .rounded))
                            .foregroundStyle(.white)
                        Spacer()
                        Text("\(Int(p.gap)) yd")
                            .font(.system(size: 13, weight: .semibold, design: .monospaced))
                            .foregroundStyle(p.gap > 18 ? Color.lmWarning : Color.lmAccent)
                    }
                }
                Text("Gaps over 18 yd leave yardages you can't cover; under 6 yd means two clubs doing one job.")
                    .font(.lmCaption).foregroundStyle(Color.lmTextTertiary)
            }
            .lmCard()
        }
    }
}

private extension Array where Element == RangeTarget {
    func uniqued() -> [RangeTarget] {
        var seen = Set<UUID>()
        return filter { seen.insert($0.id).inserted }
    }
}
