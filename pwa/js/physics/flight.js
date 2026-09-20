// flight.js — 3D ball flight: RK4 over drag + Magnus + gravity.
//
// Direct port of FlightModel.swift. The aero coefficients were fitted
// numerically against published Trackman PGA Tour averages; test/physics.test.js
// pins this port to the same numbers the Swift version targets.
//
// Coordinate frame: +x downrange, +y up, +z right.

export const Ball = {
  diameterM: 0.042670, // R&A/USGA minimum; balls are made to it
  radiusM: 0.042670 / 2,
  massKg: 0.045930, // USGA maximum
  get area() {
    return Math.PI * this.radiusM * this.radiusM;
  },
};

export const Aero = {
  cd0: 0.2255,
  // Velocity trim on base drag, normalised around 60 m/s. Slightly negative:
  // the drag crisis is complete at these speeds and Cd eases off as Re climbs.
  cdVelocity: -0.0215,
  // Spin makes the wake asymmetric and costs drag. This is why a 9000 rpm
  // wedge falls out of the sky and a 2500 rpm drive does not.
  cdSpin: 0.2243,
  clK: 0.5206,
  clExponent: 0.4643,
  clMax: 0.33,
  // PINNED, not fitted. An unconstrained fit drove this negative (the ball
  // gaining spin in flight) for a better-looking error. That is unphysical.
  // Measured golf ball spin decay is ~4%/s. Do not "optimise" this.
  spinDecayPerSecond: 0.04,
  gravity: 9.80665,

  spinRatio(omega, speed) {
    return (omega * Ball.radiusM) / Math.max(speed, 1e-3);
  },
  dragCoefficient(speed, S) {
    return Math.max(0.15, this.cd0 + (this.cdVelocity * (speed - 60)) / 60 + this.cdSpin * S);
  },
  liftCoefficient(S) {
    if (S <= 1e-6) return 0;
    return Math.min(this.clMax, this.clK * Math.pow(S, this.clExponent));
  },
};

// ── Atmosphere ──────────────────────────────────────────────────────────────

export const STANDARD_ATMOSPHERE = {
  temperatureC: 20,
  altitudeM: 0,
  humidity: 0.5,
  pressureHPa: 1013.25,
};

export function airDensity(a = STANDARD_ATMOSPHERE) {
  const temperatureC = a.temperatureC ?? 20;
  const altitudeM = a.altitudeM ?? 0;
  const humidity = a.humidity ?? 0.5;
  const pressureHPa = a.pressureHPa ?? 1013.25;

  const tK = temperatureC + 273.15;
  // Barometric formula for station pressure at altitude.
  const p = pressureHPa * 100 * Math.pow(1 - 2.25577e-5 * altitudeM, 5.25588);
  // Tetens approximation for saturation vapour pressure (Pa).
  const pSat = 610.78 * Math.exp((17.27 * temperatureC) / (temperatureC + 237.3));
  const pv = humidity * pSat;
  const pd = p - pv;
  // Moist air is LESS dense than dry air — water is lighter than N2/O2.
  return pd / (287.058 * tK) + pv / (461.495 * tK);
}

export function carryFactor(atmos) {
  return Math.sqrt(airDensity(STANDARD_ATMOSPHERE) / airDensity(atmos));
}

// ── Integrator ──────────────────────────────────────────────────────────────

const DT = 0.002; // RK4 local error here is far below our measurement noise
const YARD = 0.9144;
const FOOT = 0.3048;

/**
 * Simulate a shot.
 * @param {object} c
 * @param {number} c.ballSpeedMPH
 * @param {number} c.launchAngleDeg  vertical, degrees above horizontal
 * @param {number} c.azimuthDeg      horizontal, + = right of target
 * @param {number} c.totalSpinRPM
 * @param {number} c.spinAxisDeg     + = tilted right = curves right (fade/slice)
 * @param {object} [c.atmosphere]
 */
