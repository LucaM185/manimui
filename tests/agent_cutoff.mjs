// Agent replies cut off by the output length limit (finish_reason "length"): the agent recovers on
// its own instead of dead-ending with "The reply hit the length limit."
// The OpenRouter call is replaced by a scripted mock in the main process: free and deterministic.
//   npm run test:cutoff
import { _electron as electron } from 'playwright';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.E2E_OUT || path.join(ROOT, 'tests', 'out', 'agent_cutoff');
fs.mkdirSync(OUT, { recursive: true });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-cutoff-'));

const fails = [];
const check = (cond, msg) => { (cond ? console.log('   ✓', msg) : (fails.push(msg), console.log('   ✗', msg))); };

// Scenarios are picked by the user's prompt; every request body is recorded for inspection.
function installMock({ ipcMain }) {
  globalThis.__bodies = [];
  globalThis.__alwaysCut = true;
  ipcMain.removeHandler('ai:status');
  ipcMain.removeHandler('ai:chat');
  ipcMain.handle('ai:status', async () => ({ configured: true, model: 'mock/scripted' }));
  ipcMain.handle('ai:chat', async (_e, { body }) => {
    globalThis.__bodies.push(JSON.parse(JSON.stringify(body)));
    const msgs = body.messages;
    const text = (m) => (typeof m.content === 'string' ? m.content : (m.content || []).map((p) => p.text || '').join(''));
    const firstUser = [...msgs].reverse().find((m) => m.role === 'user' && !text(m).startsWith('[Your last reply') && !text(m).startsWith('Rendered preview'));
    const prompt = text(firstUser).split('\n')[0];
    const last = msgs[msgs.length - 1];
    const nudged = last.role === 'user' && text(last).includes('cut off by the output length limit');
    const call = (item, args) => ({ id: `call_${item}_${msgs.length}`, type: 'function', function: { name: 'add_clips', arguments: args ?? JSON.stringify({ clips: [{ item, start: 0, duration: 3 }] }) } });
    const cutNothing = { message: { role: 'assistant', content: '', reasoning_details: [{ type: 'reasoning.text', text: 'planning planning…' }] }, finish: 'length', usage: { cost: 0.008 } };
    const done = { message: { role: 'assistant', content: 'Done.' }, finish: 'stop', usage: { cost: 0.0005 } };

    if (prompt === 'think forever then square') {
      if (last.role === 'tool') return done;
      if (!nudged) return cutNothing;
      return { message: { role: 'assistant', content: '', tool_calls: [call('square')] }, finish: 'tool_calls', usage: { cost: 0.001 } };
    }
    if (prompt === 'always cut off') {
      if (last.role === 'tool') return done;
      if (globalThis.__alwaysCut) return cutNothing;
      return { message: { role: 'assistant', content: '', tool_calls: [call('star')] }, finish: 'tool_calls', usage: { cost: 0.001 } };
    }
    if (prompt === 'circle and a cut triangle') {
      const sawCut = msgs.some((m) => m.role === 'tool' && /cut off/.test(text(m)));
      if (last.role === 'tool' && !sawCut) return done;
      if (last.role === 'tool' && sawCut && !msgs.some((m) => m.tool_calls?.some((c) => c.id.startsWith('call_triangle_x')))) {
        return { message: { role: 'assistant', content: 'Resending the triangle.', tool_calls: [{ ...call('triangle'), id: 'call_triangle_x' }] }, finish: 'tool_calls', usage: { cost: 0.001 } };
      }
      if (last.role === 'tool') return done;
      return { message: { role: 'assistant', content: '', tool_calls: [call('circle'), call('triangle', '{"clips":[{"item":"trian')] }, finish: 'length', usage: { cost: 0.008 } };
    }
    return done;
  });
}

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE'));
Object.assign(env, {
  MATHSTUDIO_NO_AUTOSAVE: '1', MATHSTUDIO_HIDDEN: '1', MATHSTUDIO_DATA: path.join(TMP, 'data'), MATHSTUDIO_TEST_CONFIRM: '0',
  MATHSTUDIO_CHECKPOINTS: path.join(TMP, 'checkpoints'), MATHSTUDIO_CHATS: path.join(TMP, 'chats'), MATHSTUDIO_PROJECTS_DIR: path.join(TMP, 'projects'),
  MATHSTUDIO_RECENTS: path.join(TMP, 'recents.json'), MATHSTUDIO_STARTUP_PROJECTS: '0',
});
fs.mkdirSync(env.MATHSTUDIO_PROJECTS_DIR, { recursive: true });
const app = await electron.launch({ args: [ROOT], env, cwd: ROOT });
await app.evaluate(installMock);
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(e.message));
win.on('console', (m) => m.type() === 'error' && !/status of 422/.test(m.text()) && errors.push(m.text()));
await win.setViewportSize({ width: 1600, height: 950 });
await win.waitForSelector('.lib-card', { timeout: 90000 });
await win.click('[data-testid=right-tab-agent]');
await win.waitForSelector('[data-testid=agent-panel]');
await win.evaluate(() => window.__ms.agent.refreshStatus());

