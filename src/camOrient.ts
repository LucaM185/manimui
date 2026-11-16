// Camera orientation math (ManimGL zxz Euler angles: R = Rz(theta) · Rx(phi) · Rz(gamma)).
//
// Kept free of runtime imports so ops.ts (camera waypoints) and view3d.ts (navigation) can both use
// it without an import cycle. engine/studio_runtime.py mirrors orientBetween() for the render.
import type { CamView } from './types';

type V3 = [number, number, number];
type Angles = Pick<CamView, 'theta' | 'phi' | 'gamma'>;

const DEG = Math.PI / 180;

/** Columns of the camera rotation: screen right, screen up and "out" (from the centre towards the camera). */
export function basis(c: Angles): { right: V3; up: V3; out: V3 } {
  const [t, p, g] = [c.theta * DEG, c.phi * DEG, c.gamma * DEG];
  const ct = Math.cos(t), st = Math.sin(t), cp = Math.cos(p), sp = Math.sin(p), cg = Math.cos(g), sg = Math.sin(g);
  // Rz(t) · Rx(p) · Rz(g)
  const m = [
    [ct * cg - st * cp * sg, -ct * sg - st * cp * cg, st * sp],
    [st * cg + ct * cp * sg, -st * sg + ct * cp * cg, -ct * sp],
    [sp * sg, sp * cg, cp],
  ];
  return { right: [m[0][0], m[1][0], m[2][0]], up: [m[0][1], m[1][1], m[2][1]], out: [m[0][2], m[1][2], m[2][2]] };
}

/** theta + k·360 closest to `ref`, so view changes take the short way round. */
export function nearestTurn(theta: number, ref: number) {
  return theta + 360 * Math.round((ref - theta) / 360);
}

/**
 * Camera angles (ManimGL zxz Euler) for a Y-up turntable view: `yaw` swings the camera around the
 * world Y axis (0 = looking at the XY plane from +z, i.e. the classic 2D view), `pitch` raises it
 * towards +Y (90 = straight down). There is never any roll, so Y stays "up" on screen.
 */
export function yUpAngles(yawDeg: number, pitchDeg: number, ref: Pick<CamView, 'theta' | 'gamma'> = { theta: 0, gamma: 0 }): Angles {
  const y = yawDeg * DEG, p = pitchDeg * DEG;
  const out: V3 = [Math.cos(p) * Math.sin(y), Math.sin(p), Math.cos(p) * Math.cos(y)];
  const right: V3 = [Math.cos(y), 0, -Math.sin(y)];
  const up: V3 = [out[1] * right[2] - out[2] * right[1], out[2] * right[0] - out[0] * right[2], out[0] * right[1] - out[1] * right[0]];
  const phi = Math.acos(Math.max(-1, Math.min(1, out[2])));
  let theta: number, gamma: number;
  if (Math.sin(phi) > 1e-6) {
    theta = Math.atan2(out[0], -out[1]) / DEG;
    gamma = Math.atan2(right[2], up[2]) / DEG;
  } else {
    // looking straight along ±z: only theta + gamma matters, put the whole turn in theta
    theta = Math.atan2(right[1], right[0]) / DEG;
    gamma = 0;
  }
  return { theta: nearestTurn(theta, ref.theta), phi: phi / DEG, gamma: nearestTurn(gamma, ref.gamma) };
}

/** yaw / pitch (degrees) of the direction from the centre to the eye. */
export function yawPitch(c: Angles, refYaw = 0): { yaw: number; pitch: number } {
  const { out, right } = basis(c);
  const pitch = Math.asin(Math.max(-1, Math.min(1, out[1]))) / DEG;
  if (Math.hypot(out[0], out[2]) > 1e-3) return { yaw: nearestTurn(Math.atan2(out[0], out[2]) / DEG, refYaw), pitch };
  // straight above / below: the heading lives in the screen-right vector (horizontal, no roll)
  if (Math.hypot(right[0], right[2]) > 1e-3) return { yaw: nearestTurn(Math.atan2(-right[2], right[0]) / DEG, refYaw), pitch };
  return { yaw: refYaw, pitch };
}

/** True when the view has no roll (screen-right is horizontal, Y points up), i.e. it is a yaw/pitch view. */
export function isYUp(c: Angles) {
  const { right, up } = basis(c);
  return Math.abs(right[1]) < 1e-3 && up[1] > -1e-3;
}

