// Camera waypoints: the "Camera" row of the timeline must be visible, double-clicking it adds a
// camera keyframe (waypoint), keys show as diamonds joined by a bar, can be dragged in time, the
// camera inspector edits the key at the playhead and the engine renders the interpolated camera.
//   npm run test:camera
import { _electron as electron } from 'playwright';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tests', 'out', 'camera');
fs.mkdirSync(OUT, { recursive: true });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-cam-'));
const fails = [];
const check = (c, m) => { console.log(c ? '   ✓' : '   ✗', m); if (!c) fails.push(m); };
const near = (a, b, tol = 0.02) => Math.abs(a - b) <= tol;

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE'));
Object.assign(env, { MANIMUI_NO_AUTOSAVE: '1', MANIMUI_HIDDEN: '1', MANIMUI_DATA: path.join(TMP, 'data'), MANIMUI_STARTUP_PROJECTS: '0' });
const app = await electron.launch({ args: [ROOT], env, cwd: ROOT });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(e.message));
win.on('console', (m) => m.type() === 'error' && !/status of 422/.test(m.text()) && errors.push(m.text()));
await win.setViewportSize({ width: 1600, height: 950 });
await win.waitForSelector('.lib-card', { timeout: 90000 });

const S = (fn, arg) => win.evaluate(fn, arg);
const state = () => S(() => {
  const s = window.__ms.store.getState();
  return { camera: s.project.settings.camera || [], selection: s.selection, time: s.time, meta: s.meta, zoom: s.zoom, fresh: s.metaProject === s.project };
});
const waitFrame = async (pred = () => true, timeout = 12000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const st = await state();
    if (st.meta && st.fresh && Math.abs(st.meta.t - st.time) < 1e-6 && pred(st)) return st;
    await win.waitForTimeout(60);
  }
  return state();
};
const setTime = (t) => S((t) => window.__ms.store.getState().setTime(t), t);
const shot = (name) => win.screenshot({ path: path.join(OUT, name) });

// something in the scene so the camera has a point
await S(() => window.__ms.actions.addItem('square', { time: 0, params: { side: 2 } }));
await win.waitForTimeout(300);

console.log('· camera row is visible');
const head = win.getByTestId('camera-track-head');
const lane = win.getByTestId('camera-track');
const hb = await head.boundingBox();
const lb = await lane.boundingBox();
check(hb && hb.height >= 30 && hb.width >= 80, `camera head visible (${JSON.stringify(hb)})`);
check(lb && lb.height >= 30 && lb.width >= 200, `camera lane visible (${JSON.stringify(lb)})`);
check(await head.locator('text=Camera').isVisible(), 'label "Camera" visible');
const hint = win.locator('.cam-hint');
check(await hint.isVisible(), 'empty-lane hint visible');
const laneBg = await lane.evaluate((el) => getComputedStyle(el).backgroundColor);
check(laneBg && laneBg !== 'rgba(0, 0, 0, 0)', `lane has a background (${laneBg})`);
await shot('1_empty.png');

console.log('· double-click adds waypoints');
const zoom = (await state()).zoom;
const xAt = (t) => lb.x + t * zoom;
// the first key away from 0 anchors the default view at t=0 too, so the move animates
await win.mouse.dblclick(xAt(2), lb.y + lb.height / 2);
await win.waitForTimeout(200);
let st = await state();
check(st.camera.length === 2, `2 camera keys (${st.camera.length})`);
check(st.selection.includes('__camera__'), 'camera selected');
check(await win.getByTestId('camera-inspector').isVisible(), 'camera inspector shown');
const keys = win.locator('.cam-key');
check((await keys.count()) === 2, 'two diamonds');
const kb = await keys.nth(1).boundingBox();
check(kb && kb.width >= 8 && kb.height >= 8, `diamond has a size (${JSON.stringify(kb)})`);
check(kb && near(kb.x + kb.width / 2, xAt(2), 3), 'diamond sits at its time');
const span = win.locator('.cam-span');
const sb = await span.first().boundingBox();
check(sb && sb.width > zoom * 1.5, `bar joins the two keys (${JSON.stringify(sb)})`);
check(!(await hint.isVisible().catch(() => false)), 'hint gone once keyed');

