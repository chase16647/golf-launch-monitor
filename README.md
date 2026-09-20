# Launch Monitor

An iPhone launch monitor for iPhone 17 Pro (A19 Pro, 48MP Fusion, LiDAR, iOS 18+).
Set the phone 4–7 ft to the side of the ball, hit, get numbers.

---

## Read this first

**This has never been compiled.** It was written on a Windows machine, and
iOS code only builds on a Mac with Xcode. Expect to fix compile errors on the
first build — probably a handful of SwiftUI API mismatches and `Sendable`
complaints from strict concurrency. The physics and the computer vision have
been reasoned through and numerically validated; the *Swift syntax* has not
been checked by a compiler.

What **was** verified, numerically, before it was written into Swift:

- The flight model's aero coefficients were fitted against published Trackman
  PGA Tour averages for five clubs. Mean carry error: **6.2 yd**.
- The Magnus sign convention was caught and fixed — an inverted cross product
  in the first draft produced 68-yard drives.
- An earlier fit reached 4.4 yd error by driving spin decay *negative* (the
  ball gaining spin in flight). That was rejected as unphysical; decay is
  pinned at the measured ~4 %/s and the honest, slightly worse fit shipped.
- The side-spin detectability budget (below) is arithmetic, not optimism.

---

## Build

```bash
brew install xcodegen && xcodegen generate && open GolfLaunchMonitor.xcodeproj
```

No XcodeGen? Make a new iOS App project called `GolfLaunchMonitor`, delete its
starter files, drag in the `GolfLaunchMonitor/` folder, target iOS 18.0.

Then run the tests — they pin the flight model to tour averages and will tell
you immediately if something's off:

```bash
xcodebuild test -scheme GolfLaunchMonitor -destination 'platform=iOS Simulator,name=iPhone 16 Pro'
```

---

## Can it tell a fade from a draw?

Yes — and this is the part most phone launch monitors fake. Here's the honest
engineering.

### What the camera actually gets to see

Phone 5 ft away, 1080p, ~68° FOV, ball starting centred:

| Ball speed | Frames before it exits the frame |
|-----------:|---------------------------------:|
| 90 mph     | 12.3 |
| 120 mph    | 9.2 |
| 150 mph    | 7.4 |
| 175 mph    | 6.3 |

So: **6–9 frames, about 30 ms of flight.** Everything follows from that.

### Back spin — not measured, modelled. Said so in the UI.

From the side, a backspinning ball rotates about an axis pointing nearly
*at the camera*. There's almost no observable surface motion. Every phone-only
launch monitor models back spin; we do too, from club + ball speed + launch
angle, and the app labels it "modelled" rather than implying a measurement.

### Side spin — genuinely measured, from curvature

Magnus side-force bends the ball off its launch line, and that bend is visible
within the tracked window:

| Spin axis tilt | Lateral deviation over 8 frames | At 5 ft, 1080p |
|---------------:|--------------------------------:|---------------:|
| 5°  (baby fade)| 3.64 mm | 3.4 px |
| 10° (fade)     | 4.79 mm | 4.5 px |
| 20° (slice)    | 6.28 mm | 5.9 px |
| 35° (big slice)| 7.72 mm | 7.2 px |

Against ~1 px centroid noise, anything from a firm fade upward is a real
signal. A 5° baby draw is marginal — which is why the app reports a
**confidence score** instead of pretending otherwise.

### Marker rotation — supported, but it aliases

If you draw a line on the ball, rotation can be tracked directly. At 240 fps
that works up to the Nyquist limit:

| Spin | Degrees/frame @240fps | |
|-----:|----------------------:|-|
| 2 700 rpm | 67.5° | fine |
| 6 000 rpm | 150.0° | fine |
| **7 200 rpm** | **180.0°** | **Nyquist** |
| 9 500 rpm | 237.5° | **aliases** — reads as −122.5°, i.e. backwards |

Above 7 200 rpm the measurement wraps, so `SpinAnalyzer.unwrapRotation` uses
the club's plausible spin range to pick the right wrap count. A wedge can't be
un-aliased without knowing it's a wedge.

### The three estimates are fused, not averaged

`SpinAnalyzer` combines **curvature** (strong), **marker rotation** (strongest
when available and unaliased) and a **D-plane prior** from start direction
(always available, deliberately weak) by inverse-variance weighting, with a χ²
penalty when they disagree. The fused σ becomes the confidence bar you see.

Shapes: straight / draw / fade / hook / slice, plus push and pull variants,
classified on **yards of curve** — 6 yd and 22 yd thresholds — because that's
what a golfer perceives, not degrees of spin axis.

---

## Also worth knowing

**Motion blur is the real enemy.** At 150 mph:

| Shutter | Smear | In ball diameters |
|--------:|------:|------------------:|
| 1/1000 s | 67.1 mm | 1.57× |
| 1/2000 s | 33.5 mm | 0.79× |
| 1/4000 s | 16.8 mm | 0.39× |
| 1/8000 s | 8.4 mm | 0.20× |

The camera pins shutter and floats ISO, not the other way round — a noisy sharp
ball can be centroided, a clean smeared one cannot.

**Frame rate is measured, never assumed.** Under thermal load the sensor
quietly drops below 240. Using nominal 240 when you're getting 197 inflates
every speed by 22 %. `ShotPipeline.measuredFrameRate()` reads real PTS deltas.

**Scale is cross-checked.** LiDAR depth + intrinsics gives px/m; the ball's own
42.67 mm diameter gives it independently. If they disagree by >8 % the app says
so rather than averaging a good number with a bad one.

**Focus honesty:** iOS exposes no distance→lensPosition mapping, so LiDAR
distance is used for *scale*, not to drive the lens. Focus is one autofocus
cycle on the tee point, then locked.

---

## What's here

```
GolfLaunchMonitor/
├── Capture/
│   ├── CameraManager.swift      240/120 fps, manual exposure, locked focus
│   ├── FrameRingBuffer.swift    lock-free SPSC ring, 30 frames, zero-alloc
│   └── ImpactTrigger.swift      armed → impact → collect state machine
├── Calibration/
│   ├── LiDARCalibrator.swift    depth → px/mm, cross-checked against ball size
│   └── MotionLeveler.swift      CoreMotion gravity → true horizontal
├── Vision/
│   ├── BallTracker.swift        sub-pixel centroid, ellipse fit for smear
│   └── SpinAnalyzer.swift       three fused axis estimators + confidence
├── Physics/
│   ├── FlightModel.swift        3D RK4, drag + Magnus, fitted coefficients
│   └── ClubProfile.swift        per-club spin/launch priors
├── Play/
│   ├── RangeMode.swift          targets, proximity scoring, dispersion
│   └── CourseMode.swift         9-hole course, lies, hazards, caddie
├── UI/                          dark OLED SwiftUI, metric tiles, scrub reel
└── App/                         pipeline orchestration, session persistence
```

---

## Known limits

- **Azimuth is weak.** From a side-on camera, lateral motion is along the
  optical axis. Start direction is inferred from apparent-size change and is
  the least reliable measurement in the app.
- **Set up perpendicular to the target line.** The planar-scale assumption
  degrades for shots hit toward or away from the camera.
- **Roll-out is a guess.** Carry is measured; total distance assumes a firm
  fairway and can't know your turf.
- **Putting in course mode is statistical,** not measured. A launch monitor
  can't read a putt and the code doesn't pretend to.
- **Smash factor is assumed per club,** so "club speed" is derived, not seen.
