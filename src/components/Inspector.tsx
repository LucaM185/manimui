import { useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { python } from '@codemirror/lang-python';
import { oneDark } from '@codemirror/theme-one-dark';
import { keymap } from '@codemirror/view';
import { editClipCode, useStore, itemById } from '../store';
import { fetchClipSource } from '../engine';
import { CAMERA_ID, cameraAt, selectedMorph, CATEGORY_COLORS, isFlat, round, setCameraAt, setTransformAt, transformAt } from '../ops';
import { fitNav, lookPreset } from '../nav';
import { VIEW_PRESETS } from '../view3d';
import type { Clip, Project, Transform } from '../types';
import { evalLayout, layoutProblems } from '../globals';
import { ColorField, NumberField, SelectField, TextField, type FieldHooks } from './fields';
import LinkableParam from './LinkableParam';
import CodeKnobs, { PartStyle } from './CodeKnobs';
import { findNode, useClipParts } from '../parts';
import { deleteSelection, duplicateSelection, groupProblem, groupSelection, removeTransform } from '../actions';
import { exitWindow, isMorph, useClipThumb } from '../clipThumbs';
import { CategoryIcon } from '../icons';
import {
  AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignStartHorizontal, AlignStartVertical,
  Clapperboard, Diamond, RotateCcw, Sparkles,
  Trash2, Video, X, AlertTriangle, Copy, Link2, Unlink, Shuffle, ArrowRight, Boxes,
} from 'lucide-react';

const FW = 14.222222222222221;
const FH = 8;

function useClipEdit(id: string) {
  const st = useStore.getState;
  return {
    begin: () => st().checkpoint(),
    edit: (fn: (c: Clip, p: Project) => void) =>
      st().commit((p) => {
        const c = p.clips.find((c) => c.id === id);
        if (c) fn(c, p);
      }, { transient: true }),
  };
}

function Section({ title, children, right, icon, id, signal = 0, mark, defaultOpen = false }: {
  title: string; children: any; right?: any; icon?: any; id?: string;
  /** start expanded (the camera's view and waypoints are what you came for) */
  defaultOpen?: boolean;
  /** non-zero and changing: open this section and scroll it into view */
  signal?: number;
  /** effect id to scroll to once the section is open */
  mark?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (signal) setOpen(true);
  }, [signal]);
  useEffect(() => {
    if (!signal || !open) return;
    const target = (mark && ref.current?.querySelector(`[data-effect="${mark}"]`)) || ref.current;
    target?.scrollIntoView({ block: 'nearest' });
  }, [signal, open, mark]);
  return (
    <section className="ins-section" ref={ref} data-section={id}>
      <h5 onClick={() => setOpen(!open)}>
        <span className={`chev ${open ? 'open' : ''}`}>›</span> {icon} {title}
        <span className="spacer" />
        <span onClick={(e) => e.stopPropagation()}>{right}</span>
      </h5>
      {open && <div className="ins-body">{children}</div>}
    </section>
  );
}

