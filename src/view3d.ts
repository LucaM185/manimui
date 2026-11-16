// 3D view math for the preview overlay and CAD-style navigation.
//
// Mirrors ManimGL 1.7.2 exactly (camera_frame.py + shaders/inserts/emit_gl_Position.glsl):
//   R      = Rz(theta) · Rx(phi) · Rz(gamma)          (frame orientation, Euler "zxz")
//   v      = Rᵀ (p − centre) · zoom                     (view matrix; zoom = 1 / frame scale)
//   ndc    = (v.x · 2/FW, v.y · 2/FH) / (1 − v.z · K)   (K = 2·tan(fovy/2) / FH, fovy = 45°)
// so overlays line up with the rendered pixels in any orientation.
import { DEFAULT_CAM, FRAME_H as FH, FRAME_W as FW, isFlat, type Cam } from './ops';
import { basis, isYUp, nearestTurn, orientBetween, yawPitch, yUpAngles } from './camOrient';

export { basis, isYUp, nearestTurn, yawPitch, yUpAngles };

export type V3 = [number, number, number];
export interface Pt { x: number; y: number }

const DEG = Math.PI / 180;
export const PERSP_K = (2 * Math.tan(22.5 * DEG)) / FH;

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const norm = (a: V3) => Math.hypot(a[0], a[1], a[2]);
export const unit = (a: V3): V3 => mul(a, 1 / (norm(a) || 1));

export interface Projector {
  cam: Cam;
  w: number;
  h: number;
  /** px per world unit on the focal plane (the plane through the centre, facing the camera) */
  unit: number;
  flat: boolean;
  right: V3;
  up: V3;
  out: V3;
  centre: V3;
  /** world position of the eye */
  eye: V3;
  project(p: V3): Pt & { ok: boolean; depth: number };
  /** world point on the focal plane under a screen point */
  focal(px: number, py: number): V3;
  /** intersection of the eye ray through (px, py) with the plane n·(X − p0) = 0 */
  toPlane(px: number, py: number, n: V3, p0: V3): V3 | null;
}

export function projector(cam: Cam, w: number, h: number): Projector {
  const { right, up, out } = basis(cam);
  const centre: V3 = [cam.x, cam.y, cam.z];
  const zoom = Math.max(cam.zoom, 1e-4);
  const eye = add(centre, mul(out, 1 / PERSP_K / zoom));
  const flat = isFlat(cam);
  const pr: Projector = {
    cam, w, h, flat, right, up, out, centre, eye,
    unit: (w / FW) * zoom,
    project(p) {
      const r = sub(p, centre);
      const vx = dot(r, right) * zoom;
      const vy = dot(r, up) * zoom;
      const vz = dot(r, out) * zoom;
      const den = 1 - vz * PERSP_K;
      const ok = den > 0.02;
      const d = ok ? den : 0.02;
      return { x: ((vx * 2) / FW / d + 1) * 0.5 * w, y: (1 - (vy * 2) / FH / d) * 0.5 * h, ok, depth: den };
    },
    focal(px, py) {
      const sx = ((px / w) * 2 - 1) * (FW / 2) / zoom;
      const sy = (1 - (py / h) * 2) * (FH / 2) / zoom;
      return add(centre, add(mul(right, sx), mul(up, sy)));
    },
    toPlane(px, py, n, p0) {
      const target = pr.focal(px, py);
      const d = sub(target, eye);
      const den = dot(n, d);
      if (Math.abs(den) < 1e-9) return null;
      const t = dot(n, sub(p0, eye)) / den;
      if (t <= 0) return null;
      return add(eye, mul(d, t));
    },
  };
  return pr;
}

export const IDENTITY_CAM: Cam = { ...DEFAULT_CAM };

// ---------------------------------------------------------------- navigation
export const ORBIT_DEG_PER_PX = 0.4;

/** Turntable orbit around the centre with Y up (like three.js / most 3D viewers): drag right turns the scene right. */
export function orbit(c: Cam, dxPx: number, dyPx: number): Cam {
  const { yaw, pitch } = yawPitch(c);
  const a = yUpAngles(yaw - dxPx * ORBIT_DEG_PER_PX, Math.min(90, Math.max(-90, pitch + dyPx * ORBIT_DEG_PER_PX)), c);
  return { ...c, ...a };
}