const waitIdle = async () => {
  await win.waitForFunction(() => window.__ms.agent.useAgent.getState().running, null, { timeout: 5000 }).catch(() => {});
  await win.waitForFunction(() => !window.__ms.agent.useAgent.getState().running, null, { timeout: 30000 });
};
async function sendMsg(text) {
  await app.evaluate(() => { globalThis.__bodies = []; });
  await win.fill('[data-testid=agent-input]', text);
  await win.keyboard.press('Enter');
  await waitIdle();
}
const state = () => win.evaluate(() => {
  const a = window.__ms.agent.useAgent.getState();
  const p = window.__ms.store.getState().project;
  return {
    items: a.items.map((i) => ({ kind: i.kind, text: i.text, status: i.status, summary: i.summary, retry: i.retry })),
    history: a.history,
    clips: p.clips.map((c) => c.name),
  };
});
const bodies = () => app.evaluate(() => globalThis.__bodies);
const turnItems = (s) => s.items.slice(s.items.map((i) => i.kind).lastIndexOf('user'));
const prefillFree = (bs) => bs.every((b) => b.messages[b.messages.length - 1].role !== 'assistant');
const noEmptyAssistant = (bs) => bs.every((b) => b.messages.every((m) => m.role !== 'assistant' || (m.content && m.content.length) || m.tool_calls?.length));
const txt = (m) => (typeof m.content === 'string' ? m.content : (m.content || []).map((p) => p.text || '').join(''));

// ------------------------------------------------------------------ 1. all thinking, no output
console.log('\n▶ reply cut off before any output (all of it went to thinking)');
await sendMsg('think forever then square');
let s = await state();
let bs = await bodies();
let t = turnItems(s);
check(bs[0].max_tokens >= 120000, `max_tokens raised (${bs[0].max_tokens})`);
check(s.clips.includes('Square'), `the build went ahead after the cut-off (${s.clips})`);
check(!t.some((i) => i.kind === 'error'), `no error shown (${JSON.stringify(t.filter((i) => i.kind === 'error'))})`);
check(bs.length === 3, `cut-off → nudge → tool → done (${bs.length} requests)`);
check(prefillFree(bs), 'no request ends on an assistant message');
check(noEmptyAssistant(bs), 'no empty assistant message sent back');
check(!bs[1].messages.some((m) => m.role === 'assistant' && txt(m) === '(cut off)' && m.reasoning_details), 'the half-written thinking is not sent back');
await win.screenshot({ path: path.join(OUT, '1-recovered.png') });

// ------------------------------------------------------------------ 2. keeps getting cut off
console.log('\n▶ reply cut off every time');
await sendMsg('always cut off');
s = await state();
bs = await bodies();
t = turnItems(s);
const err = t.find((i) => i.kind === 'error');
check(bs.length === 3, `gives up after 2 automatic retries (${bs.length} requests)`);
check(!!err && err.retry === true, `error offers Retry (${JSON.stringify(err)})`);
check(!/hit the length limit/.test(err?.text || ''), 'not the old dead-end message');
check(prefillFree(bs) && noEmptyAssistant(bs), 'every request well formed');
check(s.history[s.history.length - 1].role === 'user', 'history ends on a user message, ready for Retry');
await win.screenshot({ path: path.join(OUT, '2-gave-up.png') });
check(!!(await win.$('.ag-error button, button:has-text("Retry")')), 'Retry button visible');
await app.evaluate(() => { globalThis.__alwaysCut = false; globalThis.__bodies = []; });
await win.click('button:has-text("Retry")');
await waitIdle();
s = await state();
bs = await bodies();
check(s.clips.includes('Star'), `Retry builds it (${s.clips})`);
check(prefillFree(bs) && noEmptyAssistant(bs), 'retry requests well formed');

// ------------------------------------------------------------------ 3. cut off mid tool call
console.log('\n▶ reply cut off in the middle of a tool call');
await sendMsg('circle and a cut triangle');
s = await state();
bs = await bodies();
t = turnItems(s);
const tools = t.filter((i) => i.kind === 'tool');
check(s.clips.includes('Circle'), 'the complete call ran');
check(tools.some((i) => i.status === 'error' && /cut off/.test(i.summary)), `the truncated call did not run (${JSON.stringify(tools.map((i) => i.summary))})`);
const sent = bs[1].messages.find((m) => m.tool_calls?.length === 2);
check(sent && sent.tool_calls[1].function.arguments === '{}', 'truncated arguments sent back as {}');
check(bs[1].messages.some((m) => m.role === 'tool' && /cut off by the output length limit/.test(txt(m))), 'the model is told the call was cut off');
check(s.clips.includes('Triangle'), `the model resent it and it ran (${s.clips})`);
check(!t.some((i) => i.kind === 'error'), 'no error shown');
await win.screenshot({ path: path.join(OUT, '3-mid-call.png') });

check(errors.length === 0, `no page errors ${errors.slice(0, 3).join(' | ')}`);
await app.close();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASSED');
process.exit(fails.length ? 1 : 0);