// ---------------------------------------------------------------------------- scene settings
function SceneSettings() {
  const settings = useStore((s) => s.project.settings);
  const clips = useStore((s) => s.project.clips.length);
  const st = useStore.getState;
  const set = (k: keyof Project['settings']): FieldHooks => ({
    onBegin: () => st().checkpoint(),
    onChange: (v) => st().commit((p) => { (p.settings as any)[k] = v; }, { transient: true }),
  });
  return (
    <div className="ins-scroll">
      <div className="ins-title">
        <div className="ins-icon" style={{ background: '#2a2d35' }}><Clapperboard size={18} /></div>
        <div>
          <div className="ins-name static">Scene</div>
          <div className="muted small">{clips} clip{clips === 1 ? '' : 's'} · nothing selected</div>
        </div>
      </div>
      <Section icon={<Clapperboard size={13} />} title="Scene">
        <TextField label="Name" value={settings.name} {...set('name')} />
        <ColorField label="Background" value={settings.background} {...set('background')} />
        <NumberField label="Duration" value={settings.duration} step={0.5} min={0.5} suffix="s" {...set('duration')} />
        <SelectField label="Frame rate" value={String(settings.fps)} options={['15', '24', '25', '30', '50', '60']} onBegin={() => st().checkpoint()} onChange={(v) => st().commit((p) => { p.settings.fps = Number(v); }, { transient: true })} />
      </Section>
      <Section icon={<Sparkles size={13} />} title="Getting started">
        <ul className="tips">
          <li><b>Drag</b> a mobject from the library onto the preview to place it, or onto the timeline to place it in time.</li>
          <li><b>Drag objects in the preview</b> to move them. Pick an object or the camera by its centre <b>+</b> and it snaps onto other centres. Corners scale, the top dot rotates. <kbd>⇧</kbd> constrains, <kbd>⌘</kbd> disables snapping.</li>
          <li>The <b>timeline’s vertical order is z-order</b>: the top track is drawn in front. Drag a track’s ⠿ grip to reorder.</li>
          <li><b>Click</b> the shaded start / end of a clip to pick its enter / exit animation (hover a clip’s corner and click <b>+</b> when it has none); drag the dashed line to change its length.</li>
          <li>To <b>move or change an object over time</b>, press <kbd>T</kbd> (or right-click → Add transform here): the clip splits, and you move or restyle the second half.</li>
          <li><kbd>A</kbd> select tool · <kbd>B</kbd> blade tool (click a clip to cut, <kbd>⇧</kbd> all) · <kbd>⌘B</kbd> blade at playhead</li>
          <li><kbd>Space</kbd> play · <kbd>⌘D</kbd> duplicate · <kbd>⌫</kbd> delete · <kbd>←/→</kbd> step</li>
          <li>Drop images or SVGs from Finder anywhere.</li>
        </ul>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------- transform
/**
 * Where the clip is. One static transform per clip: to move / scale / restyle something over time,
 * split it with "Add transform here" on the timeline (T) and change the copy.
 */
function TransformFields({ clip }: { clip: Clip }) {
  const time = useStore((s) => s.time);
  const fps = useStore((s) => s.project.settings.fps);
  const { begin, edit } = useClipEdit(clip.id);
  const u = Math.min(Math.max(time - clip.start, 0), clip.duration);
  const tr = transformAt(clip, u);
  const legacyKeys = clip.keys.length > 0;
  const field = (k: keyof Transform): FieldHooks => ({
    onBegin: begin,
    onChange: (v) => edit((c) => setTransformAt(c, u, { [k]: v }, fps)),
  });

  return (
    <section className="ins-section bare" data-section="transform">
      <div className="ins-body">
        {legacyKeys && (
          <div className="kf-note legacy" data-testid="legacy-keys">
            This clip moves with old keyframes ({clip.keys.length}).{' '}
            <a onClick={() => { begin(); edit((c) => { c.keys = []; c.transform = { ...transformAt(c, u) }; }); }}>Remove them</a>
            {' '}and use <b>Add transform here</b> (T) on the timeline instead.
          </div>
        )}
        <div className="grid2">
          <NumberField label="X" value={tr.x} step={0.05} {...field('x')} testid="tr-x" />
          <NumberField label="Y" value={tr.y} step={0.05} {...field('y')} testid="tr-y" />
          <NumberField label="Scale" value={tr.scale} step={0.05} min={0.01} {...field('scale')} testid="tr-scale" />
          <NumberField label="Rotation" value={tr.rotation} step={1} suffix="°" {...field('rotation')} />
        </div>
        {!legacyKeys && <LayoutBinding clip={clip} />}
        <div className="grid2">
          <NumberField label="Z" value={tr.z || 0} step={0.05} {...field('z')} testid="tr-z" />
          <NumberField label="Opacity" value={tr.opacity} step={0.05} min={0} max={1} {...field('opacity')} />
        </div>
        <div className="grid2" title="3D orientation, applied after Rotation: tip about the x axis, then turn about the y axis. Rot X −90° lays it flat on the floor, readable from the Top view.">
          <NumberField label="Rot X" value={tr.rx || 0} step={1} suffix="°" {...field('rx')} testid="tr-rx" />
          <NumberField label="Rot Y" value={tr.ry || 0} step={1} suffix="°" {...field('ry')} testid="tr-ry" />
        </div>
        <label className="dyn-toggle pin-toggle" title="Draw it on top of the video in screen space, ignoring camera moves — for titles and labels over a 3D scene">
          <input type="checkbox" data-testid="pin-toggle" checked={!!clip.fixed} onChange={(e) => { begin(); edit((c) => { if (e.target.checked) c.fixed = true; else delete c.fixed; }); }} />
          Pin to screen <span className="muted">— ignores the camera (titles over 3D)</span>
        </label>
        <div className="align-row">
          <span className="muted small">Align</span>
          {([
            [<AlignStartVertical size={14} />, 'Left edge', { x: -FW / 2 + 1.5 }],
            [<AlignCenterVertical size={14} />, 'Center horizontally', { x: 0 }],
            [<AlignEndVertical size={14} />, 'Right edge', { x: FW / 2 - 1.5 }],
            [<AlignStartHorizontal size={14} />, 'Top edge', { y: FH / 2 - 1 }],
            [<AlignCenterHorizontal size={14} />, 'Center vertically', { y: 0 }],
            [<AlignEndHorizontal size={14} />, 'Bottom edge', { y: -FH / 2 + 1 }],
          ] as [any, string, Partial<Transform>][]).map(([icon, title, patch]) => (
            <button key={title} className="mini" title={title} onClick={() => { begin(); edit((c) => setTransformAt(c, u, patch, fps)); }}>{icon}</button>
          ))}
          <div className="spacer" />
          <button className="mini text" title="Reset scale, rotation (all axes) and opacity" onClick={() => { begin(); edit((c) => setTransformAt(c, u, { scale: 1, rotation: 0, rx: 0, ry: 0, opacity: 1 }, fps)); }}><RotateCcw size={12} /> Reset</button>
        </div>
      </div>
    </section>
  );
}

type Focus = { section: string; effectId?: string; n: number } | null;

/** A part picked in the viewer / on the timeline: its own style knobs (custom-code clips), above the clip's. */
function SelectedPartStyle({ clip }: { clip: Clip }) {
  const path = useStore((s) => (s.selectedPart?.clip === clip.id ? s.selectedPart.path : null));
  const tree = useClipParts(clip);
  if (path === null || !clip.code) return null;
  return <PartStyle clip={clip} label={findNode(tree, path)?.label} />;
}

// ---------------------------------------------------------------------------- clip: parameters + transform
/** The clip's look (parameters) and place (transform). Animations, parts and effects live on the timeline. */
function ClipFields({ clip, focus }: { clip: Clip; focus: Focus }) {
  const item = itemById(clip.item);
  const assets = useStore((s) => s.project.assets);
  const { begin, edit } = useClipEdit(clip.id);
  const firstRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const f = () => {
      const el = firstRef.current?.querySelector('input:not([type=color]), textarea') as HTMLInputElement | null;
      el?.focus();
      el?.select?.();
    };
    window.addEventListener('focus-first-param', f);
    return () => window.removeEventListener('focus-first-param', f);
  }, []);
  // double-click on the clip (timeline / viewer): bring the parameters into view
  useEffect(() => {
    if (focus?.n) firstRef.current?.scrollIntoView({ block: 'nearest' });
  }, [focus?.n]);

  return (
    <>
      <section className="ins-section bare" data-section="params" ref={firstRef}>
        <div className="ins-body">
          <SelectedPartStyle clip={clip} />
          {clip.code ? (
            <CodeKnobs clip={clip} onReset={item && item.params.length > 0 ? () => { begin(); edit((c) => { c.code = null; }); } : undefined} />
          ) : item && item.params.length ? (
            item.params.map((p) => (
              <LinkableParam
                key={p.id}
                def={p}
                value={clip.params[p.id]}
                assets={assets}
                hooks={{ onBegin: begin, onChange: (v) => edit((c) => { c.params = { ...c.params, [p.id]: v }; }) }}
              />
            ))
          ) : (
            <div className="detached">
              <p>No parameters — edit the code directly.</p>
              <button className="btn small" onClick={() => editClipCode(clip.id)}>Edit code</button>
            </div>
          )}
        </div>
      </section>
      <TransformFields clip={clip} />
    </>
  );
}

