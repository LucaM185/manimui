// Settings → Agent provider: OpenRouter (default) or any OpenAI-compatible API with its own base URL,
// key, model and model options. A local mock server plays both the custom provider and OpenRouter
// (MATHSTUDIO_OPENROUTER_URL), so the real ai:chat proxy runs end to end: free and deterministic.
//   npm run test:aiprovider
import { _electron as electron } from 'playwright';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.E2E_OUT || path.join(ROOT, 'tests', 'out', 'ai_provider');
fs.mkdirSync(OUT, { recursive: true });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-aiprov-'));
const SETTINGS = path.join(TMP, 'settings.json');
const KEY = 'sk-test-custom-123';
const OR_KEY = 'sk-or-v1-mock-0123456789';

const fails = [];
const check = (cond, msg) => { (cond ? console.log('   ✓', msg) : (fails.push(msg), console.log('   ✗', msg))); };
const stored = () => { try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch { return {}; } };

// ------------------------------------------------------------------ mock OpenAI-compatible server
const requests = []; // { path, auth, title, body }
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const auth = req.headers.authorization || '';
    const or = req.url.startsWith('/or/');
    const want = `Bearer ${or ? OR_KEY : KEY}`;
    if (auth !== want) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'bad key' } }));
    }
    if (req.method === 'GET' && or && req.url === '/or/v1/key') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: { label: 'mock', usage: 0, limit: null } }));
    }
    if (req.method === 'GET' && /\/v1\/models(\?|$)/.test(req.url)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model' }, { id: 'mock-small' }] }));
    }
    if (req.method === 'POST' && req.url.endsWith('/v1/chat/completions')) {
      const body = JSON.parse(raw);
      requests.push({ path: req.url, auth, title: req.headers['x-title'], body });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      const last = body.messages[body.messages.length - 1];
      if (last.role === 'user' && JSON.stringify(last.content).includes('add a circle')) {
        // a tool call split over two chunks and WITHOUT an id (like Ollama)
        send({ choices: [{ index: 0, delta: { reasoning_content: 'I will add a circle. ' } }] });
        send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, type: 'function', function: { name: 'add_clips', arguments: '{"clips":[{"item":"circ' } }] } }] });
        send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'le","start":0,"duration":3}]}' } }] } }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        for (const w of ['All ', 'done ', 'here.']) send({ choices: [{ index: 0, delta: { content: w } }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      }
      send({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020 } });
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    res.writeHead(404);
    res.end('not found');
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}/v1`;

// ------------------------------------------------------------------ app
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE' && !k.startsWith('OPENROUTER')));
Object.assign(env, {
  MATHSTUDIO_NO_AUTOSAVE: '1', MATHSTUDIO_HIDDEN: '1', MATHSTUDIO_DATA: path.join(TMP, 'data'), MATHSTUDIO_TEST_CONFIRM: '0',
  MATHSTUDIO_CHECKPOINTS: path.join(TMP, 'checkpoints'), MATHSTUDIO_CHATS: path.join(TMP, 'chats'), MATHSTUDIO_PROJECTS_DIR: path.join(TMP, 'P'),
  MATHSTUDIO_RECENTS: path.join(TMP, 'recents.json'), MATHSTUDIO_STARTUP_PROJECTS: '0', MATHSTUDIO_SETTINGS: SETTINGS,
  MATHSTUDIO_OPENROUTER_URL: `http://127.0.0.1:${PORT}/or/v1`,
});
const app = await electron.launch({ args: [ROOT], env, cwd: ROOT });
if (process.env.MS_DEBUG) { app.process().stderr.on('data', (d) => process.stderr.write(d)); app.process().stdout.on('data', (d) => process.stdout.write(d)); }
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(e.message));
win.on('crash', () => console.log('   !! renderer crashed'));
win.on('close', () => console.log('   !! window closed'));
app.process().on('exit', (code, sig) => console.log(`   !! app exited code=${code} signal=${sig}`));
await win.setViewportSize({ width: 1600, height: 1000 });
await win.waitForSelector('.lib-card', { timeout: 90000 });
const status = () => win.evaluate(() => window.studio.ai.status());
const fillCommit = async (sel, v) => { await win.fill(sel, v); await win.press(sel, 'Enter'); await win.waitForTimeout(250); };

