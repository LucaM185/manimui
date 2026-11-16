import { useEffect, useMemo, useRef, useState } from 'react';
import { Undo2 } from 'lucide-react';
import { useStore } from '../store';
import { CAMERA_ID, MORPH_SEL, round, setTransformAt, transformAt } from '../ops';
import type { Cam } from '../ops';
import type { Clip } from '../types';
import { add, basis, dot, mul, orientMatrix, sub, turnWorld, type Axis, type Orient, type V3 } from '../view3d';

/**
 * 3D rotation widget, bottom-right of the stage while rotatable clips are selected.
 *
 * One gimbal: three rings, one per world axis (colours match the view cube), drawn in 3D from the
 * viewer's current point of view around a small card that shows the clip's orientation. Every ring
 * carries two ribbon arrows on the side facing the viewer; an arrow points the way the near side of
 * the clip will move, whatever the camera angle:
 *   click = 15° that way (Shift 90°, Alt 1°), hold = keep turning.
 * Arrows turn the clip about the world axis through its centre, so what happens on the stage is
 * exactly what the arrow shows (on an already tilted clip that changes more than one of the
 * Inspector's angles). The chips beside it are those angles (Rot X / Rot Y / Rotation) at the playhead:
 * drag = scrub that one angle, double-click = 0. With keyframes, edits go to (or create) the key at
 * the playhead like every other stage edit.
 */

type Spec = { axis: Axis; field: keyof Orient; label: string; a: V3; u: V3; v: V3; bias: number; dark: string; base: string; light: string };
// u × v = a, so a ring angle grows the way a positive (right-handed) turn about `a` moves things
const AXES: Spec[] = [
  { axis: 'x', field: 'rx', label: 'X', a: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1], bias: 1, dark: '#c23d3d', base: '#ff6b6b', light: '#ffc0c0' },
  { axis: 'y', field: 'ry', label: 'Y', a: [0, 1, 0], u: [0, 0, 1], v: [1, 0, 0], bias: -1, dark: '#2f9d3c', base: '#6bd96b', light: '#c4f5c4' },
  { axis: 'z', field: 'rotation', label: 'Z', a: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], bias: 1, dark: '#2f6fd6', base: '#6aa8ff', light: '#c6ddff' },
];
const HOLD_MS = 350;
const CLOSE_MS = 280; // after the pointer leaves the open panel
const HOLD_DEG_PER_S = 90;
const SCRUB_DEG_PER_PX = 0.5;
const DEG = Math.PI / 180;

const orientOf = (c: Clip, u: number): Orient => {
  const t = transformAt(c, u);
  return { rotation: t.rotation || 0, rx: t.rx || 0, ry: t.ry || 0 };
};
const rounded = (o: Orient): Orient => ({ rotation: round(o.rotation, 2), rx: round(o.rx, 2), ry: round(o.ry, 2) });

/** Selected clips the widget can turn: not the camera / a morph link, not on a locked track. */
export function rotatableIds(s: { selection: string[]; project: { clips: Clip[]; tracks: { id: string; locked?: boolean }[] } }) {
  const locked = new Set(s.project.tracks.filter((t) => t.locked).map((t) => t.id));
  return s.selection.filter((id) => {
    if (id === CAMERA_ID || id.startsWith(MORPH_SEL)) return false;
    const c = s.project.clips.find((c) => c.id === id);
    return !!c && !locked.has(c.track);
  });
}

type Gesture = { ids: string[]; start: Record<string, Orient>; last: Record<string, Orient>; raf: number; timer: number; checkpointed: boolean };

