/*
 * PeraPilot — realistic demo data.
 * Built relative to "today" so the demo always has a live cut-off, upcoming bills,
 * past cut-offs, transfers, savings, debts and week closings to test with.
 * Everything is generated through the same Logic functions the real app uses.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./logic.js'));
  else { root.PP = root.PP || {}; root.PP.Demo = factory(root.PP.Logic); }
})(typeof self !== 'undefined' ? self : this, function (L) {
  'use strict';
  const T = L.TX;
  const php = (n) => Math.round(n * 100);

  function rng(seed) { // small deterministic PRNG so the demo is stable
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function buildDemoState(today) {
    const rand = rng(20261101);
    const between = (lo, hi, step) => { const s = step || 5; return Math.round((lo + rand() * (hi - lo)) / s) * s; };
    let seq = 0;
    let stamp = Date.parse('2026-01-01T00:00:00Z');
    const nextStamp = () => new Date(stamp += 1000).toISOString();
    const st = L.emptyState();
    st.settings = Object.assign(L.defaultSettings(), { demo: true });

    /* wallets (opening balances are topped up at the end so nothing goes negative) */
    const W = {};
    [['Cash', 'Cash', 500], ['GCash', 'E-Wallet', 800], ['Maya', 'E-Wallet', 250], ['BDO Payroll', 'Bank Account', 3000]].forEach(([name, type, open]) => {
      const w = { id: L.uid(), name, type, openingBalance: php(open), createdAt: nextStamp() };
      st.wallets.push(w); W[name] = w;
    });

    /* cut-offs: newest first. Salary is sometimes late — that's the whole point. */
    const p0 = L.scheduledDates(st.settings, L.addDays(today, -40), today).pop(); // most recent scheduled payday
    const paydays = [p0];
    for (let i = 0; i < 3; i++) {
      const prev = L.scheduledDates(st.settings, L.addDays(paydays[paydays.length - 1], -20), L.addDays(paydays[paydays.length - 1], -1)).pop();
      paydays.push(prev);
    }
    const late = [Math.min(1, Math.max(0, L.diffDays(p0, today))), 2, 0, 1];
    const amounts = [php(22450), php(21980.5), php(23100), php(22450)];
    const plan = paydays.map((p, i) => ({ payday: p, start: L.addDays(p, late[i]), amount: amounts[i] })).reverse(); // oldest first
    plan.forEach((c, i) => { c.end = plan[i + 1] ? plan[i + 1].start : null; });
    const firstStart = plan[0].start;

    /* budget categories (weekly) */
    const created = L.addDays(firstStart, -1);
    [['Palengke', 1000], ['Grocery', 700], ['LPG', 250], ['Baon', 700], ['Food', 600], ['Transportation', 800], ['Other essentials', 450]].forEach(([name, amt], i) => {
      st.budgetCategories.push({ id: L.uid(), name, weeklyAmount: php(amt), createdOn: created, order: i });
    });
    const BC = {}; st.budgetCategories.forEach((c) => { BC[c.name] = c; });

    /* goals */
    const G = {};
    [['Emergency Fund', 100000, '', 18000], ['New Phone', 25000, L.addDays(today, 120), 0], ['Travel — Baguio', 15000, L.addDays(today, 200), 0]].forEach(([name, target, date, saved]) => {
      const g = { id: L.uid(), name, target: php(target), targetDate: date, openingSaved: php(saved), createdAt: nextStamp() };
      st.goals.push(g); G[name] = g;
    });

    /* bills (monthly) */
    const B = {};
    [['Rent', 6500, 5, 'Rent'], ['Electricity (Meralco)', 2150, 20, 'Utilities'], ['Water', 380, 18, 'Utilities'], ['Internet (PLDT)', 1699, 25, 'Internet'], ['Phone Plan', 599, 12, 'Utilities'], ['Netflix', 369, 8, 'Subscriptions']].forEach(([name, amount, dueDay, category]) => {
      const b = { id: L.uid(), name, amount: php(amount), dueDay, category, startMonth: L.monthKey(firstStart), createdAt: nextStamp() };
      st.bills.push(b); B[name] = b;
    });

    /* debts */
    const D = {};
    [['Ate Liza (personal loan)', 5000, 3500, L.addDays(today, 21), 'Bayad kada sweldo, walang interest.'],
     ['GCash GLoan', 8000, 6000, L.addDays(today, 5), 'Monthly due — huwag malate.'],
     ['SM Appliance Installment', 18000, 12000, '', '12 months to pay, 0% interest.']].forEach(([name, original, remaining, dueDate, notes]) => {
      const d = { id: L.uid(), name, originalAmount: php(original), openingRemaining: php(remaining), dueDate, notes, createdAt: nextStamp() };
      st.debts.push(d); D[name] = d;
    });

    /* transactions */
    const add = (type, date, walletName, amount, extra) => {
      if (date > today) return null;
      const tx = Object.assign({ id: L.uid(), type, amount, date, walletId: W[walletName].id, note: '', createdAt: new Date(Date.parse(date + 'T06:00:00Z') + (seq++) * 1000).toISOString(), updatedAt: '' }, extra);
      st.transactions.push(tx); return tx;
    };

    plan.forEach((c, ci) => {
      const lastDay = c.end ? L.diffDays(c.start, c.end) - 1 : L.diffDays(c.start, today);
      const d = (n) => L.addDays(c.start, n);
      const sal = add(T.INCOME, c.start, 'BDO Payroll', c.amount, { isSalary: true, category: 'Salary', forPayday: c.payday, note: 'Salary received' });
      c.salaryId = sal.id;
      add(T.TRANSFER, d(0), 'BDO Payroll', php(3000), { toWalletId: W['Cash'].id, category: 'Transfer', note: 'Cash for palengke at baon' });
      add(T.TRANSFER, d(0), 'BDO Payroll', php(4500), { toWalletId: W['GCash'].id, category: 'Transfer', note: 'GCash allowance for the cut-off' });
      if (ci % 2 === 0) add(T.TRANSFER, d(1), 'BDO Payroll', php(1000), { toWalletId: W['Maya'].id, category: 'Transfer', note: 'Maya for online orders' });
      add(T.EXPENSE, d(1), 'BDO Payroll', Math.round(c.amount * 0.1 / 100) * 100, { category: L.TITHES, note: 'Tithes — Sunday service' });

      for (let n = 0; n <= lastDay; n++) {
        const wd = n % 7;
        if (wd === 0) add(T.EXPENSE, d(n), 'Cash', php(between(700, 950)), { budgetCategoryId: BC['Palengke'].id, category: 'Palengke', note: 'Palengke — gulay, isda, karne' });
        if (wd === 2) add(T.EXPENSE, d(n), 'GCash', php(between(400, 640)), { budgetCategoryId: BC['Grocery'].id, category: 'Grocery', note: 'Grocery — bigas, sabon, toiletries' });
        if (wd !== 6) add(T.EXPENSE, d(n), 'GCash', php(between(60, 130)), { budgetCategoryId: BC['Transportation'].id, category: 'Transportation', note: 'Jeep / MRT / tricycle' });
        if (wd === 1 || wd === 3 || wd === 5) add(T.EXPENSE, d(n), 'Cash', php(between(150, 230)), { budgetCategoryId: BC['Baon'].id, category: 'Baon', note: 'Baon at pamasahe ni bunso' });
        if (wd === 2 || wd === 5) add(T.EXPENSE, d(n), wd === 2 ? 'Maya' : 'GCash', php(between(180, 320)), { budgetCategoryId: BC['Food'].id, category: 'Food', note: 'Kain sa labas / delivery' });
        if (wd === 4) add(T.EXPENSE, d(n), 'Cash', php(between(80, 160)), { budgetCategoryId: BC['Other essentials'].id, category: 'Other essentials', note: 'Load, suka, toyo, etc.' });
      }
      if (c.end && lastDay >= 9) add(T.EXPENSE, d(9), 'Cash', php(850), { budgetCategoryId: BC['LPG'].id, category: 'LPG', note: 'LPG refill 11kg' });
      if (c.end && ci === 1) add(T.EXPENSE, d(6), 'GCash', php(350), { category: 'Medical', note: 'Gamot — ubo at sipon' });
      if (c.end && ci === 2) add(T.EXPENSE, d(8), 'Maya', php(250), { category: 'Personal Care', note: 'Gupit' });
      if (c.end && ci === 2) add(T.INCOME, d(5), 'GCash', php(1500), { category: 'Side Income', note: 'Freelance — poster design' });

      /* savings, debts, goal withdrawal */
      add(T.SAVINGS, d(2), 'BDO Payroll', php(2000), { goalId: G['Emergency Fund'].id, category: 'Emergency Fund', note: 'Emergency fund contribution' });
      add(T.SAVINGS, d(2), 'BDO Payroll', php(1500), { goalId: G['New Phone'].id, category: 'New Phone', note: 'Ipon para sa phone' });
      if (ci % 2 === 1) add(T.SAVINGS, d(3), 'BDO Payroll', php(500), { goalId: G['Travel — Baguio'].id, category: 'Travel — Baguio', note: 'Baguio trip fund' });
      if (ci === 1) add(T.WITHDRAW, d(7), 'Cash', php(500), { goalId: G['Emergency Fund'].id, category: 'Emergency Fund', note: 'Emergency: gamot at laboratory' });
      if (ci >= 1) add(T.DEBT, d(3), 'BDO Payroll', php(500), { debtId: D['Ate Liza (personal loan)'].id, category: 'Debt payments', note: 'Payment — Ate Liza' });
      if (ci >= 1) add(T.DEBT, d(4), 'GCash', php(1000), { debtId: D['GCash GLoan'].id, category: 'Debt payments', note: 'GLoan payment' });
      if (ci >= 2) add(T.DEBT, d(4), 'BDO Payroll', php(1500), { debtId: D['SM Appliance Installment'].id, category: 'Debt payments', note: 'SM installment' });
    });

    /* bill payments: paid on their due date, only months from the first cut-off up to now */
    for (let key = L.monthKey(firstStart); key <= L.monthKey(today); key = L.addMonths(key, 1)) {
      st.bills.forEach((b) => {
        const due = L.dateInMonth(key, b.dueDay);
        if (due < firstStart || due > today) return;
        const wallet = b.name === 'Rent' ? 'BDO Payroll' : b.name === 'Netflix' ? 'Maya' : 'GCash';
        add(T.BILL, due, wallet, b.amount, { billId: b.id, billMonth: key, category: b.category, note: `${b.name} — ${L.formatMonth(key)}` });
      });
    }

    /* top up opening balances so every wallet ends at a realistic positive amount */
    const floors = { 'Cash': php(900), 'GCash': php(1250), 'Maya': php(420), 'BDO Payroll': php(6200) };
    const bal = L.walletBalances(st);
    st.wallets.forEach((w) => { if (bal[w.id] < floors[w.name]) w.openingBalance += floors[w.name] - bal[w.id]; });

    /* planned allocations for each cut-off */
    plan.forEach((c) => {
      st.allocations.push({ id: L.uid(), cutoffId: c.salaryId, items: L.defaultAllocationItems(c.amount, st.settings).map((i) => ({ key: i.key, label: i.label, pct: i.pct, amount: i.amount })), updatedAt: new Date().toISOString() });
    });

    /* close a few finished weeks the way a user would (through the real logic) */
    let cur = st;
    const apply = (r) => { if (r.ok) cur = L.applyOps(cur, r.ops); return r.ok; };
    const cuts = L.getCutoffs(cur);
    cuts.slice(0, -1).forEach((cut, i) => {
      const wk1 = L.weeklyBudget(cur, cut, 1, today);
      if (wk1.canClose && i % 2 === 0) {
        apply(L.closeWeekOps(cur, { cutoffId: cut.id, weekIdx: 1, toNext: Math.floor(wk1.remaining / 2 / 100) * 100, toSavings: 0, date: L.addDays(wk1.end, 1) }, today));
      }
      const wk2 = L.weeklyBudget(cur, cut, 2, today);
      if (wk2.canClose && i % 2 === 0) {
        const part = Math.floor(wk2.remaining / 2 / 100) * 100;
        apply(L.closeWeekOps(cur, { cutoffId: cut.id, weekIdx: 2, toSavings: part, toNext: 0, goalId: G['Travel — Baguio'].id, walletId: W['GCash'].id, date: L.addDays(wk2.end, 1) }, today));
      }
    });
    return cur;
  }

  return { buildDemoState };
});
