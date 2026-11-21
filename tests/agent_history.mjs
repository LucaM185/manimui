// Agent chat history (clock button, like Claude Code's /resume) + the header-less agent tab.
// The OpenRouter call is replaced by a scripted mock in the main process: free and deterministic.
//   npm run test:chats
import { _electron as electron } from 'playwright';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.E2E_OUT || path.join(ROOT, 'tests', 'out', 'agent_history');
fs.mkdirSync(OUT, { recursive: true });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-chats-'));
const CHATS = path.join(TMP, 'chats');
const DIR = path.join(TMP, 'projects');
fs.mkdirSync(DIR, { recursive: true });

const fails = [];
const check = (cond, msg) => { (cond ? console.log('   ✓', msg) : (fails.push(msg), console.log('   ✗', msg))); };

function installMock({ ipcMain }) {
  ipcMain.removeHandler('ai:status');
  ipcMain.removeHandler('ai:chat');
  ipcMain.handle('ai:status', async () => ({ configured: true, model: 'mock/scripted' }));
  ipcMain.handle('ai:chat', async (_e, { body }) => {
    const last = body.messages[body.messages.length - 1];
    const text = typeof last.content === 'string' ? last.content : (last.content.find((p) => p.type === 'text') || {}).text || '';
    const m = last.role === 'user' && text.match(/add an? (\w+)/);
    if (m) {
      return {
        message: { role: 'assistant', content: '', tool_calls: [{ id: `call_${Date.now()}`, type: 'function', function: { name: 'add_clips', arguments: JSON.stringify({ clips: [{ item: m[1], start: 0, duration: 3 }] }) } }] },
        finish: 'tool_calls',
        usage: { cost: 0.0012 },
      };
    }
    // reply with how many user messages the model saw, to prove resumed history reaches it
    const users = body.messages.filter((x) => x.role === 'user' && (typeof x.content === 'string' || !/Rendered preview/.test(JSON.stringify(x.content)))).length;
    return { message: { role: 'assistant', content: `Done (${users} user messages).` }, finish: 'stop', usage: { cost: 0.0008 } };
  });
}

async function launch() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE'));
  Object.assign(env, {
    MANIMUI_NO_AUTOSAVE: '1', MANIMUI_HIDDEN: '1', MANIMUI_DATA: path.join(TMP, 'data'), MANIMUI_TEST_CONFIRM: '0',
    MANIMUI_CHECKPOINTS: path.join(TMP, 'checkpoints'), MANIMUI_CHATS: CHATS, MANIMUI_PROJECTS_DIR: DIR,
    MANIMUI_RECENTS: path.join(TMP, 'recents.json'), MANIMUI_STARTUP_PROJECTS: '0',
  });
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
  return { app, win, errors };
}

async function sendMsg(win, text) {
  await win.fill('[data-testid=agent-input]', text);
  await win.keyboard.press('Enter');
  await win.waitForFunction(() => window.__ms.agent.useAgent.getState().running, null, { timeout: 5000 }).catch(() => {});
  await win.waitForFunction(() => !window.__ms.agent.useAgent.getState().running, null, { timeout: 30000 });
  await win.waitForTimeout(400); // the chat is saved after the project file is written
}

const index = () => { try { return JSON.parse(fs.readFileSync(path.join(CHATS, 'index.json'), 'utf8')); } catch { return []; } };
const chatFile = (id) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(CHATS, id + '.json.gz'))).toString('utf8'));
const chat = (win) => win.evaluate(() => {
  const a = window.__ms.agent.useAgent.getState();
  return { chatId: a.chatId, users: a.items.filter((i) => i.kind === 'user').map((i) => i.text), replies: a.items.filter((i) => i.kind === 'assistant').map((i) => i.text), history: a.history.length, cost: a.cost };
});
const rows = (win) => win.$$eval('[data-testid=agent-history-row]', (els) => els.map((e) => ({ title: e.querySelector('.ag-history-title').textContent, sub: e.querySelector('.ag-history-sub').textContent, current: e.classList.contains('current') })));

