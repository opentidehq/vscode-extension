const { launch, shot, run, palette } = require('./lib');
const W = process.argv[2] || '/tmp/qa/ws-vsc';
(async () => {
  const t0 = Date.now();
  const { app, page } = await launch({ exe: '/tmp/qa/vscode/code', ud: '/tmp/qa/ud-vsc', ext: '/tmp/qa/ext-vsc', folders: [W] });
  await page.waitForTimeout(9000);
  // close the secondary sidebar (chat) and any editors
  await page.keyboard.press('Control+Alt+b'); await page.waitForTimeout(500);
  await shot(page, 'vscode-01b-activated-statusbar');
  await run(page, 'opentide: Show Output');
  await page.waitForTimeout(1000);
  await shot(page, 'vscode-01c-output-channel');
  // open rule
  await page.keyboard.press('Control+p'); await page.waitForTimeout(400);
  await page.keyboard.type('suspicious-lsass-access.yaml'); await page.waitForTimeout(800);
  await page.keyboard.press('Enter'); await page.waitForTimeout(4000);
  await shot(page, 'vscode-02a-rule-open-highlight');
  await Promise.race([app.close(), new Promise(r => setTimeout(r, 15000))]);
})().catch(e => { console.error(e); process.exit(1); });