export default function RotateGizmo({ view }: { view: Cam }) {
  const selection = useStore((s) => s.selection);
  const project = useStore((s) => s.project);
  const time = useStore((s) => s.time);
  const ids = useMemo(() => rotatableIds({ selection, project }), [selection, project]);
  const g = useRef<Gesture | null>(null);
  const geo = useMemo(() => gimbal(view), [view.theta, view.phi, view.gamma]);

  // collapsed to a small icon; hovering (or focusing) it opens the panel, leaving it closes it again
  // after a moment, never in the middle of a turn / scrub
  const [open, setOpen] = useState(false);
  const inside = useRef({ hover: false, focus: false });
  const closeT = useRef(0);
  const show = () => { clearTimeout(closeT.current); setOpen(true); };
  function hide(ms = CLOSE_MS) {
    clearTimeout(closeT.current);
    closeT.current = window.setTimeout(() => {
      if (!g.current && !inside.current.hover && !inside.current.focus) setOpen(false);
    }, ms);
  }

  useEffect(() => () => { stop(); clearTimeout(closeT.current); }, []);
  useEffect(() => {
    if (ids.length) return;
    clearTimeout(closeT.current);
    inside.current = { hover: false, focus: false };
    setOpen(false);
  }, [ids.length]);
  if (!ids.length) return null;
  const primary = project.clips.find((c) => c.id === ids[0])!;
  const cur = orientOf(primary, time - primary.start);

  // ---------------------------------------------------------------- editing
  const begin = (): Gesture => {
    stop();
    const st = useStore.getState();
    const start: Record<string, Orient> = {};
    for (const id of ids) {
      const c = st.project.clips.find((c) => c.id === id);
      if (c) start[id] = orientOf(c, st.time - c.start);
    }
    g.current = { ids, start, last: { ...start }, raf: 0, timer: 0, checkpointed: false };
    return g.current;
  };
  /** Give every selected clip the orientation `next(start, last)` (one undo step per gesture). */
  const apply = (gs: Gesture, next: (start: Orient, last: Orient) => Orient) => {
    const st = useStore.getState();
    if (!gs.checkpointed) {
      st.checkpoint();
      gs.checkpointed = true;
      useStore.setState({ interacting: true, playing: false });
    }
    const fps = st.project.settings.fps;
    st.commit((p) => {
      for (const id of gs.ids) {
        const c = p.clips.find((c) => c.id === id);
        const o0 = gs.start[id];
        if (!c || !o0) continue;
        const o = rounded(next(o0, gs.last[id]));
        gs.last[id] = o;
        setTransformAt(c, st.time - c.start, o, fps);
      }
    }, { transient: true });
  };
  /** Turn `total` degrees from the gesture's start about a world axis, each clip about its own centre. */
  const turn = (gs: Gesture, axis: Axis, total: number) => apply(gs, (o0, last) => turnWorld(o0, axis, total, last));
  function stop() {
    const gs = g.current;
    if (!gs) return;
    cancelAnimationFrame(gs.raf);
    clearTimeout(gs.timer);
    g.current = null;
    if (gs.checkpointed) useStore.setState({ interacting: false });
    if (!inside.current.hover) hide();
  }

  const stepOf = (e: { shiftKey: boolean; altKey: boolean }) => (e.shiftKey ? 90 : e.altKey ? 1 : 15);

  const onArrowDown = (e: React.PointerEvent, axis: Axis, sign: number) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const gs = begin();
    const step = sign * stepOf(e);
    turn(gs, axis, step);
    // held: keep turning smoothly from where the click left it
    gs.timer = window.setTimeout(() => {
      const t0 = performance.now();
      const tick = () => {
        if (g.current !== gs) return;
        turn(gs, axis, step + (sign * HOLD_DEG_PER_S * (performance.now() - t0)) / 1000);
        gs.raf = requestAnimationFrame(tick);
      };
      gs.raf = requestAnimationFrame(tick);
    }, HOLD_MS);
  };
  const onArrowKey = (e: React.KeyboardEvent, axis: Axis, sign: number) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    turn(begin(), axis, sign * stepOf(e));
    stop();
  };

  const onValueDown = (e: React.PointerEvent, field: keyof Orient) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const gs = begin();
    const x0 = e.clientX;
    const el = e.currentTarget as HTMLElement;
    const move = (ev: PointerEvent) => {
      if (g.current !== gs) return;
      const dx = ev.clientX - x0;
      if (!gs.checkpointed && Math.abs(dx) < 2) return;
      let total = dx * SCRUB_DEG_PER_PX;
      if (ev.shiftKey) total = Math.round(total / 15) * 15;
      apply(gs, (o0) => ({ ...o0, [field]: o0[field] + total }));
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      stop();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  const setAll = (patch: Partial<Orient>) => {
    stop();
    const st = useStore.getState();
    st.checkpoint();
    const fps = st.project.settings.fps;
    st.commit((p) => {
      for (const id of ids) {
        const c = p.clips.find((c) => c.id === id);
        if (c) setTransformAt(c, st.time - c.start, patch, fps);
      }
    }, { transient: true });
  };

  const fmt = (v: number) => `${Math.abs(v) < 0.05 ? 0 : Math.round(v * 10) / 10}°`;
  const turned = Math.abs(cur.rotation) > 1e-6 || Math.abs(cur.rx) > 1e-6 || Math.abs(cur.ry) > 1e-6;
  const many = ids.length > 1;

  return (
    <div
      className={`rot-gizmo${open ? ' open' : ''}`}
      data-testid="rot-gizmo"
      data-open={open ? '1' : '0'}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      onPointerEnter={() => { inside.current.hover = true; show(); }}
      onPointerLeave={() => { inside.current.hover = false; hide(); }}
      onFocus={(e) => {
        // keyboard focus keeps it open; a mouse click also focuses the arrow, which must not
        if (!(e.target as Element).matches(':focus-visible')) return;
        inside.current.focus = true;
        show();
      }}
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        inside.current.focus = false;
        hide();
      }}
    >
      <button
        className="rot-icon"
        data-testid="rot-icon"
        aria-label={`Rotate${many ? ` ${ids.length} clips` : ''}`}
        aria-expanded={open}
        title="Rotate"
        tabIndex={open ? -1 : 0}
        onClick={show}
      >
        <GimbalIcon g={geo} o={cur} />
        {many && <span className="rot-icon-count">{ids.length}</span>}
      </button>
      <div className="rot-panel" aria-hidden={!open}>
      <div className="rot-head">
        <span title={many ? `Turns all ${ids.length} selected clips, each about its own centre` : 'Click an arrow: the side of the clip facing you moves the way the arrow points'}>Rotate{many ? ` · ${ids.length}` : ''}</span>
        <button className="rot-reset" disabled={!turned && !many} onClick={() => setAll({ rotation: 0, rx: 0, ry: 0 })} title="Reset all rotations to 0°" data-testid="rot-reset"><Undo2 size={11} /></button>
      </div>
      <div className="rot-body">
        <Rings
          g={geo}
          o={cur}
          onDown={(e, axis, sign) => onArrowDown(e, axis, sign)}
          onKey={(e, axis, sign) => onArrowKey(e, axis, sign)}
          onUp={stop}
        />
        <div className="rot-vals">
          {AXES.map((spec) => (
            <div
              key={spec.axis}
              className="rot-val"
              style={{ ['--axis' as any]: spec.base }}
              data-testid={`rot-${spec.axis}-val`}
              title={`${spec.label === 'Z' ? 'Rotation' : `Rot ${spec.label}`} (as in the Inspector): drag to change just this angle (Shift = 15° steps) · double-click for 0°`}
              onPointerDown={(e) => onValueDown(e, spec.field)}
              onDoubleClick={() => setAll({ [spec.field]: 0 })}
            >
              <span className="rot-axis">{spec.label}</span>
              <span className="rot-num">{fmt(cur[spec.field])}</span>
            </div>
          ))}
        </div>
      </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the rings
