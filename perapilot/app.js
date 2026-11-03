/*
 * PeraPilot — application shell: router, pages, forms.
 * All money rules live in js/logic.js. This file only reads state, renders it, and
 * turns form input into logic calls; every change goes through commit() so it is
 * validated, saved to IndexedDB atomically, and then rendered from the same state.
 */
(function () {
  'use strict';
  const PP = window.PP, L = PP.Logic, UI = PP.UI, DB = PP.DB, Demo = PP.Demo;
  const { esc, icon, chip, bar, empty, fld } = UI;
  const fmt = L.formatPeso;
  const TX = L.TX;

  let S = null;       // in-memory state (always equals what is saved)
  let db = null;      // persistence
  let route = { page: 'dashboard', query: {} };
  let ALLOC = null;   // live allocation editor model
  const VS = {        // view state (not saved)
    tx: { from: '', to: '', type: '', category: '', walletId: '', q: '', limit: 100 },
    cutoffId: null, budgetCutoff: null, budgetWeek: null, billMonth: null,
    report: { sel: 'cur', from: '', to: '' }
  };
  const $ = (s, r) => (r || document).querySelector(s);
  const today = () => L.todayISO();
  const wname = (id) => { const w = S.wallets.find((x) => x.id === id); return w ? w.name : '—'; };
  const cents0 = (s) => (String(s || '').trim() === '' ? 0 : L.toCents(s));

  /* ================================================================== */
  /* Saving                                                             */
  /* ================================================================== */
  /** Validate-result -> save -> update memory -> render. Returns errors[] or null. */
  async function commit(res, msg) {
    if (!res.ok) return res.errors;
    try { await db.commit(res.ops); }
    catch (e) { console.error(e); return ['Could not save to this device (' + (e && e.message || e) + '). Nothing was changed.']; }
    S = L.applyOps(S, res.ops);
    render();
    if (msg) UI.toast(msg);
    return null;
  }
  async function replaceAll(state, app) {
    await db.replaceAll(state, app);
    S = state; render();
  }
  async function reloadFromDB() {
    if (!db || !db.persistent) return;
    const loaded = await db.loadAll();
    if (JSON.stringify(loaded.state) !== JSON.stringify(S)) { S = loaded.state; render(); }
  }

  /* ================================================================== */
  /* Small view helpers                                                 */
  /* ================================================================== */
  const TX_ICON = { income: 'plus', expense: 'cash', savings: 'goal', transfer: 'swap', bill_payment: 'bill', debt_payment: 'debt', goal_withdrawal: 'undo' };
  function txInfo(t) {
    const cat = t.category || '';
    switch (t.type) {
      case TX.INCOME: return { sign: '+', cls: 'pos', sub: `${cat}${t.isSalary ? ' · Salary' : ''} · ${wname(t.walletId)}` };
      case TX.EXPENSE: return { sign: '−', cls: '', sub: `${cat} · ${wname(t.walletId)}` };
      case TX.BILL: return { sign: '−', cls: '', sub: `Bill · ${cat} · ${wname(t.walletId)}` };
      case TX.DEBT: return { sign: '−', cls: '', sub: `Debt payment · ${wname(t.walletId)}` };
      case TX.SAVINGS: return { sign: '−', cls: 'gold', sub: `Saved to ${cat} · from ${wname(t.walletId)}` };
      case TX.WITHDRAW: return { sign: '+', cls: 'gold', sub: `Withdrawn from ${cat} · to ${wname(t.walletId)}` };
      case TX.TRANSFER: return { sign: '', cls: '', sub: `${wname(t.walletId)} → ${wname(t.toWalletId)}` };
    }
    return { sign: '', cls: '', sub: '' };
  }
  function txTitle(t) { return t.note || t.category || L.TX_LABEL[t.type]; }
  function txItem(t, o) {
    o = o || {};
    const i = txInfo(t);
    const locked = L.isClosureSavings(S, t.id);
    const actions = o.actions ? `<div class="tx-actions">${locked ? chip('Week closing', 'gold') : `<button class="icon-btn sm" data-act="tx-edit" data-id="${t.id}" aria-label="Edit">${icon('edit')}</button><button class="icon-btn sm danger" data-act="tx-delete" data-id="${t.id}" aria-label="Delete">${icon('trash')}</button>`}</div>` : '';
    return `<li><span class="tx-ic ${t.type}">${icon(TX_ICON[t.type] || 'cash')}</span><div class="li-main"><div class="li-title">${esc(txTitle(t))}</div><div class="li-sub">${L.formatDate(t.date)} · ${esc(i.sub)}</div></div><div class="li-amt ${i.cls}">${i.sign}${fmt(t.amount)}${o.actions ? '' : ''}</div>${actions}</li>`;
  }
  function walletOpts(includeId) {
    const b = L.walletBalances(S);
    return L.activeWallets(S).concat(S.wallets.filter((w) => w.archivedAt && w.id === includeId))
      .map((w) => ({ value: w.id, label: `${w.name} — ${fmt(b[w.id] || 0)}` }));
  }
  function defaultWalletId() {
    const act = L.activeWallets(S);
    const last = L.sortTransactions(S.transactions).find((t) => act.some((w) => w.id === t.walletId));
    return last ? last.walletId : (act[0] ? act[0].id : '');
  }
  function needWallet() {
    if (L.activeWallets(S).length) return false;
    UI.toast('Add a wallet first (Cash, GCash, bank…).', 'error');
    openWalletForm();
    return true;
  }
  function pageHead(title, sub, actions) {
    return `<div class="page-head"><div><h2>${esc(title)}</h2>${sub ? `<p>${sub}</p>` : ''}</div><div class="row wrap">${actions || ''}</div></div><div style="height:14px"></div>`;
  }
  function kv(k, v, cls) { return `<div class="kv"><span>${k}</span><b class="num ${cls || ''}">${v}</b></div>`; }

  /* ================================================================== */
  /* DASHBOARD                                                          */
  /* ================================================================== */
  function pageDashboard() {
    const t = today();
    const cut = L.currentCutoff(S);
    const sts = L.safeToSpend(S, t);
    const np = sts.payday;
    const sum = cut ? L.currentSummary(S).summary : L.summarize([]);
    const active = L.activeWallets(S);
    const alerts = L.reminders(S, t).slice(0, 4);
    const saved = L.totalSaved(S);

    let paydayVal, paydaySub;
    if (np.overdue) { paydayVal = `<span class="warntxt">${np.overdueDays} day${np.overdueDays > 1 ? 's' : ''} late</span>`; paydaySub = `Expected ${L.formatDate(np.date)} · not received yet`; }
    else if (np.daysLeft === 0) { paydayVal = 'Today'; paydaySub = `Expected ${L.formatDate(np.date)}`; }
    else { paydayVal = `${np.daysLeft}<small style="font-size:16px;font-weight:600"> day${np.daysLeft > 1 ? 's' : ''}</small>`; paydaySub = `Expected ${L.formatDate(np.date)}`; }

    const stsNote = [];
    if (sts.reservedTotal) stsNote.push(`${fmt(sts.reservedTotal)} unpaid bills before payday`);
    if (sts.earmarkedTotal) stsNote.push(`${fmt(sts.earmarkedTotal)} planned goals/tithes`);
    const stsFoot = sts.limitedByBudget ? `Limited by your planned variable budget (${fmt(sts.variableLeft)} left).` : (stsNote.length ? `After ${stsNote.join(' and ')}.` : 'Balance minus upcoming bills.');

    const hero = `<section class="hero" aria-label="Overview">
      <div class="hero-tile main"><div class="label">Total Balance</div><div class="value num" id="total-balance">${fmt(sts.total)}</div><div class="sub">${active.length} wallet${active.length === 1 ? '' : 's'} · spendable money only</div><div class="hero-note">${icon('info')}<span>Savings goals (${fmt(saved)}) are kept separate and not counted here.</span></div></div>
      <div class="hero-tile tile-sm"><div class="label">Safe to Spend</div><div class="value num accent" id="safe-to-spend">${fmt(sts.safe)}</div><div class="sub"><b class="goldtxt num">${fmt(sts.daily)}</b> a day for ${sts.days} day${sts.days > 1 ? 's' : ''}</div><div class="sub" style="margin-top:6px;font-size:12px">${esc(stsFoot)}</div></div>
      <div class="hero-tile tile-sm"><div class="label">Days Before Payday</div><div class="value num" id="days-before">${paydayVal}</div><div class="sub">${paydaySub}</div><div class="sub" style="margin-top:6px;font-size:12px">Expected payday is a guide only.</div></div>
    </section>`;

    const alertHtml = alerts.length ? `<div class="alerts" style="margin-top:14px">${alerts.map((a) => `<div class="alert ${a.level === 'danger' ? 'danger' : a.level === 'warn' ? 'warn' : ''}">${icon(a.level === 'info' ? 'info' : 'alert')}<div class="a-text"><b>${esc(a.title)}</b>${esc(a.text)}</div>${a.action ? `<button class="link" data-act="${a.action}">Record</button>` : a.link ? `<a href="${a.link}">Open</a>` : ''}</div>`).join('')}</div>` : '<div style="height:14px"></div>';

    const lbl = cut ? `Since ${L.formatDateShort(cut.start)}` : 'No cut-off yet';
    const cards = `<div class="grid three">
      <div class="card stat stat-card"><div class="label">Income · this cut-off</div><div class="value num pos">${fmt(sum.income)}</div><div class="sub">${lbl}${sum.otherIncome ? ` · incl. ${fmt(sum.otherIncome)} other` : ''}</div></div>
      <div class="card stat stat-card exp"><div class="label">Expenses · this cut-off</div><div class="value num">${fmt(sum.expenses)}</div><div class="sub">Spending ${fmt(sum.variable)} · Bills ${fmt(sum.bills)} · Debt ${fmt(sum.debt)}</div></div>
      <div class="card stat stat-card sav"><div class="label">Savings · this cut-off</div><div class="value num gold">${fmt(sum.savingsNet)}</div><div class="sub">${sum.withdrawals ? `Saved ${fmt(sum.contributions)} · withdrew ${fmt(sum.withdrawals)}` : 'Not counted as expenses'} · All goals ${fmt(saved)}</div></div>
    </div>`;

    return `${hero}${alertHtml}${cards}
      <div class="grid two" style="margin-top:14px">
        ${dashWeekly(cut, t)}
        ${dashBills(t)}
        ${dashDebts(t)}
        ${dashRecent()}
      </div>`;
  }
  function dashWeekly(cut, t) {
    if (!cut) return `<section class="card"><div class="card-head"><h2>Weekly Budget</h2></div>${empty('No cut-off yet', 'Record the salary you actually received to start a cut-off and its weekly budget.', '<button class="btn primary sm" data-act="record-salary">Record salary</button>')}</section>`;
    const weeks = L.weeksOf(S, cut, t);
    const w = weeks.find((x) => x.current) || weeks[weeks.length - 1];
    const cls = w.remaining < 0 ? 'danger' : w.base && w.spent / w.budget >= .8 ? 'warn' : '';
    const rows = w.rows.map((r) => `<div class="cat-row"><div class="top"><span class="name">${esc(r.name)}</span><span class="num small ${r.remaining < 0 ? 'neg' : 'muted'}">${fmt(r.spent)} / ${fmt(r.budget)}</span></div>${bar(r.pct, r.pct > 1 ? 'danger' : r.pct >= .8 ? 'warn' : '')}</div>`).join('');
    return `<section class="card"><div class="card-head"><h2>Weekly Budget</h2><a class="link" href="#/budget">Open</a></div>
      <div class="row between wrap"><div><div class="small muted">Week ${w.idx} · ${L.formatDateShort(w.start)} – ${L.formatDateShort(w.end)}</div><div style="font-size:24px;font-weight:700" class="num ${w.remaining < 0 ? 'neg' : ''}">${fmt(w.remaining)} <small class="muted" style="font-size:13px;font-weight:500">left</small></div></div><div class="right small muted">Spent ${fmt(w.spent)}<br>of ${fmt(w.budget)}${w.carryIn ? ` (incl. ${fmt(w.carryIn)} carried)` : ''}</div></div>
      <div style="margin:10px 0 6px">${bar(w.budget ? w.spent / w.budget : 0, cls)}</div>${rows || '<p class="muted small">No budget categories yet.</p>'}</section>`;
  }
  function dashBills(t) {
    const list = L.incomingBills(S, t);
    const body = list.length ? `<ul class="list">${list.slice(0, 5).map((r) => `<li><span class="tx-ic bill_payment">${icon('bill')}</span><div class="li-main"><div class="li-title">${esc(r.bill.name)}</div><div class="li-sub">${r.status === 'overdue' ? `<span class="neg">Overdue · due ${L.formatDateShort(r.dueDate)}</span>` : r.daysLeft === 0 ? 'Due today' : `Due ${L.formatDateShort(r.dueDate)} · in ${r.daysLeft} day${r.daysLeft > 1 ? 's' : ''}`}</div></div><div class="li-amt">${fmt(r.bill.amount)}</div><button class="btn ghost xs" data-act="bill-pay" data-id="${r.bill.id}" data-month="${L.monthKey(t)}">Pay</button></li>`).join('')}</ul>${list.length > 5 ? `<p class="small muted" style="margin-top:8px">+ ${list.length - 5} more this month</p>` : ''}`
      : (S.bills.length ? '<p class="muted" style="margin:6px 0">All bills for this month are paid. 🎉</p>' : empty('No bills yet', 'Add your monthly obligations to see what is coming.', '<a class="btn ghost sm" href="#/bills">Add bills</a>'));
    return `<section class="card"><div class="card-head"><h2>Incoming Bills</h2><a class="link" href="#/bills">All bills</a></div>${body}</section>`;
  }
  function dashDebts(t) {
    const d = L.debtSummary(S, t);
    const body = d.list.length ? `<div class="row between" style="margin-bottom:8px"><div><div class="small muted">Total still owed</div><div style="font-size:24px;font-weight:700" class="num">${fmt(d.totalRemaining)}</div></div><div class="right small muted">${d.count} open debt${d.count === 1 ? '' : 's'}</div></div>
      <ul class="list">${d.open.slice(0, 4).map((x) => `<li><div class="li-main"><div class="li-title">${esc(x.debt.name)}</div>${bar(x.pct, '')}<div class="li-sub">${x.debt.dueDate ? `Due ${L.formatDateShort(x.debt.dueDate)}` : 'No due date'}</div></div><div class="li-amt">${fmt(x.remaining)}</div></li>`).join('')}</ul>` : empty('No debts recorded', 'Debt-free, or add one to track payments.', '<a class="btn ghost sm" href="#/debts">Add debt</a>');
    return `<section class="card"><div class="card-head"><h2>Debt Summary</h2><a class="link" href="#/debts">Manage</a></div>${body}</section>`;
  }
  function dashRecent() {
    const txs = L.sortTransactions(S.transactions).slice(0, 8);
    return `<section class="card"><div class="card-head"><h2>Recent Transactions</h2><a class="link" href="#/transactions">View all</a></div>${txs.length ? `<ul class="list">${txs.map((t) => txItem(t)).join('')}</ul>` : empty('No transactions yet', 'Record your first income or expense.', '<button class="btn primary sm" data-act="add-tx">Add transaction</button>')}</section>`;
  }

  /* ================================================================== */
  /* TRANSACTIONS                                                       */
  /* ================================================================== */
  function pageTransactions() {
    const f = VS.tx;
    const cats = Array.from(new Set(S.transactions.map((t) => t.category).filter(Boolean))).sort();
    const typeOpts = [{ value: '', label: 'All types' }].concat(Object.keys(L.TX_LABEL).map((k) => ({ value: k, label: L.TX_LABEL[k] })));
    const walletOptsAll = [{ value: '', label: 'All wallets' }].concat(S.wallets.map((w) => ({ value: w.id, label: w.name + (w.archivedAt ? ' (archived)' : '') })));
    return `${pageHead('Transactions', 'Every peso in and out, in one place.', `<button class="btn ghost sm" data-act="tx-export">${icon('download')} Export CSV</button><button class="btn primary sm" data-act="add-tx">${icon('plus')} Add</button>`)}
      <section class="card" style="margin-bottom:14px"><div class="filters" id="tx-filters">
        <div class="wide">${fld.text('q', 'Search', f.q, { placeholder: 'Note or category', type: 'search' })}</div>
        ${fld.date('from', 'From', f.from)}${fld.date('to', 'To', f.to)}
        ${fld.select('type', 'Type', typeOpts, f.type)}
        ${fld.select('category', 'Category', [{ value: '', label: 'All categories' }].concat(cats.map((c) => ({ value: c, label: c }))), f.category)}
        ${fld.select('walletId', 'Wallet', walletOptsAll, f.walletId)}
        <div><button class="btn ghost sm block" data-act="tx-reset">Clear filters</button></div>
      </div></section>
      <section class="card" id="tx-card">${txListHtml()}</section>`;
  }
  function txListHtml() {
    const f = VS.tx;
    const all = L.filterTransactions(S, f);
    const shown = all.slice(0, f.limit);
    const s = L.summarize(all);
    const head = `<div class="row between wrap" style="margin-bottom:8px"><div class="small muted" id="tx-count">${all.length} transaction${all.length === 1 ? '' : 's'}</div><div class="small row wrap" style="gap:14px"><span>In <b class="num pos">${fmt(s.income + s.withdrawals)}</b></span><span>Out <b class="num">${fmt(s.expenses)}</b></span><span>Saved <b class="num gold">${fmt(s.savingsNet)}</b></span>${s.transfers ? `<span class="muted">Transfers ${fmt(s.transfers)}</span>` : ''}</div></div>`;
    if (!all.length) return head + empty(S.transactions.length ? 'Nothing matches these filters' : 'No transactions yet', S.transactions.length ? 'Try clearing a filter.' : 'Add an income or expense to begin.');
    return head + `<ul class="list">${shown.map((t) => txItem(t, { actions: true })).join('')}</ul>${all.length > shown.length ? `<div class="center" style="margin-top:12px"><button class="btn ghost sm" data-act="tx-more">Show more (${all.length - shown.length} left)</button></div>` : ''}`;
  }
  function refreshTxList() { const c = $('#tx-card'); if (c) c.innerHTML = txListHtml(); }

  /* ---- add / edit transaction ---- */
  function expenseCatOptions(ex) {
    const budget = S.budgetCategories.filter((c) => !c.archivedOn || (ex && ex.budgetCategoryId === c.id)).map((c) => ({ value: 'b:' + c.id, label: c.name, group: 'Weekly budget' }));
    let others = L.OTHER_EXPENSE_CATEGORIES.slice();
    if (ex && !ex.budgetCategoryId && ex.category && !others.includes(ex.category)) others.unshift(ex.category);
    return budget.concat(others.map((c) => ({ value: 'c:' + c, label: c, group: 'Other expenses' })));
  }
  function txFields(type, v, ex) {
    const wl = (label) => fld.select('walletId', label, walletOpts(v.walletId), v.walletId);
    const money = fld.money('amount', 'Amount', v.amount, { required: true });
    const date = fld.date('date', 'Date', v.date, { max: today(), required: true });
    const note = (label, ph) => fld.textarea('note', label, v.note, { placeholder: ph || '' });
    const goals = S.goals.filter((g) => !g.archivedAt || (ex && ex.goalId === g.id)).map((g) => ({ value: g.id, label: g.name }));
    switch (type) {
      case TX.EXPENSE: return `<div class="form-grid">${money}${date}</div>${fld.select('category', 'Category', expenseCatOptions(ex), v.category)}<p class="hint">Weekly budget categories reduce that week\'s budget. “Other expenses” do not.</p>${wl('Paid from')}${note('Note (optional)', 'e.g. Palengke — gulay at isda')}`;
      case TX.INCOME: {
        if (ex && ex.isSalary) return `<div class="note" style="margin-bottom:12px">This is a recorded salary. Its date is the start of its cut-off.</div><div class="form-grid">${money}${date}</div>${wl('Received in')}${fld.date('forPayday', 'Expected payday it covers', v.forPayday || '')}${note('Note')}`;
        return `<div class="form-grid">${money}${date}</div>${fld.select('category', 'Category', L.INCOME_CATEGORIES.concat(ex && ex.category && !L.INCOME_CATEGORIES.includes(ex.category) ? [ex.category] : []).map((c) => ({ value: c, label: c })), v.category || 'Other')}<p class="hint">For your salary use “Record salary” so a new cut-off begins.</p>${wl('Received in')}${note('Note (optional)')}`;
      }
      case TX.SAVINGS: return goals.length ? `<div class="form-grid">${money}${date}</div>${fld.select('goalId', 'Savings goal', goals, v.goalId)}${wl('Take money from')}${note('Note (optional)')}<p class="hint">Moves money from your wallet into the goal. It is not counted as an expense.</p>` : `<p class="muted">Create a savings goal first.</p><a class="btn ghost sm" href="#/goals" data-modal-close>Go to goals</a>`;
      case TX.WITHDRAW: return goals.length ? `<div class="form-grid">${money}${date}</div>${fld.select('goalId', 'Withdraw from goal', goals, v.goalId)}${wl('Return money to')}${note('Reason (optional)')}` : `<p class="muted">You have no savings goals.</p>`;
      case TX.TRANSFER: return `<div class="form-grid">${money}${date}</div><div class="form-grid">${fld.select('walletId', 'From wallet', walletOpts(v.walletId), v.walletId)}${fld.select('toWalletId', 'To wallet', walletOpts(v.toWalletId), v.toWalletId)}</div>${note('Purpose (required)', 'e.g. Cash for palengke')}<p class="hint">Transfers move money between your own wallets. They are not income or expenses.</p>`;
      case TX.BILL: case TX.DEBT: return `<div class="note" style="margin-bottom:12px">${type === TX.BILL ? 'Bill payment' : 'Debt payment'}: ${esc(ex.note || ex.category)}</div><div class="form-grid">${money}${date}</div>${wl('Paid from')}${note('Note')}`;
    }
    return '';
  }
  function openTxForm(o) {
    o = o || {};
    if (!o.tx && needWallet()) return;
    const ex = o.tx || null;
    const t = today();
    const v = ex ? { amount: L.centsToInput(ex.amount), date: ex.date, walletId: ex.walletId, toWalletId: ex.toWalletId || '', note: ex.note || '', goalId: ex.goalId || '', forPayday: ex.forPayday || '', category: ex.type === TX.EXPENSE ? (ex.budgetCategoryId ? 'b:' + ex.budgetCategoryId : 'c:' + ex.category) : ex.category }
      : { amount: '', date: t, walletId: defaultWalletId(), toWalletId: '', note: '', goalId: o.goalId || '', forPayday: '', category: '' };
    let type = ex ? ex.type : (o.type || TX.EXPENSE);
    const types = [[TX.EXPENSE, 'Expense'], [TX.INCOME, 'Income'], [TX.SAVINGS, 'Savings'], [TX.TRANSFER, 'Transfer'], [TX.WITHDRAW, 'Withdraw']];
    const seg = ex ? '' : `<div class="seg" role="radiogroup" aria-label="Transaction type">${types.map(([k, l]) => `<label><input type="radio" name="type" value="${k}"${k === type ? ' checked' : ''}><span>${l}</span></label>`).join('')}</div>`;
    UI.form({
      title: ex ? `Edit ${L.TX_LABEL[ex.type].toLowerCase()}` : 'Add transaction',
      body: `${seg}<div id="tx-dyn">${txFields(type, v, ex)}</div>`,
      submitText: ex ? 'Save changes' : 'Save',
      onOpen(f) {
        const dyn = $('#tx-dyn', f);
        f.addEventListener('change', (e) => {
          if (e.target.name !== 'type') return;
          const cur = UI.formValues(f);
          Object.assign(v, { amount: cur.amount || '', date: cur.date || v.date, walletId: cur.walletId || v.walletId, note: cur.note || '' });
          type = e.target.value; v.category = ''; v.toWalletId = '';
          dyn.innerHTML = txFields(type, v, ex);
        });
      },
      async onSubmit(val) {
        const inp = { type, amount: L.toCents(val.amount), date: val.date, walletId: val.walletId, note: val.note };
        if (type === TX.EXPENSE) { const c = val.category || ''; if (c.startsWith('b:')) inp.budgetCategoryId = c.slice(2); else inp.category = c.slice(2); }
        else if (type === TX.INCOME) { inp.category = val.category; inp.forPayday = val.forPayday; }
        else if (type === TX.SAVINGS || type === TX.WITHDRAW) inp.goalId = val.goalId;
        else if (type === TX.TRANSFER) inp.toWalletId = val.toWalletId;
        const res = ex ? L.updateTransactionOps(S, ex.id, inp, t) : L.addTransactionOps(S, inp, t);
        const errs = await commit(res, ex ? 'Changes saved' : `${L.TX_LABEL[type]} saved`);
        if (errs) return errs;
        if (!ex && type === TX.EXPENSE && res.tx.budgetCategoryId) budgetWarning(res.tx);
      }
    });
  }
  function budgetWarning(tx) {
    const cut = L.currentCutoff(S); if (!cut) return;
    const wk = L.weeklyBudget(S, cut, L.weekIndexOf(cut, tx.date), today());
    const r = wk.rows.find((x) => x.id === tx.budgetCategoryId);
    if (r && r.remaining < 0) UI.toast(`${r.name} is over its weekly budget by ${fmt(-r.remaining)}.`, 'error');
  }

  /* ---- record salary ---- */
  function openSalaryForm() {
    if (needWallet()) return;
    const t = today();
    const last = L.currentCutoff(S);
    const v = { amount: '', date: t, walletId: last ? last.walletId : defaultWalletId() };
    const info = (date) => {
      if (!L.isISO(date)) return '';
      const pd = L.nearestPayday(S.settings, date); const d = L.diffDays(pd, date);
      const when = d === 0 ? 'right on time' : d > 0 ? `${d} day${d > 1 ? 's' : ''} after` : `${-d} day${d < -1 ? 's' : ''} before`;
      return `Matches the expected payday of <b>${L.formatDate(pd)}</b> (${d === 0 ? when : 'received ' + when}). The new cut-off starts on <b>${L.formatDate(date)}</b>, the day you actually received it.`;
    };
    UI.form({
      title: 'Record salary received',
      body: `<div class="note" style="margin-bottom:14px">Only record a salary once it has actually arrived. This starts a new cut-off.</div>
        ${fld.money('amount', 'Salary amount received', '', { required: true })}
        ${fld.date('date', 'Date received', v.date, { max: t, required: true })}
        <p class="hint" id="sal-info">${info(v.date)}</p>
        ${fld.select('walletId', 'Which wallet received it?', walletOpts(v.walletId), v.walletId)}
        ${fld.text('note', 'Note (optional)', '', { placeholder: 'e.g. 15th payday' })}`,
      submitText: 'Record salary',
      onOpen(f) { f.querySelector('[name=date]').addEventListener('input', (e) => { $('#sal-info', f).innerHTML = info(e.target.value); }); },
      async onSubmit(val) {
        const inp = { amount: L.toCents(val.amount), date: val.date, walletId: val.walletId, note: val.note };
        let res = L.recordSalaryOps(S, inp, t);
        if (!res.ok && /already recorded/.test(res.errors[0])) {
          if (!(await UI.confirm({ title: 'Possible duplicate', message: 'A salary with the same amount, date and wallet is already recorded. Is this a different salary?', confirmText: 'Yes, record again' }))) return { cancel: true };
          inp.allowDuplicate = true; res = L.recordSalaryOps(S, inp, t);
        }
        if (!res.ok) return res.errors;
        const ok = await UI.confirm({
          title: 'Start a new cut-off?', confirmText: 'Record salary & start cut-off', html: true,
          message: `<p><b>${fmt(inp.amount)}</b> will be added to <b>${esc(wname(inp.walletId))}</b>.</p><ul><li>A new cut-off begins on <b>${L.formatDate(inp.date)}</b>.</li><li>Your cut-off income, expenses and savings reset to zero.</li><li>All previous transactions stay in your history.</li></ul>`
        });
        if (!ok) return { cancel: true };
        const errs = await commit(res, 'Salary recorded — new cut-off started');
        if (errs) return errs;
        VS.cutoffId = null; VS.budgetCutoff = null; VS.budgetWeek = null;
        location.hash = '#/cutoff';
      }
    });
  }

  /* ================================================================== */
  /* SALARY & CUT-OFF (allocation plan)                                  */
  /* ================================================================== */
  function pageCutoff() {
    const cuts = L.getCutoffs(S);
    if (!cuts.length) return `${pageHead('Salary & Cut-off', 'Your cut-off begins when salary is actually received.')}<section class="card">${empty('No cut-off yet', 'Record your salary when it arrives. The expected payday alone never starts a cut-off.', '<button class="btn primary" data-act="record-salary">Record salary</button>')}</section>`;
    const cur = L.currentCutoff(S);
    const cut = (VS.cutoffId && L.cutoffById(S, VS.cutoffId)) || cur;
    const isCurrent = cut.id === cur.id;
    const t = today();
    const saved = L.getAllocation(S, cut.id);
    const items = saved ? saved.items.map((i) => ({ ...i })) : L.defaultAllocationItems(cut.amount, S.settings);
    ALLOC = { cutoffId: cut.id, salary: cut.amount, items, saved: !!saved };
    const summary = L.summarize(L.cutoffTransactions(S, cut));
    const d = L.diffDays(cut.forPayday, cut.start);
    const late = d === 0 ? 'Received on the expected date' : d > 0 ? `Received ${d} day${d > 1 ? 's' : ''} after the expected payday` : `Received ${-d} day${d < -1 ? 's' : ''} before the expected payday`;
    const np = L.nextExpectedPayday(S, t);
    const actual = L.allocationActuals(S, cut);
    const planOf = (k) => (items.find((i) => i.key === k) || { amount: 0 }).amount;

    const selector = cuts.length > 1 ? `<div style="margin-bottom:14px">${fld.select('cutoffPick', 'Showing cut-off', cuts.slice().reverse().map((c) => ({ value: c.id, label: `#${c.index} · ${L.cutoffLabel(c)} · ${fmt(c.amount)}${c.id === cur.id ? ' (current)' : ''}` })), cut.id, { 'data-change': 'cutoff-pick' })}</div>` : '';

    const allocRows = items.map((i, n) => `<div class="alloc-row" data-alloc="${n}"><div><b>${esc(i.label)}</b></div><div class="input-suffix"><input type="text" inputmode="decimal" name="pct" value="${i.pct}" aria-label="${esc(i.label)} percent"><span>%</span></div><div class="input-prefix"><b>₱</b><input type="text" inputmode="decimal" name="amount" value="${L.centsToInput(i.amount)}" aria-label="${esc(i.label)} amount"></div></div>`).join('');

    const pva = [['fixed', 'Fixed Expenses', 'Bills & debt payments', actual.fixed], ['goals', 'Goal Funds', 'Net savings to goals', actual.goals], ['offering', L.TITHES, 'Recorded as “' + L.TITHES + '”', actual.offering], ['variable', 'Variable Expenses', 'Other spending', actual.variable]]
      .map(([k, label, hint, act]) => { const p = planOf(k); const left = p - act; return `<tr><td><b>${esc(label)}</b><div class="small muted">${esc(hint)}</div></td><td class="r">${fmt(p)}</td><td class="r">${fmt(act)}</td><td class="r ${left < 0 ? 'neg' : 'pos'}">${left < 0 ? '−' : ''}${fmt(Math.abs(left))}<div class="small muted">${left < 0 ? 'over plan' : 'left'}</div></td><td style="min-width:90px">${bar(p ? act / p : 0, act > p ? 'danger' : '')}</td></tr>`; }).join('');

    return `${pageHead('Salary & Cut-off', 'Planned allocations are figures only — they never move money.', isCurrent ? `<button class="btn primary sm" data-act="record-salary">Record next salary</button>` : '')}
      ${selector}
      <div class="grid two">
        <section class="card"><div class="card-head"><h2>Cut-off #${cut.index}</h2>${isCurrent ? chip('Current', 'teal') : chip('Past', '')}</div>
          ${kv('Started', L.formatDate(cut.start))}${kv('Ended', cut.end ? L.formatDate(L.addDays(cut.end, -1)) : 'Still running')}
          ${kv('Salary received', fmt(cut.amount), 'pos')}${kv('Into wallet', esc(wname(cut.walletId)))}
          ${kv('Expected payday it covered', L.formatDate(cut.forPayday))}
          <p class="small muted" style="margin:6px 0 10px">${late}.</p>
          ${isCurrent ? `<div class="note">Next expected payday: <b>${L.formatDate(np.date)}</b>${np.overdue ? ` (${np.overdueDays} day${np.overdueDays > 1 ? 's' : ''} ago — not received yet)` : ''}. It is informational only. This cut-off continues until you record the salary you actually received.</div>` : ''}
          <div class="row wrap" style="margin-top:12px"><button class="btn ghost xs" data-act="tx-edit" data-id="${cut.id}">${icon('edit')} Edit salary entry</button><button class="btn danger-ghost xs" data-act="tx-delete" data-id="${cut.id}">${icon('trash')} Delete</button></div>
        </section>
        <section class="card"><div class="card-head"><h2>Cut-off results</h2></div>
          ${kv('Income', fmt(summary.income), 'pos')}${kv('Expenses', fmt(summary.expenses))}
          <div class="small muted" style="margin:-2px 0 4px 2px">Spending ${fmt(summary.variable)} · Bills ${fmt(summary.bills)} · Debt ${fmt(summary.debt)}</div>
          ${kv('Net savings to goals', fmt(summary.savingsNet), 'gold')}
          ${kv('Transfers (not counted)', fmt(summary.transfers))}
          <div class="kv" style="border-top:1px solid var(--line);margin-top:6px;padding-top:10px"><span><b>Net change in balance</b></span><b class="num ${summary.net < 0 ? 'neg' : 'pos'}">${summary.net < 0 ? '−' : ''}${fmt(Math.abs(summary.net))}</b></div>
        </section>
      </div>
      <section class="card" style="margin-top:14px"><div class="card-head"><h2>Salary allocation plan</h2>${saved ? chip('Saved', 'ok') : chip('Not saved yet', 'warn')}</div>
        <p class="muted small">Split ${fmt(cut.amount)} into planned figures. Edit a percent or an amount — the other follows. This is a plan only: your wallet balances change only when you record real transactions.</p>
        <form id="alloc-form" novalidate>${allocRows}<div class="alloc-total" id="alloc-total"></div>
          <div class="form-actions" style="justify-content:flex-start"><button type="button" class="btn primary" data-act="alloc-save">Save plan</button><button type="button" class="btn ghost" data-act="alloc-balance">Put difference in Unassigned</button><button type="button" class="btn ghost" data-act="alloc-reset">Reset to defaults</button></div><div class="form-errors" id="alloc-errors" hidden role="alert"></div></form>
      </section>
      <section class="card" style="margin-top:14px"><div class="card-head"><h2>Planned vs actual</h2></div>
        <p class="muted small">Plan = what you set above. Actual = what your transactions in this cut-off say.</p>
        <div class="table-wrap"><table class="tbl"><thead><tr><th>Line</th><th class="r">Planned</th><th class="r">Actual</th><th class="r">Difference</th><th></th></tr></thead><tbody>${pva}<tr><td><b>Unallocated / Unassigned</b><div class="small muted">Not planned for anything</div></td><td class="r">${fmt(planOf('unassigned'))}</td><td class="r">—</td><td class="r">—</td><td></td></tr></tbody></table></div>
      </section>
      ${cuts.length > 1 ? `<section class="card" style="margin-top:14px"><div class="card-head"><h2>All cut-offs</h2></div><ul class="list">${cuts.slice().reverse().map((c) => `<li><div class="li-main"><div class="li-title">#${c.index} · ${L.cutoffLabel(c)}</div><div class="li-sub">Expected ${L.formatDateShort(c.forPayday)} · received ${L.formatDateShort(c.start)}</div></div><div class="li-amt">${fmt(c.amount)}</div>${c.id === cut.id ? chip('Viewing', 'teal') : `<button class="btn ghost xs" data-act="cutoff-view" data-id="${c.id}">View</button>`}</li>`).join('')}</ul></section>` : ''}`;
  }
  function allocTotals() {
    const st = L.allocationStatus(ALLOC.salary, ALLOC.items);
    const box = $('#alloc-total'); if (!box) return;
    box.classList.toggle('bad', !st.balanced);
    box.innerHTML = st.balanced
      ? `<span>${icon('check')} Allocation totals 100% (${fmt(st.total)})</span><span class="num">${st.pct}%</span>`
      : `<span>${icon('alert')} ${st.diff > 0 ? `${fmt(st.diff)} not yet allocated` : `${fmt(-st.diff)} over the salary`}</span><span class="num">${st.pct}% · ${fmt(st.total)} of ${fmt(ALLOC.salary)}</span>`;
  }
  function afterCutoff() {
    const form = $('#alloc-form'); if (!form || !ALLOC) return;
    allocTotals();
    form.addEventListener('input', (e) => {
      const row = e.target.closest('[data-alloc]'); if (!row) return;
      const it = ALLOC.items[+row.dataset.alloc];
      if (e.target.name === 'pct') {
        const p = parseFloat(String(e.target.value).replace(',', '.'));
        it.pct = isNaN(p) || p < 0 ? 0 : p; it.amount = Math.round(ALLOC.salary * it.pct / 100);
        row.querySelector('[name=amount]').value = L.centsToInput(it.amount);
      } else {
        const c = L.toCents(e.target.value);
        it.amount = isNaN(c) ? 0 : c; it.pct = ALLOC.salary ? Math.round(it.amount / ALLOC.salary * 10000) / 100 : 0;
        row.querySelector('[name=pct]').value = it.pct;
      }
      allocTotals();
    });
  }

  /* ================================================================== */
  /* WEEKLY BUDGET                                                      */
  /* ================================================================== */
  function pageBudget() {
    const cuts = L.getCutoffs(S);
    const head = pageHead('Weekly Budget', 'Based on your current salary cut-off. Bills, debts and savings never reduce it.', cuts.length ? `<button class="btn primary sm" data-act="bc-add">${icon('plus')} Category</button>` : '');
    if (!cuts.length) return `${head}<section class="card">${empty('No cut-off yet', 'The weekly budget follows your salary cut-off. Record your salary to begin.', '<button class="btn primary" data-act="record-salary">Record salary</button>')}</section>`;
    const t = today();
    const cur = L.currentCutoff(S);
    const cut = (VS.budgetCutoff && L.cutoffById(S, VS.budgetCutoff)) || cur;
    const weeks = L.weeksOf(S, cut, t);
    let idx = VS.budgetWeek && VS.budgetWeek <= weeks.length ? VS.budgetWeek : (weeks.find((w) => w.current) || weeks[weeks.length - 1]).idx;
    const w = weeks[idx - 1];
    const selector = cuts.length > 1 ? `<div style="margin-bottom:12px">${fld.select('budgetCutoff', 'Cut-off', cuts.slice().reverse().map((c) => ({ value: c.id, label: `#${c.index} · ${L.cutoffLabel(c)}${c.id === cur.id ? ' (current)' : ''}` })), cut.id, { 'data-change': 'budget-cutoff' })}</div>` : '';
    const tabs = `<div class="tabs" role="tablist">${weeks.map((x) => `<button class="tab ${x.idx === idx ? 'active' : ''}" role="tab" data-act="week-pick" data-i="${x.idx}">Week ${x.idx}${x.canClose ? '<span class="dot" title="Leftover to decide"></span>' : ''}</button>`).join('')}</div>`;
    const status = w.closure ? chip('Closed', 'ok') : w.current ? chip('Current week', 'teal') : w.ended ? chip('Ended', 'warn') : chip('Upcoming', '');
    const cls = w.remaining < 0 ? 'danger' : w.budget && w.spent / w.budget >= .8 ? 'warn' : '';
    const cats = w.rows.map((r) => `<div class="cat-row"><div class="top"><span class="name">${esc(r.name)}</span><span class="num ${r.remaining < 0 ? 'neg' : ''}"><b>${fmt(r.remaining)}</b> <small class="muted">left</small></span><button class="icon-btn sm" data-act="bc-edit" data-id="${r.id}" aria-label="Edit ${esc(r.name)}">${icon('edit')}</button><button class="icon-btn sm danger" data-act="bc-del" data-id="${r.id}" aria-label="Remove ${esc(r.name)}">${icon('trash')}</button></div>${bar(r.pct, r.pct > 1 ? 'danger' : r.pct >= .8 ? 'warn' : '')}<div class="small muted" style="margin-top:4px">Spent ${fmt(r.spent)} of ${fmt(r.budget)}${r.remaining < 0 ? ` · <span class="neg">over by ${fmt(-r.remaining)}</span>` : ''}</div></div>`).join('');

    let closing = '';
    if (w.closure) {
      const c = w.closure;
      closing = `<section class="card" style="margin-top:14px"><div class="card-head"><h2>Leftover decision</h2>${chip('Closed ' + L.formatDateShort(c.closedOn), 'ok')}</div><p style="margin-bottom:6px">${fmt(c.remaining)} was left. You chose:</p><ul class="confirm-msg" style="margin:0 0 10px 18px;padding:0">${c.toSavings ? `<li><b>${fmt(c.toSavings)}</b> moved to savings</li>` : ''}${c.toNext ? `<li><b>${fmt(c.toNext)}</b> added to Week ${w.idx + 1}</li>` : ''}${c.unassigned ? `<li><b>${fmt(c.unassigned)}</b> left unassigned</li>` : ''}</ul><button class="btn ghost sm" data-act="week-reopen" data-id="${c.id}">${icon('undo')} Re-open this week</button></section>`;
    } else if (w.canClose) {
      closing = `<section class="card" style="margin-top:14px;border-color:#ecd9a5;background:#fffaf0"><div class="card-head"><h2>Week ${w.idx} has ${fmt(w.remaining)} left over</h2></div><p class="muted small">Nothing carries over automatically. Choose: move it to savings/goals, add it to next week, split it, or leave it unassigned.</p><button class="btn gold" data-act="week-close" data-cut="${cut.id}" data-i="${w.idx}">Decide what to do</button></section>`;
    } else if (w.ended && !w.closure) {
      closing = `<section class="card" style="margin-top:14px"><p class="muted" style="margin:0">This week ended with no leftover${w.remaining < 0 ? ` (over budget by ${fmt(-w.remaining)})` : ''}.</p></section>`;
    }
    return `${head}${selector}${tabs}
      <section class="card"><div class="card-head"><div><h2>Week ${w.idx} · ${L.formatDate(w.start)} – ${L.formatDate(w.end)}</h2></div>${status}</div>
        <div class="grid three" style="margin-bottom:12px"><div class="stat"><span class="label">Budget</span><span class="value num" style="font-size:20px">${fmt(w.budget)}</span><span class="sub">${w.carryIn ? `incl. ${fmt(w.carryIn)} you moved from Week ${w.idx - 1}` : 'from your categories'}</span></div><div class="stat"><span class="label">Spent</span><span class="value num" style="font-size:20px">${fmt(w.spent)}</span></div><div class="stat"><span class="label">Remaining</span><span class="value num ${w.remaining < 0 ? 'neg' : 'pos'}" style="font-size:20px">${fmt(w.remaining)}</span></div></div>
        ${bar(w.budget ? w.spent / w.budget : 0, cls)}<div style="height:8px"></div>
        ${cats || empty('No categories this week', 'Add categories like Palengke, Grocery, LPG or Baon.', '<button class="btn primary sm" data-act="bc-add">Add category</button>')}
      </section>${closing}
      <p class="note" style="margin-top:14px">Expenses count here only when you pick a <b>Weekly budget</b> category. Paying a bill, a debt, or saving to a goal never reduces this budget.</p>`;
  }
  function openBudgetCatForm(id) {
    const ex = id ? S.budgetCategories.find((c) => c.id === id) : null;
    UI.form({
      title: ex ? 'Edit budget category' : 'New budget category',
      body: `${fld.text('name', 'Category name', ex ? ex.name : '', { placeholder: 'e.g. Palengke', required: true, maxlength: 40 })}${fld.money('weeklyAmount', 'Weekly amount', ex ? L.centsToInput(ex.weeklyAmount) : '', { required: true })}${ex ? '<p class="hint">A new amount applies from the current week onward. Earlier weeks keep what they had.</p>' : ''}`,
      async onSubmit(v) {
        const inp = { name: v.name, weeklyAmount: L.toCents(v.weeklyAmount) };
        return commit(ex ? L.updateBudgetCategoryOps(S, ex.id, inp, today()) : L.addBudgetCategoryOps(S, inp, today()), ex ? 'Category updated' : 'Category added');
      }
    });
  }
  function openCloseWeek(cutId, idx) {
    const cut = L.cutoffById(S, cutId); if (!cut) return;
    const t = today();
    const wk = L.weeklyBudget(S, cut, idx, t);
    const goals = S.goals.filter((g) => !g.archivedAt);
    UI.form({
      title: `Week ${idx} leftover`, size: 'sm',
      body: `<p>You have <b>${fmt(wk.remaining)}</b> left from Week ${idx}.</p>
        <div class="row wrap" style="margin-bottom:12px"><button type="button" class="btn ghost xs" data-q="savings"${goals.length ? '' : ' disabled'}>All to savings</button><button type="button" class="btn ghost xs" data-q="next">All to next week</button><button type="button" class="btn ghost xs" data-q="split"${goals.length ? '' : ' disabled'}>Split 50/50</button><button type="button" class="btn ghost xs" data-q="none">Leave unassigned</button></div>
        ${fld.money('toSavings', 'Move to savings / goal', '')}
        ${goals.length ? fld.select('goalId', 'Savings goal', goals.map((g) => ({ value: g.id, label: g.name })), '') : '<p class="hint">Create a savings goal to move money there.</p>'}
        ${fld.select('walletId', 'Take savings from wallet', walletOpts(defaultWalletId()), defaultWalletId())}
        <p class="hint" style="margin-top:-6px">Savings leave this wallet and join the goal. Next week's budget is a planning figure only.</p>
        ${fld.money('toNext', `Add to Week ${idx + 1} budget`, '')}
        <div class="note" id="cw-left"></div>`,
      submitText: 'Save decision',
      onOpen(f) {
        const left = () => {
          const s = cents0(f.toSavings.value), n = cents0(f.toNext.value);
          const box = $('#cw-left', f);
          if (isNaN(s) || isNaN(n)) { box.textContent = 'Enter valid amounts.'; return; }
          const r = wk.remaining - s - n;
          box.innerHTML = r < 0 ? `<span class="neg">You assigned ${fmt(-r)} more than you have.</span>` : `Left unassigned: <b>${fmt(r)}</b>`;
        };
        f.addEventListener('input', left);
        f.addEventListener('click', (e) => {
          const q = e.target.closest('[data-q]'); if (!q) return;
          const R = wk.remaining; let s = 0, n = 0;
          if (q.dataset.q === 'savings') s = R; else if (q.dataset.q === 'next') n = R; else if (q.dataset.q === 'split') { s = Math.floor(R / 2); n = R - s; }
          f.toSavings.value = s ? L.centsToInput(s) : ''; f.toNext.value = n ? L.centsToInput(n) : ''; left();
        });
        left();
      },
      async onSubmit(v) {
        const toSavings = cents0(v.toSavings), toNext = cents0(v.toNext);
        if (isNaN(toSavings) || isNaN(toNext)) return ['Enter valid amounts.'];
        if (toSavings > 0 && !v.goalId) return ['Choose a savings goal for the savings amount.'];
        const res = L.closeWeekOps(S, { cutoffId: cutId, weekIdx: idx, toSavings, toNext, goalId: v.goalId, walletId: v.walletId, date: t }, t);
        if (!res.ok) return res.errors;
        if (toSavings > 0) {
          const g = S.goals.find((x) => x.id === v.goalId);
          if (!(await UI.confirm({ title: 'Move to savings?', confirmText: 'Move to savings', message: `${fmt(toSavings)} will leave ${wname(v.walletId)} and be added to “${g.name}”.` }))) return { cancel: true };
        }
        return commit(res, 'Leftover decision saved');
      }
    });
  }

  /* ================================================================== */
  /* BILLS                                                              */
  /* ================================================================== */
  function pageBills() {
    const t = today();
    const key = VS.billMonth || L.monthKey(t);
    const rows = L.billsForMonth(S, key, t);
    const total = L.sum(rows, (r) => r.bill.amount), paid = L.sum(rows.filter((r) => r.status === 'paid'), (r) => r.payment.amount);
    const remain = L.sum(rows.filter((r) => r.status !== 'paid'), (r) => r.bill.amount);
    const stat = (r) => r.status === 'paid' ? chip('Paid ' + L.formatDateShort(r.payment.date), 'ok') : r.status === 'overdue' ? chip(`Overdue ${r.daysLate}d`, 'danger') : r.status === 'pending' ? chip(r.daysLeft === 0 ? 'Due today' : `Due in ${r.daysLeft}d`, r.daysLeft <= 3 ? 'warn' : 'info') : chip('Upcoming', '');
    const list = rows.length ? `<ul class="list">${rows.map((r) => `<li><span class="tx-ic bill_payment">${icon('bill')}</span><div class="li-main"><div class="li-title">${esc(r.bill.name)} ${stat(r)}</div><div class="li-sub">${esc(r.bill.category)} · due ${L.formatDate(r.dueDate)}${r.status === 'paid' ? ` · from ${esc(wname(r.payment.walletId))}` : ''}</div></div><div class="li-amt">${fmt(r.status === 'paid' ? r.payment.amount : r.bill.amount)}</div>
        ${r.status === 'paid' ? `<button class="btn ghost xs" data-act="bill-undo" data-id="${r.payment.id}">Undo</button>` : `<button class="btn primary xs" data-act="bill-pay" data-id="${r.bill.id}" data-month="${key}">Mark paid</button>`}
        <button class="icon-btn sm" data-act="bill-edit" data-id="${r.bill.id}" aria-label="Edit">${icon('edit')}</button><button class="icon-btn sm danger" data-act="bill-del" data-id="${r.bill.id}" aria-label="Remove">${icon('trash')}</button></li>`).join('')}</ul>` : empty('No bills this month', 'Add recurring monthly bills like rent, electricity, water and internet.', '<button class="btn primary sm" data-act="bill-add">Add bill</button>');
    const history = L.sortTransactions(S.transactions.filter((x) => x.type === TX.BILL)).slice(0, 30);
    const archived = S.bills.filter((b) => b.archivedAt);
    return `${pageHead('Bills', 'Monthly obligations. Nothing is paid automatically.', `<button class="btn primary sm" data-act="bill-add">${icon('plus')} Add bill</button>`)}
      <section class="card"><div class="row between wrap" style="margin-bottom:12px"><div class="month-nav"><button class="icon-btn" data-act="bill-month" data-d="-1" aria-label="Previous month">${icon('left')}</button><b>${L.formatMonth(key)}</b><button class="icon-btn" data-act="bill-month" data-d="1" aria-label="Next month">${icon('right')}</button></div>${key !== L.monthKey(t) ? '<button class="btn ghost xs" data-act="bill-month" data-d="0">This month</button>' : ''}</div>
        <div class="grid three" style="margin-bottom:10px"><div class="stat"><span class="label">Total bills</span><span class="value num" style="font-size:20px">${fmt(total)}</span></div><div class="stat"><span class="label">Paid</span><span class="value num pos" style="font-size:20px">${fmt(paid)}</span></div><div class="stat"><span class="label">Still to pay</span><span class="value num ${remain ? '' : 'pos'}" style="font-size:20px">${fmt(remain)}</span></div></div>
        ${list}</section>
      <p class="note" style="margin-top:14px">Bills follow the calendar month, not your cut-off. Once marked paid for a month, a bill returns to pending next month. Bill payments are not counted in your weekly budget.</p>
      <section class="card" style="margin-top:14px"><div class="card-head"><h2>Payment history</h2></div>${history.length ? `<ul class="list">${history.map((x) => `<li><div class="li-main"><div class="li-title">${esc(S.bills.find((b) => b.id === x.billId) ? S.bills.find((b) => b.id === x.billId).name : 'Bill')} · ${L.formatMonth(x.billMonth)}</div><div class="li-sub">Paid ${L.formatDate(x.date)} · ${esc(wname(x.walletId))}</div></div><div class="li-amt">${fmt(x.amount)}</div></li>`).join('')}</ul>` : '<p class="muted">No payments yet.</p>'}</section>
      ${archived.length ? `<section class="card" style="margin-top:14px"><div class="card-head"><h2>Removed bills</h2></div><ul class="list">${archived.map((b) => `<li><div class="li-main"><div class="li-title">${esc(b.name)}</div><div class="li-sub">Hidden since ${L.formatDate(b.archivedAt)} · history kept</div></div><button class="btn ghost xs" data-act="bill-restore" data-id="${b.id}">Restore</button></li>`).join('')}</ul></section>` : ''}`;
  }
  function openBillForm(id) {
    const ex = id ? S.bills.find((b) => b.id === id) : null;
    UI.form({
      title: ex ? 'Edit bill' : 'Add monthly bill',
      body: `${fld.text('name', 'Bill name', ex ? ex.name : '', { placeholder: 'e.g. Electricity', required: true })}<div class="form-grid">${fld.money('amount', 'Usual amount', ex ? L.centsToInput(ex.amount) : '', { required: true })}${fld.number('dueDay', 'Due day of month', ex ? ex.dueDay : '', { min: 1, max: 31, required: true, placeholder: '1–31' })}</div>${fld.select('category', 'Category', L.BILL_CATEGORIES.map((c) => ({ value: c, label: c })), ex ? ex.category : 'Utilities')}<p class="hint">You can change the amount when you pay if this month's bill is different. If a month has fewer days, the last day is used.</p>`,
      async onSubmit(v) {
        const inp = { name: v.name, amount: L.toCents(v.amount), dueDay: parseInt(v.dueDay, 10), category: v.category };
        return commit(ex ? L.updateBillOps(S, ex.id, inp) : L.addBillOps(S, inp, today()), ex ? 'Bill updated' : 'Bill added');
      }
    });
  }
  function openPayBill(id, month) {
    if (needWallet()) return;
    const b = S.bills.find((x) => x.id === id); if (!b) return;
    const t = today();
    const due = L.dateInMonth(month, b.dueDay);
    UI.form({
      title: `Pay ${b.name}`, size: 'sm',
      body: `<div class="note" style="margin-bottom:12px">${esc(b.name)} for <b>${L.formatMonth(month)}</b> · due ${L.formatDate(due)}</div>${fld.money('amount', 'Amount paid', L.centsToInput(b.amount), { required: true })}${fld.date('date', 'Date paid', t, { max: t })}${fld.select('walletId', 'Paid from', walletOpts(defaultWalletId()), defaultWalletId())}${fld.text('note', 'Reference / note (optional)', '', { placeholder: 'e.g. reference no.' })}`,
      submitText: 'Mark as paid',
      async onSubmit(v) {
        const res = L.payBillOps(S, { billId: id, billMonth: month, amount: L.toCents(v.amount), date: v.date, walletId: v.walletId, note: v.note }, t);
        if (!res.ok) return res.errors;
        if (!(await UI.confirm({ title: 'Confirm bill payment', confirmText: 'Pay', message: `${fmt(L.toCents(v.amount))} will be deducted from ${wname(v.walletId)} for ${b.name} (${L.formatMonth(month)}).` }))) return { cancel: true };
        return commit(res, `${b.name} marked paid`);
      }
    });
  }

  /* ================================================================== */
  /* DEBTS                                                              */
  /* ================================================================== */
  function pageDebts() {
    const t = today();
    const d = L.debtSummary(S, t);
    const archived = S.debts.filter((x) => x.archivedAt);
    const cards = d.list.map((x) => {
      const dd = x.debt;
      const st = x.paid ? chip('Paid off', 'ok') : x.overdue ? chip('Overdue', 'danger') : x.dueSoon ? chip('Due soon', 'warn') : '';
      return `<section class="card"><div class="card-head"><h2>${esc(dd.name)}</h2>${st}</div>
        <div class="row between" style="align-items:flex-end"><div><div class="small muted">Remaining</div><div style="font-size:26px;font-weight:700" class="num ${x.paid ? 'pos' : ''}">${fmt(x.remaining)}</div></div><div class="right small muted">of ${fmt(dd.originalAmount)}<br>${dd.dueDate ? 'Due ' + L.formatDate(dd.dueDate) : 'No due date'}</div></div>
        <div style="margin:10px 0 4px">${bar(x.pct, x.paid ? '' : 'navy')}</div><div class="small muted">${fmt(x.totalPaid)} paid · ${Math.round(x.pct * 100)}%</div>
        ${dd.notes ? `<p class="small muted" style="margin-top:8px">${esc(dd.notes)}</p>` : ''}
        ${x.payments.length ? `<details class="disc"><summary>${x.payments.length} payment${x.payments.length > 1 ? 's' : ''}</summary><ul class="list" style="margin-top:6px">${x.payments.slice(0, 20).map((p) => `<li><div class="li-main"><div class="li-title">${L.formatDate(p.date)}</div><div class="li-sub">${esc(wname(p.walletId))}${p.note ? ' · ' + esc(p.note) : ''}</div></div><div class="li-amt">${fmt(p.amount)}</div><button class="icon-btn sm danger" data-act="tx-delete" data-id="${p.id}" aria-label="Undo payment">${icon('undo')}</button></li>`).join('')}</ul></details>` : ''}
        <div class="row wrap" style="margin-top:12px">${x.paid ? '' : `<button class="btn primary sm" data-act="debt-pay" data-id="${dd.id}">Record payment</button>`}<button class="btn ghost sm" data-act="debt-edit" data-id="${dd.id}">${icon('edit')} Edit</button><button class="btn danger-ghost sm" data-act="debt-del" data-id="${dd.id}">${icon('trash')}</button></div></section>`;
    }).join('');
    return `${pageHead('Debts', 'Balances never reset with a cut-off. Payments are always entered by you.', `<button class="btn primary sm" data-act="debt-add">${icon('plus')} Add debt</button>`)}
      ${d.list.length ? `<section class="card" style="margin-bottom:14px"><div class="grid three"><div class="stat"><span class="label">Total still owed</span><span class="value num">${fmt(d.totalRemaining)}</span></div><div class="stat"><span class="label">Open debts</span><span class="value">${d.count}</span></div><div class="stat"><span class="label">Paid so far</span><span class="value num pos">${fmt(L.sum(d.list, (x) => x.totalPaid))}</span><span class="sub">across all debts</span></div></div></section>` : ''}
      ${cards ? `<div class="cards-grid">${cards}</div>` : `<section class="card">${empty('No debts', 'Add a loan or installment to track what you still owe.', '<button class="btn primary" data-act="debt-add">Add debt</button>')}</section>`}
      ${archived.length ? `<section class="card" style="margin-top:14px"><div class="card-head"><h2>Removed debts</h2></div><ul class="list">${archived.map((x) => `<li><div class="li-main"><div class="li-title">${esc(x.name)}</div><div class="li-sub">Payment history kept</div></div><button class="btn ghost xs" data-act="debt-restore" data-id="${x.id}">Restore</button></li>`).join('')}</ul></section>` : ''}`;
  }
  function openDebtForm(id) {
    const ex = id ? S.debts.find((x) => x.id === id) : null;
    const rem = ex ? L.debtRemainingMap(S)[ex.id] : '';
    UI.form({
      title: ex ? 'Edit debt' : 'Add debt',
      body: `${fld.text('name', 'Debt name or creditor', ex ? ex.name : '', { placeholder: 'e.g. Ate Liza, GLoan', required: true })}<div class="form-grid">${fld.money('original', 'Original amount', ex ? L.centsToInput(ex.originalAmount) : '', { required: true })}${fld.money('remaining', 'Remaining balance', ex ? L.centsToInput(rem) : '', { required: true })}</div>${fld.date('dueDate', 'Due date (optional)', ex ? ex.dueDate : '')}${fld.textarea('notes', 'Notes (optional)', ex ? ex.notes : '')}${ex ? '<p class="hint">Remaining balance is what you owe now. To record a payment, use “Record payment” so your wallet is updated too.</p>' : ''}`,
      async onSubmit(v) {
        const inp = { name: v.name, original: L.toCents(v.original), remaining: L.toCents(v.remaining), dueDate: v.dueDate, notes: v.notes };
        return commit(ex ? L.updateDebtOps(S, ex.id, inp) : L.addDebtOps(S, inp), ex ? 'Debt updated' : 'Debt added');
      }
    });
  }
  function openPayDebt(id) {
    if (needWallet()) return;
    const d = S.debts.find((x) => x.id === id); if (!d) return;
    const t = today(); const rem = L.debtRemainingMap(S)[id];
    UI.form({
      title: `Pay ${d.name}`, size: 'sm',
      body: `<div class="note" style="margin-bottom:12px">Remaining balance: <b>${fmt(rem)}</b></div>${fld.money('amount', 'Payment amount', '', { required: true })}<div style="margin:-6px 0 12px"><button type="button" class="btn ghost xs" data-full>Pay full balance (${fmt(rem)})</button></div>${fld.date('date', 'Date paid', t, { max: t })}${fld.select('walletId', 'Paid from', walletOpts(defaultWalletId()), defaultWalletId())}${fld.text('note', 'Note (optional)', '')}`,
      submitText: 'Record payment',
      onOpen(f) { f.querySelector('[data-full]').addEventListener('click', () => { f.amount.value = L.centsToInput(rem); }); },
      async onSubmit(v) {
        const amount = L.toCents(v.amount);
        const res = L.payDebtOps(S, { debtId: id, amount, date: v.date, walletId: v.walletId, note: v.note }, t);
        if (!res.ok) return res.errors;
        if (!(await UI.confirm({ title: 'Confirm debt payment', confirmText: 'Pay', message: `${fmt(amount)} will be deducted from ${wname(v.walletId)}. Remaining after this: ${fmt(rem - amount)}.` }))) return { cancel: true };
        const errs = await commit(res, res.paidOff ? `${d.name} is fully paid! 🎉` : 'Payment recorded');
        return errs;
      }
    });
  }

  /* ================================================================== */
  /* GOALS                                                              */
  /* ================================================================== */
  function pageGoals() {
    const t = today();
    const goals = S.goals.filter((g) => !g.archivedAt);
    const archived = S.goals.filter((g) => g.archivedAt);
    const total = L.totalSaved(S);
    const cards = goals.map((g) => {
      const i = L.goalInfo(S, g, t);
      return `<section class="card goal-card"><div class="card-head"><h2>${esc(g.name)}</h2>${i.done ? chip('Reached', 'ok') : g.targetDate ? chip('By ' + L.formatDateShort(g.targetDate), 'gold') : ''}</div>
        <div class="row between" style="align-items:flex-end"><div class="pct num gold">${Math.round(i.pct * 100)}%</div><div class="right small muted">${fmt(i.saved)} saved<br>of ${fmt(g.target)}</div></div>
        <div style="margin:8px 0">${bar(i.pct, 'gold')}</div>
        <div class="small muted">${i.done ? 'Target reached 🎉' : `${fmt(i.remaining)} to go`}${i.perMonth ? ` · about ${fmt(i.perMonth)}/month to hit your date` : ''}</div>
        <div class="row wrap" style="margin-top:12px"><button class="btn primary sm" data-act="goal-contribute" data-id="${g.id}">Contribute</button><button class="btn ghost sm" data-act="goal-withdraw" data-id="${g.id}"${i.saved > 0 ? '' : ' disabled'}>Withdraw</button><button class="icon-btn" data-act="goal-edit" data-id="${g.id}" aria-label="Edit goal">${icon('edit')}</button><button class="icon-btn danger" data-act="goal-del" data-id="${g.id}" aria-label="Remove goal">${icon('trash')}</button></div></section>`;
    }).join('');
    return `${pageHead('Savings Goals', 'Kept separate from expenses and from your Total Balance.', `<button class="btn primary sm" data-act="goal-add">${icon('plus')} New goal</button>`)}
      <section class="card" style="margin-bottom:14px"><div class="stat"><span class="label">Total saved in goals</span><span class="value num gold">${fmt(total)}</span><span class="sub">Not part of your Total Balance (${fmt(L.totalBalance(S))}). Contributing moves money out of a wallet and into a goal.</span></div></section>
      ${cards ? `<div class="cards-grid">${cards}</div>` : `<section class="card">${empty('No goals yet', 'Create goals like Emergency Fund, New Phone or Travel.', '<button class="btn primary" data-act="goal-add">New goal</button>')}</section>`}
      ${archived.length ? `<section class="card" style="margin-top:14px"><div class="card-head"><h2>Removed goals</h2></div><ul class="list">${archived.map((g) => `<li><div class="li-main"><div class="li-title">${esc(g.name)}</div><div class="li-sub">History kept</div></div><button class="btn ghost xs" data-act="goal-restore" data-id="${g.id}">Restore</button></li>`).join('')}</ul></section>` : ''}`;
  }
  function openGoalForm(id) {
    const ex = id ? S.goals.find((g) => g.id === id) : null;
    UI.form({
      title: ex ? 'Edit goal' : 'New savings goal',
      body: `${fld.text('name', 'Goal name', ex ? ex.name : '', { placeholder: 'e.g. Emergency Fund', required: true })}${fld.money('target', 'Target amount', ex ? L.centsToInput(ex.target) : '', { required: true })}${fld.date('targetDate', 'Target date (optional)', ex ? ex.targetDate : '')}${ex ? '' : fld.money('openingSaved', 'Already saved (optional)', '')}${ex ? '<p class="hint">To change the saved amount, use Contribute or Withdraw so your wallet and history stay correct.</p>' : '<p class="hint">“Already saved” is money you set aside before using PeraPilot. It is not taken from any wallet.</p>'}`,
      async onSubmit(v) {
        const inp = { name: v.name, target: L.toCents(v.target), targetDate: v.targetDate };
        if (!ex) inp.openingSaved = cents0(v.openingSaved);
        return commit(ex ? L.updateGoalOps(S, ex.id, inp) : L.addGoalOps(S, inp), ex ? 'Goal updated' : 'Goal created');
      }
    });
  }

  /* ================================================================== */
  /* WALLETS                                                            */
  /* ================================================================== */
  function pageWallets() {
    const bal = L.walletBalances(S);
    const act = L.activeWallets(S);
    const arch = S.wallets.filter((w) => w.archivedAt);
    const wIcon = { Cash: 'cash', 'E-Wallet': 'wallet', 'Bank Account': 'bill', Other: 'wallet' };
    const cards = act.map((w) => `<section class="card"><div class="row"><span class="tx-ic transfer">${icon(wIcon[w.type] || 'wallet')}</span><div class="grow"><div class="li-title" style="font-size:16px">${esc(w.name)}</div><div class="small muted">${esc(w.type)}</div></div></div>
      <div style="font-size:26px;font-weight:700;margin:12px 0 10px" class="num ${bal[w.id] < 0 ? 'neg' : ''}">${fmt(bal[w.id] || 0)}</div>
      <div class="row wrap"><a class="btn ghost xs" href="#/transactions?wallet=${w.id}">History</a><button class="btn ghost xs" data-act="wallet-edit" data-id="${w.id}">${icon('edit')} Edit</button><button class="btn danger-ghost xs" data-act="wallet-del" data-id="${w.id}">${icon('trash')} Delete</button></div></section>`).join('');
    return `${pageHead('Wallets & Accounts', 'Where your spendable money lives.', `<button class="btn ghost sm" data-act="add-transfer">${icon('swap')} Transfer</button><button class="btn primary sm" data-act="wallet-add">${icon('plus')} Add wallet</button>`)}
      <section class="card" style="margin-bottom:14px"><div class="stat"><span class="label">Total Balance</span><span class="value num">${fmt(L.totalBalance(S))}</span><span class="sub">Sum of ${act.length} active wallet${act.length === 1 ? '' : 's'}. Savings goals are not included.</span></div></section>
      ${cards ? `<div class="cards-grid">${cards}</div>` : `<section class="card">${empty('No wallets yet', 'Add Cash, GCash, Maya or a bank account.', '<button class="btn primary" data-act="wallet-add">Add wallet</button>')}</section>`}
      ${arch.length ? `<section class="card" style="margin-top:14px"><div class="card-head"><h2>Archived wallets</h2></div><ul class="list">${arch.map((w) => `<li><div class="li-main"><div class="li-title">${esc(w.name)}</div><div class="li-sub">${esc(w.type)} · history kept</div></div><a class="btn ghost xs" href="#/transactions?wallet=${w.id}">History</a><button class="btn ghost xs" data-act="wallet-restore" data-id="${w.id}">Restore</button></li>`).join('')}</ul></section>` : ''}`;
  }
  function openWalletForm(id) {
    const ex = id ? S.wallets.find((w) => w.id === id) : null;
    UI.form({
      title: ex ? 'Edit wallet' : 'Add wallet',
      body: `${fld.text('name', 'Wallet name', ex ? ex.name : '', { placeholder: 'e.g. GCash', required: true, maxlength: 30 })}${fld.select('type', 'Type', L.WALLET_TYPES.map((x) => ({ value: x, label: x })), ex ? ex.type : 'E-Wallet')}${fld.money('openingBalance', ex ? 'Starting balance' : 'Current balance', ex ? L.centsToInput(ex.openingBalance) : '0.00')}<p class="hint">${ex ? `Starting balance is the money in this wallet before your first recorded transaction. Current balance now: ${fmt(L.walletBalances(S)[ex.id])}.` : 'The amount in this wallet right now.'}</p>`,
      async onSubmit(v) {
        const inp = { name: v.name, type: v.type, openingBalance: L.toCents(v.openingBalance) };
        return commit(ex ? L.updateWalletOps(S, ex.id, inp) : L.addWalletOps(S, inp), ex ? 'Wallet updated' : 'Wallet added');
      }
    });
  }

  /* ---- generic remove (wallet / goal / bill / debt) ---- */
  async function removeFlow(kind, id) {
    const chk = L.removalCheck(S, kind, id);
    const store = { wallet: 'wallets', goal: 'goals', bill: 'bills', debt: 'debts' }[kind];
    const item = S[store].find((x) => x.id === id); if (!item) return;
    if (chk.action === 'blocked') { await UI.notice(`Can't remove ${item.name}`, `<p>${esc(chk.reason)}</p>`); return; }
    const ok = await UI.confirm({
      title: chk.action === 'archive' ? `Archive ${item.name}?` : `Delete ${item.name}?`, danger: true,
      confirmText: chk.action === 'archive' ? 'Archive' : 'Delete', typeToConfirm: kind === 'wallet' ? 'DELETE' : undefined,
      message: chk.reason
    });
    if (!ok) return;
    const errs = await commit(L.removeItemOps(S, kind, id, today()), chk.action === 'archive' ? `${item.name} archived` : `${item.name} deleted`);
    if (errs) UI.toast(errs[0], 'error');
  }

  /* ================================================================== */
  /* REPORTS                                                            */
  /* ================================================================== */
  function reportPeriod() {
    const r = VS.report; const cur = L.currentCutoff(S);
    if (r.sel === 'all') return { kind: 'all' };
    if (r.sel === 'custom') return { kind: 'range', from: r.from, to: r.to };
    if (r.sel.startsWith('co:')) return { kind: 'cutoff', id: r.sel.slice(3) };
    if (r.sel.startsWith('m:')) return { kind: 'month', key: r.sel.slice(2) };
    return cur ? { kind: 'cutoff', id: cur.id } : { kind: 'all' };
  }
  function pageReports() {
    const cuts = L.getCutoffs(S);
    const months = Array.from(new Set(S.transactions.map((t) => L.monthKey(t.date)))).sort().reverse();
    const opts = [{ value: 'cur', label: cuts.length ? 'Current cut-off' : 'All time' }]
      .concat(cuts.slice().reverse().slice(1).map((c) => ({ value: 'co:' + c.id, label: `Cut-off #${c.index} · ${L.cutoffLabel(c)}`, group: 'Past cut-offs' })))
      .concat(months.map((m) => ({ value: 'm:' + m, label: L.formatMonth(m), group: 'Months' })))
      .concat([{ value: 'all', label: 'All time', group: 'Other' }, { value: 'custom', label: 'Custom dates…', group: 'Other' }]);
    const p = L.periodTransactions(S, reportPeriod());
    const s = L.summarize(p.txs);
    const cats = L.spendingByCategory(p.txs);
    const max = cats.length ? cats[0].amount : 1;
    const csums = L.cutoffSummaries(S), msums = L.monthlySummaries(S);
    const row = (label, sm, extra) => `<tr><td>${label}</td>${extra || ''}<td class="r pos">${fmt(sm.income)}</td><td class="r">${fmt(sm.expenses)}</td><td class="r gold">${fmt(sm.savingsNet)}</td><td class="r ${sm.net < 0 ? 'neg' : ''}">${sm.net < 0 ? '−' : ''}${fmt(Math.abs(sm.net))}</td></tr>`;
    return `${pageHead('Reports', 'Simple summaries from your transactions.', `<button class="btn ghost sm" data-act="report-export">${icon('download')} Export CSV</button>`)}
      <section class="card" style="margin-bottom:14px"><div class="filters"><div class="wide">${fld.select('reportSel', 'Period', opts, VS.report.sel, { 'data-change': 'report-sel' })}</div>${VS.report.sel === 'custom' ? `${fld.date('rfrom', 'From', VS.report.from, { 'data-change': 'report-range' })}${fld.date('rto', 'To', VS.report.to, { 'data-change': 'report-range' })}` : ''}</div><p class="small muted" style="margin:10px 0 0">${esc(p.label)} · ${p.txs.length} transaction${p.txs.length === 1 ? '' : 's'}</p></section>
      <div class="grid three" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">
        <div class="card stat stat-card"><span class="label">Total income</span><span class="value num pos">${fmt(s.income)}</span><span class="sub">Salary ${fmt(s.salary)} · Other ${fmt(s.otherIncome)}</span></div>
        <div class="card stat stat-card exp"><span class="label">Total expenses</span><span class="value num">${fmt(s.expenses)}</span><span class="sub">Spending ${fmt(s.variable)} · Bills ${fmt(s.bills)} · Debt ${fmt(s.debt)}</span></div>
        <div class="card stat stat-card sav"><span class="label">Savings contributions</span><span class="value num gold">${fmt(s.contributions)}</span><span class="sub">${s.withdrawals ? `Withdrawn ${fmt(s.withdrawals)} · net ${fmt(s.savingsNet)}` : 'Not counted as expenses'}</span></div>
        <div class="card stat stat-card"><span class="label">Net change in balance</span><span class="value num ${s.net < 0 ? 'neg' : 'pos'}">${s.net < 0 ? '−' : ''}${fmt(Math.abs(s.net))}</span><span class="sub">Income − expenses − net savings. Transfers (${fmt(s.transfers)}) excluded.</span></div>
      </div>
      <div class="grid two" style="margin-top:14px">
        <section class="card"><div class="card-head"><h2>Spending by category</h2></div>${cats.length ? cats.map((c) => `<div class="cat-row"><div class="top"><span class="name">${esc(c.category)}</span><span class="num"><b>${fmt(c.amount)}</b> <small class="muted">${s.expenses ? Math.round(c.amount / s.expenses * 100) : 0}%</small></span></div>${bar(c.amount / max, 'navy')}</div>`).join('') : '<p class="muted">No spending in this period.</p>'}</section>
        <section class="card"><div class="card-head"><h2>Transaction history</h2><a class="link" href="#/transactions${p.from || p.to ? `?from=${p.from || ''}&to=${p.to || ''}` : ''}">Open full list</a></div>${p.txs.length ? `<ul class="list">${L.sortTransactions(p.txs).slice(0, 12).map((t) => txItem(t)).join('')}</ul>${p.txs.length > 12 ? `<p class="small muted" style="margin-top:8px">+ ${p.txs.length - 12} more</p>` : ''}` : '<p class="muted">Nothing here.</p>'}</section>
      </div>
      <section class="card" style="margin-top:14px"><div class="card-head"><h2>Cut-off summaries</h2></div>${csums.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Cut-off</th><th class="r">Salary</th><th class="r">Income</th><th class="r">Expenses</th><th class="r">Savings</th><th class="r">Net</th></tr></thead><tbody>${csums.map((c) => row(`<b>#${c.cutoff.index}</b> ${L.cutoffLabel(c.cutoff)}`, c.summary, `<td class="r">${fmt(c.cutoff.amount)}</td>`)).join('')}</tbody></table></div>` : '<p class="muted">No cut-offs yet.</p>'}</section>
      <section class="card" style="margin-top:14px"><div class="card-head"><h2>Monthly summaries</h2></div>${msums.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Month</th><th class="r">Income</th><th class="r">Expenses</th><th class="r">Savings</th><th class="r">Net</th></tr></thead><tbody>${msums.map((m) => row(`<b>${L.formatMonth(m.month)}</b>`, m.summary)).join('')}</tbody></table></div>` : '<p class="muted">No data yet.</p>'}</section>`;
  }

  /* ================================================================== */
  /* SETTINGS                                                           */
  /* ================================================================== */
  function pageSettings() {
    const st = S.settings;
    return `${pageHead('Settings', 'Paydays, default allocation, and your data.')}
      <div class="grid two">
        <section class="card"><div class="card-head"><h2>Payday schedule</h2></div><form id="settings-form" novalidate>
          ${fld.text('paydays', 'Expected paydays (day of month)', st.paydays.join(', '), { placeholder: '15, 30' })}<p class="hint">Example: 15, 30. Day 30 becomes the last day in short months. These are only expected dates — a cut-off starts when you record the salary you actually received.</p>
          <h3 style="margin:14px 0 6px;font-size:15px">Default allocation</h3>
          ${st.allocation.map((a, i) => `<div class="alloc-row" style="grid-template-columns:1fr 110px"><b>${esc(a.label)}</b><div class="input-suffix"><input type="text" inputmode="decimal" name="al${i}" value="${a.pct}"><span>%</span></div></div>`).join('')}
          <div class="alloc-total" id="set-total"></div>
          <div class="form-errors" id="settings-errors" hidden role="alert" style="margin-top:10px"></div>
          <div class="form-actions" style="justify-content:flex-start"><button type="button" class="btn primary" data-act="settings-save">Save settings</button></div></form></section>
        <section class="card"><div class="card-head"><h2>Your data</h2></div>
          <p class="muted small">PeraPilot stores everything on this device (IndexedDB). Nothing is uploaded. There is no cloud backup yet, so download a backup now and then.</p>
          <div class="row wrap"><button class="btn ghost sm" data-act="backup-export">${icon('download')} Download backup</button><button class="btn ghost sm" data-act="backup-import">${icon('upload')} Restore backup</button><input type="file" id="backup-file" accept="application/json,.json" hidden></div>
          <details class="disc" open><summary>Start over</summary><div class="stack" style="margin-top:10px">
            <div><button class="btn ghost sm" data-act="demo-reload">Reload demo data</button><p class="hint" style="margin:6px 0 0">Replaces all data with realistic sample data.</p></div>
            <div><button class="btn danger-ghost sm" data-act="erase-all">Erase everything &amp; start fresh</button><p class="hint" style="margin:6px 0 0">Deletes all wallets, transactions, bills, debts and goals from this device.</p></div></div></details>
          <p class="small faint" style="margin-top:14px">Storage: ${db.persistent ? 'IndexedDB (saved on this device)' : '<b class="neg">memory only — data will be lost when you close this tab</b>'}.</p>
        </section>
      </div>`;
  }
  function afterSettings() {
    const f = $('#settings-form'); if (!f) return;
    const upd = () => {
      const tot = S.settings.allocation.reduce((s, a, i) => s + (parseFloat(String(f['al' + i].value).replace(',', '.')) || 0), 0);
      const r = Math.round(tot * 100) / 100, ok = Math.abs(r - 100) < 0.001;
      const b = $('#set-total'); b.classList.toggle('bad', !ok);
      b.innerHTML = ok ? `<span>${icon('check')} Totals 100%</span>` : `<span>${icon('alert')} Totals ${r}% — must be 100%</span>`;
    };
    f.addEventListener('input', upd); upd();
  }

  /* ================================================================== */
  /* ACTIONS (click handlers)                                           */
  /* ================================================================== */
  function download(name, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  const byId = (store, id) => S[store].find((x) => x.id === id);
  async function deleteTx(id) {
    const t = byId('transactions', id); if (!t) return;
    const info = txInfo(t);
    const extra = t.isSalary ? '<li>This salary starts a cut-off. Deleting it removes that cut-off and its allocation plan; earlier cut-offs extend until the next salary.</li>' : t.type === TX.BILL ? '<li>The bill will show as unpaid again for that month.</li>' : t.type === TX.DEBT ? '<li>The debt balance will go back up.</li>' : '';
    const ok = await UI.confirm({ title: 'Delete this transaction?', danger: true, confirmText: 'Delete', html: true, message: `<p><b>${esc(txTitle(t))}</b><br>${info.sign}${fmt(t.amount)} · ${L.formatDate(t.date)}</p><ul><li>Wallet balances${t.type === TX.SAVINGS || t.type === TX.WITHDRAW ? ' and the goal' : ''} will be corrected automatically.</li>${extra}</ul>` });
    if (!ok) return;
    const errs = await commit(L.deleteTransactionOps(S, id), 'Transaction deleted');
    if (errs) await UI.notice('Could not delete', `<p>${esc(errs[0])}</p>`);
  }
  const ACT = {
    'add-tx': () => openTxForm(),
    'add-transfer': () => openTxForm({ type: TX.TRANSFER }),
    'record-salary': () => openSalaryForm(),
    'tx-edit': (d) => { const t = byId('transactions', d.id); if (t) openTxForm({ tx: t }); },
    'tx-delete': (d) => deleteTx(d.id),
    'tx-more': () => { VS.tx.limit += 100; refreshTxList(); },
    'tx-reset': () => { Object.assign(VS.tx, { from: '', to: '', type: '', category: '', walletId: '', q: '', limit: 100 }); render(); },
    'tx-export': () => { const rows = L.filterTransactions(S, VS.tx); download(`perapilot-transactions-${today()}.csv`, '﻿' + L.transactionsCSV(S, rows), 'text/csv'); UI.toast(`Exported ${rows.length} transactions`); },
    'report-export': () => { const p = L.periodTransactions(S, reportPeriod()); download(`perapilot-report-${today()}.csv`, '﻿' + L.transactionsCSV(S, L.sortTransactions(p.txs)), 'text/csv'); UI.toast(`Exported ${p.txs.length} transactions`); },
    'more-menu': () => UI.openModal({ title: 'More', size: 'sm', body: `<div class="sheet-links">${MORE.map((n) => `<a href="${n.path}" data-modal-close>${icon(n.icon)}<span>${n.label}</span></a>`).join('')}</div>` }),
    'cutoff-view': (d) => { VS.cutoffId = d.id; render(); window.scrollTo(0, 0); },
    'alloc-save': async () => {
      const f = $('#alloc-form'); const box = $('#alloc-errors'); box.hidden = true;
      const items = ALLOC.items.map((it, i) => { const row = f.querySelectorAll('[data-alloc]')[i]; const amt = L.toCents(row.querySelector('[name=amount]').value); return { key: it.key, label: it.label, amount: amt, pct: ALLOC.salary ? Math.round(amt / ALLOC.salary * 10000) / 100 : 0 }; });
      if (items.some((i) => isNaN(i.amount))) { box.hidden = false; box.textContent = 'Enter a valid amount on every line (0 or more).'; return; }
      const errs = await commit(L.saveAllocationOps(S, ALLOC.cutoffId, items), 'Allocation plan saved');
      if (errs) { box.hidden = false; box.innerHTML = errs.map((e) => `<div>${esc(e)}</div>`).join(''); }
    },
    'alloc-reset': () => { const c = L.cutoffById(S, ALLOC.cutoffId); ALLOC.items = L.defaultAllocationItems(c.amount, S.settings); const f = $('#alloc-form'); f.querySelectorAll('[data-alloc]').forEach((r, i) => { r.querySelector('[name=pct]').value = ALLOC.items[i].pct; r.querySelector('[name=amount]').value = L.centsToInput(ALLOC.items[i].amount); }); allocTotals(); },
    'alloc-balance': () => {
      const st = L.allocationStatus(ALLOC.salary, ALLOC.items); const n = ALLOC.items.findIndex((i) => i.key === 'unassigned'); const it = ALLOC.items[n];
      if (it.amount + st.diff < 0) { UI.toast('Unassigned would go below zero. Lower another line instead.', 'error'); return; }
      it.amount += st.diff; it.pct = Math.round(it.amount / ALLOC.salary * 10000) / 100;
      const row = $('#alloc-form').querySelectorAll('[data-alloc]')[n]; row.querySelector('[name=amount]').value = L.centsToInput(it.amount); row.querySelector('[name=pct]').value = it.pct; allocTotals();
    },
    'week-pick': (d) => { VS.budgetWeek = +d.i; render(); },
    'week-close': (d) => openCloseWeek(d.cut, +d.i),
    'week-reopen': async (d) => { if (await UI.confirm({ title: 'Re-open this week?', confirmText: 'Re-open', message: 'The leftover decision will be undone. Any savings moved from this week will be returned to your wallet and removed from the goal.' })) { const errs = await commit(L.reopenWeekOps(S, d.id), 'Week re-opened'); if (errs) UI.toast(errs[0], 'error'); } },
    'bc-add': () => openBudgetCatForm(), 'bc-edit': (d) => openBudgetCatForm(d.id),
    'bc-del': async (d) => { const c = byId('budgetCategories', d.id); if (c && await UI.confirm({ title: `Remove ${c.name}?`, danger: true, confirmText: 'Remove', message: 'It stops appearing from now on. Past weeks and the expenses you recorded stay as they are.' })) commit(L.removeBudgetCategoryOps(S, d.id, today()), 'Category removed'); },
    'bill-add': () => openBillForm(), 'bill-edit': (d) => openBillForm(d.id), 'bill-pay': (d) => openPayBill(d.id, d.month), 'bill-del': (d) => removeFlow('bill', d.id),
    'bill-restore': (d) => commit(L.restoreItemOps(S, 'bill', d.id), 'Bill restored'),
    'bill-undo': async (d) => { const t = byId('transactions', d.id); if (t && await UI.confirm({ title: 'Undo this payment?', confirmText: 'Undo payment', danger: true, message: `${fmt(t.amount)} will go back to ${wname(t.walletId)} and the bill becomes pending again.` })) commit(L.deleteTransactionOps(S, d.id), 'Payment undone'); },
    'bill-month': (d) => { const t = today(); const cur = VS.billMonth || L.monthKey(t); VS.billMonth = +d.d === 0 ? L.monthKey(t) : L.addMonths(cur, +d.d); render(); },
    'debt-add': () => openDebtForm(), 'debt-edit': (d) => openDebtForm(d.id), 'debt-pay': (d) => openPayDebt(d.id), 'debt-del': (d) => removeFlow('debt', d.id),
    'debt-restore': (d) => commit(L.restoreItemOps(S, 'debt', d.id), 'Debt restored'),
    'goal-add': () => openGoalForm(), 'goal-edit': (d) => openGoalForm(d.id), 'goal-del': (d) => removeFlow('goal', d.id),
    'goal-contribute': (d) => openTxForm({ type: TX.SAVINGS, goalId: d.id }), 'goal-withdraw': (d) => openTxForm({ type: TX.WITHDRAW, goalId: d.id }),
    'goal-restore': (d) => commit(L.restoreItemOps(S, 'goal', d.id), 'Goal restored'),
    'wallet-add': () => openWalletForm(), 'wallet-edit': (d) => openWalletForm(d.id), 'wallet-del': (d) => removeFlow('wallet', d.id),
    'wallet-restore': (d) => commit(L.restoreItemOps(S, 'wallet', d.id), 'Wallet restored'),
    'settings-save': async () => {
      const f = $('#settings-form'); const box = $('#settings-errors'); box.hidden = true;
      const paydays = f.paydays.value.split(/[,\s]+/).filter(Boolean).map(Number);
      const allocation = S.settings.allocation.map((a, i) => ({ key: a.key, label: a.label, pct: parseFloat(String(f['al' + i].value).replace(',', '.')) }));
      if (allocation.some((a) => isNaN(a.pct))) { box.hidden = false; box.textContent = 'Enter a valid percentage on every line.'; return; }
      const errs = await commit(L.updateSettingsOps(S, { paydays, allocation }), 'Settings saved');
      if (errs) { box.hidden = false; box.innerHTML = errs.map((e) => `<div>${esc(e)}</div>`).join(''); }
    },
    'backup-export': () => { download(`perapilot-backup-${today()}.json`, DB.exportJSON(S), 'application/json'); UI.toast('Backup downloaded'); },
    'backup-import': () => $('#backup-file').click(),
    'demo-reload': async () => { if (await UI.confirm({ title: 'Reload demo data?', danger: true, confirmText: 'Replace with demo', typeToConfirm: 'DEMO', message: 'This replaces ALL your current data with sample data.' })) { await replaceAll(Demo.buildDemoState(today()), { seeded: true }); UI.toast('Demo data loaded'); } },
    'erase-all': async () => { if (await UI.confirm({ title: 'Erase everything?', danger: true, confirmText: 'Erase all data', typeToConfirm: 'ERASE', message: 'All wallets, transactions, bills, debts and goals on this device will be permanently deleted. Download a backup first if you may need it.' })) { await startFresh(); UI.toast('All data erased'); location.hash = '#/'; } },
    'demo-clear': async () => { if (await UI.confirm({ title: 'Start fresh?', danger: true, confirmText: 'Clear demo data', message: 'The sample data will be removed so you can enter your own wallets and salary.' })) { await startFresh(); UI.toast('Demo data cleared — add your first wallet'); location.hash = '#/'; } }
  };
  async function startFresh() {
    const st = L.emptyState(); st.settings = Object.assign(L.defaultSettings(), { paydays: S.settings.paydays, allocation: S.settings.allocation, demo: false });
    VS.cutoffId = VS.budgetCutoff = VS.budgetWeek = null;
    await replaceAll(st, { seeded: true });
  }
  const CHANGE = {
    'cutoff-pick': (el) => { VS.cutoffId = el.value; render(); },
    'budget-cutoff': (el) => { VS.budgetCutoff = el.value; VS.budgetWeek = null; render(); },
    'report-sel': (el) => { VS.report.sel = el.value; render(); },
    'report-range': () => { VS.report.from = $('[name=rfrom]').value; VS.report.to = $('[name=rto]').value; render(); }
  };

  /* ================================================================== */
  /* Router + shell                                                     */
  /* ================================================================== */
  const NAV = [
    { id: 'dashboard', path: '#/', label: 'Dashboard', icon: 'home', title: 'Dashboard' },
    { id: 'transactions', path: '#/transactions', label: 'Transactions', icon: 'list', title: 'Transactions' },
    { id: 'cutoff', path: '#/cutoff', label: 'Salary & Cut-off', icon: 'calendar', title: 'Salary & Cut-off' },
    { id: 'budget', path: '#/budget', label: 'Weekly Budget', icon: 'cash', title: 'Weekly Budget' },
    { id: 'bills', path: '#/bills', label: 'Bills', icon: 'bill', title: 'Bills' },
    { id: 'debts', path: '#/debts', label: 'Debts', icon: 'debt', title: 'Debts' },
    { id: 'goals', path: '#/goals', label: 'Savings Goals', icon: 'goal', title: 'Savings Goals' },
    { id: 'wallets', path: '#/wallets', label: 'Wallets', icon: 'wallet', title: 'Wallets & Accounts' },
    { id: 'reports', path: '#/reports', label: 'Reports', icon: 'chart', title: 'Reports' },
    { id: 'settings', path: '#/settings', label: 'Settings', icon: 'gear', title: 'Settings' }
  ];
  const BOTTOM = ['dashboard', 'transactions', 'budget', 'bills'];
  const MORE = NAV.filter((n) => !BOTTOM.includes(n.id));
  const PAGES = { dashboard: pageDashboard, transactions: pageTransactions, cutoff: pageCutoff, budget: pageBudget, bills: pageBills, debts: pageDebts, goals: pageGoals, wallets: pageWallets, reports: pageReports, settings: pageSettings };
  const AFTER = { cutoff: afterCutoff, settings: afterSettings };

  function parseHash() {
    const h = location.hash.replace(/^#\/?/, '');
    const [p, q] = h.split('?');
    return { page: PAGES[p || 'dashboard'] ? (p || 'dashboard') : 'dashboard', query: Object.fromEntries(new URLSearchParams(q || '')) };
  }
  function renderNav() {
    $('#nav-main').innerHTML = NAV.map((n) => `<a href="${n.path}" class="${n.id === route.page ? 'active' : ''}" ${n.id === route.page ? 'aria-current="page"' : ''}>${icon(n.icon)}<span>${n.label}</span></a>`).join('');
    $('#bottom-nav').innerHTML = BOTTOM.map((id) => { const n = NAV.find((x) => x.id === id); return `<a href="${n.path}" class="${n.id === route.page ? 'active' : ''}">${icon(n.icon)}<span>${n.id === 'transactions' ? 'Activity' : n.id === 'budget' ? 'Budget' : n.label}</span></a>`; }).join('')
      + `<button type="button" data-act="more-menu" class="${MORE.some((n) => n.id === route.page) ? 'active' : ''}">${icon('more')}<span>More</span></button>`;
    const cur = NAV.find((n) => n.id === route.page);
    $('#page-title').textContent = cur.title; document.title = `${cur.title} · PeraPilot`;
  }
  function renderBanners() {
    let h = '';
    if (!db.persistent) h += `<div class="banner danger">${icon('alert')}<span><b>Storage unavailable.</b> Your browser blocked local storage, so changes will be lost when you close this tab.</span></div>`;
    if (S.settings.demo) h += `<div class="banner">${icon('info')}<span>You are viewing <b>demo data</b>. Feel free to test everything.</span><button class="btn gold xs" data-act="demo-clear">Clear demo &amp; start fresh</button></div>`;
    $('#banners').innerHTML = h;
    $('#sidebar-foot').innerHTML = S.settings.demo ? 'Demo data active' : 'Data saved on this device';
  }
  function render() {
    if (!S) return;
    const el = $('#view');
    try { el.innerHTML = PAGES[route.page](); }
    catch (e) { console.error(e); el.innerHTML = `<section class="card"><h2>Something went wrong showing this page</h2><p class="muted">${esc(e.message)}</p><a class="btn ghost sm" href="#/">Back to dashboard</a></section>`; }
    if (AFTER[route.page]) AFTER[route.page]();
    renderNav(); renderBanners();
  }
  function onRoute() {
    route = parseHash();
    const q = route.query;
    if (route.page === 'transactions' && (q.wallet || q.from || q.to)) {
      Object.assign(VS.tx, { from: q.from || '', to: q.to || '', type: '', category: '', q: '', walletId: q.wallet || '', limit: 100 });
      history.replaceState(null, '', '#/transactions');
    }
    render(); window.scrollTo(0, 0);
    const v = $('#view'); if (v) v.focus({ preventScroll: true });
  }

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]'); if (!el || el.disabled) return;
    const h = ACT[el.dataset.act]; if (!h) return;
    if (el.tagName === 'A') e.preventDefault();
    const m = el.closest('.modal-wrap'); if (m && el.dataset.act === 'more-menu') return;
    Promise.resolve(h(el.dataset, el)).catch((err) => { console.error(err); UI.toast('Something went wrong: ' + err.message, 'error'); });
  });
  document.addEventListener('change', (e) => {
    const el = e.target.closest('[data-change]'); if (el && CHANGE[el.dataset.change]) { CHANGE[el.dataset.change](el); return; }
    const tf = e.target.closest('#tx-filters');
    if (tf) { const n = e.target.name; if (n && n in VS.tx) { VS.tx[n] = e.target.value; VS.tx.limit = 100; refreshTxList(); } }
    if (e.target.id === 'backup-file') importBackup(e.target);
  });
  document.addEventListener('input', (e) => {
    if (e.target.closest('#tx-filters') && e.target.name === 'q') { VS.tx.q = e.target.value; VS.tx.limit = 100; refreshTxList(); }
  });
  async function importBackup(input) {
    const file = input.files && input.files[0]; input.value = ''; if (!file) return;
    const res = DB.parseBackup(await file.text());
    if (res.error) { UI.notice('Cannot restore this file', `<p>${esc(res.error)}</p>`); return; }
    if (!(await UI.confirm({ title: 'Restore backup?', danger: true, confirmText: 'Replace my data', message: `This replaces everything on this device with the backup (${res.state.transactions.length} transactions, ${res.state.wallets.length} wallets).` }))) return;
    VS.cutoffId = VS.budgetCutoff = VS.budgetWeek = null;
    await replaceAll(res.state, { seeded: true }); UI.toast('Backup restored');
  }

  /* ================================================================== */
  /* Boot                                                               */
  /* ================================================================== */
  async function boot() {
    db = await DB.open();
    let loaded = await db.loadAll();
    if (!loaded.hasSettings && !loaded.app && !loaded.state.wallets.length && !loaded.state.transactions.length) {
      const demo = Demo.buildDemoState(today());
      await db.replaceAll(demo, { seeded: true });
      loaded = await db.loadAll();
    }
    S = loaded.state;
    window.addEventListener('hashchange', onRoute);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { const stamp = today(); reloadFromDB().then(() => { if (window.__lastDay && window.__lastDay !== stamp) render(); window.__lastDay = stamp; }); } });
    window.__lastDay = today();
    $('#loading').remove(); $('#app').hidden = false;
    onRoute();
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(() => {});
    window.PP.app = { get state() { return S; }, commit, render, VS };
  }
  boot().catch((e) => {
    console.error(e);
    const l = $('#loading'); if (l) l.innerHTML = `<p style="max-width:420px;text-align:center">PeraPilot could not start: ${esc(e.message)}</p>`;
  });
})();
