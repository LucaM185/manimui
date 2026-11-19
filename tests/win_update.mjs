// A real Windows self-update: the installed app (packaging/windows/test.sh installed it) finds a newer
// installer on a local server, downloads it, quits, the installer runs silently and starts the new
// version. Run on Windows after test.sh:
//   MS_APP=%LOCALAPPDATA%\Programs\MathStudio\MathStudio.exe MS_NEXT=release-next MS_CUR=release node tests/win_update.mjs
// MS_NEXT = the same app built as a higher version (MathStudio-Setup.exe + .blockmap + latest.yml),
// MS_CUR = the installed version's files. The server lays them out like GitHub release URLs
// (/v<version>/<file>), so the updater fetches the old .blockmap for a differential download.
import { _electron as electron } from 'playwright';
import { execSync } from 'child_process';
import fs from 'fs'; import http from 'http'; import os from 'os'; import path from 'path';
const APP = process.env.MS_APP; const NEXT = process.env.MS_NEXT; const CUR = process.env.MS_CUR;
if (!APP || !NEXT || !CUR) { console.error('set MS_APP (installed MathStudio.exe), MS_NEXT and MS_CUR (release folders)'); process.exit(2); }
const OUT = process.env.MS_OUT || path.join(os.tmpdir(), 'ms-out'); fs.mkdirSync(OUT, { recursive: true });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-upd-'));
const fails = []; const check = (c, m) => { console.log(c ? '   ✓' : '   ✗', m); if (!c) fails.push(m); };
const t0 = Date.now(); const el = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;
const ver = (dir) => /version:\s*(\S+)/.exec(fs.readFileSync(path.join(dir, 'latest.yml'), 'utf8'))[1].replace(/['"]/g, '');
const NEXT_VERSION = ver(NEXT); const CUR_VERSION = ver(CUR);
const DIRS = { [NEXT_VERSION]: path.resolve(NEXT), [CUR_VERSION]: path.resolve(CUR) };

// ---- static server with single Range support (what GitHub's CDN does): /v<version>/<file>
let served = 0; const hits = [];
const server = http.createServer((req, res) => {
  const m0 = /^\/v([^/]+)\/(.+)$/.exec(decodeURIComponent(req.url.split('?')[0]));
  const dir = m0 && DIRS[m0[1]];
  const f = dir && path.join(dir, path.basename(m0[2]));
  hits.push(`${req.method} ${req.url}${req.headers.range ? ' ' + req.headers.range.slice(0, 40) : ''}`);
  if (!f || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  const size = fs.statSync(f).size;
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  if (m) {
    const a = +m[1]; const b = m[2] ? Math.min(+m[2], size - 1) : size - 1;
    res.writeHead(206, { 'content-range': `bytes ${a}-${b}/${size}`, 'content-length': b - a + 1, 'accept-ranges': 'bytes' });
    served += b - a + 1;
    return fs.createReadStream(f, { start: a, end: b }).pipe(res);
  }
  res.writeHead(200, { 'content-length': size, 'accept-ranges': 'bytes' });
  if (req.method !== 'HEAD' && !f.endsWith('.yml') && !f.endsWith('.blockmap')) served += size;
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const URL_ = `http://127.0.0.1:${server.address().port}/v${NEXT_VERSION}/`;

const SETTINGS = path.join(TMP, 'settings.json');
fs.writeFileSync(SETTINGS, JSON.stringify({ autoCheckUpdates: false }));
const running = () => { try { return /MathStudio\.exe/i.test(execSync('tasklist /FI "IMAGENAME eq MathStudio.exe" /NH', { encoding: 'utf8' })); } catch { return false; } };
const killAll = () => { try { execSync('taskkill /IM MathStudio.exe /F /T', { stdio: 'ignore' }); } catch { /* none */ } };

const logs = [];
const launch = async () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE' && k !== 'DEBUG' && !k.startsWith('OPENROUTER')));
  Object.assign(env, { MATHSTUDIO_NO_AUTOSAVE: '1', MATHSTUDIO_DATA: path.join(TMP, 'data'),
    MATHSTUDIO_PROJECTS_DIR: path.join(TMP, 'P'), MATHSTUDIO_RECENTS: path.join(TMP, 'r.json'), MATHSTUDIO_SETTINGS: SETTINGS,
    MATHSTUDIO_STARTUP_PROJECTS: '0', MATHSTUDIO_UPDATE_URL: URL_, HF_HUB_OFFLINE: '1', MATHSTUDIO_OFFLINE: '1' });
  const app = await electron.launch({ executablePath: APP, env, timeout: 240000 });
  const grab = (d) => { for (const l of d.toString().split('\n')) if (/\[update\]/.test(l)) { logs.push(l); console.log('     ' + l.trim().slice(0, 220)); } };
  app.process().stdout?.on('data', grab); app.process().stderr?.on('data', grab);
  const win = await app.firstWindow();
  win.on('pageerror', (e) => console.log('   pageerror:', e.message));
  await win.setViewportSize({ width: 1600, height: 950 });
  await win.waitForSelector('.topbar', { timeout: 240000 });
  await win.click('[data-testid=tb-settings]');
  await win.waitForSelector('[data-testid=settings-updates]');
  await win.locator('[data-testid=settings-updates]').scrollIntoViewIfNeeded();
  return { app, win };
};
const waitState = (win, s, timeout) => win.waitForFunction((s) => document.querySelector('[data-testid=update-status]')?.getAttribute('data-state') === s, s, { timeout });

try {
  const { app, win } = await launch();
  const v0 = await app.evaluate(({ app }) => app.getVersion());
  check(v0 === CUR_VERSION, `installed app is ${v0}`);
  const st = await win.evaluate(() => window.studio.updates.get());
  check(st.mode === 'install', `installed Windows app can update itself (mode=${st.mode})`);
  // "Check" finds the new version and downloads it right away (no separate Download step)
  served = 0;
  await win.click('[data-testid=update-check]');
  await win.waitForFunction(() => ['downloading', 'ready'].includes(document.querySelector('[data-testid=update-status]')?.getAttribute('data-state')), null, { timeout: 60000 });
  check(true, `sees ${NEXT_VERSION} on the server and starts downloading (${el()})`);
  await waitState(win, 'ready', 900000);
  const size = fs.statSync(path.join(NEXT, 'MathStudio-Setup.exe')).size;
  check(true, `downloaded (${el()}): ${(served / 1e6).toFixed(1)} MB transferred for a ${(size / 1e6).toFixed(0)} MB installer (${((100 * served) / size).toFixed(0)}%)`);
  check(hits.some((h) => h.includes(`/v${CUR_VERSION}/MathStudio-Setup.exe.blockmap`)), 'fetched the installed version\'s blockmap (differential download)');
  await win.locator('[data-testid=settings-updates]').screenshot({ path: path.join(OUT, 'win_update_ready.png') });

  const closed = new Promise((r) => app.on('close', r));
  await win.click('[data-testid=update-install]');
  check(await Promise.race([closed.then(() => true), new Promise((r) => setTimeout(() => r(false), 60000))]), 'old version quits on "Restart to update"');
  // the silent installer replaces the app, then starts the new version by itself (--force-run)
  let relaunched = false;
  for (let i = 0; i < 300 && !relaunched; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    relaunched = running();
  }
  check(relaunched, `new version started automatically (${el()})`);
  await new Promise((r) => setTimeout(r, 5000));
  killAll();
  await new Promise((r) => setTimeout(r, 3000));
} catch (e) {
  check(false, `crashed: ${e.message}`);
}

try {
  const { app, win } = await launch();
  const v1 = await app.evaluate(({ app }) => app.getVersion());
  check(v1 === NEXT_VERSION, `relaunched app is version ${v1}`);
  check((await win.textContent('[data-testid=update-current]')).includes(NEXT_VERSION), 'Settings shows the new version');
  await win.waitForFunction(() => window.__ms.store.getState().engineStatus === 'ready', null, { timeout: 300000 });
  check(true, 'engine of the new version starts');
  await win.click('[data-testid=update-check]');
  await waitState(win, 'latest', 60000);
  check(true, '"You’re up to date" after the update');
  await win.locator('[data-testid=settings-updates]').screenshot({ path: path.join(OUT, 'win_update_after.png') });
  await app.close();
} catch (e) {
  check(false, `relaunch crashed: ${e.message}`);
}
server.close();
killAll();
const diff = logs.find((l) => /Full: .*To download|differential/i.test(l));
if (diff) console.log('   differential:', diff.trim());
if (fails.length) console.log('   requests:\n     ' + hits.slice(-30).join('\n     '));
console.log(fails.length ? `\nWINDOWS UPDATE: ${fails.length} FAILED\n - ${fails.join('\n - ')}` : '\nWINDOWS UPDATE: ALL PASS');
process.exit(fails.length ? 1 : 0);