const S = 124, C = S / 2, R = 44; // svg size, centre, ring radius (px)
const HB = 5.2, HH = 10.6;        // ribbon / arrowhead half-width
const A_GAP = 10, A_BODY = 44, A_TIP = 66; // arrow: degrees along the ring from the point facing the viewer
const BIAS = 0.3;
const HIT_PAD = 2; // px of grace around an arrow's outline (split halfway with a neighbour, like overlaps)

type P2 = { x: number; y: number };
const path = (q: P2[]) => `M${q.map((p) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join('L')}Z`;
type Quad = { d: string; z: number; axis: Axis; near: boolean };
type ArrowGeo = {
  key: string; spec: Spec; sign: number; name: string; z: number;
  poly: P2[]; d: string; tail: P2; tip: P2; go: P2; spine: P2[]; mid: P2; hit: string;
};

/**
 * Signed distance from (x, y) to a polygon's outline: negative inside (how deep), positive outside.
 */
function depth(poly: P2[], x: number, y: number): number {
  let best = Infinity, inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j], b = poly[i];
    if ((b.y > y) !== (a.y > y) && x < ((a.x - b.x) * (y - b.y)) / (a.y - b.y) + b.x) inside = !inside;
    const ex = b.x - a.x, ey = b.y - a.y, l2 = ex * ex + ey * ey || 1;
    const t = Math.max(0, Math.min(1, ((x - a.x) * ex + (y - a.y) * ey) / l2));
    const dx = a.x + t * ex - x, dy = a.y + t * ey - y;
    best = Math.min(best, dx * dx + dy * dy);
  }
  return inside ? -Math.sqrt(best) : Math.sqrt(best);
}

