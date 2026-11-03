// Run:  node --test tests/        (Node 18+; no dependencies needed for this file)
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../js/logic.js');
const Demo = require('../js/demo.js');

const php = (n) => Math.round(n * 100);
const TODAY = '2026-11-20';

/** Tiny harness: apply a result's ops to the state, assert it succeeded. */
function ctx(today) {
  const c = { today: today || TODAY, s: L.emptyState() };
  c.run = (r) => { assert.equal(r.ok, true, 'expected ok but got: ' + (r.errors || []).join(' | ')); c.s = L.applyOps(c.s, r.ops); return r; };
  c.bad = (r, re) => { assert.equal(r.ok, false, 'expected failure'); if (re) assert.match(r.errors.join(' '), re); return r; };
  c.wallet = (name, open, type) => c.run(L.addWalletOps(c.s, { name, type: type || 'Cash', openingBalance: php(open || 0) })).wallet;
  c.bal = (w) => L.walletBalances(c.s)[w.id];
  return c;
}

test('money parsing is exact and strict', () => {
  assert.equal(L.toCents('1,234.50'), 123450);
  assert.equal(L.toCents('₱500'), 50000);
  assert.equal(L.toCents('0.1'), 10);
  assert.equal(L.toCents('19.99'), 1999);
  assert.ok(Number.isNaN(L.toCents('-5')));
  assert.ok(Number.isNaN(L.toCents('abc')));
  assert.ok(Number.isNaN(L.toCents('1.234')));
  assert.equal(L.formatPeso(123456), '₱1,234.56');
  assert.equal(L.formatDate('2026-11-17'), 'Nov 17, 2026');
});

test('expected payday NEVER creates income or a cut-off; only recorded salary does', () => {
  const c = ctx('2026-11-16');
  const bdo = c.wallet('BDO', 1000, 'Bank Account');
  // previous salary: Oct 30 payday, received Oct 31
  c.run(L.recordSalaryOps(c.s, { amount: php(22000), date: '2026-10-31', walletId: bdo.id }, c.today));
  assert.equal(L.currentCutoff(c.s).forPayday, '2026-10-30');
  const txCount = c.s.transactions.length, cutCount = L.getCutoffs(c.s).length, bal = L.totalBalance(c.s);
  // Nov 15 (expected payday) has passed but the salary has NOT been received/recorded
  const np = L.nextExpectedPayday(c.s, c.today);
  assert.equal(np.date, '2026-11-15'); assert.equal(np.overdue, true); assert.equal(np.overdueDays, 1);
  assert.equal(L.getCutoffs(c.s).length, cutCount, 'no new cut-off just because payday passed');
  assert.equal(c.s.transactions.length, txCount, 'no auto income');
  assert.equal(L.totalBalance(c.s), bal);
  assert.equal(L.currentCutoff(c.s).start, '2026-10-31', 'cut-off still the old one');

  // salary actually arrives Nov 17 (2 days late) -> cut-off starts Nov 17, not Nov 15
  c.today = '2026-11-17';
  const r = c.run(L.recordSalaryOps(c.s, { amount: php(22000), date: '2026-11-17', walletId: bdo.id }, c.today));
  const cut = L.currentCutoff(c.s);
  assert.equal(cut.start, '2026-11-17');
  assert.equal(cut.forPayday, '2026-11-15', 'matched to the Nov 15 payday');
  assert.equal(cut.id, r.cutoffId);
  assert.equal(c.bal(bdo), php(1000 + 22000 + 22000));
  // next expected payday is now Nov 30
  assert.equal(L.nextExpectedPayday(c.s, c.today).date, '2026-11-30');
  assert.equal(L.nextExpectedPayday(c.s, c.today).daysLeft, 13);
});

test('salary: cannot be future dated, needs a wallet, blocks accidental duplicates', () => {
  const c = ctx();
  const w = c.wallet('Cash');
  c.bad(L.recordSalaryOps(c.s, { amount: php(1000), date: '2026-11-25', walletId: w.id }, c.today), /future/);
  c.bad(L.recordSalaryOps(c.s, { amount: php(1000), date: c.today, walletId: 'nope' }, c.today), /wallet/);
  c.bad(L.recordSalaryOps(c.s, { amount: 0, date: c.today, walletId: w.id }, c.today));
  c.run(L.recordSalaryOps(c.s, { amount: php(1000), date: c.today, walletId: w.id }, c.today));
  c.bad(L.recordSalaryOps(c.s, { amount: php(1000), date: c.today, walletId: w.id }, c.today), /already recorded/);
});

