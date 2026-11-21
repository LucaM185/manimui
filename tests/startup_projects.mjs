// Projects browser opens on launch; top bar has no brand / New / Open; name sits left.   node tests/startup_projects.mjs
import { _electron as electron } from 'playwright';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tests', 'out'); fs.mkdirSync(OUT, { recursive: true });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-start-'));
const fails = []; const check = (c, m) => { console.log(c ? '   ✓' : '   ✗', m); if (!c) fails.push(m); };
const run = async (extra) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE'));
  Object.assign(env, { MANIMUI_NO_AUTOSAVE: '1', MANIMUI_HIDDEN: '1', MANIMUI_DATA: path.join(TMP, 'data'),
    MANIMUI_PROJECTS_DIR: path.join(TMP, 'P'), MANIMUI_RECENTS: path.join(TMP, 'r.json') }, extra);
  const app = await electron.launch({ args: [ROOT], env, cwd: ROOT });
  const win = await app.firstWindow();
  await win.setViewportSize({ width: 1600, height: 950 });
  await win.waitForSelector('.topbar', { timeout: 60000 });
  await win.waitForTimeout(1500);
  return { app, win };
};
{
  const { app, win } = await run({ MANIMUI_STARTUP_PROJECTS: '1' });
  check(await win.evaluate(() => window.__ms.store.getState().projectsOpen), 'projects popup open at launch');
  check(!!(await win.$('[data-testid=projects-new]')), 'popup shows New project');
  await win.screenshot({ path: path.join(OUT, 'startup_projects.png') });
  await win.keyboard.press('Escape'); await win.waitForTimeout(300);
  check(!(await win.evaluate(() => window.__ms.store.getState().projectsOpen)), 'Escape closes it');
  const tb = await win.$eval('.topbar', (t) => ({ text: t.innerText, brand: !!t.querySelector('.brand, .logo'),
    btn: innerWidth - t.querySelector('[data-testid=tb-settings]').getBoundingClientRect().right, name: t.querySelector('.project-name').getBoundingClientRect().left,
    align: getComputedStyle(t.querySelector('.project-name')).textAlign }));
  check(!tb.brand && !/ManimUI/.test(tb.text), 'no logo / ManimUI brand');
  check(!/\bNew\b|\bOpen\b/.test(tb.text), 'no New / Open buttons in top bar');
  check(tb.btn < 30 && tb.name < 300 && tb.align === 'left', `name on the left, icon buttons at the right edge (settings ${tb.btn}px from edge, name ${tb.name}, ${tb.align})`);
  check(!/Projects|Code|Export|Settings/.test(tb.text), 'top bar shows icons only — no Projects/Code/Export/Settings text');
  check(!(await win.$('[data-testid=app-menu-btn]')), 'no ⋯ dropdown menu anymore');
  const order = await win.$$eval('[data-testid=app-actions] > button', (els) => els.map((e) => e.dataset.testid).join());
  check(order === 'tb-projects,tb-code,tb-export,tb-settings', `four icon buttons in order (${order})`);
  await win.screenshot({ path: path.join(OUT, 'startup_topbar.png'), clip: { x: 0, y: 0, width: 1600, height: 60 } });
  // hovering an icon shows a tooltip with its name + shortcut, after a short delay; leaving hides it
  const tipOf = (id) => win.$eval(`[data-testid=tb-${id}] .tb-tip`, (t) => {
    const r = t.getBoundingClientRect(); const cs = getComputedStyle(t);
    return { text: t.textContent.trim(), shown: cs.visibility === 'visible' && +cs.opacity > 0.9, left: r.left, right: r.right, top: r.top };
  });
  check(!(await tipOf('code')).shown, 'tooltip hidden before hovering');
  for (const [id, label, key] of [['projects', 'Projects', '⌘P'], ['code', 'Code', '⇧⌘C'], ['export', 'Export', '⌘E'], ['settings', 'Settings', '⌘,']]) {
    await win.hover(`[data-testid=tb-${id}]`); await win.waitForTimeout(650);
    const t = await tipOf(id);
    const bottom = await win.$eval('.topbar', (b) => b.getBoundingClientRect().bottom);
    check(t.shown && t.text.includes(label) && t.text.includes(key) && t.left >= 0 && t.right <= (await win.evaluate(() => innerWidth)) && t.top >= bottom - 4,
      `hover ${id} → tooltip “${t.text}” fully on screen below the bar (${JSON.stringify(t)})`);
    if (id === 'export') await win.screenshot({ path: path.join(OUT, 'topbar_tooltip.png'), clip: { x: 1100, y: 0, width: 500, height: 120 } });
  }
  await win.mouse.move(600, 400); await win.waitForTimeout(250);
  check(!(await tipOf('settings')).shown, 'tooltip hides when the pointer leaves');
  for (const [item, sel, flag] of [['projects', '[data-testid=projects-popup]', 'projectsOpen'], ['code', '[data-testid=code-popup]', 'codeOpen'], ['export', '[data-testid=export-dialog]', 'exportOpen'], ['settings', '[data-testid=settings-panel]', 'settingsOpen']]) {
    await win.click(`[data-testid=tb-${item}]`);
    const shown = await win.waitForSelector(sel, { timeout: 5000 }).then(() => true, () => false);
    check(shown, `${item} icon opens its popup`);
    await win.keyboard.press('Escape'); await win.waitForTimeout(150);
    check(!(await win.evaluate((f) => window.__ms.store.getState()[f], flag)), `Escape closes ${item}`);
  }
  await app.close();
}
{
  const { app, win } = await run({});
  check(!(await win.evaluate(() => window.__ms.store.getState().projectsOpen)), 'test env (NO_AUTOSAVE) keeps popup closed');
  await app.close();
}
console.log(fails.length ? `FAILED ${fails.length}` : 'ALL PASS'); process.exit(fails.length ? 1 : 0);
