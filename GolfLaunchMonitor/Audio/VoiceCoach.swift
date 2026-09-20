//
//  VoiceCoach.swift
//  GolfLaunchMonitor
//

import AVFoundation
import Foundation

/// Speaks the result the moment it's computed, so you can keep hitting without
/// walking back to the phone.
@MainActor
final class VoiceCoach {

    private let synthesizer = AVSpeechSynthesizer()

    var isEnabled = true
    var announcesShape = true
    var rate: Float = 0.52

    init() { configureAudioSession() }

    /// Duck other audio rather than stopping it — people practise with music on.
    private func configureAudioSession() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback,
                                 mode: .spokenAudio,
                                 options: [.duckOthers, .mixWithOthers])
        try? session.setActive(true)
    }

    func announce(_ shot: ShotResult) {
        guard isEnabled else { return }

        var parts: [String] = [
            "\(Int(shot.carryYards.rounded())) yards carry"
        ]

        if announcesShape && shot.shape != .straight {
            // Only claim a shape when we actually believe it.
            if shot.spinConfidence > 0.45 {
                parts.append(shot.shape.displayName.lowercased())
            }
        }

        parts.append("\(Int(shot.ballSpeedMPH.rounded())) mile per hour ball speed")

        speak(parts.joined(separator: ", "))
    }

    func speak(_ text: String) {
        guard isEnabled else { return }
        if synthesizer.isSpeaking {
            synthesizer.stopSpeaking(at: .immediate)
        }
        let utterance = AVSpeechUtterance(string: text)
        utterance.rate = rate
        utterance.pitchMultiplier = 1.0
        utterance.postUtteranceDelay = 0.1
        // Prefer a premium/enhanced voice when the user has one downloaded —
        // the default compact voice sounds rough over outdoor ambient noise.
        utterance.voice = Self.bestVoice()
        synthesizer.speak(utterance)
    }

    func stop() { synthesizer.stopSpeaking(at: .immediate) }

    private static func bestVoice() -> AVSpeechSynthesisVoice? {
        let language = AVSpeechSynthesisVoice.currentLanguageCode()
        let voices = AVSpeechSynthesisVoice.speechVoices()
            .filter { $0.language == language }
        return voices.first { $0.quality == .premium }
            ?? voices.first { $0.quality == .enhanced }
            ?? AVSpeechSynthesisVoice(language: language)
    }
}