test('new cut-off resets cut-off summaries but history stays', () => {
  const c = ctx('2026-11-17');
  const w = c.wallet('Cash', 0);
  c.run(L.recordSalaryOps(c.s, { amount: php(20000), date: '2026-11-02', walletId: w.id }, c.today));
  c.run(L.addTransactionOps(c.s, { type: 'expense', amount: php(500), date: '2026-11-03', walletId: w.id, category: 'Food' }, c.today));
  let cs = L.currentSummary(c.s);
  assert.equal(cs.summary.income, php(20000)); assert.equal(cs.summary.expenses, php(500));
  c.run(L.recordSalaryOps(c.s, { amount: php(21000), date: '2026-11-17', walletId: w.id }, c.today));
  cs = L.currentSummary(c.s);
  assert.equal(cs.summary.income, php(21000), 'current cut-off only has the new salary');
  assert.equal(cs.summary.expenses, 0);
  assert.equal(c.s.transactions.length, 3, 'old transactions kept');
  assert.equal(L.cutoffSummaries(c.s).length, 2);
  assert.equal(L.cutoffSummaries(c.s)[1].summary.expenses, php(500), 'old cut-off keeps its own numbers');
  assert.equal(c.bal(w), php(20000 - 500 + 21000));
});

test('salary allocation: defaults, rounding, 100% check, and it NEVER moves wallet money', () => {
  const c = ctx();
  const w = c.wallet('Bank', 0, 'Bank Account');
  const r = c.run(L.recordSalaryOps(c.s, { amount: php(22345.67), date: c.today, walletId: w.id }, c.today));
  const before = c.bal(w);
  const items = L.defaultAllocationItems(php(22345.67), c.s.settings);
  assert.deepEqual(items.map((i) => i.pct), [30, 10, 10, 40, 10]);
  assert.equal(L.sum(items, (i) => i.amount), php(22345.67), 'rounding remainder keeps the total exact');
  assert.equal(L.allocationStatus(php(22345.67), items).balanced, true);
  // unbalanced plan is rejected
  const off = items.map((i, n) => (n === 0 ? { ...i, amount: i.amount + 100 } : i));
  c.bad(L.saveAllocationOps(c.s, r.cutoffId, off), /exactly/);
  c.run(L.saveAllocationOps(c.s, r.cutoffId, items));
  assert.equal(c.bal(w), before, 'wallet unchanged by allocation');
  assert.equal(c.s.transactions.length, 1, 'no transactions created by allocation');
  assert.equal(L.getAllocation(c.s, r.cutoffId).items.length, 5);
});

test('wallet balances: income, expense, savings, bills, debts, withdrawals all consistent', () => {
  const c = ctx();
  const cash = c.wallet('Cash', 1000);
  const goal = c.run(L.addGoalOps(c.s, { name: 'Phone', target: php(10000) })).goal;
  c.run(L.addTransactionOps(c.s, { type: 'income', amount: php(500), date: c.today, walletId: cash.id, category: 'Bonus' }, c.today));
  c.run(L.addTransactionOps(c.s, { type: 'expense', amount: php(200), date: c.today, walletId: cash.id, category: 'Medical' }, c.today));
  c.run(L.addTransactionOps(c.s, { type: 'savings', amount: php(300), date: c.today, walletId: cash.id, goalId: goal.id }, c.today));
  assert.equal(c.bal(cash), php(1000 + 500 - 200 - 300));
  assert.equal(L.goalSavedMap(c.s)[goal.id], php(300));
  c.run(L.addTransactionOps(c.s, { type: 'goal_withdrawal', amount: php(100), date: c.today, walletId: cash.id, goalId: goal.id }, c.today));
  assert.equal(c.bal(cash), php(1000 + 500 - 200 - 300 + 100));
  assert.equal(L.goalSavedMap(c.s)[goal.id], php(200));
});

