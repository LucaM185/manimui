// Grouping clips into one VGroup clip: select several clips → Inspector "Group" (or ⌘G). The scene
// must look the same at every moment (positions, scale / rotation, timing, enter / exit, animated
// and imported elements), the group's parts keep each element's timing, undo brings the clips back.
//   npm run test:group
import { _electron as electron } from 'playwright';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tests', 'out', 'group_clips');
fs.mkdirSync(OUT, { recursive: true });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-group-'));
const fails = [];
const check = (c, m) => { console.log(c ? '   ✓' : '   ✗', m); if (!c) fails.push(m); };

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE'));
Object.assign(env, { MANIMUI_NO_AUTOSAVE: '1', MANIMUI_HIDDEN: '1', MANIMUI_DATA: path.join(TMP, 'data'), MANIMUI_STARTUP_PROJECTS: '0' });
const app = await electron.launch({ args: [ROOT], env, cwd: ROOT });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(e.message));
win.on('console', (m) => m.type() === 'error' && !/status of 422/.test(m.text()) && errors.push(m.text()));
await win.setViewportSize({ width: 1600, height: 1000 });
await win.waitForSelector('.lib-card', { timeout: 90000 });
const S = (fn, arg) => win.evaluate(fn, arg);
const waitFor = (pred, arg, ms = 30000) => win.waitForFunction(pred, arg, { timeout: ms }).then(() => true, () => false);
const shot = (name) => win.screenshot({ path: path.join(OUT, name) });
const proj = () => S(() => window.__ms.store.getState().project);
const settle = async () => {
  await waitFor(() => { const s = window.__ms.store.getState(); return s.meta && s.metaProject === s.project && Math.abs(s.meta.t - s.time) < 1e-6; }, null, 20000);
  await win.waitForTimeout(150);
};

// raw RGBA frames of a project at several times, straight from the engine (own render session)
const frames = (project, times, state) => S(async ([project, times, state]) => {
  const port = window.__ms.store.getState().port;
  const out = [];
  for (const t of times) {
    const r = await fetch(`http://127.0.0.1:${port}/frame`, { method: 'POST', body: JSON.stringify({ project, t, w: 480, h: 270, state }) });
    const meta = JSON.parse(decodeURIComponent(r.headers.get('X-Meta') || '{}'));
    const buf = new Uint8Array(await r.arrayBuffer());
    let sum = 0;
    for (let i = 0; i < buf.length; i += 4) sum += buf[i] + buf[i + 1] + buf[i + 2];
    out.push({ t, errors: meta.errors || {}, px: Array.from(buf), lum: sum });
  }
  return out;
}, [project, times, state]);
const savePair = (a, b, name) => S(async ([a, b, name]) => {
  const c = new OffscreenCanvas(480, 540);
  const ctx = c.getContext('2d');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(a), 480, 270), 0, 0);
  ctx.putImageData(new ImageData(new Uint8ClampedArray(b), 480, 270), 0, 270);
  const blob = await c.convertToBlob({ type: 'image/png' });
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
}, [a, b, name]).then((bytes) => fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(bytes)));
const diff = (a, b) => {
  // share of pixels that differ visibly (any channel by > 40)
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (Math.abs(a[i] - b[i]) > 40 || Math.abs(a[i + 1] - b[i + 1]) > 40 || Math.abs(a[i + 2] - b[i + 2]) > 40) n++;
  }
  return n / (a.length / 4);
};

const lib = await S(() => window.__ms.store.getState().library.items.map((i) => ({ id: i.id, prelude: !!i.prelude, dynamic: !!i.dynamic, fn: i.fn, params: i.params })));
const imported = lib.find((i) => i.prelude && !i.dynamic && i.fn && /^[A-Za-z_]\w*$/.test(i.fn) && i.id.startsWith('mobjects'))
  || lib.find((i) => i.prelude && !i.dynamic && i.fn);
console.log('imported item used:', imported?.id);

