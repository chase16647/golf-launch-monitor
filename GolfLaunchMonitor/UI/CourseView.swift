//
//  CourseView.swift
//  GolfLaunchMonitor
//
//  Play a real course from the range mat. Hole map, live lie, caddie club
//  suggestion from your own measured yardages, running scorecard.
//

import SwiftUI

struct CourseView: View {
    @Bindable var course: CourseMode
    @Environment(SessionStore.self) private var store
    @State private var showScorecard = false
    @State private var courses = Course.loadBundled()

    var body: some View {
        Group {
            if course.course == nil {
                coursePicker
            } else if course.isRoundComplete {
                RoundSummary(course: course)
            } else {
                playing
            }
        }
        .background(Color.lmBackground)
        .navigationTitle(course.course?.name ?? "Course")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if course.course != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showScorecard = true } label: {
                        Image(systemName: "list.clipboard")
                    }
                }
            }
        }
        .sheet(isPresented: $showScorecard) {
            ScorecardView(course: course)
                .presentationDetents([.medium, .large])
        }
    }

    // MARK: Picker

    private var coursePicker: some View {
        ScrollView {
            VStack(spacing: 12) {
                ForEach(courses) { c in
                    Button { course.start(course: c) } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(c.name)
                                    .font(.system(size: 18, weight: .bold, design: .rounded))
                                    .foregroundStyle(.white)
                                Text("\(c.location) · \(c.holes.count) holes · Par \(c.par) · \(c.totalYards) yd")
                                    .font(.lmCaption).foregroundStyle(Color.lmTextSecondary)
                            }
                            Spacer()
                            Image(systemName: "chevron.right")
                                .foregroundStyle(Color.lmTextTertiary)
                        }
                        .lmCard()
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(16)
        }
    }

    // MARK: Playing

    @ViewBuilder
    private var playing: some View {
        if let hole = course.currentHole {
            ScrollView {
                VStack(spacing: 14) {
                    holeHeader(hole)
                    HoleMap(hole: hole, ball: course.ball)
                        .frame(height: 260)
                        .lmCard(padding: 10)
                    caddieCard
                    if let event = course.lastEvent { eventCard(event) }
                    controls
                }
                .padding(16)
            }
            .scrollIndicators(.hidden)
        }
    }

    private func holeHeader(_ hole: Hole) -> some View {
        HStack(spacing: 14) {
            VStack(spacing: 0) {
                Text("\(hole.number)")
                    .font(.system(size: 30, weight: .bold, design: .rounded))
                Text("HOLE").font(.system(size: 9, weight: .heavy)).tracking(1)
                    .foregroundStyle(Color.lmTextTertiary)
            }
            .foregroundStyle(.white)
            .frame(width: 58)

            VStack(alignment: .leading, spacing: 3) {
                Text("Par \(hole.par) · \(hole.yards) yd")
                    .font(.system(size: 16, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white)
                HStack(spacing: 6) {
                    Label(course.ball.lie.displayName, systemImage: course.ball.lie.symbolName)
                        .font(.lmCaption)
                        .foregroundStyle(Color.lmTextSecondary)
                    if course.penalties > 0 {
                        Text("+\(course.penalties) penalty")
                            .font(.lmCaption).foregroundStyle(Color.lmDanger)
                    }
                }
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 0) {
                Text("\(Int(course.distanceToPin))")
                    .font(.system(size: 30, weight: .bold, design: .rounded))
                    .foregroundStyle(Color.lmPrimary)
                Text("TO PIN").font(.system(size: 9, weight: .heavy)).tracking(1)
                    .foregroundStyle(Color.lmTextTertiary)
            }
        }
        .lmCard()
    }

    private var caddieCard: some View {
        HStack(spacing: 12) {
            Image(systemName: "figure.golf")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(Color.lmAccent)
            VStack(alignment: .leading, spacing: 2) {
                if let club = course.suggestedClub(using: store),
                   let yardage = store.playingYardage(for: club) {
                    Text("Caddie says \(club.displayName)")
                        .font(.system(size: 15, weight: .semibold, design: .rounded))
                        .foregroundStyle(.white)
                    Text("Your \(club.shortName) carries \(Int(yardage)) yd · \(course.ball.lie.displayName) plays \(Int((1 - course.ball.lie.carryFactor) * 100))% shorter")
                        .font(.lmCaption).foregroundStyle(Color.lmTextSecondary)
                } else {
                    Text("No yardages yet")
                        .font(.system(size: 15, weight: .semibold, design: .rounded))
                        .foregroundStyle(.white)
                    Text("Hit some range shots first so the caddie knows your distances.")
                        .font(.lmCaption).foregroundStyle(Color.lmTextSecondary)
                }
            }
            Spacer()
        }
        .lmCard()
    }

    private func eventCard(_ text: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "quote.bubble.fill")
                .foregroundStyle(Color.lmWarning)
            Text(text)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(.white)
            Spacer()
        }
        .lmCard(padding: 13)
        .transition(.move(edge: .top).combined(with: .opacity))
    }

    private var controls: some View {
        HStack(spacing: 10) {
            Button("Hole Out") { course.holeOut() }
                .buttonStyle(.borderedProminent)
                .tint(.lmPrimary)
            Button("Skip") { course.skipHole() }
                .buttonStyle(.bordered)
                .tint(.lmTextSecondary)
            Spacer()
            Text("\(course.strokes + course.penalties) strokes")
                .font(.system(size: 13, weight: .semibold, design: .monospaced))
                .foregroundStyle(Color.lmTextSecondary)
        }
    }
}