// ================================================================== 1. header gone, buttons in the tab bar
let projectPath;
{
  console.log('\n▶ layout + saving');
  const { app, win, errors } = await launch();
  check(!(await win.$('.ag-head')), 'no "AI Agent · model" header row in the panel');
  check(!!(await win.$('.right-tabs [data-testid=agent-history-btn]')), 'history button in the tab bar');
  check(!!(await win.$('.right-tabs [data-testid=agent-new]')), 'new-chat button in the tab bar');
  const bb = await (await win.$('[data-testid=agent-new]')).boundingBox();
  const tabs = await (await win.$('.right-tabs')).boundingBox();
  check(bb.x + bb.width > tabs.x + tabs.width - 20, 'new chat sits at the top right');
  check(await win.$eval('[data-testid=agent-new]', (b) => b.disabled), 'new chat disabled on an empty chat');
  await win.screenshot({ path: path.join(OUT, '1-empty.png') });

  // empty history
  await win.click('[data-testid=agent-history-btn]');
  await win.waitForSelector('[data-testid=agent-history]');
  await win.waitForTimeout(150);
  check(/No past chats/.test(await win.textContent('[data-testid=agent-history]')), 'empty history says so');
  await win.keyboard.press('Escape');
  check(!(await win.$('[data-testid=agent-history]')), 'Esc closes the history');

  // chat 1: two messages
  await sendMsg(win, 'add a circle');
  await sendMsg(win, 'how does it look?');
  let c = await chat(win);
  projectPath = await win.evaluate(() => window.__ms.store.getState().filePath);
  check(!!projectPath && projectPath.startsWith(DIR), `project got a file (${projectPath})`);
  check(!!c.chatId, 'chat has an id');
  let idx = index();
  check(idx.length === 1 && idx[0].id === c.chatId, 'chat 1 saved in the index');
  check(idx[0].title === 'add a circle' && idx[0].messages === 2 && idx[0].path === projectPath, `index meta (${JSON.stringify(idx[0])})`);
  const f = chatFile(c.chatId);
  check(f.items.length > 0 && f.history.length === c.history, 'chat file has items + model history');
  check(!JSON.stringify(f.items).includes('"snapshot"') && !JSON.stringify(f.items).includes('"before"'), 'no project snapshots in the file');
  const chat1 = c.chatId;

  // chat 2
  await win.click('[data-testid=agent-new]');
  c = await chat(win);
  check(c.users.length === 0 && c.chatId === null, 'new chat is empty');
  check(await win.evaluate(() => document.activeElement?.dataset?.testid) === 'agent-input', 'input focused after new chat');
  await sendMsg(win, 'add a square');
  c = await chat(win);
  const chat2 = c.chatId;
  check(chat2 && chat2 !== chat1 && index().length === 2, 'chat 2 saved separately');

  // history lists both, newest first, current marked
  await win.click('[data-testid=agent-history-btn]');
  await win.waitForSelector('[data-testid=agent-history-row]');
  let r = await rows(win);
  check(r.length === 2 && r[0].title === 'add a square' && r[1].title === 'add a circle', `rows newest first (${r.map((x) => x.title)})`);
  check(r[0].current && !r[1].current, 'current chat marked');
  check(/1 message/.test(r[0].sub) && /2 messages/.test(r[1].sub), `message counts (${r.map((x) => x.sub)})`);
  check(/\$0\.00/.test(r[1].sub), 'cost shown');
  await win.screenshot({ path: path.join(OUT, '2-history.png') });

  // search
  await win.fill('[data-testid=agent-history-search]', 'circ');
  r = await rows(win);
  check(r.length === 1 && r[0].title === 'add a circle', 'search filters by title');
  await win.fill('[data-testid=agent-history-search]', 'zzz');
  check(/No chats match/.test(await win.textContent('[data-testid=agent-history]')), 'no-match message');
  await win.fill('[data-testid=agent-history-search]', '');

  // keyboard: ↓ + Enter resumes chat 1
  await win.keyboard.press('ArrowDown');
  await win.keyboard.press('Enter');
  await win.waitForFunction((id) => window.__ms.agent.useAgent.getState().chatId === id, chat1, { timeout: 5000 }).catch(() => {});
  c = await chat(win);
  check(c.chatId === chat1 && JSON.stringify(c.users) === '["add a circle","how does it look?"]', `chat 1 resumed (${c.users})`);
  check(!(await win.$('[data-testid=agent-history]')), 'history closed after resuming');
  check(c.cost > 0.001, 'cost restored');
  await win.screenshot({ path: path.join(OUT, '3-resumed.png') });

  // continuing the resumed chat sends its whole history to the model
  await sendMsg(win, 'one more question');
  const lastReply = await win.evaluate(() => window.__ms.agent.useAgent.getState().history.filter((m) => m.role === 'assistant').pop()?.content);
  check(/Done \(3 user messages\)/.test(lastReply), `model saw the resumed history (${lastReply})`);
  idx = index();
  check(idx.length === 2 && idx[0].id === chat1 && idx[0].messages === 3, 'resumed chat updated in place, moved to the top');

  // going back to a message of a resumed chat uses its git checkpoint
  const backs = await win.$$('[data-testid=agent-back]');
  await backs[0].click();
  await win.click('[data-testid=agent-back-go]');
  await win.waitForFunction(() => window.__ms.store.getState().project.clips.length === 0, null, { timeout: 5000 }).catch(() => {});
  check(await win.evaluate(() => window.__ms.store.getState().project.clips.length) === 0, 'back on a resumed chat restores the project from git');
  await win.waitForTimeout(300);
  check(!index().some((x) => x.id === chat1), 'chat rewound to empty leaves the history');
  await win.evaluate(() => window.__ms.store.getState().undo());
  await win.fill('[data-testid=agent-input]', '');

  // delete from the list
  await win.click('[data-testid=agent-history-btn]');
  await win.waitForSelector('[data-testid=agent-history-row]');
  r = await rows(win);
  check(r.length === 1 && r[0].title === 'add a square', 'history after rewind = chat 2 only');
  await win.hover('[data-testid=agent-history-row]');
  await win.click('[data-testid=agent-history-delete]');
  await win.waitForTimeout(200);
  check((await rows(win)).length === 0 && index().length === 0 && !fs.existsSync(path.join(CHATS, chat2 + '.json.gz')), 'delete removes the chat');
  // click outside closes
  await win.mouse.click(700, 400);
  check(!(await win.$('[data-testid=agent-history]')), 'click outside closes the history');

  // a new chat to find after a restart
  await sendMsg(win, 'add a triangle');
  check(errors.length === 0, `no page errors (${errors.join(' | ')})`);
  await app.close();
}

