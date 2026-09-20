// shape.js — shot shape classification + the D-plane side-spin prior.
// Port of the classification half of SpinAnalyzer.swift.
//
// Thresholds are in YARDS OF CURVE, not degrees of spin axis, because that is
// what a golfer actually perceives:
//     < 6 yd    straight
//     6-22 yd   draw / fade
//     > 22 yd   hook / slice
// Start direction beyond +/-3 degrees counts as a push or a pull.

import { startDirectionFaceBias, CLUBS } from './clubs.js';

export const SHAPES = {
  straight: { name: 'Straight', arrow: '↑', curvesLeft: false },
  draw: { name: 'Draw', arrow: '↖', curvesLeft: true },
  fade: { name: 'Fade', arrow: '↗', curvesLeft: false },
  hook: { name: 'Hook', arrow: '↰', curvesLeft: true },
  slice: { name: 'Slice', arrow: '↱', curvesLeft: false },
  pullDraw: { name: 'Pull Draw', arrow: '↖', curvesLeft: true },
  pullStraight: { name: 'Pull', arrow: '↑', curvesLeft: false },
  pullFade: { name: 'Pull Fade', arrow: '↗', curvesLeft: false },
  pushDraw: { name: 'Push Draw', arrow: '↖', curvesLeft: true },
  pushStraight: { name: 'Push', arrow: '↑', curvesLeft: false },
  pushFade: { name: 'Push Fade', arrow: '↗', curvesLeft: false },
};

export function classify(azimuthDeg, curveYards) {
  const absCurve = Math.abs(curveYards);
  const band = absCurve < 6 ? 0 : absCurve <= 22 ? 1 : 2;
  const right = curveYards > 0;

  if (Math.abs(azimuthDeg) <= 3) {
    if (band === 0) return 'straight';
    if (band === 1) return right ? 'fade' : 'draw';
    return right ? 'slice' : 'hook';
  }

  const pushed = azimuthDeg > 0;
  if (pushed) {
    if (band === 0) return 'pushStraight';
    if (band === 1) return right ? 'pushFade' : 'pushDraw';
    return right ? 'slice' : 'pushDraw';
  }
  if (band === 0) return 'pullStraight';
  if (band === 1) return right ? 'pullFade' : 'pullDraw';
  return right ? 'pullFade' : 'hook';
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/**
 * D-plane prior: infer spin axis from where the ball started.
 *
 * The honest caveat, same as the native app: with only start direction
 * measured you must assume a club path, and we assume the golfer swung at the
 * target. That assumption is wrong often enough that this carries a large
 * uncertainty and is a prior, never a measurement.
 */
export function dPlaneAxis(azimuthDeg, clubKey) {
  const bias = startDirectionFaceBias(clubKey);
  const face = azimuthDeg / Math.max(bias, 0.5);
  const faceToPath = face; // path assumed zero
  const loft = CLUBS[clubKey].loft;
  // Higher backspin resists axis tilt, so wedges curve less for the same
  // face-to-path than a driver does.
  const loftDamping = 1 - ((loft - 10.5) / (60 - 10.5)) * 0.45;
  return clamp(faceToPath * 0.8 * loftDamping, -60, 60);
}

/**
 * Nyquist limit for optical spin measurement: above this the ball turns more
 * than 180 degrees between frames and the measurement wraps.
 *   240 fps -> 7200 rpm.  120 fps -> 3600 rpm.
 * A 9500 rpm wedge at 240 fps reads as spinning BACKWARDS.
 */
export function nyquistSpinRPM(frameRate) {
  return frameRate * 30;
}

/** Undo that wrapping using the club's plausible spin window. */
export function unwrapRotation(wrappedDegPerFrame, frameRate, spinRange) {
  let best = null;
  for (let k = -1; k <= 6; k++) {
    const deg = wrappedDegPerFrame + k * 360;
    if (deg <= 0) continue;
    const rpm = (deg / 360) * frameRate * 60;
    if (rpm < spinRange[0] || rpm > spinRange[1]) continue;
    const mid = (spinRange[0] + spinRange[1]) / 2;
    const d = Math.abs(rpm - mid);
    if (!best || d < best.d) best = { rpm, d };
  }
  return best ? best.rpm : null;
}