test('input validation: negative, zero, huge, bad dates, missing wallet/category', () => {
  const c = ctx();
  const w = c.wallet('Cash', 100);
  const base = { type: 'expense', amount: php(10), date: c.today, walletId: w.id, category: 'Medical' };
  c.bad(L.addTransactionOps(c.s, { ...base, amount: -500 }, c.today));
  c.bad(L.addTransactionOps(c.s, { ...base, amount: 0 }, c.today));
  c.bad(L.addTransactionOps(c.s, { ...base, amount: NaN }, c.today));
  c.bad(L.addTransactionOps(c.s, { ...base, amount: 12.5 }, c.today), /amount/);
  c.bad(L.addTransactionOps(c.s, { ...base, date: '2026-02-31' }, c.today), /date/);
  c.bad(L.addTransactionOps(c.s, { ...base, date: '2027-01-01' }, c.today), /future/);
  c.bad(L.addTransactionOps(c.s, { ...base, walletId: 'x' }, c.today), /wallet/);
  c.bad(L.addTransactionOps(c.s, { ...base, category: '' }, c.today), /category/);
  c.bad(L.addTransactionOps(c.s, { ...base, amount: php(101) }, c.today), /below/, 'cannot overdraw a wallet');
  assert.equal(c.s.transactions.length, 0);
});

test('transfers: move money between wallets, never income/expense, note required', () => {
  const c = ctx();
  const bank = c.wallet('Bank', 5000, 'Bank Account');
  const gcash = c.wallet('GCash', 0, 'E-Wallet');
  const t = { type: 'transfer', amount: php(1500), date: c.today, walletId: bank.id, toWalletId: gcash.id, note: 'GCash allowance' };
  c.bad(L.addTransactionOps(c.s, { ...t, note: '' }, c.today), /purpose/);
  c.bad(L.addTransactionOps(c.s, { ...t, toWalletId: bank.id }, c.today), /different/);
  c.bad(L.addTransactionOps(c.s, { ...t, amount: php(9000) }, c.today), /below/);
  c.run(L.addTransactionOps(c.s, t, c.today));
  assert.equal(c.bal(bank), php(3500)); assert.equal(c.bal(gcash), php(1500));
  assert.equal(L.totalBalance(c.s), php(5000), 'total unchanged by a transfer');
  const sum = L.summarize(c.s.transactions);
  assert.equal(sum.income, 0); assert.equal(sum.expenses, 0); assert.equal(sum.transfers, php(1500));
  assert.equal(c.s.transactions.length, 1, 'one record, no duplicate leg');
  // editing the transfer updates both wallets exactly once
  const id = c.s.transactions[0].id;
  c.run(L.updateTransactionOps(c.s, id, { ...t, amount: php(2000) }, c.today));
  assert.equal(c.bal(bank), php(3000)); assert.equal(c.bal(gcash), php(2000));
  c.run(L.deleteTransactionOps(c.s, id));
  assert.equal(c.bal(bank), php(5000)); assert.equal(c.bal(gcash), 0);
});

test('savings contributions: leave wallet, join goal, NOT an expense, NOT in Total Balance', () => {
  const c = ctx();
  const w = c.wallet('Bank', 10000, 'Bank Account');
  const goal = c.run(L.addGoalOps(c.s, { name: 'Emergency Fund', target: php(50000) })).goal;
  c.run(L.recordSalaryOps(c.s, { amount: php(20000), date: c.today, walletId: w.id }, c.today));
  assert.equal(L.totalBalance(c.s), php(30000));
  c.run(L.addTransactionOps(c.s, { type: 'savings', amount: php(2500), date: c.today, walletId: w.id, goalId: goal.id }, c.today));
  assert.equal(L.totalBalance(c.s), php(27500), 'money left the spendable balance');
  assert.equal(L.goalSavedMap(c.s)[goal.id], php(2500));
  assert.equal(L.totalSaved(c.s), php(2500));
  const s = L.currentSummary(c.s).summary;
  assert.equal(s.expenses, 0, 'not an ordinary expense');
  assert.equal(s.contributions, php(2500));
  assert.equal(L.spendingByCategory(c.s.transactions).length, 0);
  // withdrawal beyond saved is blocked; valid withdrawal returns money
  c.bad(L.addTransactionOps(c.s, { type: 'goal_withdrawal', amount: php(3000), date: c.today, walletId: w.id, goalId: goal.id }, c.today), /negative/);
  c.run(L.addTransactionOps(c.s, { type: 'goal_withdrawal', amount: php(1000), date: c.today, walletId: w.id, goalId: goal.id }, c.today));
  assert.equal(L.totalBalance(c.s), php(28500)); assert.equal(L.goalSavedMap(c.s)[goal.id], php(1500));
  assert.equal(L.currentSummary(c.s).summary.savingsNet, php(1500));
});