const base = { params: {}, code: null, keys: [], effects: [], transform: { x: 0, y: 0, z: 0, scale: 1, rotation: 0, rx: 0, ry: 0, opacity: 1 } };
await S(([base, impId]) => {
  const st = window.__ms.store.getState();
  const items = st.library.items;
  const params = (id) => Object.fromEntries(items.find((i) => i.id === id).params.map((p) => [p.id, p.default]));
  st.commit((p) => {
    p.settings.duration = 16;
    p.tracks = ['A', 'B', 'C', 'D', 'E', 'F'].map((n) => ({ id: 't' + n, name: 'Track ' + n }));
    p.clips = [
      { ...base, id: 'txt', name: 'Text 3', item: 'text', track: 'tA', start: 9, duration: 6.5, params: { ...params('text'), text: 'ManimUI 2026' },
        transform: { ...base.transform, x: 1.6, y: 1.2, rotation: -6 }, enter: { type: 'Write', duration: 1.5, rate: 'smooth' }, exit: { type: 'FadeOut', duration: 0.6, rate: 'smooth' } },
      { ...base, id: 'dot', name: 'Dot 4', item: 'dot', track: 'tB', start: 9, duration: 6.5, params: params('dot'),
        transform: { ...base.transform, x: -0.9, y: 1.2 }, enter: { type: 'GrowFromCenter', duration: 1, rate: 'smooth' }, exit: { type: 'FadeOut', duration: 0.6, rate: 'smooth' } },
      { ...base, id: 'sq', name: 'Box', item: 'custom', track: 'tC', start: 1, duration: 8,
        code: 'return Square(side_length=1.2, fill_opacity=0.7).set_fill(BLUE)',
        transform: { ...base.transform, x: -4, y: -2, scale: 1.5, rotation: 30, opacity: 0.8 }, enter: { type: 'FadeIn', duration: 1, rate: 'smooth' }, exit: { type: 'FadeOut', duration: 1, rate: 'smooth' } },
      { ...base, id: 'orb', name: 'Orbit', item: 'custom_dynamic', dynamic: true, track: 'tD', start: 3, duration: 6,
        code: 'return Dot(radius=0.25, fill_color=YELLOW).move_to(np.array([math.cos(t*2), math.sin(t*2), 0])*1.5)',
        transform: { ...base.transform, x: 3, y: -1.5 }, enter: { type: 'FadeIn', duration: 0.5, rate: 'smooth' }, exit: { type: 'none', duration: 0 } },
      ...(impId ? [{ ...base, id: 'imp', name: 'Imported', item: impId, track: 'tE', start: 2, duration: 7, params: params(impId),
        transform: { ...base.transform, x: 4, y: 2.2, scale: 0.6 }, enter: { type: 'FadeIn', duration: 1, rate: 'smooth' }, exit: { type: 'FadeOut', duration: 1, rate: 'smooth' } }] : []),
      // stays out of the group: same track as the text, later
      { ...base, id: 'other', name: 'Other', item: 'custom', track: 'tF', start: 0, duration: 16, code: 'return Circle(radius=0.4).set_stroke(RED, 4)',
        transform: { ...base.transform, x: -6, y: 3.3 }, enter: { type: 'none', duration: 0 }, exit: { type: 'none', duration: 0 } },
    ];
  });
  window.__ms.store.setState({ time: 10, selection: [] });
}, [base, imported?.id]);
await settle();

const TIMES = [0.5, 1.5, 2.5, 3.2, 4.4, 6, 8.6, 9.4, 10.2, 12, 15.2];
const before = await proj();
const ref = await frames(before, TIMES, 'group-ref');
check(diff(ref[0].px, ref[9].px) > 0.004 && diff(ref[2].px, ref[3].px) > 0.001, 'reference frames have content that changes over time (the comparison means something)');
check(ref.every((f) => !Object.keys(f.errors).length), `reference frames render without errors ${JSON.stringify(ref.map((f) => f.errors).filter((e) => Object.keys(e).length))}`);