/** Pan so the focal plane follows the pointer. */
export function pan(c: Cam, dxPx: number, dyPx: number, stageW: number, viewZoom = c.zoom): Cam {
  const { right, up } = basis(c);
  const u = (stageW / FW) * viewZoom;
  const d = add(mul(right, -dxPx / u), mul(up, dyPx / u));
  return { ...c, x: c.x + d[0], y: c.y + d[1], z: c.z + d[2] };
}

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 40;

/** Zoom by `factor`, keeping the focal-plane point under (px, py) fixed. */
export function zoomAt(c: Cam, factor: number, px: number, py: number, w: number, h: number): Cam {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, c.zoom * factor));
  const before = projector(c, w, h).focal(px, py);
  const after = projector({ ...c, zoom }, w, h).focal(px, py);
  const d = sub(before, after);
  return { ...c, zoom, x: c.x + d[0], y: c.y + d[1], z: c.z + d[2] };
}

/** World axis-aligned boxes [lo, hi]. Keeps the orientation, frames the boxes (like "Zoom to fit"). */
export function fitView(c: Cam, boxes: [V3, V3][], w: number, h: number, margin = 0.82): Cam {
  if (!boxes.length) return { ...c, x: 0, y: 0, z: 0, zoom: 1 };
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const [a, b] of boxes) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], a[i]); hi[i] = Math.max(hi[i], b[i]); }
  const centre = mul(add(lo, hi), 0.5);
  const corners: V3[] = [];
  for (const sx of [0, 1]) for (const sy of [0, 1]) for (const sz of [0, 1]) corners.push([sx ? hi[0] : lo[0], sy ? hi[1] : lo[1], sz ? hi[2] : lo[2]]);
  let v: Cam = { ...c, x: centre[0], y: centre[1], z: centre[2] };
  const r = Math.max(norm(sub(hi, lo)) / 2, 0.05);
  v.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (FH * margin) / (2 * r)));
  for (let i = 0; i < 6; i++) {
    const pr = projector(v, w, h);
    let m = 0;
    let bad = false;
    for (const p of corners) {
      const q = pr.project(p);
      if (!q.ok) { bad = true; break; }
      m = Math.max(m, Math.abs(q.x - w / 2) / (w / 2), Math.abs(q.y - h / 2) / (h / 2));
    }
    if (bad) { v.zoom = Math.max(MIN_ZOOM, v.zoom * 0.5); continue; }
    if (m < 1e-6) break;
    const f = margin / m;
    v.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * f));
    if (Math.abs(f - 1) < 0.01) break;
  }
  return v;
}

/** Camera angles that look at the centre from direction `d` (from the centre towards the eye), Y up. */
export function anglesFor(d: V3, ref: Pick<Cam, 'theta' | 'phi' | 'gamma'> = { theta: 0, phi: 0, gamma: 0 }): { theta: number; phi: number; gamma: number } {
  const u = unit(d);
  const pitch = Math.asin(Math.max(-1, Math.min(1, u[1]))) / DEG;
  // straight above / below: keep the current heading, so the view doesn't spin half a turn on the way up
  const yaw = Math.hypot(u[0], u[2]) < 1e-6 ? yawPitch(ref).yaw : nearestTurn(Math.atan2(u[0], u[2]) / DEG, yawPitch(ref).yaw);
  return yUpAngles(yaw, pitch, ref);
}

/** Named views (Y up). Front = the classic 2D view: the XY plane seen from +z. */
export const VIEW_PRESETS: Record<string, { label: string; yaw: number; pitch: number; key?: string }> = {
  front: { label: 'Front', yaw: 0, pitch: 0, key: '1' },
  right: { label: 'Right', yaw: 90, pitch: 0, key: '3' },
  top: { label: 'Top', yaw: 0, pitch: 90, key: '7' },
  iso: { label: '3D', yaw: 35, pitch: 25, key: '5' },
  back: { label: 'Back', yaw: 180, pitch: 0 },
  left: { label: 'Left', yaw: -90, pitch: 0 },
  bottom: { label: 'Bottom', yaw: 0, pitch: -90 },
};

export function presetAngles(name: string, ref?: Pick<Cam, 'theta' | 'gamma'>) {
  const p = VIEW_PRESETS[name];
  return yUpAngles(p.yaw, p.pitch, ref);
}