test('weekly budget: only matching budget categories count; bills & savings do not', () => {
  const c = ctx('2026-11-20');
  const w = c.wallet('Cash', 50000);
  const pal = c.run(L.addBudgetCategoryOps(c.s, { name: 'Palengke', weeklyAmount: php(1000) }, '2026-11-01')).ops[0].value;
  c.run(L.addBudgetCategoryOps(c.s, { name: 'Baon', weeklyAmount: php(500) }, '2026-11-01'));
  c.run(L.recordSalaryOps(c.s, { amount: php(20000), date: '2026-11-17', walletId: w.id }, c.today));
  const goal = c.run(L.addGoalOps(c.s, { name: 'G', target: php(1000) })).goal;
  const bill = c.run(L.addBillOps(c.s, { name: 'Water', amount: php(400), dueDay: 18, category: 'Utilities' }, c.today)).ops[0].value;
  c.run(L.addTransactionOps(c.s, { type: 'expense', amount: php(300), date: '2026-11-18', walletId: w.id, budgetCategoryId: pal.id }, c.today));
  c.run(L.addTransactionOps(c.s, { type: 'expense', amount: php(999), date: '2026-11-18', walletId: w.id, category: 'Medical' }, c.today)); // not a budget category
  c.run(L.addTransactionOps(c.s, { type: 'savings', amount: php(200), date: '2026-11-18', walletId: w.id, goalId: goal.id }, c.today));
  c.run(L.payBillOps(c.s, { billId: bill.id, billMonth: '2026-11', amount: php(400), date: '2026-11-18', walletId: w.id }, c.today));
  const cut = L.currentCutoff(c.s);
  const wk = L.weeklyBudget(c.s, cut, 1, c.today);
  assert.equal(wk.base, php(1500));
  assert.equal(wk.spent, php(300), 'only the matching Palengke expense counts');
  assert.equal(wk.remaining, php(1200));
  assert.equal(wk.rows.find((r) => r.name === 'Palengke').remaining, php(700));
  assert.equal(L.weekIndexOf(cut, '2026-11-23'), 1); assert.equal(L.weekIndexOf(cut, '2026-11-24'), 2);
  assert.equal(L.weeklyBudget(c.s, cut, 2, c.today).spent, 0, 'fresh week, nothing auto-carried');
});

test('editing a weekly budget amount does not rewrite weeks that already started', () => {
  const c = ctx('2026-11-26'); // cut-off began Nov 17 -> week 1 Nov 17-23, week 2 Nov 24-30
  const w = c.wallet('Cash', 50000);
  const cat = c.run(L.addBudgetCategoryOps(c.s, { name: 'Food', weeklyAmount: php(1000) }, '2026-11-01')).ops[0].value;
  c.run(L.recordSalaryOps(c.s, { amount: php(20000), date: '2026-11-17', walletId: w.id }, c.today));
  const cut = L.currentCutoff(c.s);
  c.run(L.updateBudgetCategoryOps(c.s, cat.id, { name: 'Food', weeklyAmount: php(1500) }, c.today));
  assert.equal(L.weeklyBudget(c.s, cut, 1, c.today).base, php(1000), 'week 1 keeps the old amount');
  assert.equal(L.weeklyBudget(c.s, cut, 2, c.today).base, php(1500), 'current week uses the new amount');
  c.run(L.updateBudgetCategoryOps(c.s, cat.id, { name: 'Food', weeklyAmount: php(1200) }, c.today));
  assert.equal(L.weeklyBudget(c.s, cut, 1, c.today).base, php(1000));
  assert.equal(L.weeklyBudget(c.s, cut, 2, c.today).base, php(1200));
});

