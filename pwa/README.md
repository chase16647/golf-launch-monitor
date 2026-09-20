# Launch Monitor — PWA

Runs in a browser, installs to your home screen, works offline. No build step,
no npm install, no framework.

## Run it

```bash
cd E:\laucnhmonoitorphoeneapp\pwa
node .claude-serve.mjs
```

It serves **https on 8443** and http on 8099, and prints an address per network
adapter. **On a phone you must use the https one.**

### Why https is not optional

iOS gates both APIs this app needs behind a *secure context*:

* `DeviceOrientationEvent.requestPermission()` — tilt, lean, compass
* `navigator.mediaDevices.getUserMedia()` — the camera

Over plain http on a LAN address, Safari does not merely deny these — it
**hides the APIs entirely**, so naive feature detection reports "this device has
no motion sensors" on a phone that obviously has them. `localhost` is exempt,
which is why everything works on the desktop and nothing works on the phone.

The cert in `.certs/` is self-signed, so Safari warns once. Tap
**Advanced → Visit Website**. After that the origin is a proper secure context
and both APIs light up. Regenerate it if your LAN IP changes:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -keyout .certs/key.pem   -out .certs/cert.pem -days 825 -config .certs/openssl.cnf
```

Run the tests any time:

```bash
node --test "test/*.test.mjs"
```

(Quote the glob. Plain `node --test test/` fails on Windows — Node resolves the
bare word `test` as a module name instead of a directory.)

## Put it on your iPhone home screen

1. Open the `192.168.x.x:8099` URL in **Safari** (not Chrome — only Safari can
   install a PWA on iOS).
2. Share button → **Add to Home Screen**.
3. It launches full screen with no browser chrome, and works offline after the
   first load.

## What it does

| Tab | What it is |
|---|---|
| **Capture** | Live camera, auto-trigger on the strike, and a frame-by-frame replay with a tracer. This is the part of a launch monitor a browser genuinely can do. |
| **Range** | Landing pattern with a one-sigma dispersion ellipse, coloured by shot shape. |
| **Bag** | Yardage book built from saved shots, with carry gapping and warnings for gaps over 18 yd or under 6 yd. |
| **Align** | Live tilt/lean/squareness from the phone's motion sensors, target-line capture, and saved setup profiles so you reproduce the same rig every time. |
| **Guide** | Rig geometry, the error budget worst-first, a camera test that measures what your device delivers, and the flight calculator. |

## Setup & repeatability

The **Align** tab is the part that works identically on web and native, because
it is all static measurement rather than high-speed tracking.

**The principle: the app does not need a PERFECT position, it needs a KNOWN
one.** Every way a phone can be misplaced is a measurable degree of freedom,
and measured error is correctable error. Costs measured against the flight
model (driver, 150 mph — reproduce with `node tools/dof-analysis.mjs`):

| Axis | Misplaced by | If ignored | **If measured** |
|---|---|---|---|
| Lean (pitch) | 20° | 0.9° launch | **exact** |
| Tilt (roll) | 10° | 10° launch | **0.3°** |
| Square (yaw) | 20° | 6.4% speed (19 yd) | **1.3%** |
| Distance | 5% | 5% speed (14 yd) | **not correctable** |

Which gives three rules:

1. **Lean freely.** Pitch is nearly free. A phone against a headcover is fine.
2. **Yaw must be measured.** Gravity is physically blind to rotation about the
   vertical axis, so an accelerometer *cannot* detect being off-square. That is
   what the target-line capture is for — and it is the single most valuable
   thing in the tab.
3. **Distance is sacred.** It goes 1:1 into ball speed and nothing downstream
   recovers it.

One free accuracy win worth knowing: the ball sits still while you are armed,
so its measured size can be averaged. A single frame at 5 ft gives distance to
±3.8% (≈11 yd of carry); 60 averaged frames give ±0.6% (≈2 yd).

### No tripod

Lean it against a headcover, a shoe, a water bottle, a range bucket or the bag.
Best of all, lay a club on the ground pointing at your target and stand the
phone against the shaft — the shaft is a straight edge, so it squares you up
for free. The real risk is not the angle, it is **slipping**: put something
solid in front of the bottom edge, and the Steady check will warn you if it
shifts after you calibrate.

## What it is NOT

**It does not track the ball with the camera.** That is not a missing feature,
it is a browser limitation, and the Camera tab proves it on your own hardware
rather than asking you to take my word for it:

| Need | Native iOS | Browser |
|---|---|---|
| 240 fps capture | yes | no — 30, sometimes 60 |
| 1/2000 s shutter lock | yes | no API |
| ISO lock | yes | no API |
| LiDAR depth for scale | yes | no API |

The arithmetic: at 30 fps a 150 mph ball travels **7.3 feet between frames**,
and the camera sees about 7 feet of width from 5 feet away. The ball appears in
roughly one frame. You need 4+ points for a speed and 5+ for a curve.

So this app does the three things a browser genuinely can:

1. **Replay the strike** — Capture tab. Frame-by-frame, tracer, save a frame.
2. **Get the rig right** — Align tab. Tilt, lean, squareness, saved profiles.
3. **Model the flight** — the calculator, and the yardage book built from it.

What it cannot do is measure ball speed off your swing. The app that does that
is **ShotVision**, and it works because it is a *native* iOS app with 240 fps
`AVCaptureSession` access. That is exactly what the Swift code in
`../GolfLaunchMonitor/` does. It is an API wall, not an effort problem.

### Getting the native app onto a phone without owning a Mac

1. Push the repo to **GitHub** (public repo = free macOS runners).
2. A GitHub Actions workflow on `macos-latest` runs `xcodebuild` and produces
   an unsigned `.ipa`.
3. Install it with **AltStore** or **SideStore** using a free Apple ID. Apps
   signed this way expire after 7 days; AltStore re-signs automatically over
   Wi-Fi while it is on the same network.

Total cost: nothing. The $99 Apple Developer Program is only needed for
TestFlight or the App Store.

## Physics

Same model as the Swift app, ported and independently verified:

- RK4 integration over drag + Magnus + gravity, 2 ms step, 3D with a tilted
  spin axis so shots actually curve.
- Aero coefficients fitted against published Trackman PGA Tour averages.
  **Mean carry error 6.3 yd** across Driver / 3W / 5i / 7i / PW.
- Spin decay pinned at the measured ~4 %/s. An unconstrained fit scored better
  by making the ball *gain* spin in flight; that was rejected as unphysical.

Bugs caught during the build, all now covered by tests:

1. **Inverted Magnus cross product** — backspin generated downforce and drives
   carried 68 yards. `positive spin axis curves right...` guards it.
2. **Quadratic spin model** — gave a pitching wedge 19,834 rpm (real: 9,316),
   clamping every lofted club to its range ceiling so the model carried no
   information. Now linear at ~180 rpm per degree of loft.
3. **Roll judged against portrait** — the app is used in LANDSCAPE, where roll
   is ±90° by design. The tolerance check was telling every correctly-placed
   user to "straighten up". Roll is now measured as deviation from the nearest
   quarter turn (`rollDeviation`).
4. **"90° off square" right after capturing the target line** — at that moment
   the user is still standing behind the ball holding the phone. Technically
   true, useless advice. There is now an explicit in-hand state.
5. **Unscoped DOM queries in the Align view** — used `document.querySelector`
   for generic IDs like `#in-distance`, so two instances would fight. Scoped to
   the view root.

## Known gaps

- **Service worker is unverified.** It registers correctly in real browsers but
  could not be tested in the embedded pane used during development, so treat
  offline mode as "should work" rather than "confirmed".
- No course mode yet (the native app has one).
- Shot entry is manual by design — see *What it is NOT* above.
