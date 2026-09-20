//
//  SessionStore.swift
//  GolfLaunchMonitor
//
//  Persistence + the "what are my numbers" layer that turns a pile of shots
//  into a yardage book.
//

import Foundation
import Observation

@MainActor
@Observable
final class SessionStore {

    private(set) var sessions: [PracticeSession] = []
    var activeSession: PracticeSession?

    /// Rolling career averages across every session, used by the course caddie
    /// when the current session is too thin to be meaningful.
    private(set) var careerAverages: [Club: ClubAverage] = [:]

    private let fileURL: URL = {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory,
                                           in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("sessions.json")
    }()

    init() { load() }

    // MARK: Session lifecycle

    func startSession(name: String? = nil, mode: PracticeSession.SessionMode = .range) {
        let formatter = DateFormatter()
        formatter.dateFormat = "MMM d, h:mm a"
        let session = PracticeSession(name: name ?? formatter.string(from: Date()),
                                      mode: mode)
        activeSession = session
    }

    func record(_ shot: ShotResult) {
        if activeSession == nil { startSession() }
        activeSession?.shots.append(shot)
        // Persist eagerly. A practice session that vanishes because the app
        // was killed on a cold range is a bad day.
        save()
    }

    func endSession() {
        guard var s = activeSession, !s.shots.isEmpty else {
            activeSession = nil
            return
        }
        s.date = Date()
        sessions.insert(s, at: 0)
        activeSession = nil
        rebuildCareerAverages()
        save()
    }

    func deleteShot(_ shot: ShotResult) {
        activeSession?.shots.removeAll { $0.id == shot.id }
        for i in sessions.indices { sessions[i].shots.removeAll { $0.id == shot.id } }
        rebuildCareerAverages()
        save()
    }

    func deleteSession(_ session: PracticeSession) {
        sessions.removeAll { $0.id == session.id }
        rebuildCareerAverages()
        save()
    }

    // MARK: Yardage book

    /// The number to play. Prefers the current session when it has enough
    /// shots to be meaningful, otherwise falls back to career.
    func playingYardage(for club: Club) -> Double? {
        if let a = activeSession?.average(for: club), a.count >= 5 {
            return a.playingYardage
        }
        return careerAverages[club]?.playingYardage
    }

    func average(for club: Club) -> ClubAverage? {
        activeSession?.average(for: club) ?? careerAverages[club]
    }

    /// Full bag, sorted long to short, for the gapping chart.
    var yardageBook: [ClubAverage] {
        Club.allCases
            .compactMap { average(for: $0) }
            .sorted { $0.carryYards > $1.carryYards }
    }

    /// Gaps between consecutive clubs. Anything over ~18 yd or under ~6 yd is
    /// worth flagging — that's a hole or an overlap in the bag.
    var gapping: [(from: ClubAverage, to: ClubAverage, gap: Double)] {
        let book = yardageBook
        guard book.count > 1 else { return [] }
        return (0..<(book.count - 1)).map { i in
            (book[i], book[i + 1], book[i].carryYards - book[i + 1].carryYards)
        }
    }

    private func rebuildCareerAverages() {
        var all = PracticeSession(name: "career")
        all.shots = sessions.flatMap(\.shots)
        var out: [Club: ClubAverage] = [:]
        for club in Club.allCases {
            if let a = all.average(for: club) { out[club] = a }
        }
        careerAverages = out
    }

    // MARK: Persistence

    private func save() {
        var toSave = sessions
        if let active = activeSession, !active.shots.isEmpty {
            // Keep the in-progress session recoverable without committing it
            // to history yet.
            toSave.insert(active, at: 0)
        }
        do {
            let data = try JSONEncoder().encode(toSave)
            try data.write(to: fileURL, options: .atomic)
        } catch {
            print("SessionStore save failed: \(error)")
        }
    }

    private func load() {
        guard let data = try? Data(contentsOf: fileURL),
              let decoded = try? JSONDecoder().decode([PracticeSession].self, from: data)
        else { return }
        sessions = decoded
        rebuildCareerAverages()
    }
}
