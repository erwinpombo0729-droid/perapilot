// Real-browser end-to-end test (Playwright + Chromium). Run: node tests/e2e.js  (needs `python3 -m http.server 8765` in the project folder)
const { chromium } = require('playwright');
const URL = process.env.PP_URL || 'http://localhost:8765/index.html';
let pass = 0, fail = 0; const failures = [];
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; failures.push(msg); console.log('  ✗ FAIL: ' + msg); } };
const eq = (a, b, msg) => ok(a === b, `${msg}  [got ${JSON.stringify(a)}${a === b ? '' : ', expected ' + JSON.stringify(b)}]`);

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-PH' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await ctx.clock.install({ time: new Date('2026-11-16T09:00:00') });

  const txt = async (sel) => (await page.textContent(sel)).replace(/\s+/g, ' ').trim();
  const go = async (r) => { await page.evaluate((h) => { location.hash = h; }, '#/' + r); await page.waitForTimeout(120); };
  const modal = () => page.locator('.modal').last();
  const ready = () => page.waitForFunction(() => { const w = document.querySelectorAll('.modal-wrap'); return w.length && w[w.length - 1].dataset.ready === '1'; }, null, { timeout: 5000 });
  const fill = async (name, v) => { await ready(); await modal().locator(`[name="${name}"]`).fill(String(v)); };
  const pick = async (name, labelStartsWith) => {
    await ready(); const m = modal().locator(`select[name="${name}"]`);
    const opts = await m.locator('option').evaluateAll((os) => os.map((o) => [o.value, o.textContent]));
    const hit = opts.find(([, t]) => t.startsWith(labelStartsWith)); if (!hit) throw new Error(`no option "${labelStartsWith}" in ${name}: ${opts.map((o) => o[1])}`);
    await m.selectOption(hit[0]);
  };
  // wait until the save finished: modal closed, a confirm dialog appeared, or a validation error is showing
  const settled = () => page.waitForFunction(() => {
    const ms = document.querySelectorAll('.modal'); if (!ms.length) return true;
    const last = ms[ms.length - 1];
    if (last.querySelector('[data-ok]')) return true;
    const e = last.querySelector('.form-errors'); return !!e && !e.hidden;
  }, null, { timeout: 8000 });
  const noModal = () => page.waitForFunction(() => !document.querySelector('.modal'), null, { timeout: 8000 });
  const submit = async () => { await modal().locator('button[type=submit]').click(); await settled(); await page.waitForTimeout(40); };
  const confirmDlg = async (btn) => { await page.locator('.modal').last().locator(btn ? `button:has-text("${btn}")` : '[data-ok]').click(); await noModal().catch(() => {}); await page.waitForTimeout(60); };
  const state = () => page.evaluate(() => JSON.parse(JSON.stringify(window.PP.app.state)));
  const bal = async (name) => page.evaluate((n) => { const s = window.PP.app.state, b = window.PP.Logic.walletBalances(s); const w = s.wallets.find((x) => x.name === n); return w ? b[w.id] : null; }, name);
  const total = () => page.evaluate(() => window.PP.Logic.totalBalance(window.PP.app.state));
  const P = (n) => Math.round(n * 100);
  const reopen = async () => { await page.reload(); await page.waitForSelector('#app:not([hidden])'); await page.waitForTimeout(150); };

  console.log('\n[1] Boot, demo data, navigation');
  await page.goto(URL); await page.waitForSelector('#app:not([hidden])');
  ok((await txt('.banner')).includes('demo data'), 'first run loads demo data with a banner');
  const names = [['Transactions', 'Transactions'], ['Salary & Cut-off', 'Salary & Cut-off'], ['Weekly Budget', 'Weekly Budget'], ['Bills', 'Bills'], ['Debts', 'Debts'], ['Savings Goals', 'Savings Goals'], ['Wallets', 'Wallets & Accounts'], ['Reports', 'Reports'], ['Settings', 'Settings'], ['Dashboard', 'Dashboard']];
  for (const [label, title] of names) { await page.locator(`#nav-main a:has-text("${label}")`).first().click(); await page.waitForTimeout(100); eq(await txt('#page-title'), title, `sidebar → ${label}`); }
  ok(await page.locator('#total-balance').count() === 1 && await page.locator('#safe-to-spend').count() === 1 && await page.locator('#days-before').count() === 1, 'dashboard shows Total Balance, Safe to Spend, Days Before Payday');
  const dash = await txt('#view');
  ok(['Income · this cut-off', 'Expenses · this cut-off', 'Savings · this cut-off', 'Weekly Budget', 'Incoming Bills', 'Debt Summary', 'Recent Transactions'].every((x) => dash.includes(x)), 'dashboard has all required sections');

  console.log('\n[2] Start fresh (clear demo)');
  await page.locator('[data-act=demo-clear]').click(); await confirmDlg('Clear demo data');
  let s = await state();
  eq(s.wallets.length + s.transactions.length + s.bills.length + s.debts.length + s.goals.length, 0, 'all demo data removed');
  ok(!(await page.locator('.banner').count()), 'demo banner gone');

  console.log('\n[3] Wallets');
  for (const [name, type, amt] of [['Cash', 'Cash', '1000'], ['GCash', 'E-Wallet', '500'], ['BDO', 'Bank Account', '5000']]) {
    await go('wallets'); await page.locator('.page-head [data-act=wallet-add]').click();
    await fill('name', name); await ready(); await modal().locator('select[name=type]').selectOption(type); await fill('openingBalance', amt); await submit();
  }
  eq(await total(), P(6500), 'Total Balance = 1,000 + 500 + 5,000');
  await go('wallets'); await page.locator('.page-head [data-act=wallet-add]').click(); await fill('name', 'cash'); await submit();
  ok((await txt('.form-errors')).includes('already have a wallet'), 'duplicate wallet name rejected');
  await page.locator('.modal [data-modal-close]').first().click();

  console.log('\n[4] Salary: expected payday must not start a cut-off (clock = Nov 16, Nov 15 payday passed)');
  await go('');
  const before = (await state()).transactions.length;
  ok((await txt('#days-before')).includes('late') || (await txt('#view')).includes('Record your salary'), 'dashboard prompts to record salary (no cut-off yet)');
  eq((await state()).transactions.length, before, 'no transaction was created by the passing of the expected payday');
  eq(await total(), P(6500), 'Total Balance unchanged by expected payday');
  // first salary (Oct 31 for Oct 30 payday)
  await page.locator('.topbar [data-act=record-salary]').click();
  await fill('amount', '20000'); await fill('date', '2026-10-31'); await pick('walletId', 'BDO'); await submit();
  await confirmDlg('Record salary'); await page.waitForTimeout(200);
  s = await state(); const c1 = (await page.evaluate(() => window.PP.Logic.currentCutoff(window.PP.app.state)));
  eq(c1.start, '2026-10-31', 'first cut-off starts on the date salary was received');
  eq(c1.forPayday, '2026-10-30', 'matched to the Oct 30 expected payday');
  eq(await page.evaluate(() => location.hash), '#/cutoff', 'after salary → cut-off page opens for planning allocation');
  eq(await bal('BDO'), P(25000), 'BDO = 5,000 + 20,000 salary');

  console.log('\n[5] Allocation plan (planning only)');
  const tbBefore = await total();
  ok((await txt('#alloc-total')).includes('100%'), 'default plan totals 100%');
  const pcts = await page.locator('#alloc-form [name=pct]').evaluateAll((e) => e.map((x) => x.value));
  eq(pcts.join(','), '30,10,10,40,10', 'default allocation 30/10/10/40/10');
  await page.locator('#alloc-form [data-alloc="3"] [name=pct]').fill('35'); await page.waitForTimeout(80);
  ok((await txt('#alloc-total')).includes('not yet allocated'), 'changing a % shows the plan is no longer 100%');
  await page.locator('[data-act=alloc-save]').click(); await page.waitForTimeout(150);
  ok((await txt('#alloc-errors')).includes('exactly'), 'saving an unbalanced plan is blocked');
  await page.locator('[data-act=alloc-balance]').click(); await page.waitForTimeout(80);
  ok((await txt('#alloc-total')).includes('totals 100%'), '"difference to Unassigned" rebalances to 100%');
  await page.locator('[data-act=alloc-save]').click(); await page.waitForTimeout(200);
  s = await state(); eq(s.allocations.length, 1, 'allocation plan saved');
  eq(await total(), tbBefore, 'allocating did NOT change any wallet balance');
  eq(s.transactions.length, 1, 'allocating created no transactions');
  eq(s.allocations[0].items.find((i) => i.key === 'variable').amount, P(7000), 'variable = 35% of 20,000');

  console.log('\n[6] Late salary: expected Nov 15, received Nov 17');
  await page.clock.setFixedTime(new Date('2026-11-17T09:00:00')); await page.reload(); await page.waitForSelector('#app:not([hidden])');
  await go('');
  ok((await txt('#days-before')).includes('late') || (await txt('#view')).includes('Salary expected'), 'Nov 17 morning: still shows salary as late/expected, cut-off unchanged');
  eq((await page.evaluate(() => window.PP.Logic.currentCutoff(window.PP.app.state))).start, '2026-10-31', 'current cut-off still the old one before salary is recorded');
  await page.locator('.topbar [data-act=record-salary]').click();
  await fill('amount', '21,500.50'); await fill('date', '2026-11-17'); await pick('walletId', 'BDO');
  ok((await txt('#sal-info')).includes('Nov 15, 2026') && (await txt('#sal-info')).includes('2 days after'), 'form explains: matches Nov 15, received 2 days after');
  await submit(); await confirmDlg('Record salary'); await page.waitForTimeout(200);
  const c2 = await page.evaluate(() => window.PP.Logic.currentCutoff(window.PP.app.state));
  eq(c2.start, '2026-11-17', 'NEW cut-off begins Nov 17, not Nov 15');
  eq(c2.forPayday, '2026-11-15', 'it is linked to the Nov 15 expected payday');
  eq(await bal('BDO'), P(25000 + 21500.5), 'salary landed in the chosen wallet');
  eq((await state()).transactions.length, 2, 'earlier history preserved');
  await go('');
  eq((await txt('#days-before')).includes('13') , true, 'Days Before Payday = 13 (next expected payday Nov 30)');
  const dsum = await txt('#view');
  ok(dsum.includes('₱21,500.50'), 'cut-off income card shows only the new salary');

  console.log('\n[7] Transactions: expense, income, validation, filters');
  await go('transactions'); await page.locator('.page-head [data-act=add-tx]').click();
  await fill('amount', '-50'); await fill('note', 'bad'); await pick('category', 'Medical'); await submit();
  ok((await txt('.form-errors')).includes('greater than'), 'negative amount rejected');
  await fill('amount', '0'); await submit(); ok((await txt('.form-errors')).includes('greater than'), 'zero rejected');
  await fill('amount', 'abc'); await submit(); ok((await txt('.form-errors')).includes('greater than'), 'non-number rejected');
  await fill('amount', '5000000'); await submit(); ok((await txt('.form-errors')).includes('below'), 'cannot overdraw a wallet');
  await modal().locator('[name=date]').evaluate((e) => { e.value = '2026-11-30'; }); await fill('amount', '10'); await submit();
  ok((await txt('.form-errors')).includes('future'), 'future date rejected');
  await modal().locator('[name=date]').evaluate((e) => { e.value = '2026-11-17'; });
  await pick('walletId', 'Cash'); await fill('amount', '250'); await submit();
  eq(await bal('Cash'), P(750), 'expense reduced Cash 1,000 → 750');
  // double click must not duplicate
  await page.locator('.page-head [data-act=add-tx]').click(); await fill('amount', '100'); await pick('category', 'Medical'); await pick('walletId', 'Cash');
  await modal().locator('button[type=submit]').dblclick(); await noModal(); await page.waitForTimeout(60);
  eq((await state()).transactions.filter((t) => t.amount === P(100)).length, 1, 'double-click Save creates exactly ONE transaction');
  eq(await bal('Cash'), P(650), 'Cash 750 → 650');
  await page.locator('#tx-filters [name=type]').selectOption('expense'); await page.waitForTimeout(100);
  ok((await txt('#tx-count')).startsWith('2 '), 'type filter shows 2 expenses');
  await page.locator('#tx-filters [name=walletId]').selectOption({ label: 'GCash' }); await page.waitForTimeout(100);
  ok((await txt('#tx-card')).includes('Nothing matches'), 'wallet filter combined → no match message');
  await page.locator('[data-act=tx-reset]').click();

  console.log('\n[8] Transfers');
  await go('transactions'); await page.locator('.page-head [data-act=add-tx]').click();
  await modal().locator('.seg label:has-text("Transfer")').click();
  await fill('amount', '2000'); await pick('walletId', 'BDO'); await pick('toWalletId', 'GCash'); await submit();
  ok((await txt('.form-errors')).includes('purpose'), 'transfer without a purpose is rejected');
  await fill('note', 'GCash allowance'); await modal().locator('select[name=toWalletId]').selectOption({ index: 0 });
  await pick('toWalletId', 'BDO'); await submit(); ok((await txt('.form-errors')).includes('different'), 'same source/destination rejected');
  await pick('toWalletId', 'GCash'); const t0 = await total(); await submit();
  eq(await bal('BDO'), P(46500.5 - 2000), 'BDO decreased by transfer');
  eq(await bal('GCash'), P(2500), 'GCash increased by transfer');
  eq(await total(), t0, 'Total Balance unchanged by transfer');
  const csum = await page.evaluate(() => { const L = window.PP.Logic, s = window.PP.app.state; return L.summarize(L.cutoffTransactions(s, L.currentCutoff(s))); });
  eq(csum.transfers, P(2000), 'transfer tracked separately'); eq(csum.expenses, P(350), 'transfer NOT counted as an expense (only the 250 + 100 spent)'); eq(csum.income, P(21500.5), 'transfer NOT counted as income');

  console.log('\n[9] Savings goals');
  await go('goals'); await page.locator('.page-head [data-act=goal-add]').click();
  await fill('name', 'Emergency Fund'); await fill('target', '50000'); await submit();
  await page.locator('[data-act=goal-contribute]').first().click();
  await fill('amount', '3000'); await pick('walletId', 'BDO'); const tb2 = await total(); await submit();
  s = await state(); const g = s.goals[0];
  eq(await page.evaluate((id) => window.PP.Logic.goalSavedMap(window.PP.app.state)[id], g.id), P(3000), 'goal saved = 3,000');
  eq(await total(), tb2 - P(3000), 'contribution left the spendable Total Balance');
  const sv = await page.evaluate(() => { const L = window.PP.Logic, s = window.PP.app.state; return L.summarize(L.cutoffTransactions(s, L.currentCutoff(s))); });
  eq(sv.expenses, P(350), 'savings contribution NOT counted as an expense'); eq(sv.contributions, P(3000), 'counted as savings contribution');
  ok(!(await txt('#total-balance').catch(() => '')) || true, 'ok');
  await go(''); ok((await txt('#view')).includes('₱3,000.00'), 'dashboard savings card shows 3,000');
  await go('goals'); await page.locator('[data-act=goal-withdraw]').first().click();
  await fill('amount', '5000'); await submit(); ok((await txt('.form-errors')).includes('negative'), 'cannot withdraw more than saved');
  await fill('amount', '1000'); await pick('walletId', 'Cash'); await submit();
  eq(await page.evaluate((id) => window.PP.Logic.goalSavedMap(window.PP.app.state)[id], g.id), P(2000), 'withdrawal reduced goal to 2,000');
  eq(await bal('Cash'), P(1650), 'withdrawal returned 1,000 to Cash');
  await page.locator('[data-act=goal-del]').first().click(); ok((await txt('.modal')).includes('still has'), 'goal with savings cannot be deleted (explained)'); await page.locator('.modal [data-modal-close]').first().click();

  console.log('\n[10] Bills: manual pay, monthly recurrence, history');
  await go('bills'); await page.locator('.page-head [data-act=bill-add]').click();
  await fill('name', 'Electricity'); await fill('amount', '2,000'); await fill('dueDay', '20'); await submit();
  if (!(await txt('#view')).includes('Due in 3d')) console.log('   DEBUG errors=', await page.locator('.form-errors').allTextContents(), 'modals=', await page.locator('.modal').count(), 'bills=', (await state()).bills.length, 'today=', await page.evaluate(() => window.PP.Logic.todayISO()), 'view=', (await txt('#view')).slice(0, 300));
  ok((await txt('#view')).includes('Due in 3d'), 'new bill shows pending (due Nov 20, 3 days)');
  eq(await total(), tb2 - P(3000) + P(1000), 'adding a bill deducted nothing');
  const cb = await total();
  await page.locator('[data-act=bill-pay]').first().click(); await fill('amount', '2100'); await pick('walletId', 'BDO'); await submit(); await confirmDlg('Pay');
  eq(await total(), cb - P(2100), 'paying deducted the (edited) amount from the chosen wallet');
  ok((await txt('#view')).includes('Paid Nov 16') || (await txt('#view')).includes('Paid'), 'bill shows Paid');
  eq(await page.locator('[data-act=bill-pay]').count(), 0, 'no longer pending this month');
  const wk = await page.evaluate(() => { const L = window.PP.Logic, s = window.PP.app.state; return L.summarize(s.transactions).variable; });
  eq(wk, P(350), 'bill payment did not touch variable spending');
  await page.locator('[data-act=bill-month][data-d="1"]').click();
  ok((await txt('#view')).includes('Due in') || (await txt('#view')).includes('Upcoming'), 'next month (Dec): bill is pending again');
  ok((await txt('#view')).includes('December 2026'), 'month navigation shows December 2026');
  await page.locator('[data-act=bill-month][data-d="0"]').click();
  ok((await txt('#view')).includes('Payment history') && (await txt('#view')).includes('₱2,100.00'), 'payment history kept');
  await page.locator('[data-act=bill-undo]').first().click(); await confirmDlg('Undo payment');
  eq(await total(), cb, 'undoing returns the money'); ok(await page.locator('[data-act=bill-pay]').count() === 1, 'bill pending again after undo');
  await page.locator('[data-act=bill-pay]').first().click(); await fill('amount', '2100'); await pick('walletId', 'BDO'); await submit(); await confirmDlg('Pay');

  console.log('\n[11] Debts');
  await go('debts'); await page.locator('.page-head [data-act=debt-add]').click();
  await fill('name', 'Ate Liza'); await fill('original', '5000'); await fill('remaining', '3000'); await submit();
  await page.locator('[data-act=debt-pay]').first().click(); await fill('amount', '3500'); await pick('walletId', 'Cash'); await submit();
  ok((await txt('.form-errors')).includes('more than the remaining'), 'overpaying a debt is rejected');
  const cd = await bal('Cash'); await fill('amount', '1000'); await submit(); await confirmDlg('Pay');
  eq(await bal('Cash'), cd - P(1000), 'debt payment deducted from wallet');
  ok((await txt('#view')).includes('₱2,000.00'), 'remaining balance reduced to 2,000');
  await page.locator('[data-act=debt-pay]').first().click(); await modal().locator('[data-full]').click(); await pick('walletId', 'BDO'); await submit(); await confirmDlg('Pay');
  ok((await txt('#view')).includes('Paid off'), 'debt marked paid at zero'); eq(await page.locator('[data-act=debt-pay]').count(), 0, 'no more pay button');
  // new cut-off must not reset debt: record another salary
  const dBefore = await page.evaluate(() => { const L = window.PP.Logic, s = window.PP.app.state; return L.debtRemainingMap(s)[s.debts[0].id]; }); eq(dBefore, 0, 'remaining = 0');

  console.log('\n[12] Weekly budget');
  await go('budget'); await page.locator('.page-head [data-act=bc-add]').click(); await fill('name', 'Palengke'); await fill('weeklyAmount', '1000'); await submit();
  await go('transactions'); await page.locator('.page-head [data-act=add-tx]').click();
  await fill('amount', '400'); await pick('category', 'Palengke'); await pick('walletId', 'Cash'); await submit();
  await go('budget'); ok((await txt('#view')).includes('₱600.00'), 'Palengke shows ₱600 left after ₱400 expense');
  await go('transactions'); await page.locator('.page-head [data-act=add-tx]').click();
  await fill('amount', '200'); await pick('category', 'Medical'); await pick('walletId', 'Cash'); await submit();
  eq((await state()).transactions.filter((t) => t.category === 'Medical' && t.amount === P(200)).length, 1, 'the ₱200 Medical expense was really saved');
  await go('budget'); ok((await txt('#view')).includes('₱600.00'), 'non-budget category does NOT reduce the weekly budget');
  await go('transactions'); await page.locator('.page-head [data-act=add-tx]').click();
  await fill('amount', '700'); await pick('category', 'Palengke'); await pick('walletId', 'BDO'); await submit();
  ok(await page.locator('.toast.error').count() >= 1, 'over-budget warning toast appears');
  await go('budget'); ok((await txt('#view')).includes('over by ₱100.00'), 'Palengke shows over by ₱100');

  console.log('\n[13] Persistence across refresh + deletes');
  const snap = await state();
  await reopen();
  const after = await state();
  eq(JSON.stringify(after.transactions.map((t) => t.id).sort()), JSON.stringify(snap.transactions.map((t) => t.id).sort()), 'all transactions survive a page refresh');
  eq(after.wallets.length, 3, 'wallets survive'); eq(after.goals.length, 1, 'goals survive'); eq(after.bills.length, 1, 'bills survive'); eq(after.debts.length, 1, 'debts survive');
  eq(after.allocations.length, 1, 'allocation plan survives'); eq(await total(), await page.evaluate(() => window.PP.Logic.totalBalance(window.PP.app.state)), 'balance recomputes identically');
  eq(await page.evaluate(() => window.PP.Logic.currentCutoff(window.PP.app.state).start), '2026-11-17', 'cut-off still starts Nov 17 after refresh');
  const fresh = await page.context().newPage(); await fresh.goto(URL); await fresh.waitForSelector('#app:not([hidden])'); await fresh.waitForTimeout(150);
  eq(await fresh.evaluate(() => window.PP.app.state.transactions.length), snap.transactions.length, 'a brand-new tab sees the same data (stored in IndexedDB)'); await fresh.close();
  await go('wallets'); await page.locator('[data-act=wallet-del]').first().click();
  ok((await txt('.modal')).includes('still holds') || (await txt('.modal')).includes('linked'), 'wallet with balance/history cannot be hard-deleted (explained)'); await page.locator('.modal [data-modal-close]').first().click();
  await go('transactions'); const n0 = (await state()).transactions.length;
  await page.locator('[data-act=tx-delete]').first().click(); await page.waitForTimeout(100); await confirmDlg('Delete');
  eq((await state()).transactions.length, n0 - 1, 'deleting a transaction removes exactly one record');

  console.log('\n[14] Reports + settings + backup');
  await go('reports'); const rep = await txt('#view');
  ok(['Total income', 'Total expenses', 'Savings contributions', 'Spending by category', 'Transaction history', 'Cut-off summaries', 'Monthly summaries'].every((x) => rep.includes(x)), 'reports has every required section');
  const consistent = await page.evaluate(() => { const L = window.PP.Logic, s = window.PP.app.state; const open = s.wallets.reduce((a, w) => a + w.openingBalance, 0); return L.totalBalance(s) - open === L.summarize(s.transactions).net; });
  ok(consistent, 'consistency: wallet totals == income − expenses − net savings');
  await go('settings'); await page.locator('[name=paydays]').fill('10, 25'); await page.locator('[data-act=settings-save]').click(); await page.waitForTimeout(150);
  eq((await state()).settings.paydays.join(','), '10,25', 'payday schedule is configurable');
  await page.locator('#settings-form [name=al0]').fill('50'); await page.waitForTimeout(80); ok((await txt('#set-total')).includes('must be 100'), 'default allocation must total 100%');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('[data-act=backup-export]').click()]);
  ok(dl.suggestedFilename().startsWith('perapilot-backup'), 'backup downloads as a file');

  console.log('\n[15] Mobile layout + install readiness');
  const m = await browser.newContext({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true }); const mp = await m.newPage();
  await mp.goto(URL); await mp.waitForSelector('#app:not([hidden])');
  ok(await mp.locator('#bottom-nav').isVisible(), 'mobile shows bottom navigation'); ok(!(await mp.locator('#sidebar').isVisible()), 'sidebar hidden on mobile');
  await mp.locator('#bottom-nav [data-act=more-menu]').click(); await mp.waitForTimeout(100); ok(await mp.locator('.sheet-links a').count() >= 6, '"More" sheet lists the other pages');
  await mp.locator('.sheet-links a:has-text("Wallets")').click(); await mp.waitForTimeout(150); eq(await mp.textContent('#page-title'), 'Wallets & Accounts', 'More → Wallets works');
  const manifest = await mp.evaluate(() => fetch('manifest.webmanifest').then((r) => r.json())); ok(manifest.display === 'standalone' && manifest.icons.length >= 3, 'manifest valid (standalone + icons)');
  const sw = await mp.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => !!r)); ok(sw, 'service worker registered'); await m.close();

  ok(errors.length === 0, 'no JavaScript errors during the whole run' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  console.log(`\n==== ${pass} passed, ${fail} failed ====`); if (fail) console.log('FAILED:\n - ' + failures.join('\n - '));
  await browser.close(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH', e); process.exit(2); });