console.log('· inspector edits the key at the playhead');
await setTime(2);
await win.waitForTimeout(100);
const zf = win.getByTestId('cam-zoom');
await zf.fill('2');
await zf.press('Enter');
await win.waitForTimeout(150);
st = await state();
const k2 = [...st.camera].sort((a, b) => a.t - b.t)[1];
check(k2 && near(k2.zoom, 2), `key at 2s zoom = 2 (${k2?.zoom})`);
check((await win.locator('.kf-row').count()) === 2, 'keyframe list shows 2 rows');
await shot('2_keys.png');

console.log('· engine interpolates between waypoints');
await setTime(1);
st = await waitFrame((s) => s.meta.camera);
check(st.meta.camera && st.meta.camera.zoom > 1.01 && st.meta.camera.zoom < 1.99, `zoom at 1s between keys (${st.meta.camera?.zoom})`);
await setTime(2);
st = await waitFrame((s) => s.meta.camera && near(s.meta.camera.zoom, 2));
check(st.meta.camera && near(st.meta.camera.zoom, 2), `zoom at 2s = 2 (${st.meta.camera?.zoom})`);

console.log('· hovering a waypoint previews what the camera sees there');
// pixels that differ from the background = how much of the frame the square covers
const coverage = () => win.getByTestId('cam-preview').locator('canvas').evaluate((cv) => {
  const g = cv.getContext('2d');
  const d = g.getImageData(0, 0, cv.width, cv.height).data;
  const [r0, g0, b0] = [d[0], d[1], d[2]];
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - r0) + Math.abs(d[i + 1] - g0) + Math.abs(d[i + 2] - b0) > 40) n++;
  return { frac: n / (cv.width * cv.height), w: cv.width, h: cv.height };
});
const hoverKey = async (i) => {
  const b = await keys.nth(i).boundingBox();
  await win.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await win.waitForSelector('[data-testid="cam-preview"][data-ready="1"]', { timeout: 15000 });
  return b;
};
// the square fades in from 0 s: make it present at the first key too
await S(() => window.__ms.store.getState().commit((p) => { p.clips[0].enter = { ...p.clips[0].enter, type: 'none' }; }));
await win.waitForTimeout(150);
const timeBefore = (await state()).time;
const kb0 = await hoverKey(0);
const card = win.getByTestId('cam-preview');
check(await card.isVisible(), 'preview card shown on hover');
const cb = await card.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
check(cb && cb.y + cb.height <= kb0.y + 2 && Math.abs(cb.x + cb.width / 2 - (kb0.x + kb0.width / 2)) < cb.width / 2, `card sits above the diamond (${JSON.stringify(cb)})`);
check(await card.locator('text=0.00s').isVisible(), 'card shows the key time');
const c0 = await coverage();
check(c0.w > 100 && Math.abs(c0.h / c0.w - 9 / 16) < 0.02, `frame has the scene aspect (${c0.w}×${c0.h})`);
check(c0.frac > 0.005, `square visible in the key-0 preview (${c0.frac.toFixed(3)})`);
await shot('2b_hover_key0.png');
await hoverKey(1);
check(await card.locator('text=2.00s').isVisible(), 'card follows the hovered key');
check(await card.locator('text=2×').isVisible(), 'caption shows the key zoom');
const c1 = await coverage();
check(c1.frac > c0.frac * 2.5, `zoomed key shows the square ~4× bigger (${c0.frac.toFixed(3)} → ${c1.frac.toFixed(3)})`);
check(near((await state()).time, timeBefore, 1e-9), 'hovering does not move the playhead');
await shot('2c_hover_key1.png');
await win.mouse.move(lb.x + lb.width - 40, lb.y - 60);
await win.waitForTimeout(100);
check(!(await card.isVisible().catch(() => false)), 'card hides when the pointer leaves');
// an edit to the key re-renders its preview
await setTime(2);
await zf.fill('1.5');
await zf.press('Enter');
await win.waitForTimeout(150);
await hoverKey(1);
check(await card.locator('text=1.5×').isVisible(), 'preview follows key edits');
const c2 = await coverage();
check(c2.frac < c1.frac && c2.frac > c0.frac, `coverage between the two (${c2.frac.toFixed(3)})`);
await win.mouse.move(lb.x + lb.width - 40, lb.y - 60);
await zf.fill('2');
await zf.press('Enter');
await win.waitForTimeout(150);