try {
  await win.click('[data-testid=tb-settings]');
  await win.waitForSelector('[data-testid=settings-panel]');
  await win.waitForSelector('[data-testid=settings-ai-provider-openrouter]');

  // ================================================================== 1. OpenRouter stays the default
  console.log('1. OpenRouter default');
  check(await win.getAttribute('[data-testid=settings-ai-provider-openrouter]', 'aria-checked') === 'true', 'OpenRouter is the default provider');
  const s0 = await status();
  check(s0.provider === 'openrouter' && s0.model === 'anthropic/claude-haiku-5.5', `default model (${s0.model})`);
  check(!(await win.$('[data-testid=settings-ai-baseurl]')), 'no base URL row for OpenRouter');
  // the (repo .env) key may already be there; type the mock's one
  if (!(await win.$('[data-testid=settings-key-input]'))) await win.click('[data-testid=settings-key-change]');
  await win.fill('[data-testid=settings-key-input]', OR_KEY);
  await win.click('[data-testid=settings-key-save]');
  await win.waitForSelector('[data-testid=settings-key-remove]');
  check(stored().openrouterKey === OR_KEY, 'OpenRouter key still saved as before');
  await win.waitForSelector('[data-testid=settings-key-test-result]', { timeout: 8000 }).catch(() => {});
  check(/Key works/.test(await win.textContent('[data-testid=settings-key-test-result]').catch(() => '')), 'saving the OpenRouter key runs the key test → ok');

  // custom OpenRouter model + options
  await fillCommit('[data-testid=settings-ai-model]', 'openai/gpt-5-mini');
  check(stored().ai?.openrouter?.model === 'openai/gpt-5-mini', 'OpenRouter model saved');
  check((await status()).model === 'openai/gpt-5-mini', 'agent uses the chosen OpenRouter model');
  await win.click('[data-testid=settings-ai-models-load]');
  await win.click('[data-testid=settings-ai-model]');
  await win.waitForSelector('[data-testid=settings-ai-model-option]', { timeout: 8000 }).catch(() => {});
  check(await win.$$eval('[data-testid=settings-ai-model-option]', (o) => o.map((x) => x.textContent).join(',')) === 'mock-model,mock-small', 'OpenRouter model list loaded into the picker');
  await win.keyboard.press('Escape');
  check(!(await win.$('[data-testid=settings-ai-model-list]')) && !!(await win.$('[data-testid=settings-panel]')), 'Escape closes the list, not the popup');
  check(requests.length === 0, 'listing models costs no chat call');
  await win.click('[data-testid=settings-ai-effort-high]');
  await win.waitForTimeout(200);
  check(stored().ai?.openrouter?.reasoning === 'high', 'OpenRouter thinking effort saved');
  await win.screenshot({ path: path.join(OUT, '1_openrouter.png') });

  // ================================================================== 2. switch to an OpenAI-compatible provider
  console.log('2. OpenAI-compatible provider');
  await win.click('[data-testid=settings-ai-provider-custom]');
  await win.waitForSelector('[data-testid=settings-ai-baseurl]');
  check(stored().ai?.provider === 'custom', 'provider saved');
  const s1 = await status();
  check(s1.provider === 'custom' && !s1.configured, 'not configured until URL + model are set');
  check(!!(await win.$('[data-testid=settings-ai-hint]')), 'the popup says what is missing');
  check(await win.inputValue('[data-testid=settings-ai-model]') === '', 'custom model starts empty (not the OpenRouter one)');
  check(await win.getAttribute('[data-testid=settings-ai-effort-off]', 'aria-checked') === 'true', 'custom thinking defaults to Off');

  // presets fill the URL
  await win.selectOption('[data-testid=settings-ai-preset]', 'LM Studio');
  await win.waitForTimeout(300);
  check(stored().ai?.custom?.baseUrl === 'http://localhost:1234/v1' && stored().ai?.custom?.name === 'LM Studio', 'preset fills base URL + name');
  check(await win.inputValue('[data-testid=settings-ai-baseurl]') === 'http://localhost:1234/v1', 'URL field shows the preset');

  // a bad URL is refused
  await fillCommit('[data-testid=settings-ai-baseurl]', 'ftp://nope');
  await win.waitForSelector('[data-testid=settings-ai-error]');
  check(stored().ai?.custom?.baseUrl === 'http://localhost:1234/v1', 'non-http URL refused, old one kept');

  // pasting the full endpoint is normalised to the base URL; without the key the server says 401
  await fillCommit('[data-testid=settings-ai-baseurl]', `${BASE}/chat/completions/`);
  check(stored().ai?.custom?.baseUrl === BASE, `endpoint path trimmed (${stored().ai?.custom?.baseUrl})`);
  check(!stored().ai?.custom?.name, 'name cleared for a non-preset URL');
  await win.waitForSelector('[data-testid=settings-ai-conn]', { timeout: 8000 });
  check(/rejected the key \(401\)/.test(await win.textContent('[data-testid=settings-ai-conn]')), 'connection check reports the missing key');

  // key → reconnects automatically and lists the models
  await win.fill('[data-testid=settings-ai-key-input]', KEY);
  await win.click('[data-testid=settings-ai-key-save]');
  await win.waitForSelector('[data-testid=settings-ai-key-remove]');
  check(stored().ai?.custom?.apiKey === KEY, 'custom key saved in settings.json');
  if (process.platform !== 'win32') check((fs.statSync(SETTINGS).mode & 0o077) === 0, 'settings.json still owner-only');
  const shown = await win.textContent('[data-testid=settings-ai-key-state]');
  check(!shown.includes(KEY), `custom key shown masked (${shown.trim()})`);
  const pub = await win.evaluate(() => window.studio.settings.get());
  check(!JSON.stringify(pub).includes(KEY), 'the key never reaches the renderer');
  await win.waitForFunction(() => /Connected · 2 models/.test(document.querySelector('[data-testid=settings-ai-conn]')?.textContent || ''), null, { timeout: 8000 }).catch(() => {});
  check(/Connected · 2 models/.test(await win.textContent('[data-testid=settings-ai-conn]')), 'connected, models listed');

  // pick from the list with the keyboard: filter, ↓, ↩
  await win.click('[data-testid=settings-ai-model]');
  await win.keyboard.type('small');
  check(await win.$$eval('[data-testid=settings-ai-model-option]', (o) => o.map((x) => x.textContent).join(',')) === 'mock-small', 'typing filters the list');
  await win.keyboard.press('ArrowDown');
  await win.keyboard.press('Enter');
  await win.waitForTimeout(300);
  check(stored().ai?.custom?.model === 'mock-small', 'model picked from the list');
  // click an option
  await win.fill('[data-testid=settings-ai-model]', 'model');
  await win.click('[data-testid=settings-ai-model-option]:has-text("mock-model")');
  await win.waitForTimeout(300);
  check(stored().ai?.custom?.model === 'mock-model', 'model clicked in the list');
  await fillCommit('[data-testid=settings-ai-model]', 'not-there');
  check(!!(await win.$('[data-testid=settings-ai-model-unknown]')), 'warns about a model the server does not list');
  await fillCommit('[data-testid=settings-ai-model]', 'mock-model');
  const s2 = await status();
  check(s2.configured && s2.model === 'mock-model' && s2.label === `127.0.0.1:${PORT}`, `configured (${s2.label} · ${s2.model})`);
  check(!(await win.$('[data-testid=settings-ai-model-unknown]')), 'model is in the server list (no warning)');

  // model options
  await win.click('[data-testid=settings-ai-effort-low]');
  await fillCommit('[data-testid=settings-ai-maxtokens]', '4096');
  await fillCommit('[data-testid=settings-ai-temperature]', '5');
  await win.waitForSelector('[data-testid=settings-ai-error]');
  check(stored().ai?.custom?.temperature === undefined, 'temperature 5 refused');
  await fillCommit('[data-testid=settings-ai-temperature]', '0.3');
  await win.click('[data-testid=settings-ai-vision]');
  await win.waitForTimeout(300);
  const c = stored().ai?.custom || {};
  check(c.reasoning === 'low' && c.maxTokens === 4096 && c.temperature === 0.3 && c.vision === false, `options saved (${JSON.stringify({ r: c.reasoning, m: c.maxTokens, t: c.temperature, v: c.vision })})`);
  check(stored().ai?.openrouter?.model === 'openai/gpt-5-mini' && stored().ai?.openrouter?.reasoning === 'high', 'OpenRouter options untouched by the custom ones');
  await win.screenshot({ path: path.join(OUT, '2_custom.png') });
  await win.click('[data-testid=settings-close]');

  // ================================================================== 3. the agent runs on the custom provider
  console.log('3. agent turn via the custom provider');
  await win.click('[data-testid=right-tab-agent]');
  await win.waitForSelector('[data-testid=agent-panel]');
  await win.evaluate(() => window.__ms.agent.refreshStatus());
  await win.fill('[data-testid=agent-input]', 'add a circle');
  await win.keyboard.press('Enter');
  await win.waitForFunction(() => window.__ms.agent.useAgent.getState().running, null, { timeout: 5000 }).catch(() => {});
  await win.waitForFunction(() => !window.__ms.agent.useAgent.getState().running, null, { timeout: 60000 });
  await win.waitForTimeout(300);
  const clips = await win.evaluate(() => window.__ms.store.getState().project.clips.map((x) => x.item));
  check(clips.length === 1, `the tool call ran (clips: ${clips.join(',')})`);
  const reply = await win.evaluate(() => window.__ms.agent.useAgent.getState().items.filter((i) => i.kind === 'assistant').map((i) => i.text).join('|'));
  check(reply.includes('All done here.'), `streamed reply shown (${reply})`);
  const errs = await win.evaluate(() => window.__ms.agent.useAgent.getState().items.filter((i) => i.kind === 'error').map((i) => i.text));
  check(errs.length === 0, `no agent errors ${errs.join(' | ')}`);

  const cr = requests.filter((r) => !r.path.startsWith('/or/'));
  check(cr.length === 2, `two chat calls to the custom URL (${cr.length})`);
  if (cr.length >= 2) {
    const [a, b] = cr;
    check(a.body.model === 'mock-model' && a.auth === `Bearer ${KEY}`, 'model + key sent');
    check(a.body.reasoning_effort === 'low' && !('reasoning' in a.body), 'thinking sent as reasoning_effort');
    check(a.body.max_tokens === 4096 && a.body.temperature === 0.3, 'max_tokens + temperature from settings');
    check(!('usage' in a.body) && a.body.stream === true && a.body.stream_options?.include_usage, 'OpenAI streaming options, no OpenRouter fields');
    check(!JSON.stringify(a.body).includes('cache_control'), 'no cache_control hints (off)');
    check(typeof a.body.messages[0].content === 'string' && a.body.messages.every((m) => typeof m.content === 'string' || m.content == null), 'text content flattened to strings');
    check(!a.title, 'no OpenRouter X-Title header');
    check(Array.isArray(a.body.tools) && a.body.tools.length > 5, 'tools sent');
    const asst = b.body.messages.find((m) => m.role === 'assistant' && m.tool_calls);
    const tool = b.body.messages.find((m) => m.role === 'tool');
    check(!!asst?.tool_calls?.[0]?.id && tool?.tool_call_id === asst.tool_calls[0].id, `missing tool-call id filled in and matched (${asst?.tool_calls?.[0]?.id})`);
    check(!JSON.stringify(b.body).includes('reasoning_details'), 'no reasoning_details sent back');
    check(!JSON.stringify(b.body).includes('image_url'), 'image input off → no images sent');
  }

  // ================================================================== 4. back to OpenRouter: same proxy, OpenRouter shape
  console.log('4. OpenRouter request shape');
  await win.click('[data-testid=tb-settings]');
  await win.waitForSelector('[data-testid=settings-ai-provider-openrouter]');
  await win.click('[data-testid=settings-ai-provider-openrouter]');
  await win.waitForTimeout(300);
  check(await win.inputValue('[data-testid=settings-ai-model]') === 'openai/gpt-5-mini', 'OpenRouter model shown again');
  await win.click('[data-testid=settings-ai-provider-custom]');
  await win.waitForSelector('[data-testid=settings-ai-baseurl]');
  check(await win.inputValue('[data-testid=settings-ai-baseurl]') === BASE && await win.inputValue('[data-testid=settings-ai-model]') === 'mock-model', 'custom settings kept across switches');
  await win.click('[data-testid=settings-ai-provider-openrouter]');
  await win.click('[data-testid=settings-close]');
  await win.evaluate(() => window.__ms.agent.refreshStatus());
  const n0 = requests.length;
  await win.fill('[data-testid=agent-input]', 'thanks');
  await win.keyboard.press('Enter');
  await win.waitForFunction(() => window.__ms.agent.useAgent.getState().running, null, { timeout: 5000 }).catch(() => {});
  await win.waitForFunction(() => !window.__ms.agent.useAgent.getState().running, null, { timeout: 60000 });
  const orq = requests.slice(n0);
  check(orq.length === 1 && orq[0].path.startsWith('/or/'), 'call went to OpenRouter');
  if (orq[0]) {
    const o = orq[0];
    check(o.body.model === 'openai/gpt-5-mini' && o.auth === `Bearer ${OR_KEY}` && o.title === 'MathStudio', 'OpenRouter model, key, X-Title');
    check(o.body.reasoning?.effort === 'high' && o.body.usage?.include === true, 'OpenRouter reasoning + usage fields');
    check(o.body.max_tokens >= 120000, `agent's large output cap kept by default (${o.body.max_tokens})`);
    check(JSON.stringify(o.body).includes('cache_control'), 'prompt-cache breakpoints kept for OpenRouter');
  }

  // clearing the model goes back to the default
  await win.click('[data-testid=tb-settings]');
  await win.waitForSelector('[data-testid=settings-ai-model]');
  await fillCommit('[data-testid=settings-ai-model]', '');
  check(!stored().ai?.openrouter?.model && (await status()).model === 'anthropic/claude-haiku-5.5', 'empty model = default model');
  await win.screenshot({ path: path.join(OUT, '3_back.png') });
  check(errors.length === 0, `no page errors ${errors.join(' | ')}`);
} catch (e) {
  fails.push(`crashed: ${e.message}`);
  console.log(e);
  await win.screenshot({ path: path.join(OUT, 'crash.png') }).catch(() => {});
} finally {
  await app.close().catch(() => {});
  server.close();
}

console.log(fails.length ? `\n${fails.length} FAILED:\n - ${fails.join('\n - ')}` : '\nall passed');
process.exit(fails.length ? 1 : 0);
