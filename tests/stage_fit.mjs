// Default layout: the timeline height adapts so the 16:9 stage fills the center column with only
// its 20px padding around it (no letterbox bands), follows window resizes, stops once the user
// drags the splitter, and double-clicking the splitter fits again.
//   npm run test:stagefit
import { _electron as electron } from 'playwright';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tests', 'out', 'stagefit');
fs.mkdirSync(OUT, { recursive: true });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-fit-'));
const fails = [];
const check = (c, m) => { console.log(c ? '   ✓' : '   ✗', m); if (!c) fails.push(m); };

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE'));
Object.assign(env, { MANIMUI_NO_AUTOSAVE: '1', MANIMUI_HIDDEN: '1', MANIMUI_DATA: path.join(TMP, 'data'), MANIMUI_STARTUP_PROJECTS: '0' });
const app = await electron.launch({ args: [ROOT], env, cwd: ROOT });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(e.message));

const measure = () => win.evaluate(() => {
  const r = (sel) => { const b = document.querySelector(sel).getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
  return { wrap: r('.preview-wrap'), stage: r('.stage'), tl: r('.hsplit').y };
});
const snug = (m) => {
  const gapX = m.wrap.w - m.stage.w, gapY = m.wrap.h - m.stage.h;
  return { gapX, gapY, ok: Math.abs(gapX - 40) <= 3 && Math.abs(gapY - 40) <= 3 };
};
const resize = async (w, h) => { await win.setViewportSize({ width: w, height: h }); await win.waitForTimeout(250); };

await win.setViewportSize({ width: 1512, height: 945 }); // MacBook Pro 14" full-screen-ish window
await win.waitForSelector('.lib-card', { timeout: 90000 });
await win.waitForTimeout(400);

for (const [w, h] of [[1512, 945], [1728, 1080], [1440, 860], [1920, 1140]]) {
  await resize(w, h);
  const m = await measure();
  const s = snug(m);
  check(s.ok, `${w}×${h}: stage ${Math.round(m.stage.w)}×${Math.round(m.stage.h)} in ${Math.round(m.wrap.w)}×${Math.round(m.wrap.h)} (gaps ${s.gapX.toFixed(0)}/${s.gapY.toFixed(0)})`);
  await win.screenshot({ path: path.join(OUT, `fit_${w}x${h}.png`) });
}

console.log('· manual drag wins');
await resize(1512, 945);
const before = await measure();
const sp = await win.getByTestId('timeline-split').boundingBox();
await win.mouse.move(sp.x + 300, sp.y + 2);
await win.mouse.down();
await win.mouse.move(sp.x + 300, sp.y + 2 - 120, { steps: 6 });
await win.mouse.up();
await win.waitForTimeout(200);
const dragged = await measure();
check(Math.abs(dragged.tl - (before.tl - 120)) <= 3, `splitter moved up 120px (${before.tl.toFixed(0)} → ${dragged.tl.toFixed(0)})`);
await resize(1600, 945);
const afterResize = await measure();
check(Math.abs(afterResize.tl - dragged.tl) <= 3, `window resize keeps the dragged height (${afterResize.tl.toFixed(0)})`);

console.log('· double-click fits again');
const sp2 = await win.getByTestId('timeline-split').boundingBox();
await win.mouse.dblclick(sp2.x + 300, sp2.y + 2);
await win.waitForTimeout(250);
const refit = await measure();
check(snug(refit).ok, `refit after double-click (gaps ${snug(refit).gapX.toFixed(0)}/${snug(refit).gapY.toFixed(0)})`);

check(errors.length === 0, `no page errors (${errors.join(' | ')})`);
await app.close();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(fails.length ? `\n${fails.length} FAILED` : '\nall passed');
process.exit(fails.length ? 1 : 0);
