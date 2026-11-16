// Hover card for a camera waypoint on the timeline: what the camera sees at that key, i.e. the
// rendered output frame at the key's time (the engine's /frame without the editor `view` override).
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { base } from '../engine';
import { useStore } from '../store';
import type { FrameMeta, Project } from '../types';
import type { AnchorRect } from './AnimPicker';
import './CamKeyPreview.css';

const PREVIEW_W = 224; // css px
const HOVER_DELAY = 90; // ms: sweeping the pointer across several keys does not queue a render per key

type Shot = { img: ImageData; cam: FrameMeta['camera'] };
// one cache per project object: every edit makes a new project, so stale pictures drop out on their own
const cache = new WeakMap<Project, Map<string, Shot>>();
// key id -> last picture shown, displayed (dimmed) while a newer one renders after an edit
const lastShown = new Map<string, Shot>();

async function renderAt(project: Project, t: number, w: number, h: number): Promise<Shot> {
  const r = await fetch(`${base()}/frame`, {
    method: 'POST',
    // same engine state as the live preview (no rebuild of the scene); thumb: queued behind live frames
    body: JSON.stringify({ project, t, w, h, thumb: true, state: useStore.getState().sessionId }),
  });
  if (!r.ok) throw new Error(`engine returned ${r.status}`);
  const meta: FrameMeta = JSON.parse(decodeURIComponent(r.headers.get('X-Meta') || '{}'));
  const buf = await r.arrayBuffer();
  return { img: new ImageData(new Uint8ClampedArray(buf), meta.w, meta.h), cam: meta.camera };
}

const fmtCam = (c: FrameMeta['camera'] | undefined) => {
  if (!c) return '';
  const parts = [`${+(c.zoom ?? 1).toFixed(2)}×`];
  if (Math.abs(c.x) > 1e-3 || Math.abs(c.y) > 1e-3) parts.push(`(${+c.x.toFixed(2)}, ${+c.y.toFixed(2)})`);
  const deg = (v?: number) => Math.round(v || 0);
  if (deg(c.theta) || deg(c.phi) || deg(c.gamma)) parts.push(`θ ${deg(c.theta)}° φ ${deg(c.phi)}°${deg(c.gamma) ? ` γ ${deg(c.gamma)}°` : ''}`);
  return parts.join(' · ');
};

export default function CamKeyPreview({ keyId, t, anchor }: { keyId: string; t: number; anchor: AnchorRect }) {
  const project = useStore((s) => s.project);
  const [res0, res1] = project.settings.resolution || [1920, 1080];
  const aspect = res1 > 0 && res0 > 0 ? res1 / res0 : 9 / 16;
  const cssH = Math.round(PREVIEW_W * aspect);
  const ck = t.toFixed(4);
  const [shot, setShot] = useState<Shot | null>(() => cache.get(project)?.get(ck) || null);
  const [failed, setFailed] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const hit = cache.get(project)?.get(ck);
    if (hit) {
      setShot(hit);
      lastShown.set(keyId, hit);
      return;
    }
    setShot(null);
    setFailed(false);
    let dead = false;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const timer = setTimeout(async () => {
      try {
        const s = await renderAt(project, t, Math.round(PREVIEW_W * dpr), Math.round(cssH * dpr));
        let m = cache.get(project);
        if (!m) cache.set(project, (m = new Map()));
        m.set(ck, s);
        lastShown.set(keyId, s);
        if (!dead) setShot(s);
      } catch {
        if (!dead) setFailed(true);
      }
    }, HOVER_DELAY);
    return () => {
      dead = true;
      clearTimeout(timer);
    };
  }, [project, ck, keyId, t, cssH]);

  const shown = shot || lastShown.get(keyId) || null;
  const stale = !shot && !!shown;

  useLayoutEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !shown) return;
    cv.width = shown.img.width;
    cv.height = shown.img.height;
    cv.getContext('2d')?.putImageData(shown.img, 0, 0);
  }, [shown]);

  // above the diamond, centred on it, kept inside the window
  const cardW = PREVIEW_W + 12;
  const cardH = cssH + 50;
  const cx = (anchor.left + anchor.right) / 2;
  const left = Math.max(8, Math.min(window.innerWidth - cardW - 8, cx - cardW / 2));
  const above = anchor.top - cardH - 10;
  const top = above >= 8 ? above : anchor.bottom + 10;
  const arrowX = Math.max(14, Math.min(cardW - 14, cx - left));

  return createPortal(
    <div className={`cam-preview ${above >= 8 ? 'up' : 'down'}`} data-testid="cam-preview" data-ready={shot ? '1' : '0'} style={{ left, top, width: cardW }}>
      <div className="cam-preview-frame" style={{ height: cssH, background: project.settings.background || '#1e1e1e' }}>
        {shown && <canvas ref={canvasRef} className={stale ? 'stale' : ''} style={{ width: PREVIEW_W, height: cssH }} />}
        {!shown && !failed && <div className="cam-preview-wait"><span className="cam-preview-spinner" /></div>}
        {!shown && failed && <div className="cam-preview-wait muted">no preview</div>}
      </div>
      <div className="cam-preview-cap">
        <b>{t.toFixed(2)}s</b>
        <span className="muted">{fmtCam(shown?.cam)}</span>
      </div>
      <div className="cam-preview-hint">drag to move · double-click to remove</div>
      <i className="cam-preview-arrow" style={{ left: arrowX }} />
    </div>,
    document.body,
  );
}
