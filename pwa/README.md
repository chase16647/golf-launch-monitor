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
| **Analyze** | A real frame-by-frame scrubber for ANY video — including slo-mo shot with the stock Camera app — plus a GolfTec-style skeleton overlay with live spine/shoulder/hip angles and an address-position ghost comparison. |
| **Course** | GPS round tracking on a free satellite map. Auto-detects tee/green from OpenStreetMap where the course is mapped; otherwise mark the tee and pin once and it's remembered forever. Scorecard, stats, handicap index, Skins/Nassau. |
| **Range** | Landing pattern with a one-sigma dispersion ellipse, coloured by shot shape. |
| **Bag** | Yardage book built from saved shots, carry gapping, and your Handicap Index once you have 3+ rounds logged with a course rating/slope. |
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

## Analyze: any video, real frame stepping

The stock Camera app's scrub bar is a finger-drag over the whole clip — it is
genuinely hard to land on one specific frame. This is the fix: import a video
(any format Safari can play, including 120/240fps slo-mo) and step through it
one frame at a time with dedicated buttons, not a drag gesture. There is no
way to know an arbitrary imported file's real per-frame timing cross-browser,
so you tell it the frame rate you shot at (same thing iOS already showed you
in the Camera app's slo-mo picker) and it steps in exact multiples of that.

**Verified working end-to-end**: a real recorded video pushed through the
import path in the browser correctly reported 42 frames for a ~1.4s clip at a
30fps step, and frame-stepping/jump-to-frame both worked with zero errors.

### The pose overlay — what it actually is

On-device pose detection (MediaPipe, WASM, no server, ~5.7MB model fetched
once and cached). Draws a skeleton and computes spine tilt, shoulder tilt, hip
tilt, and head sway relative to an address position you mark.

**What it is not**: GolfTec uses multiple synchronised cameras or true motion
capture. This is one camera, so every angle is a 2D projection of a 3D
motion — a face-on camera reads spine tilt and sway well but foreshortens
shoulder turn; down-the-line does the opposite. There is no single camera
position that reads everything correctly, because that needs a second camera.
The app labels every angle "approx." and is most useful compared against your
own address position, not as an absolute number. Confidence also drops hard
through the downswing — motion blur at swing speed degrades keypoint
detection exactly when you most want it.

### Reference lines — draw and snap perfectly straight

The other half of a coaching overlay: drag a straight line onto the paused
frame — a plumb line down the spine, a level line at ball height, a shaft-
plane line at address. Get close to level or plumb and it **snaps in exactly
straight**, correcting for a shaky finger.

This is not cosmetic labelling — a "straight line" that reads 2° off is worse
than no line at all, because it looks authoritative while being wrong. On a
snap, the line's actual pixels are recomputed from the snapped angle and the
drag length, not just relabelled: `node tools/verify-snap.mjs` reproduces the
check that a near-level drag reconstructs to a line measuring *exactly*
0.000000°, not "close to zero." A real bug was caught this way during
development — the original snap logic rounded to the nearest 15° grid step
before checking whether that step was level/plumb, which made the wider
"easy to snap" catch radius unreachable past 7.5° off-axis. Fixed by checking
the four cardinal directions independently, before falling through to the
general grid; `test/linedraw.test.mjs` pins the exact case that broke.

Level and plumb lines automatically extend to the full width/height of the
frame — that's how a ground or plumb reference is actually used, as a guide
spanning the whole image, not a short drawn segment. Lines persist as you
scrub through every frame of the clip, which is the point: mark a plumb line
at address and watch exactly how far the head or hips drift from it through
the swing. Multiple lines, each a different colour, with per-line delete plus
undo/clear-all.

**Verified working**: the model fetch returns a real 200 from Google's model
CDN, the WASM pipeline runs without throwing, and it correctly reports "no
pose found" on a synthetic test image with no person in it rather than
hallucinating a false positive.

## Course: free satellite map + real course data where it exists

Three ways a hole's tee/green get filled in, tried in order:

1. **OpenStreetMap has this course tagged** → auto-detected from GPS, zero
   taps. Real surveyed tee/green/bunker/hazard shapes, for courses that have
   been mapped by OSM contributors.
2. **You've played this exact hole before in this app** → remembered forever
   from a rounded GPS key, even when OSM has nothing.
3. **Neither** → mark the tee, walk to the pin, mark that once. It is
   remembered after, so this is a one-time cost per hole, not per round.

Satellite imagery is Esri World Imagery (free, no key). Course geometry is
OpenStreetMap via the free Overpass API. Both cost nothing and need no
account.

**Coverage, stated plainly**: OSM's golf tagging is volunteer-contributed.
Well-known and public courses are often mapped in real detail. Plenty of
smaller or private courses have nothing tagged at all — you get the manual
fallback for those, which still works and still gets remembered.

**A verification gap worth knowing about**: the public Overpass mirrors block
requests from datacenter/cloud IPs as anti-scraping protection, which is
exactly what this looked like in development, so the query returned 406 and
could not be tested end-to-end from here. It is standard Overpass QL and
should work normally from a phone's browser — ordinary residential/mobile
traffic — but **this specific piece needs testing on a real device**. Every
other part of the pipeline (satellite tiles, the GPS round flow, remembered
holes, scorecard, handicap) was verified directly, including two real bugs
found and fixed while testing: a null map-centre crash during the loading
phase, and a fallback gate that silently broke when fixing the first bug (it
checked `!tee` for "no source resolved yet", which stopped being true once
`tee` was given a placeholder default — fixed by gating on `source` instead).

### Scorecard, handicap, and games

`js/scorecard/handicap.js` implements the standard WHS differential and index
formula — `(score − rating) × 113 / slope`, best-N-of-last-20 averaged and
scaled by 0.96 — verified against a published worked example. Not the full
official spec (no Playing Conditions Calculation, no exceptional-score
capping, both of which need USGA's live data feed), but the core formula every
golfer recognises as "my handicap." Skins and Nassau are pure scoring math,
entered by one person for the group — no accounts, no server.

### What's deliberately not here

No social feed, no leaderboards — those need a backend server, which this
app does not have and was not asked to have. No licensed hazard/green-contour
data for every course on Earth — that needs a paid provider. Both are honest
scope cuts, not oversights.

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

- **Overpass (OSM course data) is unverified from this environment** — see the
  Course section above. Test it on a phone and report what you see.
- Shot entry on the calculator is manual by design — see *What it is NOT* above.
- No social feed or leaderboards (needs a backend); no paid course-data license
  for hazard/green-contour accuracy on every course.