test('week leftover is never carried automatically; user chooses (savings / next week / split / unassigned)', () => {
  const c = ctx('2026-11-26');
  const w = c.wallet('Cash', 50000);
  const goal = c.run(L.addGoalOps(c.s, { name: 'Travel', target: php(10000) })).goal;
  c.run(L.addBudgetCategoryOps(c.s, { name: 'Food', weeklyAmount: php(1000) }, '2026-11-01'));
  c.run(L.recordSalaryOps(c.s, { amount: php(20000), date: '2026-11-17', walletId: w.id }, c.today));
  const cut = L.currentCutoff(c.s);
  let wk1 = L.weeklyBudget(c.s, cut, 1, c.today);
  assert.equal(wk1.ended, true); assert.equal(wk1.canClose, true); assert.equal(wk1.remaining, php(1000));
  assert.equal(L.weeklyBudget(c.s, cut, 2, c.today).carryIn, 0, 'nothing carried automatically');
  const before = L.totalBalance(c.s);
  // over-assigning is blocked
  c.bad(L.closeWeekOps(c.s, { cutoffId: cut.id, weekIdx: 1, toSavings: php(800), toNext: php(300), walletId: w.id, goalId: goal.id, date: c.today }, c.today), /up to/);
  // split: 400 to savings, 300 to next week, 300 left unassigned
  const r = c.run(L.closeWeekOps(c.s, { cutoffId: cut.id, weekIdx: 1, toSavings: php(400), toNext: php(300), walletId: w.id, goalId: goal.id, date: c.today }, c.today));
  assert.equal(r.closure.unassigned, php(300));
  assert.equal(L.weeklyBudget(c.s, cut, 2, c.today).carryIn, php(300));
  assert.equal(L.weeklyBudget(c.s, cut, 2, c.today).budget, php(1300));
  assert.equal(L.goalSavedMap(c.s)[goal.id], php(400));
  assert.equal(L.totalBalance(c.s), before - php(400));
  assert.equal(L.currentSummary(c.s).summary.expenses, 0, 'leftover to savings is not an expense');
  c.bad(L.closeWeekOps(c.s, { cutoffId: cut.id, weekIdx: 1, toNext: php(1), date: c.today }, c.today), /already closed/);
  // the savings entry is locked while the week is closed...
  const stx = c.s.transactions.find((t) => t.type === 'savings');
  c.bad(L.deleteTransactionOps(c.s, stx.id), /Re-open/);
  // ...and re-opening restores everything with no leftovers
  c.run(L.reopenWeekOps(c.s, r.closure.id));
  assert.equal(L.totalBalance(c.s), before); assert.equal(L.goalSavedMap(c.s)[goal.id], 0);
  assert.equal(L.weeklyBudget(c.s, cut, 2, c.today).carryIn, 0);
  // a running week cannot be closed
  c.bad(L.closeWeekOps(c.s, { cutoffId: cut.id, weekIdx: 2, toNext: php(1), date: c.today }, c.today), /still running/);
});

test('bills: manual pay only, monthly (not per cut-off), recurs next month, keeps history', () => {
  const c = ctx('2026-11-10');
  const w = c.wallet('GCash', 5000, 'E-Wallet');
  const elec = c.run(L.addBillOps(c.s, { name: 'Electricity', amount: php(2000), dueDay: 20, category: 'Utilities' }, c.today)).ops[0].value;
  // nothing is auto-paid
  assert.equal(L.billStatus(c.s, elec, '2026-11', c.today).status, 'pending');
  assert.equal(L.totalBalance(c.s), php(5000));
  // a new cut-off does NOT reset or touch the bill
  c.run(L.recordSalaryOps(c.s, { amount: php(10000), date: '2026-11-10', walletId: w.id }, c.today));
  assert.equal(L.billStatus(c.s, elec, '2026-11', c.today).status, 'pending');
  c.bad(L.payBillOps(c.s, { billId: elec.id, billMonth: '2026-11', amount: php(99999), date: c.today, walletId: w.id }, c.today), /below/);
  c.run(L.payBillOps(c.s, { billId: elec.id, billMonth: '2026-11', amount: php(2100), date: '2026-11-10', walletId: w.id }, c.today));
  assert.equal(L.billStatus(c.s, elec, '2026-11', c.today).status, 'paid');
  assert.equal(c.bal(w), php(5000 + 10000 - 2100), 'deducted from the chosen wallet');
  assert.equal(L.incomingBills(c.s, c.today).length, 0, 'no longer pending this month');
  c.bad(L.payBillOps(c.s, { billId: elec.id, billMonth: '2026-11', amount: php(2100), date: '2026-11-10', walletId: w.id }, c.today), /already marked paid/);
  // next month it is pending again
  assert.equal(L.billStatus(c.s, elec, '2026-12', '2026-12-01').status, 'pending');
  assert.equal(L.incomingBills(c.s, '2026-12-01').length, 1);
  // payment is a bill_payment: not a weekly variable expense
  assert.equal(L.summarize(c.s.transactions).variable, 0);
  assert.equal(L.summarize(c.s.transactions).bills, php(2100));
  // undo a payment: money returns, bill pending again
  const pay = c.s.transactions.find((t) => t.type === 'bill_payment');
  c.run(L.deleteTransactionOps(c.s, pay.id));
  assert.equal(L.billStatus(c.s, elec, '2026-11', c.today).status, 'pending');
  assert.equal(c.bal(w), php(15000));
  // overdue detection + day 31 clamps to short months
  assert.equal(L.billStatus(c.s, elec, '2026-11', '2026-11-25').status, 'overdue');
  const rent = c.run(L.addBillOps(c.s, { name: 'Dues', amount: php(100), dueDay: 31, category: 'Other' }, '2026-02-10')).ops[0].value;
  assert.equal(L.billStatus(c.s, rent, '2026-02', '2026-02-10').dueDate, '2026-02-28');
});

