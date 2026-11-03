const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const errors = [];
  for (const [name, vp] of [['desktop', { width: 1280, height: 860 }], ['mobile', { width: 390, height: 800 }]]) {
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, isMobile: name === 'mobile', hasTouch: name === 'mobile' });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') errors.push(name + ' console: ' + m.text()); });
    page.on('pageerror', (e) => errors.push(name + ' pageerror: ' + e.message));
    await page.goto('http://localhost:8765/index.html');
    await page.waitForSelector('#app:not([hidden])');
    for (const r of ['', 'transactions', 'cutoff', 'budget', 'bills', 'debts', 'goals', 'wallets', 'reports', 'settings']) {
      await page.goto('http://localhost:8765/index.html#/' + r);
      await page.waitForTimeout(150);
      const title = await page.textContent('#page-title');
      const txt = (await page.textContent('#view')).trim().length;
      if (txt < 50) errors.push(`${name} ${r}: view nearly empty`);
      await page.screenshot({ path: `/tmp/claude-0/shots/${name}-${r || 'dashboard'}.png`, fullPage: true });
      console.log(name, r || 'dashboard', '->', title, txt, 'chars');
    }
    await ctx.close();
  }
  await browser.close();
  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'NO CONSOLE ERRORS');
})();