// ================================================================== 2. after a restart
{
  console.log('\n▶ after a restart');
  const { app, win, errors } = await launch();
  await win.evaluate((p) => window.__ms.actions.switchToProject(p, { quiet: true }), projectPath);
  await win.waitForFunction((p) => window.__ms.store.getState().filePath === p, projectPath, { timeout: 10000 });
  await win.click('[data-testid=right-tab-agent]').catch(() => {});
  let c = await chat(win);
  check(c.users.length === 0, 'reopened project starts with a fresh chat');
  await win.click('[data-testid=agent-history-btn]');
  await win.waitForSelector('[data-testid=agent-history-row]');
  const r = await rows(win);
  check(r.length === 1 && r[0].title === 'add a triangle' && !r[0].current, `saved chat listed after restart (${r.map((x) => x.title)})`);
  await win.click('[data-testid=agent-history-row]');
  await win.waitForFunction(() => window.__ms.agent.useAgent.getState().items.length > 0, null, { timeout: 5000 }).catch(() => {});
  c = await chat(win);
  check(JSON.stringify(c.users) === '["add a triangle"]', 'resumed after restart');
  await win.screenshot({ path: path.join(OUT, '4-after-restart.png') });

  // another project doesn't list this project's chats
  await win.evaluate(() => window.__ms.store.getState().loadProject(window.__ms.ops.newProject ? window.__ms.ops.newProject() : undefined, null));
  await win.waitForTimeout(200);
  if (await win.evaluate(() => !!window.__ms.store.getState().filePath)) console.log('   (skipped: could not open a blank project)');
  else {
    await win.evaluate(() => window.__ms.agent.newChat());
    await win.click('[data-testid=agent-history-btn]');
    await win.waitForSelector('[data-testid=agent-history]');
    await win.waitForTimeout(150);
    check((await rows(win)).length === 0, "another project doesn't show this project's chats");
  }
  check(errors.length === 0, `no page errors (${errors.join(' | ')})`);
  await app.close();
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(fails.length ? `\n✗ ${fails.length} failed:\n - ${fails.join('\n - ')}` : '\n✓ all agent history checks passed');
process.exit(fails.length ? 1 : 0);