test('debts: flexible payments reduce balance, never reset, can reach zero, no overpay', () => {
  const c = ctx();
  const w = c.wallet('Bank', 20000, 'Bank Account');
  const d = c.run(L.addDebtOps(c.s, { name: 'Ate Liza', original: php(5000), remaining: php(4000), dueDate: '' })).ops[0].value;
  assert.equal(L.debtRemainingMap(c.s)[d.id], php(4000));
  c.bad(L.payDebtOps(c.s, { debtId: d.id, amount: php(4001), date: c.today, walletId: w.id }, c.today), /more than the remaining/);
  c.run(L.payDebtOps(c.s, { debtId: d.id, amount: php(1250.5), date: c.today, walletId: w.id }, c.today));
  assert.equal(L.debtRemainingMap(c.s)[d.id], php(2749.5));
  assert.equal(c.bal(w), php(20000 - 1250.5));
  // new cut-off does not reset the debt
  c.run(L.recordSalaryOps(c.s, { amount: php(1000), date: c.today, walletId: w.id }, c.today));
  assert.equal(L.debtRemainingMap(c.s)[d.id], php(2749.5));
  const r = c.run(L.payDebtOps(c.s, { debtId: d.id, amount: php(2749.5), date: c.today, walletId: w.id }, c.today));
  assert.equal(r.paidOff, true);
  const info = L.debtInfo(c.s, d, c.today);
  assert.equal(info.paid, true); assert.equal(info.remaining, 0); assert.equal(info.payments.length, 2);
  c.bad(L.payDebtOps(c.s, { debtId: d.id, amount: php(1), date: c.today, walletId: w.id }, c.today), /fully paid/);
  assert.equal(L.debtSummary(c.s, c.today).totalRemaining, 0);
  assert.equal(L.summarize(c.s.transactions).debt, php(4000));
});

test('wallet safety: balance blocks removal, history archives, empty deletes', () => {
  const c = ctx();
  const a = c.wallet('A', 100), b = c.wallet('B', 0), e = c.wallet('Empty', 0);
  assert.equal(L.removalCheck(c.s, 'wallet', a.id).action, 'blocked');
  c.bad(L.removeItemOps(c.s, 'wallet', a.id, c.today), /still holds/);
  assert.equal(L.removalCheck(c.s, 'wallet', e.id).action, 'delete');
  c.run(L.addTransactionOps(c.s, { type: 'transfer', amount: php(100), date: c.today, walletId: a.id, toWalletId: b.id, note: 'move all' }, c.today));
  assert.equal(L.removalCheck(c.s, 'wallet', a.id).action, 'archive', 'zero balance but linked history');
  const r = c.run(L.removeItemOps(c.s, 'wallet', a.id, c.today));
  assert.equal(r.mode, 'archived');
  assert.equal(L.totalBalance(c.s), php(100));
  assert.equal(c.s.transactions.length, 1, 'history preserved');
  assert.equal(L.activeWallets(c.s).length, 2);
  c.bad(L.addTransactionOps(c.s, { type: 'expense', amount: php(1), date: c.today, walletId: a.id, category: 'Other' }, c.today), /archived/);
  assert.equal(c.run(L.removeItemOps(c.s, 'wallet', e.id, c.today)).mode, 'deleted');
  c.run(L.restoreItemOps(c.s, 'wallet', a.id));
  assert.equal(L.activeWallets(c.s).length, 2);
  // goals with savings cannot be deleted
  const goal = c.run(L.addGoalOps(c.s, { name: 'Phone', target: php(100) })).goal;
  c.run(L.addTransactionOps(c.s, { type: 'savings', amount: php(10), date: c.today, walletId: b.id, goalId: goal.id }, c.today));
  assert.equal(L.removalCheck(c.s, 'goal', goal.id).action, 'blocked');
});