/**
 * Orientation part way (f in 0..1) from view a to view b along the direct path. Lerping the zxz
 * Euler angles one by one makes the eye wander and roll on the way (Front → Top swings out
 * sideways); instead Y-up views move in a straight line in yaw / pitch (short way round, never
 * rolling) and anything with roll falls back to a quaternion slerp (the shortest rotation).
 * `ref` picks which ±360 representation of theta / gamma comes back.
 */
export function orientBetween(a: Angles, b: Angles, f: number, ref: Pick<CamView, 'theta' | 'gamma'> = a): Angles {
  if (isYUp(a) && isYUp(b)) {
    const pa = yawPitch(a);
    const pb = yawPitch(b, pa.yaw);
    // top / bottom views have a heading too (yawPitch reads it from screen-right), so this is well defined
    return yUpAngles(pa.yaw + (pb.yaw - pa.yaw) * f, pa.pitch + (pb.pitch - pa.pitch) * f, ref);
  }
  const e = eulerOf(slerp(quatOf(a), quatOf(b), f));
  return { theta: nearestTurn(e.theta, ref.theta), phi: e.phi, gamma: nearestTurn(e.gamma, ref.gamma) };
}

/**
 * Orientation between two camera waypoints. Keys that both look straight down z (2D views, maybe
 * rolled) keep the plain angle lerp: it is exact there and keeps deliberate multi-turn spins
 * (roll 0 → 360). Any tilted key takes the direct path of orientBetween().
 */
export function keyOrientBetween(a: Angles, b: Angles, f: number): Angles {
  const lin = { theta: a.theta + (b.theta - a.theta) * f, phi: a.phi + (b.phi - a.phi) * f, gamma: a.gamma + (b.gamma - a.gamma) * f };
  if (f <= 0) return { theta: a.theta, phi: a.phi, gamma: a.gamma };
  if (f >= 1) return { theta: b.theta, phi: b.phi, gamma: b.gamma };
  if (Math.abs(a.phi) < 1e-6 && Math.abs(b.phi) < 1e-6) return lin;
  return orientBetween(a, b, f, lin);
}

type Quat = [number, number, number, number]; // w, x, y, z
function quatOf(c: Angles): Quat {
  const { right: r, up: u, out: o } = basis(c);
  // rotation matrix with columns right / up / out
  const m00 = r[0], m01 = u[0], m02 = o[0], m10 = r[1], m11 = u[1], m12 = o[1], m20 = r[2], m21 = u[2], m22 = o[2];
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    return [0.25 * s, (m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s];
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return [(m21 - m12) / s, 0.25 * s, (m01 + m10) / s, (m02 + m20) / s];
  }
  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return [(m02 - m20) / s, (m01 + m10) / s, 0.25 * s, (m12 + m21) / s];
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return [(m10 - m01) / s, (m02 + m20) / s, (m12 + m21) / s, 0.25 * s];
}
function slerp(a: Quat, b: Quat, f: number): Quat {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  if (d < 0) { b = [-b[0], -b[1], -b[2], -b[3]]; d = -d; }
  if (d > 0.9995) {
    const q = a.map((v, i) => v + (b[i] - v) * f) as Quat;
    const n = Math.hypot(...q);
    return q.map((v) => v / n) as Quat;
  }
  const th = Math.acos(d);
  const sa = Math.sin((1 - f) * th) / Math.sin(th), sb = Math.sin(f * th) / Math.sin(th);
  return a.map((v, i) => v * sa + b[i] * sb) as Quat;
}
/** Quaternion → ManimGL zxz Euler angles (degrees), R = Rz(theta)·Rx(phi)·Rz(gamma). */
function eulerOf([w, x, y, z]: Quat): Angles {
  const m00 = 1 - 2 * (y * y + z * z), m10 = 2 * (x * y + w * z);
  const m02 = 2 * (x * z + w * y), m12 = 2 * (y * z - w * x), m22 = 1 - 2 * (x * x + y * y);
  const m20 = 2 * (x * z - w * y), m21 = 2 * (y * z + w * x);
  const phi = Math.acos(Math.max(-1, Math.min(1, m22)));
  if (Math.sin(phi) > 1e-6) return { theta: Math.atan2(m02, -m12) / DEG, phi: phi / DEG, gamma: Math.atan2(m20, m21) / DEG };
  return { theta: Math.atan2(m10, m00) / DEG, phi: phi / DEG, gamma: 0 };
}
