// A real Mac self-update: a release build (packaging/mac/build.sh --release) "installed" in a temp
// Applications folder finds a newer release on a local server, downloads its zip, quits, Squirrel
// swaps the bundle and starts the new version. Both builds must be signed with the same Developer
// ID (notarization is not needed locally: the download carries no quarantine flag).
//   MS_CUR=release/mac MS_NEXT=release/mac-next node tests/mac_update.mjs
// (both from build.sh --release; MS_NOTARIZE=0 is fine, MS_VERSION=99.0.0 MS_MAC_OUT=release/mac-next
// for the second). The server lays the files out like GitHub release URLs (/v<version>/<file>), so
// the updater also fetches the installed version's .blockmap for a differential download.
import { _electron as electron } from 'playwright';
import { execFileSync, execSync } from 'child_process';
import fs from 'fs'; import http from 'http'; import os from 'os'; import path from 'path';
const NEXT = process.env.MS_NEXT; const CUR = process.env.MS_CUR;
if (!NEXT || !CUR) { console.error('set MS_CUR and MS_NEXT (release folders from build.sh --release)'); process.exit(2); }
const OUT = process.env.MS_OUT || path.join(process.cwd(), 'tests', 'out'); fs.mkdirSync(OUT, { recursive: true });
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ms-macupd-')));
const fails = []; const check = (c, m) => { console.log(c ? '   ✓' : '   ✗', m); if (!c) fails.push(m); };
const t0 = Date.now(); const el = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;
const ver = (dir) => /version:\s*(\S+)/.exec(fs.readFileSync(path.join(dir, 'latest-mac.yml'), 'utf8'))[1].replace(/['"]/g, '');
const NEXT_VERSION = ver(NEXT); const CUR_VERSION = ver(CUR);
const DIRS = { [NEXT_VERSION]: path.resolve(NEXT), [CUR_VERSION]: path.resolve(CUR) };
const ZIP = 'ManimUI-arm64-mac.zip';

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

// "install": unzip the current release's update zip, as a user dragging it to Applications would
const APPS = path.join(TMP, 'Applications'); fs.mkdirSync(APPS);
execFileSync('ditto', ['-x', '-k', path.join(CUR, ZIP), APPS]);
const BUNDLE = path.join(APPS, 'ManimUI.app');
const BIN = path.join(BUNDLE, 'Contents', 'MacOS', 'ManimUI');
const plistVersion = () => execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(BUNDLE, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
const pids = () => { try { return execSync(`pgrep -f "${BIN}"`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean); } catch { return []; } };
const killAll = () => { for (const p of pids()) try { process.kill(+p, 'SIGTERM'); } catch { /* gone */ } };
check(plistVersion() === CUR_VERSION, `installed ${CUR_VERSION} in ${APPS}`);

const SETTINGS = path.join(TMP, 'settings.json');
fs.writeFileSync(SETTINGS, JSON.stringify({ autoCheckUpdates: false }));
const logs = [];
const launch = async () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE' && k !== 'DEBUG' && !k.startsWith('OPENROUTER')));
  Object.assign(env, { MANIMUI_NO_AUTOSAVE: '1', MANIMUI_DATA: path.join(TMP, 'data'),
    MANIMUI_PROJECTS_DIR: path.join(TMP, 'P'), MANIMUI_RECENTS: path.join(TMP, 'r.json'), MANIMUI_SETTINGS: SETTINGS,
    MANIMUI_STARTUP_PROJECTS: '0', MANIMUI_UPDATE_URL: URL_, MANIMUI_UPDATE_CACHE: 'manimui-updater-test', HF_HUB_OFFLINE: '1', MANIMUI_OFFLINE: '1' });
  const app = await electron.launch({ executablePath: BIN, env, timeout: 240000 });
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
  const st = await win.evaluate(() => window.studio.updates.get());
  check(st.mode === 'install', `release build can update itself (mode=${st.mode})`);
  // "Check" finds the new version and downloads it right away (no separate Download step)
  served = 0;
  await win.click('[data-testid=update-check]');
  await win.waitForFunction(() => ['downloading', 'ready'].includes(document.querySelector('[data-testid=update-status]')?.getAttribute('data-state')), null, { timeout: 60000 });
  check(true, `sees ${NEXT_VERSION} on the server and starts downloading (${el()})`);
  await waitState(win, 'ready', 900000).catch(async (e) => { console.log('   status:', await win.textContent('[data-testid=update-status]')); throw e; });
  const size = fs.statSync(path.join(NEXT, ZIP)).size;
  check(true, `downloaded (${el()}): ${(served / 1e6).toFixed(1)} MB from the server for a ${(size / 1e6).toFixed(0)} MB zip (${((100 * served) / size).toFixed(0)}%)`);
  // the first update after installing from the dmg is a full download: electron-updater diffs
  // against the previous update's zip in its cache, and a fresh install has none; later ones diff
  console.log(`   · ${hits.some((h) => h.includes(`/v${CUR_VERSION}/${ZIP}.blockmap`)) ? 'differential download (fetched the installed version\'s blockmap)' : 'full download (first update: no previous zip cached)'}`);
  await win.locator('[data-testid=settings-updates]').screenshot({ path: path.join(OUT, 'mac_update_ready.png') });

  const closed = new Promise((r) => app.on('close', r));
  await win.click('[data-testid=update-install]');
  check(await Promise.race([closed.then(() => true), new Promise((r) => setTimeout(() => r(false), 60000))]), 'old version quits on "Restart to update"');
  let swapped = false; let relaunched = false;
  for (let i = 0; i < 180 && !(swapped && relaunched); i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try { swapped = plistVersion() === NEXT_VERSION; } catch { swapped = false; }
    relaunched = swapped && pids().length > 0;
  }
  check(swapped, `bundle replaced in place: Info.plist says ${(() => { try { return plistVersion(); } catch { return '?'; } })()} (${el()})`);
  check(relaunched, 'new version started automatically');
  const v = (await import('child_process')).spawnSync('codesign', ['--verify', '--deep', '--strict', BUNDLE], { encoding: 'utf8' });
  check(v.status === 0, `updated bundle's signature is valid${v.status ? ': ' + v.stderr.slice(0, 300) : ''}`);
  await new Promise((r) => setTimeout(r, 4000));
  killAll();
  await new Promise((r) => setTimeout(r, 3000));
} catch (e) {
  check(false, `crashed: ${e.message}`);
}

try {
  const { app, win } = await launch();
  const v1 = await app.evaluate(({ app }) => app.getVersion());
  check(v1 === NEXT_VERSION, `relaunched app is version ${v1}`);
  await win.waitForFunction(() => window.__ms.store.getState().engineStatus === 'ready', null, { timeout: 300000 });
  check(true, 'engine of the new version starts');
  await win.click('[data-testid=update-check]');
  await waitState(win, 'latest', 60000);
  check(true, '"You’re up to date" after the update');
  await win.locator('[data-testid=settings-updates]').screenshot({ path: path.join(OUT, 'mac_update_after.png') });
  await app.close();
} catch (e) {
  check(false, `relaunch crashed: ${e.message}`);
}
server.close();
killAll();
fs.rmSync(path.join(os.homedir(), 'Library', 'Caches', 'manimui-updater-test'), { recursive: true, force: true });
if (fails.length) console.log('   requests:\n     ' + hits.slice(-30).join('\n     '));
else fs.rmSync(TMP, { recursive: true, force: true });
console.log(fails.length ? `\nMAC UPDATE: ${fails.length} FAILED\n - ${fails.join('\n - ')}` : '\nMAC UPDATE: ALL PASS');
process.exit(fails.length ? 1 : 0);