/**
 * Who owns each pixel: the arrow it sits deepest inside (or, within HIT_PAD outside, the nearest).
 * Where two arrows overlap the border lands in the middle between them, so every point belongs to
 * at most one arrow and a click never goes to the arrow you were not aiming at. Each arrow's hit
 * area is returned as a path of 1 px row runs.
 */
function hitAreas(arrows: { poly: P2[] }[]): { paths: string[]; owner: (x: number, y: number) => number } {
  const boxes = arrows.map(({ poly }) => {
    const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
    return { x0: Math.min(...xs) - HIT_PAD, x1: Math.max(...xs) + HIT_PAD, y0: Math.min(...ys) - HIT_PAD, y1: Math.max(...ys) + HIT_PAD };
  });
  const owner = (x: number, y: number) => {
    let who = -1, best = HIT_PAD;
    for (let i = 0; i < arrows.length; i++) {
      const b = boxes[i];
      if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1) continue;
      const d = depth(arrows[i].poly, x, y);
      if (d < best) { best = d; who = i; }
    }
    return who;
  };
  const x0 = Math.floor(Math.min(...boxes.map((b) => b.x0))), x1 = Math.ceil(Math.max(...boxes.map((b) => b.x1)));
  const y0 = Math.floor(Math.min(...boxes.map((b) => b.y0))), y1 = Math.ceil(Math.max(...boxes.map((b) => b.y1)));
  const paths = arrows.map(() => '');
  for (let y = y0; y < y1; y++) {
    let run = -1, from = x0;
    for (let x = x0; x <= x1; x++) {
      const who = x < x1 ? owner(x + 0.5, y + 0.5) : -1;
      if (who === run) continue;
      if (run >= 0) paths[run] += `M${from} ${y}h${x - from}v1h${from - x}z`;
      run = who;
      from = x;
    }
  }
  return { paths, owner };
}

/** Everything about the gimbal that depends only on the point of view. */
function gimbal(view: Pick<Cam, 'theta' | 'phi' | 'gamma'>) {
  const { right, up, out } = basis(view);
  const px = (p: V3): P2 => ({ x: C + dot(p, right), y: C - dot(p, up) });

  const quads: Quad[] = [];
  const arrows: ArrowGeo[] = [];
  for (const spec of AXES) {
    const { a, u, v, axis } = spec;
    const ao = dot(a, out), cr = Math.sqrt(Math.max(0, 1 - ao * ao));
    const rad = (f: number): V3 => add(mul(u, Math.cos(f)), mul(v, Math.sin(f)));
    /** Point of the ribbon at ring angle f, s px across it. */
    const pt = (f: number, s: number): V3 => {
      const r = rad(f);
      return add(mul(r, R), mul(add(mul(a, cr), mul(r, -ao)), s));
    };

    // where the arrows sit: the ring point nearest the viewer; a face-on ring has none, so the more
    // face-on it is, the more they lean towards the top (bottom for the Y ring) of the screen, which
    // keeps them steady while orbiting
    const flat = (d: V3) => sub(d, mul(a, dot(d, a)));
    const front = add(flat(out), mul(flat(up), BIAS * spec.bias * Math.abs(ao)));
    const f0 = Math.atan2(dot(front, v), dot(front, u));

    const N = 48;
    for (let i = 0; i < N; i++) {
      const f1 = (i / N) * 2 * Math.PI, f2 = ((i + 1) / N) * 2 * Math.PI, fm = (f1 + f2) / 2;
      quads.push({
        d: path([px(pt(f1, HB)), px(pt(f2, HB)), px(pt(f2, -HB)), px(pt(f1, -HB))]),
        z: dot(rad(fm), out),
        axis,
        near: !(cr > 0.06 && dot(rad(fm), out) < 0),
      });
    }

    for (const sign of [1, -1]) {
      const at = (d: number) => f0 + sign * d * DEG;
      const n = 8;
      const top: P2[] = [], bot: P2[] = [];
      for (let i = 0; i <= n; i++) {
        const f = at(A_GAP + ((A_BODY - A_GAP) * i) / n);
        top.push(px(pt(f, HB)));
        bot.push(px(pt(f, -HB)));
      }
      const poly = [...top, px(pt(at(A_BODY), HH)), px(pt(at(A_TIP), 0)), px(pt(at(A_BODY), -HH)), ...bot.reverse()];
      const spine: P2[] = [];
      for (let d = A_GAP + 3; d <= A_BODY + 6; d += 2) spine.push(px(pt(at(d), 0)));
      const name = sign > 0 ? 'pos' : 'neg';
      arrows.push({
        key: `${axis}-${name}`, spec, sign, name,
        z: dot(rad(at((A_GAP + A_BODY) / 2)), out),
        poly, d: path(poly), spine,
        tail: px(pt(at(A_GAP), 0)), tip: px(pt(at(A_TIP), 0)),
        // the way the arrow sets off (where the near side of the clip goes), for tests
        go: px(pt(at(A_GAP + 10), 0)),
        mid: px(pt(at((A_GAP + A_BODY) / 2 + 6), 0)),
        hit: '',
      });
    }
  }
  quads.sort((p, q) => p.z - q.z);
  arrows.sort((p, q) => p.z - q.z);

  const { paths, owner } = hitAreas(arrows);
  arrows.forEach((ar, i) => {
    ar.hit = paths[i];
    // a point that surely clicks this arrow (for tests): the spine point nearest the nominal middle
    // that is this arrow's and not a neighbour's
    const mine = ar.spine.filter((p) => owner(p.x, p.y) === i);
    if (mine.length) ar.mid = mine.reduce((b, p) => (Math.hypot(p.x - ar.mid.x, p.y - ar.mid.y) < Math.hypot(b.x - ar.mid.x, b.y - ar.mid.y) ? p : b));
  });
  return { right, up, out, px, quads, arrows };
}
type Gimbal = ReturnType<typeof gimbal>;