// ---------------------------------------------------------------------------- position bound to globals
function LayoutExpr({ clip, axis }: { clip: Clip; axis: 'x' | 'y' }) {
  const globals = useStore((s) => s.project.globals);
  const expr = clip.layout?.[axis] ?? '';
  const [text, setText] = useState(expr);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setText(expr); setErr(null); }, [expr]);
  const { begin, edit } = useClipEdit(clip.id);
  const commit = () => {
    if (text === expr) return;
    if (evalLayout(text, globals) === null) {
      const unknown = layoutProblems(text, globals);
      setErr(unknown.length ? `unknown: ${unknown.join(', ')}` : 'invalid expression');
      return;
    }
    setErr(null);
    begin();
    edit((c) => { c.layout = { ...(c.layout || {}), [axis]: text.trim() }; });
  };
  return (
    <div className={`layout-row ${err ? 'err' : ''}`} title="Follows the globals; drag the clip to place it by hand instead">
      <Link2 size={11} />
      <span className="ax">{axis.toUpperCase()} =</span>
      <input
        value={text}
        spellCheck={false}
        data-testid={`layout-${axis}`}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      <button className="mini" title="Unbind (keep the current position)" data-testid={`layout-unbind-${axis}`} onClick={() => { begin(); edit((c) => { if (c.layout) { delete c.layout[axis]; if (c.layout.x == null && c.layout.y == null) delete c.layout; } }); }}>
        <Unlink size={11} />
      </button>
      {err && <div className="layout-err">{err}</div>}
    </div>
  );
}