// MARK: - Hole map

struct HoleMap: View {
    let hole: Hole
    let ball: BallPosition

    var body: some View {
        Canvas { context, size in
            let totalYards = Double(hole.yards) + 30
            let maxOffset = 80.0

            func project(_ distance: Double, _ offset: Double) -> CGPoint {
                CGPoint(x: size.width / 2 + (offset / maxOffset) * (size.width / 2 - 10),
                        y: size.height - 16 - (distance / totalYards) * (size.height - 32))
            }

            // Fairway ribbon along the centreline.
            var fairway = Path()
            let steps = 40
            var leftEdge: [CGPoint] = [], rightEdge: [CGPoint] = []
            for i in 0...steps {
                let d = Double(i) / Double(steps) * Double(hole.yards)
                let o = hole.centrelineOffset(at: d)
                leftEdge.append(project(d, o - hole.fairwayHalfWidth))
                rightEdge.append(project(d, o + hole.fairwayHalfWidth))
            }
            fairway.move(to: leftEdge[0])
            for p in leftEdge.dropFirst() { fairway.addLine(to: p) }
            for p in rightEdge.reversed() { fairway.addLine(to: p) }
            fairway.closeSubpath()
            context.fill(fairway, with: .color(Color.lmPrimary.opacity(0.13)))

            // Hazards.
            for hazard in hole.hazards {
                let a = project(hazard.fromYards, min(hazard.fromOffset, hazard.toOffset))
                let b = project(hazard.toYards, max(hazard.fromOffset, hazard.toOffset))
                let rect = CGRect(x: min(a.x, b.x), y: min(a.y, b.y),
                                  width: abs(b.x - a.x), height: abs(b.y - a.y))
                let color: Color = switch hazard.kind {
                case .water: Color(red: 0.2, green: 0.5, blue: 0.95)
                case .bunker: Color(red: 0.92, green: 0.83, blue: 0.55)
                case .trees: Color(red: 0.15, green: 0.45, blue: 0.22)
                case .outOfBounds: Color.lmDanger
                }
                context.fill(Path(roundedRect: rect, cornerRadius: 6),
                             with: .color(color.opacity(hazard.kind == .outOfBounds ? 0.16 : 0.45)))
            }

            // Green.
            let greenCentre = project(Double(hole.greenDistance),
                                      hole.centrelineOffset(at: Double(hole.greenDistance)))
            let gr = (hole.greenRadius / maxOffset) * (size.width / 2 - 10)
            context.fill(Path(ellipseIn: CGRect(x: greenCentre.x - gr, y: greenCentre.y - gr * 0.6,
                                                width: gr * 2, height: gr * 1.2)),
                         with: .color(Color.lmPrimary.opacity(0.42)))

            // Pin.
            var pin = Path()
            pin.move(to: greenCentre)
            pin.addLine(to: CGPoint(x: greenCentre.x, y: greenCentre.y - 14))
            context.stroke(pin, with: .color(.white), lineWidth: 1.5)
            context.fill(Path(CGRect(x: greenCentre.x, y: greenCentre.y - 14,
                                     width: 8, height: 6)),
                         with: .color(.lmDanger))

            // Ball.
            let bp = project(ball.distanceFromTee, ball.offset)
            context.fill(Path(ellipseIn: CGRect(x: bp.x - 5, y: bp.y - 5, width: 10, height: 10)),
                         with: .color(.white))
            context.stroke(Path(ellipseIn: CGRect(x: bp.x - 8, y: bp.y - 8, width: 16, height: 16)),
                           with: .color(.white.opacity(0.4)), lineWidth: 1)

            // Line to the pin.
            var aim = Path()
            aim.move(to: bp)
            aim.addLine(to: greenCentre)
            context.stroke(aim, with: .color(.white.opacity(0.28)),
                           style: StrokeStyle(lineWidth: 1, dash: [4, 5]))
        }
    }
}