/** The clip as a card inside the gimbal (notch = its top edge; tint = front / back). */
function cardOf(g: Gimbal, o: Orient) {
  const m = orientMatrix(o);
  const turnP = (p: V3): V3 => [0, 1, 2].map((i) => m[i][0] * p[0] + m[i][1] * p[1] + m[i][2] * p[2]) as V3;
  const k = R * 0.5;
  const pts = (q: V3[]) => q.map((p) => g.px(mul(turnP(p), k))).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  return {
    card: pts([[-1, -0.65, 0], [1, -0.65, 0], [1, 0.65, 0], [-1, 0.65, 0]]),
    notch: pts([[-0.28, 0.65, 0], [0.28, 0.65, 0], [0, 1.02, 0]]),
    facing: dot(turnP([0, 0, 1]), g.out),
  };
}

/** The collapsed widget: the same gimbal, small, from the same point of view. */
function GimbalIcon({ g, o }: { g: Gimbal; o: Orient }) {
  const { card, notch, facing } = cardOf(g, o);
  const base = (axis: Axis) => AXES.find((s) => s.axis === axis)!.base;
  const pad = 4;
  return (
    <svg className="rot-icon-svg" viewBox={`${C - R - HH - pad} ${C - R - HH - pad} ${2 * (R + HH + pad)} ${2 * (R + HH + pad)}`} aria-hidden>
      {g.quads.filter((q) => !q.near).map((q, i) => <path key={`b${i}`} d={q.d} className="rot-band back" style={{ ['--axis' as any]: base(q.axis) }} />)}
      <polygon points={card} className={`rot-card ${facing >= 0 ? 'front' : 'back'}`} />
      <polygon points={notch} className="rot-notch" />
      {g.quads.filter((q) => q.near).map((q, i) => <path key={`n${i}`} d={q.d} className="rot-band near" style={{ ['--axis' as any]: base(q.axis) }} />)}
      {g.arrows.map((a) => <path key={a.key} d={a.d} className="rot-icon-arrow" fill={a.spec.base} stroke={a.spec.dark} />)}
    </svg>
  );
}

/**
 * One gimbal as seen from `view`: a card showing the clip's orientation inside three rings, one
 * about each world axis. Each ring is a ribbon band (a cone section tilted so that its near part
 * faces the viewer: a flat strip when the ring is edge-on, an annulus when face-on), with two
 * arrows starting back to back at the point of the ring nearest the viewer. Bands are painted far
 * to near (the card between their back and near halves), arrows last, nearest on top, and the one
 * under the pointer drawn once more over everything. Clicks go by hitAreas, never by paint order.
 */
