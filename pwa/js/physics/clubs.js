// clubs.js — per-club priors. Port of ClubProfile.swift.
//
// These seed the spin estimate. Back spin cannot be measured by a phone camera
// from the side, so total spin comes from a loft-based model anchored on ball
// speed and launch angle. The app labels it "modelled" rather than pretending.

export const CLUBS = {
  driver: { name: 'Driver', short: 'Dr', loft: 10.5, spin: [1800, 3600], refSpeed: 167, refLaunch: 10.9, smash: 1.48 },
  threeWood: { name: '3 Wood', short: '3W', loft: 15, spin: [2600, 4600], refSpeed: 158, refLaunch: 9.2, smash: 1.46 },
  fiveWood: { name: '5 Wood', short: '5W', loft: 18, spin: [3200, 5400], refSpeed: 152, refLaunch: 9.4, smash: 1.46 },
  hybrid: { name: 'Hybrid', short: 'Hy', loft: 21, spin: [3600, 5800], refSpeed: 146, refLaunch: 10.2, smash: 1.44 },
  fourIron: { name: '4 Iron', short: '4i', loft: 24, spin: [3800, 5600], refSpeed: 137, refLaunch: 11.0, smash: 1.40 },
  fiveIron: { name: '5 Iron', short: '5i', loft: 27, spin: [4300, 6300], refSpeed: 132, refLaunch: 14.3, smash: 1.40 },
  sixIron: { name: '6 Iron', short: '6i', loft: 31, spin: [5000, 7000], refSpeed: 127, refLaunch: 15.5, smash: 1.36 },
  sevenIron: { name: '7 Iron', short: '7i', loft: 35, spin: [5800, 8000], refSpeed: 120, refLaunch: 16.3, smash: 1.36 },
  eightIron: { name: '8 Iron', short: '8i', loft: 39, spin: [6600, 8800], refSpeed: 115, refLaunch: 18.1, smash: 1.30 },
  nineIron: { name: '9 Iron', short: '9i', loft: 43, spin: [7400, 9600], refSpeed: 109, refLaunch: 20.4, smash: 1.30 },
  pitchingWedge: { name: 'Pitching Wedge', short: 'PW', loft: 47, spin: [8000, 10500], refSpeed: 102, refLaunch: 24.2, smash: 1.25 },
  gapWedge: { name: 'Gap Wedge', short: 'GW', loft: 52, spin: [8600, 11000], refSpeed: 95, refLaunch: 26.5, smash: 1.18 },
  sandWedge: { name: 'Sand Wedge', short: 'SW', loft: 56, spin: [9000, 11500], refSpeed: 88, refLaunch: 28.5, smash: 1.18 },
  lobWedge: { name: 'Lob Wedge', short: 'LW', loft: 60, spin: [9200, 12000], refSpeed: 80, refLaunch: 31.0, smash: 1.18 },
};

export const BAG_ORDER = [
  'driver', 'threeWood', 'fiveWood', 'hybrid', 'fourIron', 'fiveIron', 'sixIron',
  'sevenIron', 'eightIron', 'nineIron', 'pitchingWedge', 'gapWedge', 'sandWedge', 'lobWedge',
];

export const SWING_PROFILES = {
  tour: { name: 'Tour', spinMultiplier: 1.0 },
  low: { name: 'Low (0-5)', spinMultiplier: 1.08 },
  mid: { name: 'Mid (6-15)', spinMultiplier: 1.18 },
  high: { name: 'High (16+)', spinMultiplier: 1.32 },
};

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/**
 * Estimate total spin from what a camera can actually observe.
 * Anchored on three real relationships: spin rises with dynamic loft, with
 * impact speed, and with launch angle above what the club normally produces
 * (which implies more loft was delivered).
 */
export function estimateTotalSpin(clubKey, ballSpeedMPH, launchAngleDeg, profileKey = 'mid') {
  const club = CLUBS[clubKey];
  const profile = SWING_PROFILES[profileKey] || SWING_PROFILES.mid;

  const loft = club.loft;
  // Linear in loft at ~180 rpm/degree. Verified against tour averages:
  //   Driver 10.5deg -> 2710 (real 2686), 7-iron 35deg -> 7120 (real 7097),
  //   PW 47deg -> 9280 (real 9316).
  // An earlier quadratic form gave a PW 19,834 rpm and clamped every lofted
  // club to its range ceiling, which made the model useless. Keep it linear.
  const base = 820 + 180 * loft;

  const speedScale = clamp(ballSpeedMPH / club.refSpeed, 0.6, 1.4);
  const launchResidual = launchAngleDeg - club.refLaunch;
  const launchScale = clamp(1 + launchResidual * 0.03, 0.7, 1.35);

  const raw = base * speedScale * launchScale * profile.spinMultiplier;
  return clamp(raw, club.spin[0], club.spin[1]);
}

/** Typical launch angle for a club, used to prefill the form. */
export function defaultLaunch(clubKey) {
  return CLUBS[clubKey].refLaunch;
}

export function defaultBallSpeed(clubKey) {
  return CLUBS[clubKey].refSpeed;
}

/**
 * Fraction of the way from club path toward face angle that the ball starts.
 * Low loft pushes start direction toward the face; high loft drags it toward
 * the path. This is the D-plane ratio the side-spin prior inverts.
 */
export function startDirectionFaceBias(clubKey) {
  const loft = CLUBS[clubKey].loft;
  const t = (loft - 10.5) / (60 - 10.5);
  return 0.85 - 0.15 * t;
}