export function simulate(c) {
  const atmos = c.atmosphere || STANDARD_ATMOSPHERE;
  const rho = airDensity(atmos);

  const v0 = c.ballSpeedMPH * 0.44704;
  const vla = (c.launchAngleDeg * Math.PI) / 180;
  const azi = ((c.azimuthDeg || 0) * Math.PI) / 180;
  const axis = ((c.spinAxisDeg || 0) * Math.PI) / 180;

  let px = 0, py = 0, pz = 0;
  let vx = v0 * Math.cos(vla) * Math.cos(azi);
  let vy = v0 * Math.sin(vla);
  let vz = v0 * Math.cos(vla) * Math.sin(azi);

  const omega0 = (c.totalSpinRPM * 2 * Math.PI) / 60;

  // Spin axis unit vector. Sign derivation, because getting this backwards
  // silently inverts every draw and fade (it did, in the first draft — drives
  // carried 68 yards instead of 254):
  //   For a ball travelling +x, backspin means the top moves toward -x.
  //   A point at (0,+r,0) has velocity w × r; for that to point -x, w must be +z.
  //   So backspin is +z — the axis points to the right.
  //   Tilting right (positive spinAxisDeg) must then produce a rightward force,
  //   which w = (0, -sin, cos) does. Verified: +20° gives 31.7 yd right.
  const sx = 0;
  const sy = -Math.sin(axis);
  const sz = Math.cos(axis);

  const launchDirX = Math.cos(azi);
  const launchDirZ = Math.sin(azi);

  let t = 0, apex = 0, sampleAcc = 0;
  const points = [{ t: 0, x: 0, y: 0, z: 0, speed: v0 }];

  function accel(ax, ay, az, at) {
    const speed = Math.hypot(ax, ay, az);
    if (speed < 1e-6) return [0, -Aero.gravity, 0];

    const omega = omega0 * Math.exp(-Aero.spinDecayPerSecond * at);
    const S = Aero.spinRatio(omega, speed);
    const cd = Aero.dragCoefficient(speed, S);
    const cl = Aero.liftCoefficient(S);

    // q = 0.5*rho*A*|v| / m — shared scalar; times v gives the v^2 dependence.
    const q = (0.5 * rho * Ball.area * speed) / Ball.massKg;

    // Magnus acts along (spin × v) normalised.
    const cxv = sy * az - sz * ay;
    const cyv = sz * ax - sx * az;
    const czv = sx * ay - sy * ax;
    const cn = Math.hypot(cxv, cyv, czv) || 1;
    const L = q * cl * speed;

    return [
      -q * cd * ax + (L * cxv) / cn,
      -Aero.gravity - q * cd * ay + (L * cyv) / cn,
      -q * cd * az + (L * czv) / cn,
    ];
  }

  while (t < 20) {
    const k1 = accel(vx, vy, vz, t);
    const v2x = vx + 0.5 * DT * k1[0], v2y = vy + 0.5 * DT * k1[1], v2z = vz + 0.5 * DT * k1[2];
    const k2 = accel(v2x, v2y, v2z, t + DT / 2);
    const v3x = vx + 0.5 * DT * k2[0], v3y = vy + 0.5 * DT * k2[1], v3z = vz + 0.5 * DT * k2[2];
    const k3 = accel(v3x, v3y, v3z, t + DT / 2);
    const v4x = vx + DT * k3[0], v4y = vy + DT * k3[1], v4z = vz + DT * k3[2];
    const k4 = accel(v4x, v4y, v4z, t + DT);

    // Position advances on RK4-weighted velocities — the consistent pairing
    // for this second-order system.
    const nx = px + (DT / 6) * (vx + 2 * v2x + 2 * v3x + v4x);
    const ny = py + (DT / 6) * (vy + 2 * v2y + 2 * v3y + v4y);
    const nz = pz + (DT / 6) * (vz + 2 * v2z + 2 * v3z + v4z);

    const nvx = vx + (DT / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);
    const nvy = vy + (DT / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
    const nvz = vz + (DT / 6) * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2]);

    t += DT;
    if (ny > apex) apex = ny;

    if (ny < 0 && t > 0.05) {
      // Linear interpolation to the ground crossing; the step is 2 ms so this
      // is well inside any error we care about.
      const f = py / (py - ny);
      const lx = px + f * (nx - px);
      const lz = pz + f * (nz - pz);
      const lvx = vx + f * (nvx - vx);
      const lvy = vy + f * (nvy - vy);
      const lvz = vz + f * (nvz - vz);

      const carry = lx / YARD;
      const side = lz / YARD;

      // How far the landing point sits off the INITIAL launch line. This is
      // what separates a straight push from a genuine slice.
      const along = lx * launchDirX + lz * launchDirZ;
      const curve = (lz - launchDirZ * along) / YARD;

      const landSpeed = Math.hypot(lvx, lvy, lvz);
      const descent = (Math.atan2(-lvy, Math.hypot(lvx, lvz)) * 180) / Math.PI;
      const spinAtLanding = c.totalSpinRPM * Math.exp(-Aero.spinDecayPerSecond * t);

      points.push({ t, x: lx, y: 0, z: lz, speed: landSpeed });

      const roll = rollYards(descent, landSpeed, spinAtLanding);

      return {
        carryYards: carry,
        totalYards: carry + roll,
        rollYards: roll,
        sideYards: side,
        curveYards: curve,
        apexFeet: apex / FOOT,
        hangTimeSeconds: t,
        descentAngleDeg: descent,
        landingSpeedMPH: landSpeed / 0.44704,
        trajectory: points,
      };
    }

    px = nx; py = ny; pz = nz;
    vx = nvx; vy = nvy; vz = nvz;

    // Decimate for drawing — no need for 3500 points on screen.
    sampleAcc += DT;
    if (sampleAcc >= 0.04) {
      sampleAcc = 0;
      points.push({ t, x: px, y: py, z: pz, speed: Math.hypot(vx, vy, vz) });
    }
  }

  return null;
}

/**
 * Roll-out on a firm fairway. Unapologetically empirical — real roll depends
 * on turf firmness, slope, moisture and bounce angle, none of which we can
 * know. Tuned so a tour driver runs ~20 yd and a wedge checks to near zero.
 * Carry is the measured number; treat total as indicative.
 */
function rollYards(descentDeg, landingSpeed, spinRPM) {
  const angleFactor = Math.max(0, Math.cos((descentDeg * Math.PI) / 180));
  const spinFactor = Math.max(0.05, 1 - spinRPM / 9000);
  const speedYd = (landingSpeed / 0.44704) * 0.26;
  return Math.max(0, speedYd * angleFactor * angleFactor * spinFactor);
}
