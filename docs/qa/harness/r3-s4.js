const { launch, shot, run, palette } = require('./lib');
const W = '/tmp/qa/ws';
(async () => {
  const t0 = Date.now();
  const { app, page } = await launch({ exe: '/tmp/qa/vscode/code', ud: '/tmp/qa/ud-r3', ext: '/tmp/qa/ext-r3', folders: [W], extra: ['--disable-workspace-trust'] });
  await page.waitForTimeout(10000);
  await page.keyboard.press('Control+Alt+b'); await page.waitForTimeout(500);
  await shot(page, 'r3-10-vscode-01b-activated-statusbar');
  await run(page, 'opentide: Show Output'); await page.waitForTimeout(800);
  await shot(page, 'r3-10-vscode-01c-output-channel-tier4');
  await page.keyboard.press('Control+p'); await page.waitForTimeout(400);
  await page.keyboard.type('suspicious-lsass-access.yaml'); await page.waitForTimeout(800);
  await page.keyboard.press('Enter'); await page.waitForTimeout(4000);
  await shot(page, 'r3-10-vscode-02a-rule-open-highlight');
  // introduce a bad KQL operator after line 61
  await page.keyboard.press('Control+g'); await page.waitForTimeout(300);
  await page.keyboard.type('62'); await page.keyboard.press('Enter');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('| frobnicate EventID', { delay: 20 });
  await page.waitForTimeout(5000);
  await page.keyboard.press('Control+Shift+m'); await page.waitForTimeout(1500);
  await shot(page, 'r3-10-vscode-02b-diagnostic-bad-kql');
  // completion
  await page.keyboard.press('Control+g'); await page.waitForTimeout(300);
  await page.keyboard.type('63'); await page.keyboard.press('Enter');
  await page.keyboard.press('End'); await page.keyboard.press('Enter');
  await page.keyboard.type('| whe', { delay: 30 });
  await page.keyboard.press('Control+Space'); await page.waitForTimeout(2500);
  await shot(page, 'r3-10-vscode-02c-completion-kql');
  await page.keyboard.press('Escape');
  // hover on EventID in line 61
  await page.keyboard.press('Control+g'); await page.waitForTimeout(300);
  await page.keyboard.type('61'); await page.keyboard.press('Enter');
  await page.keyboard.press('Home'); for (let i = 0; i < 16; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Control+k'); await page.keyboard.press('Control+i'); await page.waitForTimeout(2500);
  await shot(page, 'r3-10-vscode-02d-hover');
  await page.keyboard.press('Escape');
  // yaml-key hover: line 5 schema
  await page.keyboard.press('Control+g'); await page.waitForTimeout(300);
  await page.keyboard.type('30'); await page.keyboard.press('Enter');
  // semantic tokens inspect
  await run(page, 'Developer: Inspect Editor Tokens and Scopes'); await page.waitForTimeout(2000);
  await shot(page, 'r3-10-vscode-02e-semantic-token-inspector');
  await page.keyboard.press('Escape');
  console.log('elapsed', Date.now() - t0);
  await Promise.race([app.close(), new Promise(r => setTimeout(r, 15000))]);
})().catch(e => { console.error(e); process.exit(1); });