// MARK: - Scorecard

struct ScorecardView: View {
    @Bindable var course: CourseMode

    var body: some View {
        NavigationStack {
            List {
                ForEach(course.scorecard) { score in
                    HStack {
                        Text("\(score.holeNumber)")
                            .font(.system(size: 15, weight: .bold, design: .rounded))
                            .frame(width: 26)
                        Text("Par \(score.par)")
                            .font(.lmCaption).foregroundStyle(.secondary)
                        Spacer()
                        Text(score.scoreName)
                            .font(.lmCaption)
                            .foregroundStyle(score.toPar <= 0 ? Color.lmPrimary : Color.lmWarning)
                        Text("\(score.strokes)")
                            .font(.system(size: 17, weight: .bold, design: .rounded))
                            .frame(width: 30, alignment: .trailing)
                    }
                }
            }
            .navigationTitle("Scorecard")
            .navigationBarTitleDisplayMode(.inline)
            .safeAreaInset(edge: .bottom) {
                HStack {
                    Text("Through \(course.scorecard.count)")
                        .font(.lmCaption).foregroundStyle(.secondary)
                    Spacer()
                    Text(course.totalToPar == 0 ? "E"
                         : (course.totalToPar > 0 ? "+\(course.totalToPar)" : "\(course.totalToPar)"))
                        .font(.system(size: 20, weight: .bold, design: .rounded))
                        .foregroundStyle(course.totalToPar <= 0 ? Color.lmPrimary : Color.lmWarning)
                }
                .padding()
                .background(.ultraThinMaterial)
            }
        }
    }
}

struct RoundSummary: View {
    @Bindable var course: CourseMode

    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                VStack(spacing: 6) {
                    Text(course.totalToPar == 0 ? "Even Par"
                         : (course.totalToPar > 0 ? "+\(course.totalToPar)" : "\(course.totalToPar)"))
                        .font(.system(size: 48, weight: .bold, design: .rounded))
                        .foregroundStyle(Color.lmPrimary)
                    Text("\(course.scorecard.reduce(0) { $0 + $1.strokes }) strokes")
                        .font(.lmBody).foregroundStyle(Color.lmTextSecondary)
                }
                .frame(maxWidth: .infinity)
                .lmCard(padding: 26)

                ScorecardView(course: course).frame(height: 400)
            }
            .padding(16)
        }
    }
}
