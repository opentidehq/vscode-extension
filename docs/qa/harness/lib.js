const { _electron } = require('/opt/node-tools/node_modules/playwright');
const fs = require('fs');
const SCREENS = '/home/user/vscode-extension/docs/qa/screens';
async function launch({ exe, ud, ext, folders = [], env = {}, extra = [] }) {
  const app = await _electron.launch({
    executablePath: exe,
    args: ['--no-sandbox', '--disable-gpu', '--disable-updates', '--skip-welcome', '--skip-release-notes',
      '--user-data-dir', ud, '--extensions-dir', ext, '--new-window', ...extra, ...folders],
    env: { ...process.env, DISPLAY: process.env.DISPLAY, ...env },
    timeout: 120000,
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1600, height: 1000 }).catch(() => {});
  return { app, page };
}
async function shot(page, name) {
  const f = `${SCREENS}/${name}.png`;
  await page.screenshot({ path: f });
  console.log('shot', f);
}
async function palette(page, text, wait = 1500) {
  await page.keyboard.press('Escape');
  await page.mouse.click(85, 51).catch(() => {});
  await page.waitForTimeout(300);
  await page.keyboard.press('Control+Shift+p');
  await page.waitForSelector('.quick-input-widget', { state: 'visible', timeout: 8000 });
  await page.waitForTimeout(400);
  await page.keyboard.type(text, { delay: 45 });
  await page.waitForTimeout(wait);
}
async function run(page, text) {
  await palette(page, text);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
}
module.exports = { launch, shot, palette, run, SCREENS };
