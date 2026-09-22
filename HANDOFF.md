# Handoff: golf launch monitor (Chase)

Updated 2026-09-21 so a fresh session (or Claude / Gemini) can continue seamlessly.

## Goal
Chase wants a ShotVision-style launch monitor on his iPhone 17 Pro that measures ball speed, launch angle, side spin (draw/fade/slice/hook), carry, with strike replay, range and course modes. Dark, Apple-like UI.

## Where everything is
- Local: `E:\laucnhmonoitorphoeneapp`
- GitHub (public): https://github.com/chase16647/golf-launch-monitor
- Live web app (GitHub Pages, real HTTPS): https://chase16647.github.io/golf-launch-monitor/
- Latest built native app IPA: `C:\Users\chase\Desktop\launchmonitor-ipa\GolfLaunchMonitor-unsigned.ipa` (~690 KB)
- Latest build workflow: https://github.com/chase16647/golf-launch-monitor/actions/workflows/ios.yml

## Two halves
1. **Native iOS**, `GolfLaunchMonitor/` (Swift 6, SwiftUI, iOS 18). The only version that measures ball speed (240 fps, locked shutter, LiDAR). Generated from `project.yml` via XcodeGen. GitHub Actions (`.github/workflows/ios.yml`, macos-latest) builds unsigned `.ipa` on push to `main`.
2. **PWA**, `pwa/`. Does what a browser can: strike capture + frame-by-frame replay with tracer, Align tab (tilt/lean/squareness from motion sensors, target line, saved setup profiles), flight calculator (in Guide tab), range dispersion, yardage book. Browsers cannot measure ball speed (30-60 fps, no shutter/ISO control, no LiDAR). Deploys via `.github/workflows/pages.yml`.

## Native iOS App & Sideloading Setup (Windows 11)
- **Sideloader**: Using **Sideloadly v0.60** on Windows 11 (preferred over AltServer due to USB direct connection and no mDNS tray daemon conflicts).
- **Free Apple ID Sideloading**: Apps signed with free Apple ID expire after 7 days (renew by re-running Sideloadly `Start`).
- **Device Requirements**:
  - Phone: iPhone 17 Pro (iOS 18).
  - Settings > Privacy & Security > Developer Mode: **ON** (requires restart).
  - Settings > General > VPN & Device Management: Trust developer profile.
- **Installing the IPA**:
  1. Delete old app icon from iPhone Home Screen if re-installing (clears iOS launch cache).
  2. Open Sideloadly on PC -> select `Desktop\launchmonitor-ipa\GolfLaunchMonitor-unsigned.ipa` -> enter free Apple ID -> click **Start**.
  3. Open `GolfLaunchMonitor` on iPhone.

## Critical Bugs Diagnosed & Fixed in Native App Codebase
- **`VoiceCoach` Audio Session Launch Crash**: Removed eager `AVAudioSession.sharedInstance().setActive(true)` call from `VoiceCoach.init()` which threw unhandled OSStatus exception on app launch before app window reached active state. Audio session activation deferred lazily to `speak()`.
- **`import Synchronization` (`Atomic<Int>`) dyld Crash**: Removed Swift 6 `Synchronization` module dependency in `FrameRingBuffer.swift` and replaced with standard `os_unfair_lock` thread-safe counter. Prevents `dyld: Symbol not found` launch crashes on free-signed binaries.
- **Swift 6 `@MainActor` Struct Initialization**: Annotated `@main struct LaunchMonitorApp` with `@MainActor` to prevent `@StateObject` initialization concurrency mismatches.
- **Sideloadly Codesign & Product Name Spaces**: Changed `PRODUCT_NAME` in `project.yml` from `Launch Monitor` to `GolfLaunchMonitor` and updated `PRODUCT_BUNDLE_IDENTIFIER` to `com.chase.launchmonitor`. Eliminates spaces in `.app` executable paths that broke Sideloadly Python codesign (`0xe8008001: ApplicationVerificationFailed` and `Guru Meditation missing 1 required positional argument: 'orig'`).
- **`UILaunchScreen` Resource Reference Fix**: Replaced `<key>UIColorName</key><string></string>` in `Info.plist` with valid empty dict `<dict/>`, fixing SpringBoard launch scene cancellation on iOS 18.
- **UIKit Scene Presentation & Orientation Fix**: Added `UIInterfaceOrientationPortrait` and `<key>UIRequiresFullScreen</key><true/>` to `Info.plist` so iOS SpringBoard allows scene presentation when launched from the Portrait Home Screen.

