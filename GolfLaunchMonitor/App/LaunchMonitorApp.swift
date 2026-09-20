//
//  LaunchMonitorApp.swift
//  GolfLaunchMonitor
//

import SwiftUI

@main
struct LaunchMonitorApp: App {
    @State private var store = SessionStore()
    @StateObject private var pipeline = ShotPipeline()
    @State private var range = RangeMode()
    @State private var course = CourseMode()

    var body: some Scene {
        WindowGroup {
            RootView(pipeline: pipeline, range: range, course: course)
                .environment(store)
                .preferredColorScheme(.dark)
                .onAppear {
                    // A range session is the reason the phone is out of the
                    // pocket — don't let it sleep between shots.
                    UIApplication.shared.isIdleTimerDisabled = true

                    pipeline.onShotRecorded = { shot in
                        store.record(shot)
                        range.score(shot)
                        if course.course != nil, !course.isRoundComplete {
                            course.play(shot)
                        }
                    }
                }
        }
    }
}

struct RootView: View {
    @ObservedObject var pipeline: ShotPipeline
    @Bindable var range: RangeMode
    @Bindable var course: CourseMode
    @Environment(SessionStore.self) private var store

    @State private var tab: AppTab = .capture
    @State private var presentedShot: ShotResult?

    /// Named AppTab, not Tab: SwiftUI has its own `Tab` view, and shadowing it
    /// makes `Tab("Monitor", ...)` resolve to this enum, which has no such
    /// initializer.
    enum AppTab: Hashable { case capture, range, course, bag }

    var body: some View {
        TabView(selection: $tab) {
            Tab("Monitor", systemImage: "camera.metering.center.weighted", value: AppTab.capture) {
                CaptureView(pipeline: pipeline)
            }
            Tab("Range", systemImage: "target", value: AppTab.range) {
                NavigationStack { RangeView(range: range, pipeline: pipeline) }
            }
            Tab("Course", systemImage: "flag.fill", value: AppTab.course) {
                NavigationStack { CourseView(course: course) }
            }
            Tab("Bag", systemImage: "bag.fill", value: AppTab.bag) {
                NavigationStack { BagView() }
            }
        }
        .tint(.lmPrimary)
        .onChange(of: pipeline.lastShot) { _, shot in
            // Surface the full breakdown automatically — the whole point is
            // that you don't walk over to the phone after every swing.
            if let shot { presentedShot = shot }
        }
        .sheet(item: $presentedShot) { shot in
            NavigationStack {
                ShotResultView(shot: shot, frames: pipeline.capturedFrames)
                    .navigationTitle(shot.club.displayName)
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button("Done") { presentedShot = nil }
                        }
                        ToolbarItem(placement: .topBarLeading) {
                            Button(role: .destructive) {
                                store.deleteShot(shot)
                                presentedShot = nil
                            } label: {
                                Image(systemName: "trash")
                            }
                        }
                    }
            }
            .presentationDetents([.large])
        }
    }
}