test('editing/deleting transactions never duplicates and keeps every total consistent', () => {
  const c = ctx();
  const w = c.wallet('Cash', 1000);
  c.run(L.addTransactionOps(c.s, { type: 'expense', amount: php(100), date: c.today, walletId: w.id, category: 'Medical' }, c.today));
  const id = c.s.transactions[0].id;
  for (let i = 1; i <= 5; i++) c.run(L.updateTransactionOps(c.s, id, { type: 'expense', amount: php(100 + i), date: c.today, walletId: w.id, category: 'Medical' }, c.today));
  assert.equal(c.s.transactions.length, 1);
  assert.equal(c.bal(w), php(1000 - 105));
  // cannot delete income that would leave a wallet negative
  c.run(L.addTransactionOps(c.s, { type: 'income', amount: php(500), date: c.today, walletId: w.id, category: 'Bonus' }, c.today));
  const inc = c.s.transactions.find((t) => t.type === 'income');
  c.run(L.addTransactionOps(c.s, { type: 'expense', amount: php(1300), date: c.today, walletId: w.id, category: 'Other' }, c.today));
  c.bad(L.deleteTransactionOps(c.s, inc.id), /below/);
  // type cannot be changed on edit
  const r = L.updateTransactionOps(c.s, id, { type: 'income', amount: php(10), date: c.today, walletId: w.id, category: 'Medical' }, c.today);
  assert.equal(r.tx.type, 'expense');
});

test('editing a salary re-scales its plan; deleting it removes the cut-off, plan and week closings', () => {
  const c = ctx('2026-11-30');
  const w = c.wallet('Bank', 0, 'Bank Account');
  const r = c.run(L.recordSalaryOps(c.s, { amount: php(20000), date: '2026-11-17', walletId: w.id }, c.today));
  c.run(L.saveAllocationOps(c.s, r.cutoffId, L.defaultAllocationItems(php(20000), c.s.settings)));
  c.run(L.updateTransactionOps(c.s, r.cutoffId, { amount: php(25000), date: '2026-11-17', walletId: w.id }, c.today));
  assert.equal(L.sum(L.getAllocation(c.s, r.cutoffId).items, (i) => i.amount), php(25000));
  assert.equal(L.currentCutoff(c.s).amount, php(25000));
  c.run(L.deleteTransactionOps(c.s, r.cutoffId));
  assert.equal(L.getCutoffs(c.s).length, 0); assert.equal(c.s.allocations.length, 0);
});

test('safe to spend = balance - unpaid bills due before payday; daily guide; goals excluded', () => {
  const c = ctx('2026-11-20');
  const w = c.wallet('GCash', 0, 'E-Wallet');
  const goal = c.run(L.addGoalOps(c.s, { name: 'G', target: php(9999), openingSaved: php(50000) })).goal;
  c.run(L.recordSalaryOps(c.s, { amount: php(10000), date: '2026-11-17', walletId: w.id }, c.today));
  c.run(L.addBillOps(c.s, { name: 'Internet', amount: php(1500), dueDay: 25, category: 'Internet' }, '2026-11-01'));  // before Nov 30 payday
  c.run(L.addBillOps(c.s, { name: 'Rent', amount: php(5000), dueDay: 5, category: 'Rent' }, '2026-11-01'));          // Dec 5: after payday
  const s = L.safeToSpend(c.s, c.today);
  assert.equal(s.total, php(10000), 'goal savings are NOT in Total Balance');
  assert.equal(s.payday.date, '2026-11-30'); assert.equal(s.days, 10);
  // Rent for Nov 5 was never paid (overdue, current month) and also counts
  assert.equal(s.reservedTotal, php(6500));
  assert.equal(s.safe, php(3500));
  assert.equal(s.daily, php(350));
  assert.equal(s.variableLeft, null, 'no plan yet -> balance based');
  assert.ok(goal);

  // With a planned allocation: variable budget left caps it, unmet goal/tithe plans are earmarked
  const cut = L.currentCutoff(c.s);
  c.run(L.saveAllocationOps(c.s, cut.id, L.defaultAllocationItems(php(10000), c.s.settings))); // variable 4000, goals 1000, tithes 1000
  c.run(L.addTransactionOps(c.s, { type: 'expense', amount: php(1000), date: '2026-11-18', walletId: w.id, category: 'Medical' }, c.today));
  const p = L.safeToSpend(c.s, c.today);
  assert.equal(p.total, php(9000));
  assert.deepEqual(p.earmarked, { goals: php(1000), offering: php(1000) });
  assert.equal(p.available, php(9000 - 6500 - 2000));      // 500
  assert.equal(p.variableLeft, php(3000));
  assert.equal(p.safe, php(500), 'cannot exceed what you actually have free');
  assert.equal(p.limitedByBudget, false);
  // lots of free money -> the remaining variable budget becomes the ceiling
  c.run(L.addTransactionOps(c.s, { type: 'income', amount: php(20000), date: '2026-11-19', walletId: w.id, category: 'Bonus' }, c.today));
  const q = L.safeToSpend(c.s, c.today);
  assert.equal(q.safe, php(3000)); assert.equal(q.limitedByBudget, true); assert.equal(q.daily, php(300));
});

