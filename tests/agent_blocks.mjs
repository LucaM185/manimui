// The agent builds tidy blocks: one clip per block, each on its own track named after it, with
// every element a named part row. Drives the agent's tools directly (no model calls — free).
//   npm run test:blocks
import { _electron as electron } from 'playwright';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tests', 'out', 'agent_blocks');
fs.mkdirSync(OUT, { recursive: true });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-blocks-'));
const fails = [];
const check = (c, m) => { console.log(c ? '   ✓' : '   ✗', m); if (!c) fails.push(m); };

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE'));
Object.assign(env, { MANIMUI_NO_AUTOSAVE: '1', MANIMUI_DATA: path.join(TMP, 'data'), MANIMUI_STARTUP_PROJECTS: '0' });
const app = await electron.launch({ args: [ROOT], env, cwd: ROOT });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(e.message));
win.on('console', (m) => m.type() === 'error' && !/status of 422/.test(m.text()) && errors.push(m.text()));
await win.setViewportSize({ width: 1600, height: 1000 });
await win.waitForSelector('.lib-card', { timeout: 90000 });
const S = (fn, arg) => win.evaluate(fn, arg);
const tool = (name, args) => S(async ([name, args]) => {
  const h = window.__ms.sessions.docHandle(window.__ms.store.getState().sessionId);
  const r = await window.__ms.agentTools.runTool(h, name, JSON.stringify(args));
  return { ok: r.ok, text: r.text };
}, [name, args]);

console.log('\n1. system prompt');
const sys = await S(() => window.__ms.agentTools.buildSystemPrompt(window.__ms.store.getState().library));
check(/tidy BLOCKS/.test(sys) && /ONE TRACK PER BLOCK/.test(sys) && /VARIABLE NAMES/.test(sys), 'prompt asks for blocks, one track per block, named parts');
check(!/One clip per visual element/.test(sys), 'old "one clip per visual element" rule is gone');

console.log('\n2. blocks added in order → named tracks stacked like a staircase, named part rows');
await tool('set_globals', { set: [{ name: 'TITLE_SIZE', type: 'number', value: 56 }, { name: 'BODY_SIZE', type: 'number', value: 36 }] });
const TITLE = `title = Text("What this project means", font_size=TITLE_SIZE)
underline = Line(LEFT, RIGHT, stroke_color="#58C4DD", stroke_width=4).set_width(title.get_width() + 0.4).next_to(title, DOWN, buff=0.15)
return VGroup(title, underline)`;
const CHART = `axes = Axes(x_range=(0, 5, 1), y_range=(0, 5, 1), width=5, height=3.5)
x_label = Text("speed", font_size=24).next_to(axes.x_axis, DOWN, buff=0.2)
y_label = Text("quality", font_size=24).rotate(PI / 2).next_to(axes.y_axis, LEFT, buff=0.2)
axes_with_labels = VGroup(axes, x_label, y_label)
curve = axes.get_graph(lambda x: 4.5 - 0.15 * x * x, x_range=(0, 5), stroke_color=YELLOW)
return VGroup(axes_with_labels, curve)`;
const BULLET = (s) => `marker = Dot(radius=0.08)
text = Text("${s}", font_size=BODY_SIZE).next_to(marker, RIGHT, buff=0.25)
return VGroup(marker, text)`;
let r = await tool('add_clips', { clips: [
  { item: 'custom', name: 'Title', code: TITLE, start: 0, duration: 10, y: 3.1, parts: { '0': { at: 0, enter: { type: 'Write', duration: 1 } }, '1': { at: 0.8, enter: { type: 'GrowFromLeft', duration: 0.6 } } } },
  { item: 'custom', name: 'Speed vs quality chart', code: CHART, start: 1.5, duration: 8.5, x: -2.5, y: -0.6, parts: { stagger: 0.4 } },
  { item: 'custom', name: 'Bullet: fast', code: BULLET('fast'), start: 3.5, duration: 6.5, x: 3.5, y: 0.5 },
  { item: 'custom', name: 'Bullet: cheap', code: BULLET('cheap'), start: 4.5, duration: 5.5, x: 3.5, y: -0.5 },
] });
const out = JSON.parse(r.text);
console.log('   ', JSON.stringify(out).slice(0, 900));
check(r.ok, 'add_clips ok');
const byName = Object.fromEntries(out.added.map((a) => [a.name, a]));
check(out.added.every((a) => a.track === a.name), `each block got its own track named after it (${out.added.map((a) => a.track).join(', ')})`);
check(JSON.stringify(byName['Title'].parts) === JSON.stringify(['0 title (Text)', '1 underline (Line)']), `title parts listed by name: ${JSON.stringify(byName['Title'].parts)}`);
const chartParts = byName['Speed vs quality chart'].parts || [];
check(['0 axes_with_labels (VGroup)', '0.0 axes (Axes)', '0.1 x_label (Text)', '0.2 y_label (Text)', '1 curve (ParametricCurve)'].every((x) => chartParts.includes(x)) || chartParts.some((x) => /^1 curve/.test(x)) && chartParts.includes('0.1 x_label (Text)'), `chart parts nested + named: ${JSON.stringify(chartParts)}`);
check(!(out.warnings || []).some((w) => /no name on the timeline/.test(w)), 'no unnamed-part warning for well-named blocks');
const p = await S(() => window.__ms.store.getState().project);
const trackNames = p.tracks.map((t) => t.name);
check(JSON.stringify(trackNames.slice(0, 4)) === JSON.stringify(['Bullet: cheap', 'Bullet: fast', 'Speed vs quality chart', 'Title']), `staircase: latest block on top (${trackNames.join(' / ')})`);
check(!trackNames.some((n) => /^Track \d+$/.test(n) && p.clips.some((c) => p.tracks.find((t) => t.name === n)?.id === c.track)), 'no default "Track N" names on used tracks');

