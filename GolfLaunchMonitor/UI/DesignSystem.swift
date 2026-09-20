//
//  DesignSystem.swift
//  GolfLaunchMonitor
//
//  Dark-first, OLED-native. The app is used outdoors in bright sun and at
//  dusk, so contrast is high and the background is true black — which on the
//  iPhone 17 Pro's OLED means those pixels are literally off, saving power
//  through a long range session.
//
//  Type is SF Pro with rounded numerals for the big metrics: golf numbers read
//  better with the geometric feel, and monospaced digits stop the tiles
//  jittering as values change.
//

import SwiftUI

// MARK: - Colour

extension Color {
    /// True black. Not near-black — we want the OLED pixels off.
    static let lmBackground = Color.black
    static let lmSurface = Color(white: 0.07)
    static let lmSurfaceElevated = Color(white: 0.12)
    static let lmSeparator = Color(white: 0.20)

    static let lmPrimary = Color(red: 0.36, green: 0.95, blue: 0.52)   // signal green
    static let lmAccent = Color(red: 0.22, green: 0.62, blue: 1.00)    // iOS blue
    static let lmWarning = Color(red: 1.00, green: 0.72, blue: 0.20)
    static let lmDanger = Color(red: 1.00, green: 0.32, blue: 0.32)

    static let lmTextPrimary = Color.white
    static let lmTextSecondary = Color(white: 0.62)
    static let lmTextTertiary = Color(white: 0.40)

    /// Shot-shape colour: draws cool, fades warm, straight neutral.
    static func shapeColor(_ shape: ShotShape) -> Color {
        switch shape {
        case .straight, .pullStraight, .pushStraight: .lmPrimary
        case .draw, .pullDraw, .pushDraw: Color(red: 0.36, green: 0.78, blue: 1.0)
        case .fade, .pullFade, .pushFade: Color(red: 1.0, green: 0.78, blue: 0.36)
        case .hook: Color(red: 0.42, green: 0.52, blue: 1.0)
        case .slice: Color(red: 1.0, green: 0.48, blue: 0.32)
        }
    }

    static func confidenceColor(_ c: Double) -> Color {
        switch c {
        case 0.7...: .lmPrimary
        case 0.4..<0.7: .lmWarning
        default: .lmDanger
        }
    }
}

// MARK: - Type

extension Font {
    /// The hero number on a metric tile.
    static func lmMetric(_ size: CGFloat = 46) -> Font {
        .system(size: size, weight: .semibold, design: .rounded)
            .monospacedDigit()
    }
    static let lmMetricLabel = Font.system(size: 12, weight: .semibold, design: .rounded)
    static let lmUnit = Font.system(size: 15, weight: .medium, design: .rounded)
    static let lmTitle = Font.system(size: 22, weight: .bold, design: .rounded)
    static let lmBody = Font.system(size: 15, weight: .regular)
    static let lmCaption = Font.system(size: 12, weight: .medium)
}

// MARK: - Metric tile

/// The big readouts. Sized generously because they're read from ten feet away
/// while the phone sits on the ground.
struct MetricTile: View {
    var label: String
    var value: String
    var unit: String?
    var tint: Color = .lmTextPrimary
    var emphasis: Emphasis = .standard
    var footnote: String?

    enum Emphasis { case hero, standard, compact }

    private var valueSize: CGFloat {
        switch emphasis {
        case .hero: 56
        case .standard: 38
        case .compact: 26
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label.uppercased())
                .font(.lmMetricLabel)
                .tracking(0.8)
                .foregroundStyle(Color.lmTextTertiary)

            HStack(alignment: .firstTextBaseline, spacing: 3) {
                Text(value)
                    .font(.lmMetric(valueSize))
                    .foregroundStyle(tint)
                    .contentTransition(.numericText())
                if let unit {
                    Text(unit)
                        .font(.lmUnit)
                        .foregroundStyle(Color.lmTextSecondary)
                }
            }
            .lineLimit(1)
            .minimumScaleFactor(0.6)

            if let footnote {
                Text(footnote)
                    .font(.lmCaption)
                    .foregroundStyle(Color.lmTextTertiary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.vertical, emphasis == .hero ? 18 : 14)
        .background(Color.lmSurface, in: .rect(cornerRadius: 18))
        .overlay(
            RoundedRectangle(cornerRadius: 18)
                .strokeBorder(Color.lmSeparator.opacity(0.6), lineWidth: 0.5)
        )
    }
}

// MARK: - Chrome

/// Glass pill used for status chips over the camera feed.
struct StatusPill: View {
    var text: String
    var systemImage: String?
    var tint: Color = .lmTextPrimary

    var body: some View {
        HStack(spacing: 6) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.system(size: 11, weight: .bold))
            }
            Text(text)
                .font(.system(size: 12, weight: .semibold, design: .rounded))
        }
        .foregroundStyle(tint)
        .padding(.horizontal, 11)
        .padding(.vertical, 6)
        .background(.ultraThinMaterial, in: Capsule())
        .overlay(Capsule().strokeBorder(tint.opacity(0.28), lineWidth: 0.5))
    }
}

/// Primary action button, full width.
struct PrimaryButton: View {
    var title: String
    var systemImage: String?
    var tint: Color = .lmPrimary
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if let systemImage { Image(systemName: systemImage) }
                Text(title).font(.system(size: 17, weight: .semibold, design: .rounded))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
            .background(tint, in: .rect(cornerRadius: 16))
            .foregroundStyle(.black)
        }
        .buttonStyle(.plain)
        .sensoryFeedback(.impact(weight: .medium), trigger: title)
    }
}

/// Section header with optional trailing accessory.
struct SectionHeader<Trailing: View>: View {
    var title: String
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack {
            Text(title)
                .font(.system(size: 13, weight: .semibold, design: .rounded))
                .tracking(0.6)
                .foregroundStyle(Color.lmTextTertiary)
            Spacer()
            trailing
        }
    }
}

extension SectionHeader where Trailing == EmptyView {
    init(_ title: String) { self.init(title: title) { EmptyView() } }
}

// MARK: - Confidence bar

/// Small inline bar. Used wherever we show a number we only partly believe —
/// which, for spin, is always.
struct ConfidenceBar: View {
    var confidence: Double
    var label: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            if let label {
                Text(label)
                    .font(.lmCaption)
                    .foregroundStyle(Color.lmTextTertiary)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.lmSeparator)
                    Capsule()
                        .fill(Color.confidenceColor(confidence))
                        .frame(width: geo.size.width * confidence.clamped(to: 0...1))
                }
            }
            .frame(height: 4)
        }
    }
}

// MARK: - Modifiers

extension View {
    /// Standard card treatment.
    func lmCard(padding: CGFloat = 16) -> some View {
        self.padding(padding)
            .background(Color.lmSurface, in: .rect(cornerRadius: 20))
            .overlay(
                RoundedRectangle(cornerRadius: 20)
                    .strokeBorder(Color.lmSeparator.opacity(0.6), lineWidth: 0.5)
            )
    }
}