// ------------------------------------------------------------------ group from the inspector
console.log('\n▶ Select 2+ clips → Inspector shows Group');
const ids = ['txt', 'dot', 'sq', 'orb', ...(imported ? ['imp'] : [])];
await S((ids) => window.__ms.store.setState({ selection: ids }), ids);
await win.waitForSelector('[data-testid=group-clips]');
check(await win.locator('[data-testid=group-clips]').isEnabled(), 'Group button is enabled');
await shot('1_selected.png');
await win.click('[data-testid=group-clips]');
check(await waitFor(() => window.__ms.store.getState().project.clips.length === 2, null, 15000), 'the selected clips became one clip (plus the untouched one)');
let p = await proj();
const g = p.clips.find((c) => c.id !== 'other');
console.log(g.code);
check(g && /return group_of\(/.test(g.code) && g.dynamic === true, 'group clip: code returns group_of(...), dynamic because one element is animated');
check(g.start === 1 && Math.abs(g.duration - 14.5) < 1e-6, `group spans the elements (start ${g.start}, duration ${g.duration})`);
check(Object.keys(g.parts).filter((k) => !k.includes('.')).length === ids.length, 'one timed part per element');
check(p.tracks.length === 2, `emptied tracks removed (tracks: ${p.tracks.map((t) => t.name).join(', ')})`);
check(g.track === 'tA', 'group sits on the front-most element’s track');
const st1 = await S(() => { const s = window.__ms.store.getState(); return { sel: s.selection, open: s.partsOpen }; });
check(st1.sel.length === 1 && st1.sel[0] === g.id && st1.open.includes(g.id), 'group selected and its part rows shown');
await settle();
await win.waitForTimeout(800);
await shot('2_grouped.png');
const partRows = await win.locator('.part-row, [data-part-path]').count();
console.log('   part rows on the timeline:', partRows);

console.log('\n▶ The scene looks the same at every moment');
const after = await frames(p, TIMES, 'group-after');
check(after.every((f) => !Object.keys(f.errors).length), `grouped frames render without errors ${JSON.stringify(after.map((f) => f.errors).filter((e) => Object.keys(e).length))}`);
for (let i = 0; i < TIMES.length; i++) {
  const d = diff(ref[i].px, after[i].px);
  if (d > 0.0001) await savePair(ref[i].px, after[i].px, `diff_${TIMES[i]}`);
  check(d < 0.0008, `t=${TIMES[i]}s: ${(d * 100).toFixed(2)}% of pixels differ`);
}

console.log('\n▶ Exported scene code includes the imported definition');
const code = await S(async (project) => {
  const port = window.__ms.store.getState().port;
  const r = await fetch(`http://127.0.0.1:${port}/code`, { method: 'POST', body: JSON.stringify({ project }) });
  return (await r.json()).code;
}, p);
if (imported) check(new RegExp(`def ${imported.fn}\\b|class ${imported.fn}\\b|${imported.fn}\\s*=`).test(code), `scene.py defines ${imported.fn}`);
check(/def make_text_3\(\)/.test(code) && /place_part\(/.test(code), 'scene.py has the element factories');

console.log('\n▶ Moving the group moves every element');
await S((id) => window.__ms.store.getState().commit((p) => { p.clips.find((c) => c.id === id).transform.x += 1; }), g.id);
await settle();
const meta = await S(() => window.__ms.store.getState().meta);
const info = meta.clips[g.id];
check(!!info && Math.abs(info.x - (g.transform.x + 1)) < 1e-6, 'group clip info follows its transform');
check(info && info.w < 12, `hit box is the drawn content, not the padding (w=${info?.w?.toFixed(2)})`);

console.log('\n▶ Undo brings back the separate clips');
await S(() => { const s = window.__ms.store.getState(); s.undo(); s.undo(); });
p = await proj();
check(p.clips.length === before.clips.length && p.tracks.length === 6, 'undo restores the clips and tracks');

console.log('\n▶ ⌘G groups two clips');
await S(() => window.__ms.store.setState({ selection: ['txt', 'dot'] }));
await win.locator('.stage-canvas').click({ position: { x: 5, y: 5 } }).catch(() => {});
await S(() => window.__ms.store.setState({ selection: ['txt', 'dot'] }));
await win.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
await win.keyboard.press('Meta+g');
check(await waitFor(() => window.__ms.store.getState().project.clips.length === 5, null, 10000), '⌘G grouped Text + Dot');
p = await proj();
const g2 = p.clips.find((c) => /^Group/.test(c.name));
check(!!g2 && !g2.dynamic && g2.item === 'custom' && g2.start === 9, 'static group of two at the elements’ start');
await settle();
await win.waitForTimeout(600);
await shot('3_cmd_g.png');

console.log('\n▶ Morphs can’t be grouped');
await S(() => { const s = window.__ms.store.getState(); s.undo(); });
await S(() => window.__ms.store.getState().commit((p) => { const t = p.clips.find((c) => c.id === 'txt'); t.exit = { type: 'TransformInto', duration: 1, rate: 'smooth', target: 'sq' }; }));
await S(() => window.__ms.store.setState({ selection: ['txt', 'dot'] }));
await win.waitForSelector('[data-testid=group-clips]');
check(await win.locator('[data-testid=group-clips]').isDisabled(), 'Group disabled while a selected clip morphs');

check(!errors.length, `no page errors ${errors.slice(0, 3).join(' | ')}`);
await app.close();
console.log(fails.length ? `\n✗ ${fails.length} failed` : '\n✓ all passed');
process.exit(fails.length ? 1 : 0);
