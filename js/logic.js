/*
 * PeraPilot — financial logic (no DOM, no storage).
 *
 * Design rules:
 *  - All money is stored as integer CENTAVOS (₱1.00 = 100). No floating-point drift.
 *  - Transactions are the single source of truth. Wallet balances, goal saved
 *    amounts and debt balances are DERIVED from them, never stored, so editing or
 *    deleting a transaction can never leave duplicate or stale numbers behind.
 *  - A cut-off begins ONLY at a salary transaction that was actually recorded.
 *    Cut-offs are derived from those salary transactions (cut-off id = salary tx id).
 *  - Every mutation is a pure function returning {ok, errors, ops}. `ops` are applied
 *    with applyOps() (in memory) and persisted atomically by db.js.
 *  - Works in the browser (window.PP.Logic) and in Node (module.exports) for tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.PP = root.PP || {}; root.PP.Logic = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Constants                                                          */
  /* ------------------------------------------------------------------ */
  const TX = {
    INCOME: 'income', EXPENSE: 'expense', SAVINGS: 'savings', TRANSFER: 'transfer',
    BILL: 'bill_payment', DEBT: 'debt_payment', WITHDRAW: 'goal_withdrawal'
  };
  const TX_LABEL = {
    income: 'Income', expense: 'Expense', savings: 'Savings', transfer: 'Transfer',
    bill_payment: 'Bill payment', debt_payment: 'Debt payment', goal_withdrawal: 'Goal withdrawal'
  };
  const TITHES = 'Offering / Tithes';
  const OTHER_EXPENSE_CATEGORIES = [TITHES, 'Medical', 'Education', 'Personal Care', 'Subscriptions', 'Entertainment', 'Gifts', 'Other'];
  const INCOME_CATEGORIES = ['Bonus', 'Side Income', 'Allowance', 'Refund', 'Gift', 'Other'];
  const WALLET_TYPES = ['Cash', 'E-Wallet', 'Bank Account', 'Other'];
  const BILL_CATEGORIES = ['Rent', 'Utilities', 'Internet', 'Insurance', 'Subscriptions', 'Loan / Installment', 'Other'];
  const DEFAULT_ALLOCATION = [
    { key: 'fixed', label: 'Fixed Expenses', pct: 30 },
    { key: 'goals', label: 'Goal Funds', pct: 10 },
    { key: 'offering', label: TITHES, pct: 10 },
    { key: 'variable', label: 'Variable Expenses', pct: 40 },
    { key: 'unassigned', label: 'Unallocated / Unassigned', pct: 10 }
  ];
  const MAX_CENTS = 1000000000 * 100; // ₱1B sanity cap
  const WEEK_DAYS = 7;

  /* ------------------------------------------------------------------ */
  /* Money                                                              */
  /* ------------------------------------------------------------------ */
  /** Parse user input ("1,234.50", "₱500") to integer centavos. Returns NaN if invalid. */
  function toCents(input) {
    if (typeof input === 'number') {
      if (!isFinite(input)) return NaN;
      return Math.round(input * 100);
    }
    if (typeof input !== 'string') return NaN;
    const s = input.replace(/[₱,\s]/g, '').replace(/^PHP/i, '');
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
    const [p, c = ''] = s.split('.');
    return parseInt(p, 10) * 100 + parseInt((c + '00').slice(0, 2), 10);
  }
  function fromCents(c) { return c / 100; }
  /** Plain "1234.50" string for form inputs. */
  function centsToInput(c) { return (c / 100).toFixed(2); }
  const pesoFmt = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' });
  function formatPeso(c) { return pesoFmt.format((c || 0) / 100); }
  function sum(list, fn) { let t = 0; for (const x of list) t += fn ? fn(x) : x; return t; }

  /* ------------------------------------------------------------------ */
  /* Dates (all dates are 'YYYY-MM-DD' strings; arithmetic done in UTC)  */
  /* ------------------------------------------------------------------ */
  const pad = (n) => String(n).padStart(2, '0');
  function dateNum(iso) { return Math.round(Date.parse(iso + 'T00:00:00Z') / 86400000); }
  function fromNum(n) { return new Date(n * 86400000).toISOString().slice(0, 10); }
  function isISO(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const t = Date.parse(s + 'T00:00:00Z');
    return !isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
  }
  function addDays(iso, n) { return fromNum(dateNum(iso) + n); }
  function diffDays(a, b) { return dateNum(b) - dateNum(a); } // b - a
  function monthKey(iso) { return iso.slice(0, 7); }
  function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
  function addMonths(key, n) {
    let [y, m] = key.split('-').map(Number);
    m += n; y += Math.floor((m - 1) / 12); m = (((m - 1) % 12) + 12) % 12 + 1;
    return y + '-' + pad(m);
  }
  function dateInMonth(key, day) {
    const [y, m] = key.split('-').map(Number);
    return key + '-' + pad(Math.min(day, daysInMonth(y, m)));
  }
  function monthEnd(key) { return dateInMonth(key, 31); }
  function todayISO(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  const dateFmt = new Intl.DateTimeFormat('en-PH', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const dateShortFmt = new Intl.DateTimeFormat('en-PH', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const monthFmt = new Intl.DateTimeFormat('en-PH', { year: 'numeric', month: 'long', timeZone: 'UTC' });
  const weekdayFmt = new Intl.DateTimeFormat('en-PH', { weekday: 'short', timeZone: 'UTC' });
  function formatDate(iso) { return iso ? dateFmt.format(new Date(iso + 'T00:00:00Z')) : '—'; }
  function formatDateShort(iso) { return iso ? dateShortFmt.format(new Date(iso + 'T00:00:00Z')) : '—'; }
  function formatMonth(key) { return monthFmt.format(new Date(key + '-01T00:00:00Z')); }
  function formatWeekday(iso) { return weekdayFmt.format(new Date(iso + 'T00:00:00Z')); }

  let _seq = 0;
  function uid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + (++_seq).toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }
  function nowStamp() { return new Date().toISOString(); }

  /* ------------------------------------------------------------------ */
  /* State                                                              */
  /* ------------------------------------------------------------------ */
  function defaultSettings() {
    return { id: 'settings', paydays: [15, 30], allocation: DEFAULT_ALLOCATION.map((x) => ({ ...x })), demo: false };
  }
  function emptyState() {
    return {
      settings: defaultSettings(), wallets: [], transactions: [], goals: [], bills: [], debts: [],
      budgetCategories: [], allocations: [], weekClosures: []
    };
  }
  const COLLECTIONS = ['wallets', 'transactions', 'goals', 'bills', 'debts', 'budgetCategories', 'allocations', 'weekClosures'];

  /** Apply persistence ops to a state, returning a NEW state (input is not mutated). */
  function applyOps(state, ops) {
    const next = Object.assign({}, state);
    const cloned = {};
    for (const op of ops) {
      if (op.store === 'meta') {
        if (op.op === 'put' && op.value && op.value.id === 'settings') next.settings = op.value;
        continue;
      }
      if (!cloned[op.store]) { next[op.store] = state[op.store].slice(); cloned[op.store] = true; }
      const arr = next[op.store];
      const id = op.op === 'delete' ? op.id : op.value.id;
      const i = arr.findIndex((x) => x.id === id);
      if (op.op === 'put') { if (i >= 0) arr[i] = op.value; else arr.push(op.value); }
      else if (i >= 0) arr.splice(i, 1);
    }
    return next;
  }
  const put = (store, value) => ({ store, op: 'put', value });
  const del = (store, id) => ({ store, op: 'delete', id });
  const fail = (...errors) => ({ ok: false, errors: errors.flat(), ops: [] });

  /* ------------------------------------------------------------------ */
  /* Derived balances                                                   */
  /* ------------------------------------------------------------------ */
  function walletBalances(state) {
    const b = {};
    const add = (id, d) => { if (id) b[id] = (b[id] || 0) + d; };
    state.wallets.forEach((w) => { b[w.id] = w.openingBalance || 0; });
    for (const t of state.transactions) {
      switch (t.type) {
        case TX.INCOME: case TX.WITHDRAW: add(t.walletId, t.amount); break;
        case TX.EXPENSE: case TX.SAVINGS: case TX.BILL: case TX.DEBT: add(t.walletId, -t.amount); break;
        case TX.TRANSFER: add(t.walletId, -t.amount); add(t.toWalletId, t.amount); break;
      }
    }
    return b;
  }
  function goalSavedMap(state) {
    const m = {};
    state.goals.forEach((g) => { m[g.id] = g.openingSaved || 0; });
    for (const t of state.transactions) {
      if (t.type === TX.SAVINGS && t.goalId) m[t.goalId] = (m[t.goalId] || 0) + t.amount;
      else if (t.type === TX.WITHDRAW && t.goalId) m[t.goalId] = (m[t.goalId] || 0) - t.amount;
    }
    return m;
  }
  function debtRemainingMap(state) {
    const m = {};
    state.debts.forEach((d) => { m[d.id] = d.openingRemaining; });
    for (const t of state.transactions) {
      if (t.type === TX.DEBT && t.debtId && t.debtId in m) m[t.debtId] -= t.amount;
    }
    return m;
  }
  const activeWallets = (state) => state.wallets.filter((w) => !w.archivedAt);
  /** Total Balance = active wallets only. Savings goals are NEVER included. */
  function totalBalance(state) {
    const b = walletBalances(state);
    return sum(activeWallets(state), (w) => b[w.id] || 0);
  }
  function totalSaved(state) {
    const m = goalSavedMap(state);
    return sum(state.goals.filter((g) => !g.archivedAt), (g) => m[g.id] || 0);
  }

  /** Integrity check run on the would-be state before any change is saved. */
  function validateLedger(state) {
    const errors = [];
    const walletIds = new Set(state.wallets.map((w) => w.id));
    const b = walletBalances(state);
    for (const w of state.wallets) {
      if ((b[w.id] || 0) < 0) errors.push(`${w.name} would go below ₱0.00 (short by ${formatPeso(-(b[w.id]))}).`);
    }
    for (const t of state.transactions) {
      if (t.walletId && !walletIds.has(t.walletId)) { errors.push('A transaction points to a wallet that no longer exists.'); break; }
      if (t.toWalletId && !walletIds.has(t.toWalletId)) { errors.push('A transfer points to a wallet that no longer exists.'); break; }
    }
    const gm = goalSavedMap(state);
    for (const g of state.goals) {
      if ((gm[g.id] || 0) < 0) errors.push(`Goal "${g.name}" would have a negative saved amount.`);
    }
    const dm = debtRemainingMap(state);
    for (const d of state.debts) {
      if (dm[d.id] < 0) errors.push(`Payments on "${d.name}" would exceed what is owed.`);
    }
    return errors;
  }
  function finalize(state, ops, extra) {
    const errs = validateLedger(applyOps(state, ops));
    if (errs.length) return fail(errs);
    return Object.assign({ ok: true, errors: [], ops }, extra || {});
  }

  /* ------------------------------------------------------------------ */
  /* Paydays and cut-offs                                               */
  /* ------------------------------------------------------------------ */
  function scheduledDates(settings, fromISO, toISO) {
    const days = (settings.paydays && settings.paydays.length ? settings.paydays : [15, 30]);
    const out = [];
    let key = addMonths(monthKey(fromISO), -1);
    const last = addMonths(monthKey(toISO), 1);
    while (key <= last) {
      for (const d of days) out.push(dateInMonth(key, d));
      key = addMonths(key, 1);
    }
    return Array.from(new Set(out)).sort().filter((d) => d >= fromISO && d <= toISO);
  }
  function nextScheduledAfter(settings, iso) { return scheduledDates(settings, addDays(iso, 1), addDays(iso, 70))[0]; }
  function nextScheduledOnOrAfter(settings, iso) { return scheduledDates(settings, iso, addDays(iso, 70))[0]; }
  /** Which scheduled payday does an actual salary date most likely belong to? */
  function nearestPayday(settings, actualISO) {
    const c = scheduledDates(settings, addDays(actualISO, -40), addDays(actualISO, 40));
    let best = c[0], bd = Infinity;
    for (const d of c) {
      const dist = Math.abs(diffDays(d, actualISO));
      if (dist < bd) { bd = dist; best = d; }
    }
    return best;
  }

  /** Cut-offs derived from salary transactions that were ACTUALLY RECEIVED. */
  function getCutoffs(state) {
    const sal = state.transactions.filter((t) => t.type === TX.INCOME && t.isSalary)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.createdAt || '') < (b.createdAt || '') ? -1 : 1));
    return sal.map((t, i) => ({
      id: t.id, index: i + 1, start: t.date, end: sal[i + 1] ? sal[i + 1].date : null,
      salaryTx: t, forPayday: t.forPayday || t.date, amount: t.amount, walletId: t.walletId
    }));
  }
  function currentCutoff(state) { const c = getCutoffs(state); return c.length ? c[c.length - 1] : null; }
  function cutoffById(state, id) { return getCutoffs(state).find((c) => c.id === id) || null; }
  function inCutoff(cutoff, date) { return date >= cutoff.start && (cutoff.end === null || date < cutoff.end); }
  function cutoffTransactions(state, cutoff) { return state.transactions.filter((t) => inCutoff(cutoff, t.date)); }
  function cutoffLabel(c) {
    return `${formatDateShort(c.start)} – ${c.end ? formatDateShort(addDays(c.end, -1)) : 'now'}`;
  }

  /** Expected payday is informational only: it never creates income or a cut-off. */
  function nextExpectedPayday(state, today) {
    const cut = currentCutoff(state);
    const date = cut ? nextScheduledAfter(state.settings, cut.forPayday) : nextScheduledOnOrAfter(state.settings, today);
    const overdue = date < today;
    return { date, overdue, overdueDays: overdue ? diffDays(date, today) : 0, daysLeft: overdue ? 0 : diffDays(today, date) };
  }

  /* ------------------------------------------------------------------ */
  /* Summaries                                                          */
  /* ------------------------------------------------------------------ */
  function summarize(txs) {
    const s = { income: 0, salary: 0, otherIncome: 0, variable: 0, bills: 0, debt: 0, expenses: 0, contributions: 0, withdrawals: 0, savingsNet: 0, transfers: 0, net: 0, count: txs.length };
    for (const t of txs) {
      switch (t.type) {
        case TX.INCOME: s.income += t.amount; if (t.isSalary) s.salary += t.amount; else s.otherIncome += t.amount; break;
        case TX.EXPENSE: s.variable += t.amount; break;
        case TX.BILL: s.bills += t.amount; break;
        case TX.DEBT: s.debt += t.amount; break;
        case TX.SAVINGS: s.contributions += t.amount; break;
        case TX.WITHDRAW: s.withdrawals += t.amount; break;
        case TX.TRANSFER: s.transfers += t.amount; break;
      }
    }
    s.expenses = s.variable + s.bills + s.debt;
    s.savingsNet = s.contributions - s.withdrawals;
    s.net = s.income - s.expenses - s.savingsNet; // = change in total wallet balance for these transactions
    return s;
  }
  function spendingByCategory(txs) {
    const m = {};
    for (const t of txs) {
      let cat = null;
      if (t.type === TX.EXPENSE || t.type === TX.BILL) cat = t.category || 'Uncategorized';
      else if (t.type === TX.DEBT) cat = 'Debt payments';
      if (cat) m[cat] = (m[cat] || 0) + t.amount;
    }
    return Object.entries(m).map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount - a.amount);
  }
  function currentSummary(state) {
    const c = currentCutoff(state);
    return { cutoff: c, summary: summarize(c ? cutoffTransactions(state, c) : state.transactions) };
  }
  function cutoffSummaries(state) {
    return getCutoffs(state).map((c) => {
      const txs = cutoffTransactions(state, c);
      return { cutoff: c, summary: summarize(txs), days: c.end ? diffDays(c.start, c.end) : null };
    }).reverse();
  }
  function monthlySummaries(state) {
    const by = {};
    for (const t of state.transactions) (by[monthKey(t.date)] = by[monthKey(t.date)] || []).push(t);
    return Object.keys(by).sort().reverse().map((k) => ({ month: k, summary: summarize(by[k]) }));
  }
  /** period: {kind:'cutoff',id} | {kind:'month',key} | {kind:'range',from,to} | {kind:'all'} */
  function periodTransactions(state, period) {
    let from = null, to = null, label = 'All time';
    if (period.kind === 'cutoff') {
      const c = cutoffById(state, period.id);
      if (c) { from = c.start; to = c.end ? addDays(c.end, -1) : null; label = 'Cut-off ' + cutoffLabel(c); }
    } else if (period.kind === 'month') { from = period.key + '-01'; to = monthEnd(period.key); label = formatMonth(period.key); }
    else if (period.kind === 'range') { from = period.from || null; to = period.to || null; label = `${formatDate(from)} – ${formatDate(to)}`; }
    const txs = state.transactions.filter((t) => (!from || t.date >= from) && (!to || t.date <= to));
    return { txs, from, to, label };
  }
  function sortTransactions(txs) {
    return txs.slice().sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : (a.createdAt || '') < (b.createdAt || '') ? 1 : -1));
  }
  function filterTransactions(state, f) {
    f = f || {};
    const q = (f.q || '').trim().toLowerCase();
    return sortTransactions(state.transactions.filter((t) => {
      if (f.from && t.date < f.from) return false;
      if (f.to && t.date > f.to) return false;
      if (f.type && t.type !== f.type) return false;
      if (f.category && (t.category || '') !== f.category) return false;
      if (f.walletId && t.walletId !== f.walletId && t.toWalletId !== f.walletId) return false;
      if (q && !((t.note || '') + ' ' + (t.category || '')).toLowerCase().includes(q)) return false;
      return true;
    }));
  }
  /** Effect of one transaction on a wallet (signed centavos), used for the wallet history view. */
  function txEffectOnWallet(t, walletId) {
    let e = 0;
    switch (t.type) {
      case TX.INCOME: case TX.WITHDRAW: if (t.walletId === walletId) e = t.amount; break;
      case TX.EXPENSE: case TX.SAVINGS: case TX.BILL: case TX.DEBT: if (t.walletId === walletId) e = -t.amount; break;
      case TX.TRANSFER: if (t.walletId === walletId) e -= t.amount; if (t.toWalletId === walletId) e += t.amount; break;
    }
    return e;
  }

  /* ------------------------------------------------------------------ */
  /* Transactions                                                       */
  /* ------------------------------------------------------------------ */
  function findById(list, id) { return list.find((x) => x.id === id); }
  function checkWallet(state, id, label, existingId, errors) {
    const w = findById(state.wallets, id);
    if (!w) { errors.push(`Choose a ${label}.`); return null; }
    if (w.archivedAt && id !== existingId) { errors.push(`${w.name} is archived. Choose another ${label}.`); return null; }
    return w;
  }
  /** Validate + normalise transaction input. `existing` is set when editing. */
  function buildTransaction(state, inp, today, existing) {
    const errors = [];
    const type = existing ? existing.type : inp.type;
    if (!Object.values(TX).includes(type)) return { errors: ['Choose a transaction type.'] };
    const amount = inp.amount;
    if (!Number.isInteger(amount) || amount <= 0) errors.push('Enter an amount greater than ₱0.00.');
    else if (amount > MAX_CENTS) errors.push('That amount is too large.');
    if (!isISO(inp.date)) errors.push('Choose a valid date.');
    else if (inp.date > today) errors.push('The date cannot be in the future.');
    const note = (inp.note || '').trim().slice(0, 300);
    const tx = {
      id: existing ? existing.id : uid(), type, amount, date: inp.date, note,
      createdAt: existing ? existing.createdAt : nowStamp(), updatedAt: nowStamp()
    };
    tx.walletId = inp.walletId;
    checkWallet(state, inp.walletId, type === TX.TRANSFER ? 'source wallet' : 'wallet', existing && existing.walletId, errors);

    if (type === TX.INCOME) {
      if (existing && existing.isSalary) {
        tx.isSalary = true; tx.category = 'Salary';
        tx.forPayday = isISO(inp.forPayday) ? inp.forPayday : existing.forPayday;
      } else {
        tx.category = (inp.category || '').trim() || 'Other';
      }
    } else if (type === TX.EXPENSE) {
      if (inp.budgetCategoryId) {
        const bc = findById(state.budgetCategories, inp.budgetCategoryId);
        if (!bc || (bc.archivedOn && !(existing && existing.budgetCategoryId === bc.id))) errors.push('Choose a valid budget category.');
        else { tx.budgetCategoryId = bc.id; tx.category = bc.name; }
      } else {
        const c = (inp.category || '').trim();
        if (!c) errors.push('Choose a category.'); else tx.category = c;
      }
    } else if (type === TX.SAVINGS || type === TX.WITHDRAW) {
      const g = findById(state.goals, inp.goalId);
      if (!g) errors.push('Choose a savings goal.');
      else if (g.archivedAt && !(existing && existing.goalId === g.id)) errors.push('That goal is archived.');
      else { tx.goalId = g.id; tx.category = g.name; }
    } else if (type === TX.TRANSFER) {
      tx.toWalletId = inp.toWalletId;
      checkWallet(state, inp.toWalletId, 'destination wallet', existing && existing.toWalletId, errors);
      if (inp.walletId && inp.walletId === inp.toWalletId) errors.push('Source and destination wallets must be different.');
      if (note.length < 3) errors.push('A transfer needs a purpose or note (for example: "Cash for palengke").');
      tx.category = 'Transfer';
    } else if (type === TX.BILL) {
      const b = findById(state.bills, existing ? existing.billId : inp.billId);
      if (!b) errors.push('Choose a bill.');
      else { tx.billId = b.id; tx.billMonth = existing ? existing.billMonth : inp.billMonth; tx.category = b.category || 'Bills'; }
    } else if (type === TX.DEBT) {
      const d = findById(state.debts, existing ? existing.debtId : inp.debtId);
      if (!d) errors.push('Choose a debt.');
      else { tx.debtId = d.id; tx.category = 'Debt payments'; }
    }
    if (errors.length) return { errors };
    return { tx, errors: [] };
  }

  function addTransactionOps(state, inp, today) {
    if (inp.type === TX.BILL || inp.type === TX.DEBT) return fail('Use the Bills or Debts page to record this payment.');
    const r = buildTransaction(state, inp, today, null);
    if (r.errors.length) return fail(r.errors);
    return finalize(state, [put('transactions', r.tx)], { tx: r.tx });
  }
  function isClosureSavings(state, id) { return state.weekClosures.some((c) => c.savingsTxId === id); }

  function updateTransactionOps(state, id, inp, today) {
    const ex = findById(state.transactions, id);
    if (!ex) return fail('That transaction no longer exists.');
    if (isClosureSavings(state, id)) return fail('This savings entry came from a weekly budget closing. Re-open that week to change it.');
    const merged = Object.assign({}, inp, { type: ex.type });
    if (ex.type === TX.BILL || ex.type === TX.DEBT) merged.note = inp.note;
    const r = buildTransaction(state, merged, today, ex);
    if (r.errors.length) return fail(r.errors);
    const ops = [put('transactions', r.tx)];
    // If a salary amount changes, re-scale the planned allocation by its percentages.
    if (ex.isSalary && ex.amount !== r.tx.amount) {
      const al = state.allocations.find((a) => a.cutoffId === ex.id);
      if (al) ops.push(put('allocations', Object.assign({}, al, { items: allocateByPct(r.tx.amount, al.items), updatedAt: nowStamp() })));
    }
    return finalize(state, ops, { tx: r.tx });
  }
  function deleteTransactionOps(state, id) {
    const ex = findById(state.transactions, id);
    if (!ex) return fail('That transaction no longer exists.');
    if (isClosureSavings(state, id)) return fail('This savings entry came from a weekly budget closing. Re-open that week to remove it.');
    const ops = [del('transactions', id)];
    if (ex.isSalary) {
      state.allocations.filter((a) => a.cutoffId === id).forEach((a) => ops.push(del('allocations', a.id)));
      state.weekClosures.filter((c) => c.cutoffId === id).forEach((c) => ops.push(del('weekClosures', c.id)));
    }
    return finalize(state, ops);
  }

  /** Record salary ACTUALLY received. This is the only thing that starts a new cut-off. */
  function recordSalaryOps(state, inp, today) {
    const errors = [];
    if (!Number.isInteger(inp.amount) || inp.amount <= 0) errors.push('Enter the salary amount received (more than ₱0.00).');
    else if (inp.amount > MAX_CENTS) errors.push('That amount is too large.');
    if (!isISO(inp.date)) errors.push('Choose the date the salary was actually received.');
    else if (inp.date > today) errors.push('Salary can only be recorded once it has been received (date cannot be in the future).');
    checkWallet(state, inp.walletId, 'wallet that received the salary', null, errors);
    if (errors.length) return fail(errors);
    const dup = state.transactions.find((t) => t.isSalary && t.date === inp.date && t.amount === inp.amount && t.walletId === inp.walletId);
    if (dup && !inp.allowDuplicate) return fail('A salary of the same amount is already recorded on that date and wallet. If this is a different salary, tick the confirmation.');
    const forPayday = isISO(inp.forPayday) ? inp.forPayday : nearestPayday(state.settings, inp.date);
    const tx = {
      id: uid(), type: TX.INCOME, amount: inp.amount, date: inp.date, walletId: inp.walletId, category: 'Salary',
      isSalary: true, forPayday, note: (inp.note || '').trim().slice(0, 300) || 'Salary received',
      createdAt: nowStamp(), updatedAt: nowStamp()
    };
    return finalize(state, [put('transactions', tx)], { tx, cutoffId: tx.id });
  }

  /* ------------------------------------------------------------------ */
  /* Salary allocation (planning only — never touches wallets)           */
  /* ------------------------------------------------------------------ */
  /** Split `salary` by the percentages of `items`; the rounding remainder goes to the last line. */
  function allocateByPct(salary, items) {
    const out = items.map((it) => ({ ...it, amount: 0 }));
    let t = 0;
    out.forEach((o, i) => { o.amount = Math.round((salary * items[i].pct) / 100); t += o.amount; });
    out[out.length - 1].amount += salary - t;
    return out;
  }
  function defaultAllocationItems(salary, settings) { return allocateByPct(salary, settings.allocation); }
  function getAllocation(state, cutoffId) { return state.allocations.find((a) => a.cutoffId === cutoffId) || null; }
  function allocationStatus(salary, items) {
    const total = sum(items, (i) => i.amount);
    const pct = sum(items, (i) => i.pct);
    return { total, pct: Math.round(pct * 100) / 100, diff: salary - total, balanced: total === salary };
  }
  function saveAllocationOps(state, cutoffId, items) {
    const c = cutoffById(state, cutoffId);
    if (!c) return fail('That cut-off no longer exists.');
    for (const it of items) {
      if (!Number.isInteger(it.amount) || it.amount < 0) return fail(`"${it.label}" needs a valid amount (0 or more).`);
      if (!(it.pct >= 0)) return fail(`"${it.label}" needs a valid percentage.`);
    }
    const st = allocationStatus(c.amount, items);
    if (!st.balanced) return fail(`The plan must total exactly ${formatPeso(c.amount)} (100%). It is currently ${st.diff > 0 ? formatPeso(st.diff) + ' short' : formatPeso(-st.diff) + ' over'}.`);
    const ex = getAllocation(state, cutoffId);
    const rec = { id: ex ? ex.id : uid(), cutoffId, items: items.map((i) => ({ key: i.key, label: i.label, pct: i.pct, amount: i.amount })), updatedAt: nowStamp() };
    return { ok: true, errors: [], ops: [put('allocations', rec)] };
  }
  /** Planned vs ACTUAL for each allocation line, for one cut-off. */
  function allocationActuals(state, cutoff) {
    const txs = cutoffTransactions(state, cutoff);
    const a = { fixed: 0, goals: 0, offering: 0, variable: 0 };
    for (const t of txs) {
      if (t.type === TX.BILL || t.type === TX.DEBT) a.fixed += t.amount;
      else if (t.type === TX.SAVINGS) a.goals += t.amount;
      else if (t.type === TX.WITHDRAW) a.goals -= t.amount;
      else if (t.type === TX.EXPENSE) { if (t.category === TITHES) a.offering += t.amount; else a.variable += t.amount; }
    }
    return a;
  }

  /* ------------------------------------------------------------------ */
  /* Weekly budget                                                      */
  /* ------------------------------------------------------------------ */
  function weekIndexOf(cutoff, date) { return Math.floor(diffDays(cutoff.start, date) / WEEK_DAYS) + 1; }
  function weekRange(cutoff, idx) {
    const start = addDays(cutoff.start, (idx - 1) * WEEK_DAYS);
    let end = addDays(start, WEEK_DAYS - 1);
    if (cutoff.end && end >= cutoff.end) end = addDays(cutoff.end, -1);
    return { start, end };
  }
  /** Number of weeks that have started (as of `today`) in this cut-off. */
  function weekCount(cutoff, today) {
    const last = cutoff.end ? addDays(cutoff.end, -1) : today;
    return Math.max(1, weekIndexOf(cutoff, last < cutoff.start ? cutoff.start : last));
  }
  /** Weekly amount in force on a date. Editing a budget never rewrites weeks that already started. */
  function amountAt(cat, date) {
    let a = cat.weeklyAmount;
    if (cat.history && cat.history.length) {
      a = cat.history[0].amount;
      for (const h of cat.history) if (h.from <= date) a = h.amount;
    }
    return a;
  }
  function categoryInWeek(cat, range) {
    if (cat.createdOn && range.end < cat.createdOn) return false;
    if (cat.archivedOn && range.start >= cat.archivedOn) return false;
    return true;
  }
  function getClosure(state, cutoffId, idx) { return state.weekClosures.find((c) => c.cutoffId === cutoffId && c.weekIdx === idx) || null; }
  function weeklyBudget(state, cutoff, idx, today) {
    const range = weekRange(cutoff, idx);
    const cats = state.budgetCategories.filter((c) => categoryInWeek(c, range)).sort((a, b) => (a.order || 0) - (b.order || 0));
    const txs = state.transactions.filter((t) => t.type === TX.EXPENSE && t.budgetCategoryId && t.date >= range.start && t.date <= range.end);
    const rows = cats.map((c) => {
      const spent = sum(txs.filter((t) => t.budgetCategoryId === c.id), (t) => t.amount);
      const amt = amountAt(c, range.start);
      return { id: c.id, name: c.name, budget: amt, spent, remaining: amt - spent, pct: amt ? spent / amt : 0 };
    });
    const prev = idx > 1 ? getClosure(state, cutoff.id, idx - 1) : null;
    const carryIn = prev ? prev.toNext : 0;
    const base = sum(rows, (r) => r.budget);
    const spent = sum(rows, (r) => r.spent);
    const closure = getClosure(state, cutoff.id, idx);
    const ended = today > range.end;
    return {
      idx, start: range.start, end: range.end, ended, current: !ended && today >= range.start,
      rows, base, carryIn, budget: base + carryIn, spent, remaining: base + carryIn - spent, closure,
      canClose: ended && !closure && (base + carryIn - spent) > 0
    };
  }
  function weeksOf(state, cutoff, today) {
    const n = weekCount(cutoff, today);
    const out = [];
    for (let i = 1; i <= n; i++) out.push(weeklyBudget(state, cutoff, i, today));
    return out;
  }
  /** Let the user decide what happens to a week's leftover. Nothing carries over automatically. */
  function closeWeekOps(state, inp, today) {
    const c = cutoffById(state, inp.cutoffId);
    if (!c) return fail('That cut-off no longer exists.');
    const wk = weeklyBudget(state, c, inp.weekIdx, today);
    if (wk.closure) return fail('This week is already closed.');
    if (!wk.ended) return fail('This week is still running. You can decide on the leftover once it ends.');
    if (wk.remaining <= 0) return fail('There is no leftover to assign for this week.');
    const toSavings = inp.toSavings || 0, toNext = inp.toNext || 0;
    if (!Number.isInteger(toSavings) || !Number.isInteger(toNext) || toSavings < 0 || toNext < 0) return fail('Amounts must be zero or more.');
    if (toSavings + toNext > wk.remaining) return fail(`You can only assign up to ${formatPeso(wk.remaining)}.`);
    const ops = [];
    let savingsTxId = null;
    if (toSavings > 0) {
      const r = buildTransaction(state, { type: TX.SAVINGS, amount: toSavings, date: inp.date || today, walletId: inp.walletId, goalId: inp.goalId, note: `Week ${inp.weekIdx} leftover` }, today, null);
      if (r.errors.length) return fail(r.errors);
      savingsTxId = r.tx.id; ops.push(put('transactions', r.tx));
    }
    const rec = {
      id: uid(), cutoffId: c.id, weekIdx: inp.weekIdx, remaining: wk.remaining, toSavings, toNext,
      unassigned: wk.remaining - toSavings - toNext, savingsTxId, closedOn: today, createdAt: nowStamp()
    };
    ops.push(put('weekClosures', rec));
    return finalize(state, ops, { closure: rec });
  }
  function reopenWeekOps(state, closureId) {
    const cl = findById(state.weekClosures, closureId);
    if (!cl) return fail('That closing no longer exists.');
    const later = getClosure(state, cl.cutoffId, cl.weekIdx + 1);
    if (later && cl.toNext > 0) return fail('The next week is already closed and uses this carry-over. Re-open that week first.');
    const ops = [del('weekClosures', cl.id)];
    if (cl.savingsTxId) ops.push(del('transactions', cl.savingsTxId));
    return finalize(state, ops);
  }

  /* Budget categories ------------------------------------------------ */
  function validBudgetCat(inp) {
    const name = (inp.name || '').trim();
    if (!name) return 'Give the category a name.';
    if (!Number.isInteger(inp.weeklyAmount) || inp.weeklyAmount < 0) return 'Enter a weekly amount (0 or more).';
    if (inp.weeklyAmount > MAX_CENTS) return 'That amount is too large.';
    return null;
  }
  function nameTaken(list, name, exceptId) {
    return list.some((x) => x.id !== exceptId && !x.archivedOn && !x.archivedAt && x.name.trim().toLowerCase() === name.trim().toLowerCase());
  }
  function addBudgetCategoryOps(state, inp, today) {
    const e = validBudgetCat(inp); if (e) return fail(e);
    if (nameTaken(state.budgetCategories, inp.name)) return fail('A budget category with that name already exists.');
    const rec = { id: uid(), name: inp.name.trim(), weeklyAmount: inp.weeklyAmount, createdOn: today, order: state.budgetCategories.length };
    return { ok: true, errors: [], ops: [put('budgetCategories', rec)] };
  }
  function updateBudgetCategoryOps(state, id, inp, today) {
    const ex = findById(state.budgetCategories, id); if (!ex) return fail('Category not found.');
    const e = validBudgetCat(inp); if (e) return fail(e);
    if (nameTaken(state.budgetCategories, inp.name, id)) return fail('A budget category with that name already exists.');
    const rec = Object.assign({}, ex, { name: inp.name.trim(), weeklyAmount: inp.weeklyAmount });
    if (inp.weeklyAmount !== ex.weeklyAmount) {
      // new amount applies from the start of the week we are in; earlier weeks keep what they had
      const cut = currentCutoff(state);
      const from = cut && today >= cut.start ? weekRange(cut, weekIndexOf(cut, today)).start : today;
      const hist = (ex.history && ex.history.length ? ex.history : [{ from: '0000-00-00', amount: ex.weeklyAmount }]).filter((h) => h.from < from);
      hist.push({ from, amount: inp.weeklyAmount });
      rec.history = hist;
    }
    const ops = [put('budgetCategories', rec)];
    if (ex.name !== inp.name.trim()) { // keep the snapshot names on past expenses in sync
      state.transactions.filter((t) => t.budgetCategoryId === id).forEach((t) => ops.push(put('transactions', Object.assign({}, t, { category: inp.name.trim() }))));
    }
    return { ok: true, errors: [], ops };
  }
  function removeBudgetCategoryOps(state, id, today) {
    const ex = findById(state.budgetCategories, id); if (!ex) return fail('Category not found.');
    const used = state.transactions.some((t) => t.budgetCategoryId === id);
    if (!used) return { ok: true, errors: [], mode: 'deleted', ops: [del('budgetCategories', id)] };
    return { ok: true, errors: [], mode: 'archived', ops: [put('budgetCategories', Object.assign({}, ex, { archivedOn: today }))] };
  }

  /* ------------------------------------------------------------------ */
  /* Wallets                                                            */
  /* ------------------------------------------------------------------ */
  function validWallet(state, inp, exceptId) {
    const name = (inp.name || '').trim();
    if (!name) return 'Give the wallet a name.';
    if (nameTaken(state.wallets, name, exceptId)) return 'You already have a wallet with that name.';
    if (!WALLET_TYPES.includes(inp.type)) return 'Choose a wallet type.';
    if (!Number.isInteger(inp.openingBalance) || inp.openingBalance < 0) return 'Enter a starting balance (0 or more).';
    if (inp.openingBalance > MAX_CENTS) return 'That amount is too large.';
    return null;
  }
  function addWalletOps(state, inp) {
    const e = validWallet(state, inp); if (e) return fail(e);
    const rec = { id: uid(), name: inp.name.trim(), type: inp.type, openingBalance: inp.openingBalance, createdAt: nowStamp() };
    return { ok: true, errors: [], ops: [put('wallets', rec)], wallet: rec };
  }
  function updateWalletOps(state, id, inp) {
    const ex = findById(state.wallets, id); if (!ex) return fail('Wallet not found.');
    const e = validWallet(state, inp, id); if (e) return fail(e);
    return finalize(state, [put('wallets', Object.assign({}, ex, { name: inp.name.trim(), type: inp.type, openingBalance: inp.openingBalance }))]);
  }
  /** Decide what "delete" means for an item without losing history. */
  function removalCheck(state, kind, id) {
    if (kind === 'wallet') {
      const bal = walletBalances(state)[id] || 0;
      const linked = state.transactions.filter((t) => t.walletId === id || t.toWalletId === id).length;
      if (bal !== 0) return { action: 'blocked', reason: `This wallet still holds ${formatPeso(bal)}. Transfer the money to another wallet first, then you can remove it.`, balance: bal, linked };
      if (linked) return { action: 'archive', reason: `This wallet has ${linked} linked transaction${linked > 1 ? 's' : ''}, so it can't be deleted. It will be archived: hidden from lists and totals, history kept.`, balance: bal, linked };
      return { action: 'delete', reason: 'This wallet has no balance and no transactions.', balance: bal, linked };
    }
    if (kind === 'goal') {
      const saved = goalSavedMap(state)[id] || 0;
      const linked = state.transactions.filter((t) => t.goalId === id).length;
      if (saved !== 0) return { action: 'blocked', reason: `This goal still has ${formatPeso(saved)} saved. Withdraw it to a wallet first, then you can remove the goal.`, saved, linked };
      if (linked) return { action: 'archive', reason: 'This goal has contribution history, so it will be archived instead of deleted.', saved, linked };
      return { action: 'delete', reason: 'This goal has no savings and no history.', saved, linked };
    }
    if (kind === 'bill') {
      const linked = state.transactions.filter((t) => t.billId === id).length;
      if (linked) return { action: 'archive', reason: `This bill has ${linked} payment${linked > 1 ? 's' : ''} on record. It will be archived: no longer expected from this month, but past payments stay in your history.`, linked };
      return { action: 'delete', reason: 'This bill has no payments on record.', linked };
    }
    if (kind === 'debt') {
      const linked = state.transactions.filter((t) => t.debtId === id).length;
      if (linked) return { action: 'archive', reason: `This debt has ${linked} payment${linked > 1 ? 's' : ''} on record. It will be archived and stop counting in your debt summary; payments stay in your history.`, linked };
      return { action: 'delete', reason: 'This debt has no payments on record.', linked };
    }
    return { action: 'blocked', reason: 'Unknown item.' };
  }
  const KIND_STORE = { wallet: 'wallets', goal: 'goals', bill: 'bills', debt: 'debts' };
  function removeItemOps(state, kind, id, today) {
    const store = KIND_STORE[kind];
    const ex = store && findById(state[store], id);
    if (!ex) return fail('Item not found.');
    const chk = removalCheck(state, kind, id);
    if (chk.action === 'blocked') return fail(chk.reason);
    if (chk.action === 'delete') return finalize(state, [del(store, id)], { mode: 'deleted' });
    const rec = Object.assign({}, ex, { archivedAt: today });
    if (kind === 'bill') rec.archivedFrom = monthKey(today);
    return finalize(state, [put(store, rec)], { mode: 'archived' });
  }
  function restoreItemOps(state, kind, id) {
    const store = KIND_STORE[kind];
    const ex = store && findById(state[store], id);
    if (!ex) return fail('Item not found.');
    const rec = Object.assign({}, ex); delete rec.archivedAt; delete rec.archivedFrom;
    return { ok: true, errors: [], ops: [put(store, rec)] };
  }

  /* ------------------------------------------------------------------ */
  /* Savings goals                                                      */
  /* ------------------------------------------------------------------ */
  function validGoal(state, inp, exceptId) {
    const name = (inp.name || '').trim();
    if (!name) return 'Give the goal a name.';
    if (nameTaken(state.goals, name, exceptId)) return 'You already have a goal with that name.';
    if (!Number.isInteger(inp.target) || inp.target <= 0) return 'Enter a target amount greater than ₱0.00.';
    if (inp.target > MAX_CENTS) return 'That amount is too large.';
    if (inp.targetDate && !isISO(inp.targetDate)) return 'Choose a valid target date.';
    if (inp.openingSaved !== undefined && (!Number.isInteger(inp.openingSaved) || inp.openingSaved < 0)) return 'Already-saved amount must be 0 or more.';
    return null;
  }
  function addGoalOps(state, inp) {
    const e = validGoal(state, inp); if (e) return fail(e);
    const rec = { id: uid(), name: inp.name.trim(), target: inp.target, targetDate: inp.targetDate || '', openingSaved: inp.openingSaved || 0, createdAt: nowStamp() };
    return { ok: true, errors: [], ops: [put('goals', rec)], goal: rec };
  }
  function updateGoalOps(state, id, inp) {
    const ex = findById(state.goals, id); if (!ex) return fail('Goal not found.');
    const e = validGoal(state, inp, id); if (e) return fail(e);
    const rec = Object.assign({}, ex, { name: inp.name.trim(), target: inp.target, targetDate: inp.targetDate || '' });
    const ops = [put('goals', rec)];
    if (ex.name !== rec.name) state.transactions.filter((t) => t.goalId === id).forEach((t) => ops.push(put('transactions', Object.assign({}, t, { category: rec.name }))));
    return finalize(state, ops);
  }
  function goalInfo(state, goal, today) {
    const saved = goalSavedMap(state)[goal.id] || 0;
    const pct = goal.target ? Math.min(1, Math.max(0, saved / goal.target)) : 0;
    let monthsLeft = null, perMonth = null;
    if (goal.targetDate && today) {
      monthsLeft = Math.max(1, Math.ceil(diffDays(today, goal.targetDate) / 30));
      if (goal.targetDate < today) monthsLeft = 0;
      perMonth = saved >= goal.target ? 0 : monthsLeft ? Math.ceil((goal.target - saved) / monthsLeft) : goal.target - saved;
    }
    return { saved, pct, remaining: Math.max(0, goal.target - saved), done: saved >= goal.target, monthsLeft, perMonth };
  }

  /* ------------------------------------------------------------------ */
  /* Bills (monthly; paid manually; never auto-deducted)                 */
  /* ------------------------------------------------------------------ */
  function validBill(inp) {
    if (!(inp.name || '').trim()) return 'Give the bill a name.';
    if (!Number.isInteger(inp.amount) || inp.amount <= 0) return 'Enter the bill amount (more than ₱0.00).';
    if (inp.amount > MAX_CENTS) return 'That amount is too large.';
    if (!Number.isInteger(inp.dueDay) || inp.dueDay < 1 || inp.dueDay > 31) return 'Due day must be between 1 and 31.';
    return null;
  }
  function addBillOps(state, inp, today) {
    const e = validBill(inp); if (e) return fail(e);
    if (nameTaken(state.bills, inp.name)) return fail('You already have a bill with that name.');
    const rec = { id: uid(), name: inp.name.trim(), amount: inp.amount, dueDay: inp.dueDay, category: inp.category || 'Other', startMonth: inp.startMonth || monthKey(today), createdAt: nowStamp() };
    return { ok: true, errors: [], ops: [put('bills', rec)] };
  }
  function updateBillOps(state, id, inp) {
    const ex = findById(state.bills, id); if (!ex) return fail('Bill not found.');
    const e = validBill(inp); if (e) return fail(e);
    if (nameTaken(state.bills, inp.name, id)) return fail('You already have a bill with that name.');
    return { ok: true, errors: [], ops: [put('bills', Object.assign({}, ex, { name: inp.name.trim(), amount: inp.amount, dueDay: inp.dueDay, category: inp.category || ex.category }))] };
  }
  function billPayment(state, billId, key) {
    return state.transactions.find((t) => t.type === TX.BILL && t.billId === billId && t.billMonth === key) || null;
  }
  /** Status of one bill for one month: paid | overdue | pending | upcoming | na (not applicable). */
  function billStatus(state, bill, key, today) {
    const payment = billPayment(state, bill.id, key);
    if (payment) return { status: 'paid', dueDate: dateInMonth(key, bill.dueDay), payment };
    if (bill.startMonth && key < bill.startMonth) return { status: 'na' };
    if (bill.archivedFrom && key >= bill.archivedFrom) return { status: 'na' };
    const dueDate = dateInMonth(key, bill.dueDay);
    const cur = monthKey(today);
    if (key > cur) return { status: 'upcoming', dueDate };
    if (dueDate < today) return { status: 'overdue', dueDate, daysLate: diffDays(dueDate, today) };
    return { status: 'pending', dueDate, daysLeft: diffDays(today, dueDate) };
  }
  function billsForMonth(state, key, today, includeArchived) {
    return state.bills.map((b) => ({ bill: b, ...billStatus(state, b, key, today) }))
      .filter((r) => r.status !== 'na' && (includeArchived || !r.bill.archivedAt || r.status === 'paid'))
      .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));
  }
  /** Bills this month that still need paying (never reset by a cut-off). */
  function incomingBills(state, today) {
    return billsForMonth(state, monthKey(today), today).filter((r) => r.status === 'pending' || r.status === 'overdue');
  }
  function payBillOps(state, inp, today) {
    const bill = findById(state.bills, inp.billId);
    if (!bill) return fail('Bill not found.');
    if (!/^\d{4}-\d{2}$/.test(inp.billMonth || '')) return fail('Choose which month this payment is for.');
    if (billPayment(state, bill.id, inp.billMonth)) return fail(`${bill.name} is already marked paid for ${formatMonth(inp.billMonth)}.`);
    if (bill.startMonth && inp.billMonth < bill.startMonth) return fail('This bill did not exist yet in that month.');
    const note = (inp.note || '').trim() || `${bill.name} — ${formatMonth(inp.billMonth)}`;
    const r = buildTransaction(state, { type: TX.BILL, amount: inp.amount, date: inp.date, walletId: inp.walletId, billId: bill.id, billMonth: inp.billMonth, note }, today, null);
    if (r.errors.length) return fail(r.errors);
    return finalize(state, [put('transactions', r.tx)], { tx: r.tx });
  }

  /* ------------------------------------------------------------------ */
  /* Debts (balances never reset; never auto-paid)                       */
  /* ------------------------------------------------------------------ */
  function validDebt(inp) {
    if (!(inp.name || '').trim()) return 'Enter the creditor or debt name.';
    if (!Number.isInteger(inp.original) || inp.original <= 0) return 'Enter the original amount (more than ₱0.00).';
    if (!Number.isInteger(inp.remaining) || inp.remaining < 0) return 'Enter the remaining balance (0 or more).';
    if (inp.remaining > inp.original) return 'Remaining balance cannot be more than the original amount.';
    if (inp.original > MAX_CENTS) return 'That amount is too large.';
    if (inp.dueDate && !isISO(inp.dueDate)) return 'Choose a valid due date.';
    return null;
  }
  function addDebtOps(state, inp) {
    const e = validDebt(inp); if (e) return fail(e);
    const rec = { id: uid(), name: inp.name.trim(), originalAmount: inp.original, openingRemaining: inp.remaining, dueDate: inp.dueDate || '', notes: (inp.notes || '').trim().slice(0, 300), createdAt: nowStamp() };
    return { ok: true, errors: [], ops: [put('debts', rec)] };
  }
  function updateDebtOps(state, id, inp) {
    const ex = findById(state.debts, id); if (!ex) return fail('Debt not found.');
    // `remaining` entered by the user is the CURRENT balance; convert back to the opening balance.
    const paid = sum(state.transactions.filter((t) => t.type === TX.DEBT && t.debtId === id), (t) => t.amount);
    const e = validDebt(inp); if (e) return fail(e);
    const opening = inp.remaining + paid;
    if (opening > inp.original) return fail('Original amount must be at least the current balance plus payments already made.');
    return finalize(state, [put('debts', Object.assign({}, ex, { name: inp.name.trim(), originalAmount: inp.original, openingRemaining: opening, dueDate: inp.dueDate || '', notes: (inp.notes || '').trim().slice(0, 300) }))]);
  }
  function debtInfo(state, debt, today) {
    const remaining = debtRemainingMap(state)[debt.id];
    const payments = sortTransactions(state.transactions.filter((t) => t.type === TX.DEBT && t.debtId === debt.id));
    const paid = remaining <= 0;
    return {
      remaining, paid, payments, totalPaid: debt.originalAmount - remaining,
      pct: debt.originalAmount ? Math.min(1, (debt.originalAmount - remaining) / debt.originalAmount) : 0,
      overdue: !paid && !!debt.dueDate && !!today && debt.dueDate < today,
      dueSoon: !paid && !!debt.dueDate && !!today && debt.dueDate >= today && diffDays(today, debt.dueDate) <= 7
    };
  }
  function debtSummary(state, today) {
    const list = state.debts.filter((d) => !d.archivedAt).map((d) => ({ debt: d, ...debtInfo(state, d, today) }));
    const open = list.filter((x) => !x.paid);
    return { list, open, totalRemaining: sum(open, (x) => x.remaining), totalOriginal: sum(list, (x) => x.debt.originalAmount), count: open.length };
  }
  function payDebtOps(state, inp, today) {
    const debt = findById(state.debts, inp.debtId);
    if (!debt) return fail('Debt not found.');
    const remaining = debtRemainingMap(state)[debt.id];
    if (remaining <= 0) return fail(`${debt.name} is already fully paid.`);
    if (Number.isInteger(inp.amount) && inp.amount > remaining) return fail(`That is more than the remaining balance of ${formatPeso(remaining)}.`);
    const note = (inp.note || '').trim() || `Payment — ${debt.name}`;
    const r = buildTransaction(state, { type: TX.DEBT, amount: inp.amount, date: inp.date, walletId: inp.walletId, debtId: debt.id, note }, today, null);
    if (r.errors.length) return fail(r.errors);
    return finalize(state, [put('transactions', r.tx)], { tx: r.tx, paidOff: inp.amount === remaining });
  }

  /* ------------------------------------------------------------------ */
  /* Safe to Spend                                                      */
  /* ------------------------------------------------------------------ */
  /**
   * Safe to Spend — how much you can spend on day-to-day things until the next expected payday.
   *
   *   available = Total Balance (active wallets only — savings goals are never included)
   *               − unpaid bills due before the next expected payday
   *               − goal funds / tithes you PLANNED for this cut-off but have not yet set aside
   *   If a salary allocation is planned, the remaining planned Variable Expenses
   *   (plan − variable spending so far) is also a ceiling:  safe = min(available, variable left).
   *   Daily guide = safe ÷ days before payday (at least 1).
   *
   * Debts are not reserved (they have no fixed instalment, you pay them manually).
   * Nothing here moves money; it is a guide computed from transactions + plan.
   */
  function safeToSpend(state, today) {
    const total = totalBalance(state);
    const np = nextExpectedPayday(state, today);
    const windowEnd = np.overdue ? today : np.date;
    const reserved = [];
    let key = monthKey(today);
    const lastKey = monthKey(windowEnd);
    while (key <= lastKey) {
      for (const r of billsForMonth(state, key, today)) {
        if ((r.status === 'pending' || r.status === 'overdue' || r.status === 'upcoming') && r.dueDate <= windowEnd) reserved.push(r);
      }
      key = addMonths(key, 1);
    }
    const reservedTotal = sum(reserved, (r) => r.bill.amount);
    let earmarked = { goals: 0, offering: 0 }, variableLeft = null;
    const cut = currentCutoff(state);
    const plan = cut ? getAllocation(state, cut.id) : null;
    if (plan) {
      const act = allocationActuals(state, cut);
      const item = (k) => (plan.items.find((i) => i.key === k) || { amount: 0 }).amount;
      earmarked = { goals: Math.max(0, item('goals') - act.goals), offering: Math.max(0, item('offering') - act.offering) };
      variableLeft = Math.max(0, item('variable') - act.variable);
    }
    const earmarkedTotal = earmarked.goals + earmarked.offering;
    const available = Math.max(0, total - reservedTotal - earmarkedTotal);
    const limitedByBudget = variableLeft !== null && variableLeft < available;
    const safe = variableLeft === null ? available : Math.min(available, variableLeft);
    const days = Math.max(1, np.daysLeft);
    return {
      total, reserved, reservedTotal, earmarked, earmarkedTotal, available, variableLeft, limitedByBudget,
      safe, days, daily: Math.floor(safe / days), shortfall: Math.max(0, reservedTotal - total), payday: np
    };
  }

  /* ------------------------------------------------------------------ */
  /* Reminders                                                          */
  /* ------------------------------------------------------------------ */
  function reminders(state, today) {
    const out = [];
    const np = nextExpectedPayday(state, today);
    const cut = currentCutoff(state);
    if (!state.wallets.some((w) => !w.archivedAt)) out.push({ level: 'info', title: 'Add your first wallet', text: 'Create a wallet (Cash, GCash, bank) so you can record money.', link: '#/wallets' });
    if (!cut) out.push({ level: 'info', title: 'Record your salary', text: 'Your first cut-off starts when you record a salary you actually received.', action: 'record-salary' });
    else {
      if (np.overdue) out.push({ level: 'warn', title: `Salary expected ${formatDateShort(np.date)}`, text: `It's ${np.overdueDays} day${np.overdueDays > 1 ? 's' : ''} past the expected payday. Your current cut-off continues until you record the salary you actually received.`, action: 'record-salary' });
      else if (np.daysLeft === 0) out.push({ level: 'info', title: 'Expected payday is today', text: 'Record your salary once it actually arrives. Nothing changes until you do.', action: 'record-salary' });
      if (!getAllocation(state, cut.id)) out.push({ level: 'info', title: 'Plan your salary allocation', text: 'You have not planned how to split this cut-off\'s salary yet.', link: '#/cutoff' });
    }
    for (const r of incomingBills(state, today)) {
      if (r.status === 'overdue') out.push({ level: 'danger', title: `${r.bill.name} is overdue`, text: `${formatPeso(r.bill.amount)} was due ${formatDate(r.dueDate)} (${r.daysLate} day${r.daysLate > 1 ? 's' : ''} ago).`, link: '#/bills' });
      else if (r.daysLeft <= 3) out.push({ level: 'warn', title: `${r.bill.name} due ${r.daysLeft === 0 ? 'today' : r.daysLeft === 1 ? 'tomorrow' : 'in ' + r.daysLeft + ' days'}`, text: `${formatPeso(r.bill.amount)} due ${formatDate(r.dueDate)}.`, link: '#/bills' });
    }
    const sts = safeToSpend(state, today);
    if (sts.shortfall > 0) out.push({ level: 'danger', title: 'Bills are more than your balance', text: `Unpaid bills before payday total ${formatPeso(sts.reservedTotal)}, but your Total Balance is ${formatPeso(sts.total)}.`, link: '#/bills' });
    if (cut) {
      const weeks = weeksOf(state, cut, today);
      const w = weeks.find((x) => x.current) || weeks[weeks.length - 1];
      if (w && !w.ended) {
        for (const r of w.rows) {
          if (r.budget > 0 && r.spent > r.budget) out.push({ level: 'danger', title: `${r.name} is over budget`, text: `Spent ${formatPeso(r.spent)} of ${formatPeso(r.budget)} this week.`, link: '#/budget' });
          else if (r.budget > 0 && r.pct >= 0.8) out.push({ level: 'warn', title: `${r.name}: ${Math.round(r.pct * 100)}% used`, text: `${formatPeso(r.remaining)} left for this week.`, link: '#/budget' });
        }
        // pace: spending faster than the week is passing
        const elapsed = (diffDays(w.start, today) + 1) / WEEK_DAYS;
        if (w.budget > 0 && elapsed < 0.6 && w.spent / w.budget > 0.6) out.push({ level: 'warn', title: 'Spending fast this week', text: `${Math.round((w.spent / w.budget) * 100)}% of the weekly budget is gone after ${diffDays(w.start, today) + 1} day${diffDays(w.start, today) ? 's' : ''}.`, link: '#/budget' });
      }
      const open = weeks.filter((x) => x.canClose);
      if (open.length) out.push({ level: 'info', title: `Week ${open[0].idx} has ${formatPeso(open[0].remaining)} left over`, text: 'Decide what to do with it: savings, next week, split, or leave it unassigned.', link: '#/budget' });
    }
    for (const x of debtSummary(state, today).open) {
      if (x.overdue) out.push({ level: 'danger', title: `${x.debt.name} debt is overdue`, text: `${formatPeso(x.remaining)} remaining, due ${formatDate(x.debt.dueDate)}.`, link: '#/debts' });
      else if (x.dueSoon) out.push({ level: 'warn', title: `${x.debt.name} due ${formatDateShort(x.debt.dueDate)}`, text: `${formatPeso(x.remaining)} remaining.`, link: '#/debts' });
    }
    const rank = { danger: 0, warn: 1, info: 2 };
    return out.sort((a, b) => rank[a.level] - rank[b.level]);
  }

  /* ------------------------------------------------------------------ */
  /* Settings                                                           */
  /* ------------------------------------------------------------------ */
  function updateSettingsOps(state, inp) {
    const days = (inp.paydays || []).map(Number);
    if (!days.length || days.length > 4) return fail('Enter between 1 and 4 payday dates (day of the month).');
    if (days.some((d) => !Number.isInteger(d) || d < 1 || d > 31)) return fail('Paydays must be days of the month from 1 to 31.');
    const al = inp.allocation || state.settings.allocation;
    let total = 0;
    for (const a of al) { if (!(a.pct >= 0)) return fail('Allocation percentages must be 0 or more.'); total += a.pct; }
    if (Math.abs(total - 100) > 0.001) return fail(`Default allocation must total 100% (currently ${Math.round(total * 100) / 100}%).`);
    const rec = Object.assign({}, state.settings, { paydays: Array.from(new Set(days)).sort((a, b) => a - b), allocation: al.map((a) => ({ key: a.key, label: a.label, pct: a.pct })) });
    return { ok: true, errors: [], ops: [put('meta', rec)] };
  }

  /* ------------------------------------------------------------------ */
  /* CSV export                                                         */
  /* ------------------------------------------------------------------ */
  function transactionsCSV(state, txs) {
    const wn = (id) => { const w = findById(state.wallets, id); return w ? w.name : ''; };
    const q = (s) => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
    const rows = [['Date', 'Type', 'Category', 'Wallet', 'To wallet', 'Amount (PHP)', 'Note'].map(q).join(',')];
    for (const t of txs) rows.push([t.date, TX_LABEL[t.type], t.category || '', wn(t.walletId), wn(t.toWalletId), (t.amount / 100).toFixed(2), t.note || ''].map(q).join(','));
    return rows.join('\r\n');
  }

  return {
    TX, TX_LABEL, TITHES, OTHER_EXPENSE_CATEGORIES, INCOME_CATEGORIES, WALLET_TYPES, BILL_CATEGORIES, DEFAULT_ALLOCATION, COLLECTIONS, WEEK_DAYS,
    toCents, fromCents, centsToInput, formatPeso, sum,
    isISO, addDays, diffDays, monthKey, addMonths, dateInMonth, monthEnd, todayISO, formatDate, formatDateShort, formatMonth, formatWeekday, daysInMonth,
    uid, emptyState, defaultSettings, applyOps, validateLedger,
    walletBalances, goalSavedMap, debtRemainingMap, totalBalance, totalSaved, activeWallets,
    scheduledDates, nextScheduledAfter, nextScheduledOnOrAfter, nearestPayday,
    getCutoffs, currentCutoff, cutoffById, inCutoff, cutoffTransactions, cutoffLabel, nextExpectedPayday,
    summarize, spendingByCategory, currentSummary, cutoffSummaries, monthlySummaries, periodTransactions,
    sortTransactions, filterTransactions, txEffectOnWallet,
    addTransactionOps, updateTransactionOps, deleteTransactionOps, recordSalaryOps, isClosureSavings,
    allocateByPct, defaultAllocationItems, getAllocation, allocationStatus, saveAllocationOps, allocationActuals,
    weekIndexOf, weekRange, weekCount, amountAt, weeklyBudget, weeksOf, getClosure, closeWeekOps, reopenWeekOps,
    addBudgetCategoryOps, updateBudgetCategoryOps, removeBudgetCategoryOps,
    addWalletOps, updateWalletOps, removalCheck, removeItemOps, restoreItemOps,
    addGoalOps, updateGoalOps, goalInfo,
    addBillOps, updateBillOps, billStatus, billsForMonth, incomingBills, billPayment, payBillOps,
    addDebtOps, updateDebtOps, debtInfo, debtSummary, payDebtOps,
    safeToSpend, reminders, updateSettingsOps, transactionsCSV
  };
});