// ---------------------------------------------------------------- geometry helpers
export function convexHull(pts: Pt[]): Pt[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Pt[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Point inside a convex polygon, or within `pad` px of its outline. */
export function inPolygon(pt: Pt, poly: Pt[], pad = 0): boolean {
  if (poly.length < 3) {
    if (!poly.length) return false;
    const a = poly[0], b = poly[poly.length - 1];
    return segDist(pt, a, b) <= Math.max(pad, 4);
  }
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  if (inside || pad <= 0) return inside;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) if (segDist(pt, poly[i], poly[j]) <= pad) return true;
  return false;
}

function segDist(p: Pt, a: Pt, b: Pt) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

export function polyArea(poly: Pt[]) {
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y);
  return Math.abs(s / 2);
}

/** World corners of a clip's oriented box: centre (x, y, z), base size (w, h, d) × scale, rotated about z,
 *  then tipped about x (rx) and turned about y (ry) — the same order as the engine's apply_transform. */
export function boxCorners(tr: { x: number; y: number; z: number; scale: number; rotation: number; rx?: number; ry?: number }, size: { w: number; h: number; d: number; ox?: number; oy?: number }): V3[] {
  const a = tr.rotation * DEG;
  const ca = Math.cos(a), sa = Math.sin(a);
  const bx = (tr.rx || 0) * DEG, by = (tr.ry || 0) * DEG;
  const cx = Math.cos(bx), sx_ = Math.sin(bx), cy = Math.cos(by), sy_ = Math.sin(by);
  const hw = (size.w * tr.scale) / 2, hh = (size.h * tr.scale) / 2, hd = (size.d * tr.scale) / 2;
  const out: V3[] = [];
  for (const sz of hd > 1e-6 ? [-1, 1] : [0]) {
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const lx = sx * hw + (size.ox || 0) * tr.scale, ly = sy * hh + (size.oy || 0) * tr.scale;
      // spin in plane (z)
      const px = lx * ca - ly * sa, py = lx * sa + ly * ca, pz = sz * hd;
      // tip about x
      const qy = py * cx - pz * sx_, qz = py * sx_ + pz * cx;
      // turn about y
      const rx = px * cy + qz * sy_, rz = -px * sy_ + qz * cy;
      out.push([tr.x + rx, tr.y + qy, tr.z + rz]);
    }
  }
  return out;
}

// ---------------------------------------------------------------- clip orientation
export type Orient = { rotation: number; rx: number; ry: number };
export type Axis = 'x' | 'y' | 'z';
type M3 = number[][];

const mm = (a: M3, b: M3): M3 => a.map((r) => [0, 1, 2].map((j) => r[0] * b[0][j] + r[1] * b[1][j] + r[2] * b[2][j]));
function axisRot(axis: Axis, deg: number): M3 {
  const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG);
  if (axis === 'x') return [[1, 0, 0], [0, c, -s], [0, s, c]];
  if (axis === 'y') return [[c, 0, s], [0, 1, 0], [-s, 0, c]];
  return [[c, -s, 0], [s, c, 0], [0, 0, 1]];
}

/** The clip's rotation matrix: Ry(ry)·Rx(rx)·Rz(rotation), the engine's apply_transform order. */
export function orientMatrix(o: Orient): M3 {
  return mm(axisRot('y', o.ry), mm(axisRot('x', o.rx), axisRot('z', o.rotation)));
}

export const axisMatrix = axisRot;

/**
 * Rot X / Rot Y / Rotation (degrees) of a rotation matrix, the inverse of orientMatrix. Of the
 * equivalent angle triples, returns the one closest to `ref`, so turning a clip step by step never
 * makes its numbers jump by a full turn (which keyframes would animate as a spin).
 */