console.log('\n3. inline / helper-built elements → warning about unnamed rows');
r = await tool('add_clips', { clips: [{ item: 'custom', name: 'Messy', code: 'return VGroup(Circle(radius=0.5), Square(side_length=0.8).shift(RIGHT*1.5))', start: 0, duration: 3, track: 'Messy', x: 0, y: -3 }] });
const out2 = JSON.parse(r.text);
check((out2.warnings || []).some((w) => /"Messy": parts 0, 1 have no name on the timeline/.test(w)), `warns about unnamed parts: ${JSON.stringify(out2.warnings)}`);
check(JSON.stringify(out2.added[0].parts) === JSON.stringify(['0 (unnamed) (Circle)', '1 (unnamed) (Square)']), `outline shows them unnamed: ${JSON.stringify(out2.added[0].parts)}`);

console.log('\n4. update with fixed code → names listed, no warning; library items list no parts');
const messy = out2.added[0].id;
r = await tool('update_clips', { updates: [{ id: messy, code: 'ring = Circle(radius=0.5)\nbox = Square(side_length=0.8).next_to(ring, RIGHT)\nreturn VGroup(ring, box)' }] });
const out3 = JSON.parse(r.text);
check(JSON.stringify(out3.parts?.[messy]) === JSON.stringify(['0 ring (Circle)', '1 box (Square)']), `update lists the renamed parts: ${JSON.stringify(out3.parts)}`);
check(!(out3.warnings || []).some((w) => /no name/.test(w)), 'no warning after naming');
r = await tool('add_clips', { clips: [{ item: 'tex', name: 'Formula', start: 0, duration: 3, track: 'Formula', y: -2 }] });
check(!JSON.parse(r.text).added[0].parts, 'library item: no parts outline (glyphs are not listed)');
const single = JSON.parse((await tool('add_clips', { clips: [{ item: 'custom', name: 'Plain axes', code: 'return Axes(x_range=(0,3,1), y_range=(0,3,1), width=3, height=2)', start: 5, duration: 2, track: 'Formula' }] })).text);
check(!single.added[0].parts && !(single.warnings || []).some((w) => /no name/.test(w)), 'a single mobject (Axes) is not flagged for its internal parts');
// an invisible alignment frame (the prompt's left-align trick) gets no row; indices stay real
const framed = JSON.parse((await tool('add_clips', { clips: [{ item: 'custom', name: 'Bullet: framed', track: 'Bullet: framed', start: 0, duration: 3, y: -3.2, code: 'frame = Rectangle(width=4, height=0.5, stroke_width=0)\nmarker = Dot(radius=0.08)\nlabel = Text("framed", font_size=30).next_to(marker, RIGHT, buff=0.25)\nrow = VGroup(marker, label).move_to(frame).align_to(frame, LEFT)\nreturn VGroup(frame, row)' }] })).text);
check(JSON.stringify(framed.added[0].parts) === JSON.stringify(['1 row (VGroup)', '1.0 marker (Dot)', '1.1 label (Text)']), `invisible frame has no part row: ${JSON.stringify(framed.added[0].parts)}`);

console.log('\n5. overlap on a named track → the new track is named after the clip');
r = await tool('add_clips', { clips: [{ item: 'circle', name: 'Highlight', start: 0.5, duration: 2, track: 'Title' }] });
const out5 = JSON.parse(r.text);
check(out5.added[0].track === 'Highlight', `moved to a new track named after it (${out5.added[0].track})`);
const p5 = await S(() => window.__ms.store.getState().project);
const ti = (n) => p5.tracks.findIndex((t) => t.name === n);
check(ti('Highlight') === ti('Title') - 1, 'right above the busy track, not on a neighbour block\'s track');

console.log('\n6. the timeline shows the part rows by name');
await S(() => { const s = window.__ms.store.getState(); window.__ms.store.setState({ partsOpen: s.project.clips.map((c) => c.id), time: 6 }); });
await win.waitForTimeout(2500);
await win.screenshot({ path: path.join(OUT, 'timeline.png') });
const rowText = await S(() => document.querySelector('.timeline')?.innerText || document.body.innerText);
check(['title', 'underline', 'axes_with_labels', 'curve', 'marker'].every((n) => rowText.includes(n)), 'part rows labelled title / underline / axes_with_labels / curve / marker');

check(!errors.length, `no page errors ${errors.slice(0, 3).join(' | ')}`);
await app.close();
console.log(fails.length ? `\n${fails.length} FAILED:\n - ${fails.join('\n - ')}` : '\nALL PASSED');
process.exit(fails.length ? 1 : 0);