## Local Dev Commands
- PWA local server: `cd pwa; node .claude-serve.mjs` (HTTPS 8443, HTTP 8099 desktop only)
- PWA tests: `node --test "test/*.test.mjs"` (29 passing).
- Commit rule: Bash apostrophes inside heredocs/commit messages break quoting; write commit messages to a temp file and use `git commit -F`. `gh` is authenticated as `chase16647`.

## Decisions & Physics Constants
- Flight model fitted to Trackman tour averages (mean carry error ~6.2 yd). Spin decay pinned at 4%/s (do NOT unpin).
- Back spin is modelled (linear in loft: `820 + 180 * loft`). Side spin is measured from flight curvature.
- Setup insight: phone needs a KNOWN position, not a perfect one. Lean/tilt are measurable & correctable; yaw needs target-line capture; distance is 1:1 with ball speed.
- Swift strict concurrency (`SWIFT_STRICT_CONCURRENCY: complete`) is active.

## Working with Chase
Terse, dictates, on Windows. Wants me to run things ("u run"), not hand him instructions. Verifies by using the app, distrusts unproven claims, cost-sensitive.


## Update 2026-09-22: big PWA feature push, native sideloading parked

Chase asked to park the Sideloadly debugging loop (device-specific, hard to
debug blind, gemini already tried 3x) and instead build out the PWA toward
"every feature 18Birdies has." Scoped honestly rather than built blindly:
skipped anything needing a backend server (social feed, leaderboards) or a
paid course-data license (hazard-accurate satellite maps everywhere).

Shipped, all free/client-only:
- **Analyze tab**: real frame-by-frame video scrubber for ANY imported video
  (fixes "I hate scrolling the Camera app"), plus a GolfTec-style pose overlay
  (MediaPipe, on-device, ~5.7MB model cached after first use) with spine/
  shoulder/hip angles and an address-position ghost comparison. Both verified
  working end-to-end in-browser (real recorded video correctly stepped
  frame-by-frame; pose model fetched, ran, and correctly returned "no pose"
  on a person-less test image).
- **Course tab**: GPS round tracking on a free Esri satellite map, with real
  tee/green/hazard geometry from OpenStreetMap where a course is mapped
  (Overpass API), falling back to walk-and-mark (remembered forever after)
  where it isn't. Full round flow verified end-to-end (start -> mark pin ->
  mark shot -> hole out -> advance -> remembered-hole recall -> finish ->
  save -> handicap index). Found and fixed 2 real bugs during testing: a null
  map-centre crash, and a fallback gate that broke while fixing the first bug.
- **Scorecard/handicap**: real WHS-style differential/index formula (verified
  against a published worked example), round stats (GIR/fairways/putts),
  Skins and Nassau side games. Bag tab shows the handicap index once 3+ rounds
  are logged with a course rating/slope.

**Could NOT verify from this sandbox**: the Overpass (OpenStreetMap) course
data query. Overpass's public mirrors block datacenter/cloud IPs as
anti-scraping protection, and that's what this dev environment looks like to
them (406 on every request, even a bare GET to the server root). This should
work fine from a real phone browser (ordinary residential/mobile traffic) but
needs testing on-device — ask Chase what he sees when he opens Course at an
actual course. Esri satellite tiles WERE verified (plain HTTPS GET, real
image back, no key needed).

51/51 JS tests passing (added gps.test.mjs, handicap.test.mjs,
coursedata.test.mjs for the new pure-logic modules). New tabs pushed the tab
bar to 7; CSS shrunk slightly to fit (see css/app.css .tab rules).

Native iOS / Sideloadly debugging is explicitly ON HOLD per Chase's request,
not abandoned — pick it back up when he wants to return to it.