export function orientFromMatrix(m: M3, ref: Orient = { rotation: 0, rx: 0, ry: 0 }): Orient {
  const s = Math.max(-1, Math.min(1, -m[1][2]));
  const near = (o: Orient): Orient => ({ rx: nearestTurn(o.rx, ref.rx), ry: nearestTurn(o.ry, ref.ry), rotation: nearestTurn(o.rotation, ref.rotation) });
  if (Math.abs(s) > 1 - 1e-9) {
    // tipped exactly ±90°: Rot Y and Rotation turn about the same axis; keep Rotation, solve Rot Y
    const rx = s > 0 ? 90 : -90;
    const ry = s > 0 ? ref.rotation + Math.atan2(m[0][1], m[0][0]) / DEG : Math.atan2(-m[0][1], m[0][0]) / DEG - ref.rotation;
    return near({ rx, ry, rotation: ref.rotation });
  }
  const a = Math.asin(s) / DEG, b = Math.atan2(m[0][2], m[2][2]) / DEG, c = Math.atan2(m[1][0], m[1][1]) / DEG;
  const dist = (o: Orient) => Math.abs(o.rx - ref.rx) + Math.abs(o.ry - ref.ry) + Math.abs(o.rotation - ref.rotation);
  const p = near({ rx: a, ry: b, rotation: c }), q = near({ rx: 180 - a, ry: b + 180, rotation: c + 180 });
  return dist(q) < dist(p) - 1e-9 ? q : p;
}

/** `o` turned by `deg` about a world axis through the clip's centre (right-handed). */
export function turnWorld(o: Orient, axis: Axis, deg: number, ref: Orient = o): Orient {
  return orientFromMatrix(mm(axisRot(axis, deg), orientMatrix(o)), ref);
}

/** True when the clip has a 3D orientation (not lying in a plane parallel to XY). */
export const isTilted = (tr: { rx?: number; ry?: number }) => Math.abs(tr.rx || 0) > 1e-9 || Math.abs(tr.ry || 0) > 1e-9;

/** Ease between two views (raw: centre / zoom / Euler angles each interpolated on their own). */
export function lerpCam(a: Cam, b: Cam, f: number): Cam {
  const out: any = {};
  for (const k of ['x', 'y', 'z', 'theta', 'phi', 'gamma'] as const) out[k] = a[k] + (b[k] - a[k]) * f;
  // zoom interpolates geometrically, which feels uniform
  out.zoom = Math.exp(Math.log(a.zoom) + (Math.log(b.zoom) - Math.log(a.zoom)) * f);
  return out;
}

/**
 * Ease between two views along the direct path (used by view-cube / preset fly-tos): centre and
 * zoom as lerpCam, orientation via orientBetween (yaw / pitch for Y-up views, else slerp).
 */
export function lerpView(a: Cam, b: Cam, f: number, ref: Pick<Cam, 'theta' | 'gamma'> = a): Cam {
  return { ...lerpCam(a, b, f), ...orientBetween(a, b, f, ref) };
}

const EYE_WORDS: Record<string, string> = {
  front: 'eye on +z looking at the XY plane (the classic flat 2D view)',
  top: 'eye above on +y looking straight down at the XZ floor (screen right = +x, screen up = -z)',
  bottom: 'eye below on -y looking up',
  right: 'eye on +x looking towards -x',
  left: 'eye on -x looking towards +x',
  back: 'eye on -z looking at the back of the XY plane (2D content reads mirrored)',
  iso: 'eye front-right-above, y up',
};

/** The named view (view cube / presets) closest to `c`, if within `tolDeg` of it. */
export function nearestPreset(c: Pick<Cam, 'theta' | 'phi' | 'gamma'>, tolDeg = 12): string | null {
  const o = basis(c).out;
  let best: string | null = null, bestDot = Math.cos(tolDeg * DEG);
  for (const name of Object.keys(VIEW_PRESETS)) {
    const d = dot(o, basis(presetAngles(name)).out);
    if (d > bestDot) { bestDot = d; best = name; }
  }
  return best;
}

/** Plain-words description of a view for the AI agent (Y-up names, as on the view cube). */
export function describeView(c: Cam): string {
  const r = (v: number) => Math.round(v * 100) / 100;
  const o = basis(c).out;
  const name = nearestPreset(c);
  const words = name ? `≈ ${VIEW_PRESETS[name].label} view: ${EYE_WORDS[name]}` : `eye direction from the centre (${o.map(r).join(', ')})`;
  return `${words}; {x: ${r(c.x)}, y: ${r(c.y)}, z: ${r(c.z)}, zoom: ${r(c.zoom)}, theta: ${r(c.theta)}, phi: ${r(c.phi)}, gamma: ${r(c.gamma)}}`;
}