function Rings({ g, o, onDown, onKey, onUp }: {
  g: Gimbal; o: Orient;
  onDown: (e: React.PointerEvent, axis: Axis, sign: number) => void;
  onKey: (e: React.KeyboardEvent, axis: Axis, sign: number) => void;
  onUp: () => void;
}) {
  const [hot, setHot] = useState<string | null>(null);
  const { px, quads } = g;
  const { arrows } = g;
  const top = arrows.find((a) => a.key === hot);

  const band = (q: Quad, i: number) => (
    <path key={i} d={q.d} className={`rot-band ${q.near ? 'near' : 'back'}`} style={{ ['--axis' as any]: AXES.find((s) => s.axis === q.axis)!.base }} />
  );

  const { card, notch, facing } = cardOf(g, o);

  return (
    <svg className="rot-ring" width={S} height={S} viewBox={`0 0 ${S} ${S}`} data-testid="rot-ring" data-facing={facing >= 0 ? 'front' : 'back'}>
      {AXES.map((spec) => {
        const p0 = px(mul(spec.a, -R * 1.3)), p1 = px(mul(spec.a, R * 1.3));
        return <line key={spec.axis} x1={p0.x} y1={p0.y} x2={p1.x} y2={p1.y} className="rot-axis-line" style={{ ['--axis' as any]: spec.base }} />;
      })}
      {quads.filter((q) => !q.near).map(band)}
      <polygon points={card} className={`rot-card ${facing >= 0 ? 'front' : 'back'}`} />
      <polygon points={notch} className="rot-notch" />
      {quads.filter((q) => q.near).map(band)}
      {arrows.map(({ key, spec, sign, name, d, tail, tip, go, mid, hit }) => {
        const len = Math.hypot(go.x - tail.x, go.y - tail.y) || 1;
        const id = `rot-grad-${spec.axis}-${sign > 0 ? 'p' : 'n'}`;
        return (
          <g
            key={key}
            className={`rot-arrow${hot === key ? ' hot' : ''}`}
            style={{ ['--axis' as any]: spec.base }}
            role="button"
            tabIndex={0}
            aria-label={`Turn 15° about ${spec.label}, ${sign > 0 ? 'counter-clockwise' : 'clockwise'} seen from +${spec.label}`}
            data-testid={`rot-${spec.axis}-${name}`}
            data-mid={`${mid.x.toFixed(1)},${mid.y.toFixed(1)}`}
            data-dir={`${((go.x - tail.x) / len).toFixed(4)},${((go.y - tail.y) / len).toFixed(4)}`}
            onPointerEnter={() => setHot(key)}
            onPointerLeave={() => setHot((h) => (h === key ? null : h))}
            onPointerDown={(e) => onDown(e, spec.axis, sign)}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            onKeyDown={(e) => onKey(e, spec.axis, sign)}
          >
            <title>{`Turn 15° this way (about ${spec.label}): the side facing you follows the arrow · Shift 90° · Alt 1° · hold to keep turning`}</title>
            <defs>
              <linearGradient id={id} gradientUnits="userSpaceOnUse" x1={tail.x} y1={tail.y} x2={tip.x} y2={tip.y}>
                <stop offset="0" stopColor={spec.dark} />
                <stop offset="0.6" stopColor={spec.base} />
                <stop offset="1" stopColor={spec.light} />
              </linearGradient>
            </defs>
            <path d={d} className="rot-arrow-edge" fill={spec.dark} transform="translate(0 1.8)" />
            <path d={d} className="rot-arrow-shape" fill={`url(#${id})`} />
            <path d={hit} className="rot-arrow-hit" />
          </g>
        );
      })}
      {/* the arrow under the pointer, again on top of the others (the DOM order never changes: moving
          the hovered node would drop its pointer capture mid-click) */}
      {top && (
        <g className="rot-arrow-over" style={{ ['--axis' as any]: top.spec.base }} aria-hidden>
          <path d={top.d} className="rot-arrow-edge" fill={top.spec.dark} transform="translate(0 1.8)" />
          <path d={top.d} className="rot-arrow-shape" fill={`url(#rot-grad-${top.spec.axis}-${top.sign > 0 ? 'p' : 'n'})`} />
        </g>
      )}
    </svg>
  );
}