/** X / Y that follow expressions over number globals, so spacing globals move separate elements. */
function LayoutBinding({ clip }: { clip: Clip }) {
  const hasNumberGlobals = useStore((s) => (s.project.globals || []).some((g) => g.type === 'number'));
  const { begin, edit } = useClipEdit(clip.id);
  const bound = clip.layout && (clip.layout.x != null || clip.layout.y != null);
  if (!bound && !hasNumberGlobals) return null;
  return (
    <div className="layout-bind">
      {clip.layout?.x != null && <LayoutExpr clip={clip} axis="x" />}
      {clip.layout?.y != null && <LayoutExpr clip={clip} axis="y" />}
      {hasNumberGlobals && (clip.layout?.x == null || clip.layout?.y == null) && (
        <button
          className="btn small ghost layout-add"
          data-testid="layout-bind"
          title="Make the position an expression over globals, e.g. TOP_Y - 2*ROW_GAP"
          onClick={() => {
            begin();
            edit((c) => {
              const l = { ...(c.layout || {}) };
              if (l.x == null) l.x = String(round(c.transform.x, 3));
              if (l.y == null) l.y = String(round(c.transform.y, 3));
              c.layout = l;
            });
          }}
        >
          <Link2 size={11} /> Bind position to globals
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------- code tab
export function CodeTab({ clip }: { clip: Clip }) {
  const [code, setCode] = useState('');
  const [dynamic, setDynamic] = useState(false);
  const [dirty, setDirty] = useState(false);
  const { begin, edit } = useClipEdit(clip.id);
  const error = useStore((s) => s.meta?.errors?.[clip.id]);
  const item = itemById(clip.item);
  const timer = useRef<any>(null);
  const began = useRef(false);
  const sig = JSON.stringify([clip.item, clip.params, clip.code, (clip as any).dynamic]);

  useEffect(() => {
    if (dirty) return;
    fetchClipSource(clip).then((r) => {
      setCode(r.code);
      setDynamic(r.dynamic);
    });
  }, [sig]);

  const apply = (text: string) => {
    if (!began.current) {
      begin();
      began.current = true;
    }
    edit((c) => {
      c.code = text;
      (c as any).dynamic = dynamic;
    });
    setDirty(false);
  };

  const onChange = (v: string) => {
    setCode(v);
    setDirty(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => apply(v), 700);
  };

  const ext = useMemo(
    () => [
      python(),
      keymap.of([{ key: 'Mod-Enter', run: (v) => { clearTimeout(timer.current); apply(v.state.doc.toString()); return true; } }]),
    ],
    [clip.id, dynamic],
  );

  return (
    <div className="code-tab">
      <div className="code-tab-head">
        <span className="mono small">def make_{clip.name.toLowerCase().replace(/\W+/g, '_')}({dynamic ? 't, a' : ''}):</span>
        <div className="spacer" />
        {clip.code && item && item.params.length > 0 && (
          <button className="btn small ghost" onClick={() => { begin(); edit((c) => { c.code = null; delete (c as any).dynamic; }); began.current = false; }}>Reset to template</button>
        )}
      </div>
      <div className="code-editor" data-testid="clip-code">
        <CodeMirror value={code} theme={oneDark} extensions={ext} onChange={onChange} basicSetup={{ foldGutter: false }} height="100%" onBlur={() => { began.current = false; }} />
      </div>
      <label className="dyn-toggle">
        <input
          type="checkbox"
          checked={dynamic}
          onChange={(e) => {
            setDynamic(e.target.checked);
            begin();
            edit((c) => { (c as any).dynamic = e.target.checked; c.code = c.code || code; });
          }}
        />
        Rebuild every frame — the code can use <code>t</code> (seconds since the clip started) and <code>a</code> (0 → 1 over the clip)
      </label>
      {error ? <pre className="code-error">{error}</pre> : <div className="muted small">Edits apply automatically (⌘↩ to apply now). Any ManimGL code works — return a mobject.</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------- camera
function CameraInspector() {
  const project = useStore((s) => s.project);
  const camFullView = useStore((s) => s.camFullView);
  const time = useStore((s) => s.time);
  const st = useStore.getState;
  const fps = project.settings.fps;
  const cam = cameraAt(project, time);
  const keys = [...(project.settings.camera || [])].sort((a, b) => a.t - b.t);
  const onKey = keys.find((k) => Math.abs(k.t - time) <= 0.5 / fps);
  const field = (k: 'x' | 'y' | 'z' | 'zoom' | 'theta' | 'phi' | 'gamma'): FieldHooks => ({
    onBegin: () => st().checkpoint(),
    onChange: (v) => st().commit((p) => setCameraAt(p, st().time, { [k]: v }, fps), { transient: true }),
  });
  const commit = (fn: (p: Project) => void) => st().commit(fn);
  return (
    <aside className="panel inspector" data-testid="camera-inspector">
      <div className="panel-head"><span>Inspector</span></div>
      <div className="ins-title">
        <div className="ins-icon" style={{ background: '#3d7ff0' }}><Video size={18} /></div>
        <div>
          <div className="ins-name static">Camera</div>
          <div className="muted small">{keys.length ? `${keys.length} keyframe${keys.length > 1 ? 's' : ''}` : 'static (default view)'}</div>
        </div>
      </div>
      <div className="ins-scroll">
        <Section
          icon={<Video size={13} />}
          title="View"
          id="cam-view"
          defaultOpen
          right={
            <div className="kf-controls">
              <button className={`kf-btn ${onKey ? 'on' : keys.length ? 'half' : ''}`} title={onKey ? 'Remove camera key' : 'Add camera key at playhead (K)'} onClick={() => commit((p) => {
                if (onKey) p.settings.camera = (p.settings.camera || []).filter((k) => k.id !== onKey.id);
                else setCameraAt(p, time, {}, fps);
              })}>
                <Diamond size={12} fill={onKey ? 'currentColor' : 'none'} />
              </button>
            </div>
          }
        >
          <div className="kf-note">{onKey ? '◆ Editing the camera key at the playhead' : 'Editing creates a camera keyframe at the playhead'}</div>
          <div className="grid2">
            <NumberField label="X" value={cam.x} step={0.1} {...field('x')} />
            <NumberField label="Y" value={cam.y} step={0.1} {...field('y')} />
            <NumberField label="Z" value={cam.z} step={0.1} {...field('z')} />
            <NumberField label="Zoom" value={cam.zoom} step={0.05} min={0.05} suffix="×" {...field('zoom')} testid="cam-zoom" />
          </div>
          <div className="sub-head">Orientation <span className="muted small">(degrees, like frame.reorient)</span></div>
          <div className="grid2 grid3">
            <NumberField label="Orbit θ" value={cam.theta} step={1} suffix="°" {...field('theta')} testid="cam-theta" />
            <NumberField label="Tilt φ" value={cam.phi} step={1} suffix="°" {...field('phi')} testid="cam-phi" />
            <NumberField label="Roll γ" value={cam.gamma} step={1} suffix="°" {...field('gamma')} />
          </div>
          <div className="view-presets">
            {(['top', 'front', 'right', 'iso'] as const).map((k) => (
              <button key={k} className="btn small ghost" data-testid={`cam-preset-${k}`} title={`${VIEW_PRESETS[k].label}${VIEW_PRESETS[k].key ? ` (${VIEW_PRESETS[k].key})` : ''}`} onClick={() => lookPreset(k, 'camera')}>
                {k === 'iso' ? '3D' : VIEW_PRESETS[k].label}
              </button>
            ))}
            <button className="btn small ghost" title="Zoom the camera to fit" onClick={() => fitNav('camera')}>Fit</button>
          </div>
          <div className="row-btns" style={{ padding: 0 }}>
            <button className="btn small" onClick={() => commit((p) => setCameraAt(p, time, { x: 0, y: 0, z: 0, zoom: 1, theta: 0, phi: 0, gamma: 0 }, fps))}>Reset view here</button>
            <button className="btn small ghost" disabled={!keys.length} onClick={() => commit((p) => { p.settings.camera = []; })}>Remove all keys</button>
          </div>
          <div className="seg cam-seg">
            <button className={camFullView && isFlat(cam) ? 'on' : ''} disabled={!isFlat(cam)} title={isFlat(cam) ? '' : 'The full-scene crop view is for flat (2D) cameras'} onClick={() => useStore.setState({ camFullView: true, editorView: null })}>Full scene</button>
            <button className={!camFullView || !isFlat(cam) ? 'on' : ''} onClick={() => useStore.setState({ camFullView: false, editorView: null })}>Camera view</button>
          </div>
          <p className="muted small" style={{ margin: 0 }}>
            {!isFlat(cam)
              ? 'Looking through the 3D camera: right-drag (or ⌥-drag) to orbit, ⇧+right-drag to pan, drag to pan, scroll to zoom to the pointer. Click the view cube to look from a side.'
              : camFullView
              ? 'The preview shows the whole scene; the blue box is what the camera sees. Drag it to move, drag a corner to resize (⌥ resizes from the centre), drag outside it to draw a new crop, scroll to zoom. Press C to look through the camera.'
              : 'Looking through the camera: drag to pan, scroll to zoom. Press C to go back to the full scene.'}
          </p>
        </Section>
        {keys.length > 0 && (
          <Section icon={<Diamond size={13} />} title="Waypoints" id="cam-keys" defaultOpen>
            <div className="kf-list">
              {keys.map((k, i) => (
                <div key={k.id} className={`kf-row ${onKey?.id === k.id ? 'on' : ''}`} onClick={() => st().setTime(k.t)}>
                  <span className="kf-dia" style={{ color: 'var(--accent)' }}><Diamond size={10} fill="currentColor" /></span>
                  <span className="mono">{k.t.toFixed(2)}s</span>
                  <span className="muted small">({k.x.toFixed(1)}, {k.y.toFixed(1)}{k.z ? `, ${k.z.toFixed(1)}` : ''}) ×{k.zoom.toFixed(2)}{k.theta || k.phi || k.gamma ? ` · ${(k.theta || 0).toFixed(0)}°/${(k.phi || 0).toFixed(0)}°` : ''}</span>
                  <div className="spacer" />
                  {i > 0 && (
                    <select value={k.ease || 'smooth'} onClick={(e) => e.stopPropagation()} onChange={(e) => commit((p) => { const kk = p.settings.camera?.find((x) => x.id === k.id); if (kk) kk.ease = e.target.value; })}>
                      {['smooth', 'linear', 'rush_into', 'rush_from', 'double_smooth'].map((r) => <option key={r}>{r}</option>)}
                    </select>
                  )}
                  <button className="mini" onClick={(e) => { e.stopPropagation(); commit((p) => { p.settings.camera = (p.settings.camera || []).filter((x) => x.id !== k.id); }); }}><X size={13} /></button>
                </div>
              ))}
            </div>
          </Section>
        )}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------- inspector
export default function Inspector() {
  const selection = useStore((s) => s.selection);
  const clips = useStore((s) => s.project.clips);
  const errors = useStore((s) => s.meta?.errors) || {};
  const clip = selection.length === 1 ? clips.find((c) => c.id === selection[0]) : undefined;
  if (selection.length === 1 && selection[0] === CAMERA_ID) return <CameraInspector />;
  const morphOf = selectedMorph(selection);
  const morphClip = morphOf ? clips.find((c) => c.id === morphOf) : undefined;
  if (morphClip && isMorph(morphClip)) return <TransformInspector clip={morphClip} />;

  if (selection.length > 1) {
    const sel = clips.filter((c) => selection.includes(c.id));
    const groupWhy = groupProblem(selection);
    return (
      <aside className="panel inspector">
        <div className="panel-head"><span>Inspector</span></div>
        <div className="ins-scroll">
          <div className="ins-title">
            <div className="ins-icon">{sel.length}</div>
            <div className="ins-name static">{sel.length} clips selected</div>
          </div>
          <div className="multi-list">
            {sel.map((c) => <div key={c.id} onClick={() => useStore.setState({ selection: [c.id] })}>{c.name}</div>)}
          </div>
          <div className="row-btns">
            <button className="btn small primary" data-testid="group-clips" disabled={!!groupWhy} title={groupWhy || 'Make one VGroup clip of them (⌘G) — each keeps its position and timing'} onClick={groupSelection}><Boxes size={13} /> Group</button>
            <button className="btn small" onClick={duplicateSelection}><Copy size={13} /> Duplicate</button>
            <button className="btn small danger" onClick={deleteSelection}><Trash2 size={13} /> Delete</button>
          </div>
          <p className="muted small">{groupWhy && sel.length > 1 ? groupWhy + '. ' : ''}Drag them together in the preview or the timeline.</p>
        </div>
      </aside>
    );
  }

  if (!clip) {
    return (
      <aside className="panel inspector">
        <div className="panel-head"><span>Inspector</span></div>
        <SceneSettings />
      </aside>
    );
  }

  return <ClipInspector clip={clip} error={errors[clip.id]} />;
}

/** The transform clip between two states (clip.exit morphs it into clip.exit.target). */
function TransformInspector({ clip }: { clip: Clip }) {
  const library = useStore((s) => s.library);
  const clips = useStore((s) => s.project.clips);
  const target = clips.find((c) => c.id === clip.exit.target);
  const { begin, edit } = useClipEdit(clip.id);
  const anims = library?.animations;
  const kinds = (anims?.exit || []).filter((a) => a.id === 'TransformInto' || a.id === 'TransformMatching');
  const [t0] = exitWindow(clip);
  const start = clip.start + t0;
  const end = clip.start + clip.duration;
  const ed = clip.enter.type !== 'none' ? clip.enter.duration : 0;
  const thumbA = useClipThumb(clip);
  const thumbB = useClipThumb(target);
  const pick = (id: string) => useStore.setState({ selection: [id] });
  return (
    <aside className="panel inspector" data-testid="transform-inspector">
      <div className="panel-head"><span>Inspector</span></div>
      <div className="ins-title">
        <div className="ins-thumb tclip-thumb" title="Transform"><Shuffle size={20} /></div>
        <div className="grow">
          <div className="ins-name static">Transform</div>
          <div className="muted small ins-sub">{clip.name} <ArrowRight size={10} /> {target?.name ?? '?'} · {start.toFixed(2)}s → {end.toFixed(2)}s</div>
        </div>
      </div>
      <div className="ins-scroll" key={clip.id}>
        <div className="morph-states">
          <button className="morph-state" data-testid="morph-from" onClick={() => pick(clip.id)} title={`Select “${clip.name}” (before the transform)`}>
            {thumbA.url ? <img src={thumbA.url} alt="" /> : <span />}
            <span className="nm">{clip.name}</span>
          </button>
          <ArrowRight size={16} className="muted" />
          {target && (
            <button className="morph-state" data-testid="morph-to" onClick={() => pick(target.id)} title={`Select “${target.name}” (after the transform) — move or restyle it to change what the transform becomes`}>
              {thumbB.url ? <img src={thumbB.url} alt="" /> : <span />}
              <span className="nm">{target.name}</span>
            </button>
          )}
        </div>
        <div className="ins-body">
          {kinds.length > 1 && (
            <SelectField
              label="Kind"
              value={clip.exit.type}
              options={kinds.map((k) => k.id)}
              labels={Object.fromEntries(kinds.map((k) => [k.id, k.label]))}
              onBegin={begin}
              onChange={(v) => edit((c) => { c.exit = { ...c.exit, type: v }; })}
            />
          )}
          <NumberField
            label="Length"
            testid="morph-length"
            value={round(end - start, 2)}
            step={0.1}
            min={0.1}
            max={round(clip.duration - ed, 2)}
            suffix="s"
            onBegin={begin}
            onChange={(v) => edit((c) => { c.exit = { ...c.exit, duration: round(Math.max(0.1, Math.min(c.duration - ed, v)), 2) }; })}
          />
          <SelectField label="Easing" value={clip.exit.rate || 'smooth'} options={anims?.rates || ['smooth']} onBegin={begin} onChange={(v) => edit((c) => { c.exit = { ...c.exit, rate: v }; })} />
          {clip.exit.type === 'TransformMatching' && <div className="hint">Matches identical glyphs between two Tex / Text objects (great for equation steps).</div>}
          <p className="muted small">Ends where “{target?.name}” starts. Drag the transform's edges on the timeline to change when it starts or ends.</p>
          <div className="row-btns">
            <button className="btn small danger" data-testid="remove-transform" onClick={() => removeTransform(clip.id)}><Trash2 size={13} /> Remove transform</button>
          </div>
        </div>
      </div>
    </aside>
  );
}

function ClipInspector({ clip, error }: { clip: Clip; error?: string }) {
  const item = itemById(clip.item);
  const color = CATEGORY_COLORS[item?.category || 'Custom'];
  const thumb = useClipThumb(clip);
  const focus = useStore((s) => (s.inspectorFocus?.clip === clip.id ? s.inspectorFocus : null));
  return (
    <aside className="panel inspector" data-testid="inspector">
      <div className="panel-head"><span>Inspector</span></div>
      <div className="ins-title">
        <div className="ins-thumb" style={{ borderColor: color }} title={item?.name}>
          {thumb.url ? <img src={thumb.url} alt="" /> : <span style={{ color }}><CategoryIcon category={item?.category || 'Custom'} size={20} /></span>}
        </div>
        <div className="grow">
          <input
            className="ins-name"
            value={clip.name}
            data-testid="clip-name"
            onFocus={() => useStore.getState().checkpoint()}
            onChange={(e) => useStore.getState().commit((p) => { const c = p.clips.find((c) => c.id === clip.id); if (c) c.name = e.target.value; }, { transient: true })}
          />
          <div className="muted small ins-sub"><CategoryIcon category={item?.category || 'Custom'} size={11} /> {item?.name}{item?.dynamic || clip.dynamic ? ' · animated' : ''}{clip.code ? ' · custom code' : ''}</div>
        </div>
      </div>
      {error && <div className="ins-error" onClick={() => editClipCode(clip.id)}><AlertTriangle size={12} /> {error}</div>}
      <div className="ins-scroll" key={clip.id}>
        <ClipFields clip={clip} focus={focus} />
      </div>
    </aside>
  );
}
