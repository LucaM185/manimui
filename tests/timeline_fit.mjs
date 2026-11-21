// Timeline zoom defaults to Fit: the whole scene stays in view as the window resizes or the scene
// grows, until the user zooms by hand; Fit turns it back on, and every opened project starts fitted.
//   npm run build && node tests/timeline_fit.mjs
import { _electron as electron } from 'playwright';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-fit-'));
const fails = [];
const check = (c, m) => { console.log(c ? '   ✓' : '   ✗', m); if (!c) fails.push(m); };

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE'));
Object.assign(env, { MANIMUI_NO_AUTOSAVE: '1', MANIMUI_HIDDEN: '1', MANIMUI_DATA: path.join(TMP, 'data'), MANIMUI_STARTUP_PROJECTS: '0' });
const app = await electron.launch({ args: [ROOT], env, cwd: ROOT });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(e.message));
await win.setViewportSize({ width: 1600, height: 950 });
await win.waitForSelector('.lib-card', { timeout: 90000 });
const S = (fn, arg) => win.evaluate(fn, arg);
const waitFor = (pred, arg, ms = 5000) => win.waitForFunction(pred, arg, { timeout: ms }).then(() => true, () => false);
// the scene's end (duration) sits ~40px inside the right edge of the timeline when fitted
const fitted = () => S(() => {
  const st = window.__ms.store.getState();
  const el = document.querySelector('.tl-scroll');
  const end = st.project.settings.duration * st.zoom + 168; // HEADER_W
  return { fit: st.zoomFit, zoom: st.zoom, gap: el.clientWidth - end, scroll: el.scrollLeft };
});
const isFitted = (f) => f.fit && f.scroll === 0 && Math.abs(f.gap - 40) < 2;

console.log('\n▶ Fit is the default');
let f = await fitted();
check(isFitted(f), `fresh project is fitted (gap ${f.gap.toFixed(1)}px, zoomFit ${f.fit})`);

console.log('\n▶ Fit follows the scene length and the window size');
await S(() => window.__ms.store.getState().commit((p) => { p.settings.duration = 30; }));
await waitFor(() => { const s = window.__ms.store.getState(); return Math.abs(document.querySelector('.tl-scroll').clientWidth - (30 * s.zoom + 168) - 40) < 2; });
f = await fitted();
check(isFitted(f), `longer scene refits (gap ${f.gap.toFixed(1)}px)`);
await win.setViewportSize({ width: 1200, height: 950 });
await waitFor(() => { const s = window.__ms.store.getState(); return Math.abs(document.querySelector('.tl-scroll').clientWidth - (s.project.settings.duration * s.zoom + 168) - 40) < 2; });
f = await fitted();
check(isFitted(f), `narrower window refits (gap ${f.gap.toFixed(1)}px)`);

console.log('\n▶ Zooming by hand turns Fit off and sticks');
await win.click('.tl-zoom-btns button[title="Zoom in"]');
f = await fitted();
const z = f.zoom;
check(!f.fit, 'zoom in clears Fit');
await S(() => window.__ms.store.getState().commit((p) => { p.settings.duration = 40; }));
await win.setViewportSize({ width: 1400, height: 950 });
await win.waitForTimeout(300);
f = await fitted();
check(!f.fit && Math.abs(f.zoom - z) < 1e-6, `manual zoom survives scene / window changes (${z.toFixed(1)} → ${f.zoom.toFixed(1)})`);

console.log('\n▶ ⌘-scroll also counts as zooming by hand');
await win.click('.tl-zoom-btns button[title="Fit the whole scene"]');
f = await fitted();
check(isFitted(f), 'Fit button turns Fit back on');
const box = await (await win.$('.tl-lanes')).boundingBox();
await win.mouse.move(box.x + 200, box.y + 20);
await win.keyboard.down('Meta');
await win.mouse.wheel(0, -100);
await win.keyboard.up('Meta');
await win.waitForTimeout(100);
f = await fitted();
check(!f.fit, '⌘-scroll clears Fit');

console.log('\n▶ Opening a project starts fitted again');
await S(() => { const st = window.__ms.store.getState(); const p = structuredClone(st.project); p.settings.duration = 12; st.loadProject(p, null); });
await waitFor(() => { const s = window.__ms.store.getState(); return s.zoomFit && Math.abs(document.querySelector('.tl-scroll').clientWidth - (12 * s.zoom + 168) - 40) < 2; });
f = await fitted();
check(isFitted(f), `opened project is fitted (gap ${f.gap.toFixed(1)}px)`);

check(!errors.length, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
await app.close();
console.log(fails.length ? `\n✗ ${fails.length} failed` : '\n✓ all passed');
process.exit(fails.length ? 1 : 0);