console.log('· drag a waypoint in time');
const kb2 = await keys.nth(1).boundingBox();
await win.mouse.move(kb2.x + kb2.width / 2, kb2.y + kb2.height / 2);
await win.mouse.down();
await win.mouse.move(kb2.x + kb2.width / 2 + zoom, kb2.y + kb2.height / 2, { steps: 6 });
await win.mouse.up();
await win.waitForTimeout(150);
st = await state();
const moved = [...st.camera].sort((a, b) => a.t - b.t)[1];
check(moved && near(moved.t, 3, 0.1), `key dragged to ~3s (${moved?.t})`);

console.log('· K adds a key, double-click on a diamond removes it');
await setTime(4);
await win.locator('.stage').click({ position: { x: 5, y: 5 } }).catch(() => {});
await S(() => window.__ms.store.setState({ selection: ['__camera__'] }));
await win.keyboard.press('k');
await win.waitForTimeout(150);
st = await state();
check(st.camera.length === 3, `K adds a camera key (${st.camera.length})`);
await keys.nth(2).dblclick();
await win.waitForTimeout(150);
st = await state();
check(st.camera.length === 2, `double-click removes it (${st.camera.length})`);
await shot('3_final.png');

console.log('· the camera turns straight from one view to the next (no Euler-angle detour)');
// Front (0,0,0) → Top (180,90,180): lerping the angles one by one passes (90,45,90) halfway, which
// looks sideways along x. The direct path is halfway up the arc: eye direction (0, .707, .707).
const outOf = (c) => {
  const D = Math.PI / 180, [t, p, g] = [c.theta * D, c.phi * D, c.gamma * D];
  return [Math.sin(t) * Math.sin(p), -Math.cos(t) * Math.sin(p), Math.cos(p)];
};
await S(() => window.__ms.store.getState().commit((p) => {
  p.settings.camera = [
    { id: 'ckA', t: 5, x: 0, y: 0, z: 0, zoom: 1, theta: 0, phi: 0, gamma: 0, ease: 'smooth' },
    { id: 'ckB', t: 7, x: 0, y: 0, z: 0, zoom: 1, theta: 180, phi: 90, gamma: 180, ease: 'smooth' },
  ];
}));
await setTime(6);
st = await waitFrame((s) => s.meta.camera && Math.abs(s.meta.camera.phi - 45) < 1);
const ui = await S(() => { const s = window.__ms.store.getState(); return window.__ms.cameraAt ? window.__ms.cameraAt(s.project, 6) : null; });
const eo = st.meta.camera && outOf(st.meta.camera);
check(eo && near(eo[0], 0, 0.01) && near(eo[1], Math.SQRT1_2, 0.01) && near(eo[2], Math.SQRT1_2, 0.01), `engine: halfway eye on the direct arc (${eo?.map((v) => v.toFixed(3))})`);
if (ui) {
  const uo = outOf(ui);
  check(near(uo[0], eo[0], 0.005) && near(uo[1], eo[1], 0.005) && near(uo[2], eo[2], 0.005), `editor overlay agrees with the engine (${uo.map((v) => v.toFixed(3))})`);
}
await shot('4_front_to_top_mid.png');

check(!errors.length, `no page errors ${errors.slice(0, 3).join(' | ')}`);
await app.close();
fs.rmSync(TMP, { recursive: true, force: true });
if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log('\nall camera track checks passed');
