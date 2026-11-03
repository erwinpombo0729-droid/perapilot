const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  await p.goto('http://localhost:8765/index.html'); await p.waitForSelector('#app:not([hidden])');
  for (const r of ['', 'transactions', 'cutoff', 'budget', 'bills', 'debts', 'goals', 'wallets', 'reports', 'settings']) {
    await p.goto('http://localhost:8765/index.html#/' + r); await p.waitForTimeout(150);
    const res = await p.evaluate(() => {
      const vw = document.documentElement.clientWidth, out = [];
      document.querySelectorAll('#view *, .topbar *, #banners *').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width && r.right > vw + 1) out.push(el.tagName.toLowerCase() + '.' + (el.className && el.className.baseVal === undefined ? el.className : '') + ' right=' + Math.round(r.right) + ' w=' + Math.round(r.width));
      });
      return { vw, sw: document.documentElement.scrollWidth, out: out.slice(0, 6) };
    });
    console.log(r || 'dashboard', JSON.stringify(res));
  }
  await b.close();
})();