test('reminders flag overdue salary, due bills, budget usage', () => {
  const c = ctx('2026-12-02'); // Nov 30 payday has passed
  const w = c.wallet('Cash', 50000);
  c.run(L.recordSalaryOps(c.s, { amount: php(10000), date: '2026-11-17', walletId: w.id }, '2026-11-17'));
  c.run(L.addBillOps(c.s, { name: 'Water', amount: php(300), dueDay: 1, category: 'Utilities' }, '2026-11-01'));
  const msgs = L.reminders(c.s, c.today).map((r) => r.title);
  assert.ok(msgs.some((t) => /Salary expected/.test(t)), 'overdue payday reminder');
  assert.ok(msgs.some((t) => /Water is overdue/.test(t)), 'overdue bill reminder');
});

test('reports: period filters, category spend, cut-off + monthly summaries, CSV', () => {
  const c = ctx('2026-11-20');
  const w = c.wallet('Cash', 100000);
  c.run(L.recordSalaryOps(c.s, { amount: php(20000), date: '2026-11-03', walletId: w.id }, c.today));
  c.run(L.addTransactionOps(c.s, { type: 'expense', amount: php(120), date: '2026-11-04', walletId: w.id, category: 'Medical', note: 'Gamot, "mild"' }, c.today));
  c.run(L.addTransactionOps(c.s, { type: 'expense', amount: php(80), date: '2026-11-05', walletId: w.id, category: 'Medical' }, c.today));
  const cat = L.spendingByCategory(c.s.transactions);
  assert.deepEqual(cat, [{ category: 'Medical', amount: php(200) }]);
  assert.equal(L.monthlySummaries(c.s)[0].summary.income, php(20000));
  const p = L.periodTransactions(c.s, { kind: 'range', from: '2026-11-05', to: '2026-11-05' });
  assert.equal(p.txs.length, 1);
  assert.equal(L.filterTransactions(c.s, { type: 'expense' }).length, 2);
  assert.equal(L.filterTransactions(c.s, { category: 'Medical', q: 'mild' }).length, 1);
  const csv = L.transactionsCSV(c.s, L.sortTransactions(c.s.transactions));
  assert.match(csv, /"Gamot, ""mild"""/);
});

test('consistency: wallet net change always equals income - expenses - net savings', () => {
  const st = Demo.buildDemoState('2026-11-01');
  assert.deepEqual(L.validateLedger(st), []);
  const opening = L.sum(st.wallets, (w) => w.openingBalance);
  const s = L.summarize(st.transactions);
  assert.equal(L.totalBalance(st) - opening, s.net, 'dashboard, reports and wallets agree');
  // every transaction is counted exactly once across cut-offs + pre-cutoff (history before first salary)
  const first = L.getCutoffs(st)[0].start;
  const inCut = L.sum(L.getCutoffs(st), (c) => L.cutoffTransactions(st, c).length);
  assert.equal(inCut + st.transactions.filter((t) => t.date < first).length, st.transactions.length);
});

test('demo data is valid and covers every feature', () => {
  for (const today of ['2026-11-01', '2026-11-16', '2026-12-31', '2027-03-15']) {
    const st = Demo.buildDemoState(today);
    assert.deepEqual(L.validateLedger(st), [], 'valid ledger on ' + today);
    assert.ok(st.wallets.length >= 4 && st.goals.length >= 3 && st.bills.length >= 5 && st.debts.length >= 3);
    assert.ok(L.getCutoffs(st).length >= 4);
    assert.ok(st.transactions.every((t) => t.date <= today), 'no future-dated demo transactions');
    assert.ok(L.totalBalance(st) > 0);
    const types = new Set(st.transactions.map((t) => t.type));
    for (const t of Object.values(L.TX)) assert.ok(types.has(t), 'demo includes ' + t);
    assert.ok(st.weekClosures.length >= 1, 'demo has week closings');
    assert.ok(!L.nextExpectedPayday(st, today).overdue || true);
  }
});
