import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
const Module = require('module');
const originalLoad = Module._load;
let activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-accounting-expenses-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => activeTestDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};
const dbModule = require('../main/db');
const { initDatabase, getDatabase, getCurrentSchemaVersion, closeDatabase } = dbModule;
const expenses = require('../main/accounting/expenses');
let checks = 0;
function equal(actual: unknown, expected: unknown, message: string): void { assert.equal(actual, expected, message); checks++; }
function ok(value: unknown, message: string): void { assert.ok(value, message); checks++; }
function throws(fn: () => unknown, pattern: RegExp, message: string): void { assert.throws(fn, pattern, message); checks++; }
function resetDb(): any {
  try { closeDatabase(); } catch {}
  activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-accounting-expenses-case-'));
  initDatabase();
  const db = getDatabase();
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('country', 'IR', CURRENT_TIMESTAMP)").run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('currency', 'IRR', CURRENT_TIMESTAMP)").run();
  return db;
}
try {
  const db = resetDb();
  equal(getCurrentSchemaVersion(), 103, 'fresh install reaches schema v103');
  for (const table of ['accounting_expense_categories','accounting_payment_method_mappings','accounting_expenses']) {
    ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), 'migration creates ' + table);
  }
  const selectableAccounts = expenses.listPostingAccounts(db, ['expense']);
  ok(selectableAccounts.some((account: any) => account.id === 'acct-operating-expenses'), 'account API source lists active posting expense accounts');
  ok(!selectableAccounts.some((account: any) => account.id === 'acct-expenses'), 'account selection excludes non-postable group accounts');
  equal(expenses.listPostingAccounts(db, ['not-an-account-type']).length, 0, 'invalid account-type filters return no accounts instead of all accounts');

  const category = expenses.saveExpenseCategory(db, { name: 'Utilities', expense_account_id: 'acct-operating-expenses' }, 'manager-1');
  equal(category.name, 'Utilities', 'category is created');
  equal(category.expense_account_id, 'acct-operating-expenses', 'category maps to the selected expense account');
  throws(() => expenses.saveExpenseCategory(db, { name: 'Wrong account', expense_account_id: 'acct-cash-drawer' }, 'manager-1'), /requires an account of type: expense/i, 'category cannot map to cash');
  throws(() => expenses.saveExpenseCategory(db, { name: 'Utilities', expense_account_id: 'acct-operating-expenses' }, 'manager-1'), /already exists/i, 'category names are case-insensitively unique');

  throws(() => expenses.createExpense(db, {
    category_id: category.id, expense_date: '2026-10-11', amount_minor: 1000, currency_code: 'USD',
    description: 'Wrong currency must be rejected',
  }, 'manager-1'), /must match the configured store currency/i, 'expense currency must match the configured store currency');

  throws(() => db.prepare('INSERT INTO accounting_expenses (id,category_id,expense_account_id,expense_date,amount_minor,currency_code,description) VALUES (?,?,?,?,?,?,?)')
    .run('direct-fractional-amount', category.id, 'acct-operating-expenses', '2026-10-11', 1.5, 'IRR', 'Direct fractional amount'),
    /safe integer/i, 'database trigger rejects fractional expense minor units');
  throws(() => db.prepare('INSERT INTO accounting_expenses (id,category_id,expense_account_id,expense_date,amount_minor,currency_code,description) VALUES (?,?,?,?,?,?,?)')
    .run('direct-invalid-date', category.id, 'acct-operating-expenses', '2026-02-30', 100, 'IRR', 'Direct invalid date'),
    /real calendar date/i, 'database trigger rejects impossible calendar dates');
  throws(() => db.prepare('INSERT INTO accounting_expenses (id,category_id,expense_account_id,expense_date,amount_minor,currency_code,description) VALUES (?,?,?,?,?,?,?)')
    .run('direct-wrong-currency', category.id, 'acct-operating-expenses', '2026-10-11', 100, 'USD', 'Direct wrong currency'),
    /configured store currency/i, 'database trigger rejects mismatched store currency');
  throws(() => db.prepare('INSERT INTO accounting_expenses (id,category_id,expense_account_id,expense_date,amount_minor,currency_code,description,idempotency_key) VALUES (?,?,?,?,?,?,?,?)')
    .run('direct-bad-idempotency', category.id, 'acct-operating-expenses', '2026-10-11', 100, 'IRR', 'Invalid idempotency fields', 'direct-key'),
    /idempotency key and payload hash/i, 'database trigger rejects incomplete idempotency metadata');

  const inactiveCategory = expenses.saveExpenseCategory(db, { name: 'Archived costs', expense_account_id: 'acct-operating-expenses', is_active: false }, 'manager-1');
  equal(inactiveCategory.is_active, 0, 'category can be deactivated explicitly');
  const inactiveAfterEdit = expenses.saveExpenseCategory(db, { name: 'Archived costs', expense_account_id: 'acct-payment-fees' }, 'manager-1', inactiveCategory.id);
  equal(inactiveAfterEdit.is_active, 0, 'editing an inactive category without is_active does not reactivate it');
  throws(() => expenses.saveExpenseCategory(db, { name: 'Bad active value', expense_account_id: 'acct-operating-expenses', is_active: 'false' }, 'manager-1'), /must be a boolean/i, 'invalid active flags are rejected');

  const mapping = expenses.setPaymentAccountMapping(db, 'cash', 'acct-cash-drawer', 'manager-1');
  equal(mapping.account_id, 'acct-cash-drawer', 'cash maps to cash drawer');
  throws(() => expenses.setPaymentAccountMapping(db, 'cash', 'acct-operating-expenses', 'manager-1'), /requires an account of type: asset/i, 'cash cannot map to expense account');
  throws(() => expenses.setPaymentAccountMapping(db, 'custom:999999', 'acct-bank', 'manager-1'), /custom payment method does not exist/i, 'unknown custom payment methods are rejected');

  const customMethod = db.prepare("INSERT INTO payment_methods (name,is_active,sort_order,created_at,updated_at) VALUES ('Online Transfer',1,10,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").run();
  const customKey = 'custom:' + Number(customMethod.lastInsertRowid);
  const customMapping = expenses.setPaymentAccountMapping(db, customKey, 'acct-bank', 'manager-1');
  throws(() => expenses.setPaymentAccountMapping(db, customKey, 'acct-payables', 'manager-1'), /requires an account of type: asset/i, 'custom payment methods cannot map to liability accounts');
  const customPaid = expenses.createExpense(db, {
    category_id: category.id, expense_date: '2026-10-11', amount_minor: 1000, currency_code: 'IRR',
    description: 'Custom payment uses its asset account', payment_status: 'paid',
    payment_method_key: customKey, payment_date: '2026-10-11',
  }, 'manager-1');
  equal(customPaid.payment_account_id, 'acct-bank', 'paid custom-method expense snapshots its mapped asset account');
  db.prepare('UPDATE payment_methods SET is_active = 0 WHERE id = ?').run(Number(customMethod.lastInsertRowid));
  throws(() => expenses.createExpense(db, {
    category_id: category.id, expense_date: '2026-10-11', amount_minor: 1000, currency_code: 'IRR',
    description: 'Inactive payment methods must not be used for new expenses', payment_status: 'paid',
    payment_method_key: customKey, payment_date: '2026-10-11',
  }, 'manager-1'), /active payment method/i, 'inactive custom payment methods cannot pay a new expense');
  db.prepare('UPDATE payment_methods SET is_active = 1 WHERE id = ?').run(Number(customMethod.lastInsertRowid));
  equal(customMapping.payment_method_name, 'Online Transfer', 'existing custom payment method is exposed in account mapping');
  equal(customMapping.account_id, 'acct-bank', 'custom payment method maps to selected bank account');
  ok(expenses.listPaymentAccountMappings(db).some((item: any) => item.payment_method_key === customKey && item.account_id === 'acct-bank'), 'mapping list returns configured custom payment methods');

  const unpaid = expenses.createExpense(db, {
    category_id: category.id, expense_date: '2026-10-11', amount_minor: 250000, currency_code: 'IRR',
    description: 'Monthly electricity', payment_status: 'unpaid',
  }, 'manager-1');
  equal(unpaid.status, 'draft', 'new expense starts as draft');
  equal(unpaid.payment_status, 'unpaid', 'unpaid expense needs no payment mapping');
  equal(unpaid.payment_method_key, null, 'unpaid expense has no payment method');
  equal(expenses.listExpenses(db, { category_id: category.id }).length, 2, 'expense list filters by category after multiple expenses exist');
  throws(() => expenses.listExpenses(db, { status: 'unexpected' }), /status filter must be/i, 'invalid expense status filters are rejected');
  throws(() => expenses.listExpenses(db, { payment_status: 'unexpected' }), /payment status filter must be/i, 'invalid payment status filters are rejected');
  equal(expenses.getExpense(db, unpaid.id).id, unpaid.id, 'expense detail resolves the created record');

  throws(() => expenses.createExpense(db, {
    category_id: category.id, expense_date: '2026-02-30', amount_minor: 100, currency_code: 'IRR', description: 'Invalid date',
  }, 'manager-1'), /real calendar date/i, 'impossible expense dates are rejected');
  throws(() => expenses.createExpense(db, {
    category_id: category.id, expense_date: '2026-10-11', amount_minor: 0, currency_code: 'IRR', description: 'Zero amount',
  }, 'manager-1'), /positive safe integer/i, 'zero amount is rejected');
  throws(() => expenses.createExpense(db, {
    category_id: category.id, expense_date: '2026-10-11', amount_minor: 100, currency_code: 'IRR', description: 'Paid without mapping',
    payment_status: 'paid', payment_method_key: 'card', payment_date: '2026-10-11',
  }, 'manager-1'), /map this payment method/i, 'paid expense requires a mapped payment method');

  const paidRequest = {
    category_id: category.id, expense_date: '2026-10-11', amount_minor: 12000, currency_code: 'IRR',
    description: 'Paid for supplies', payee: 'Coffee Supplier', reference_number: 'INV-12000',
    payment_status: 'paid', payment_method_key: 'cash', payment_date: '2026-10-11',
  };
  const paid = expenses.createExpense(db, paidRequest, 'manager-1', 'expense-request-0001');
  const creationAudit = JSON.parse((db.prepare("SELECT after_json FROM accounting_audit_log WHERE entity_type='expense' AND entity_id=? ORDER BY id DESC LIMIT 1").get(paid.id) as any).after_json);
  equal(creationAudit.payee, 'Coffee Supplier', 'expense creation audit snapshot includes payee');
  equal(creationAudit.reference_number, 'INV-12000', 'expense creation audit snapshot includes reference number');
  equal(paid.payment_status, 'paid', 'paid expense keeps payment state');
  equal(paid.payment_account_id, 'acct-cash-drawer', 'expense detail snapshots the mapped payment account');
  expenses.setPaymentAccountMapping(db, 'cash', 'acct-bank', 'manager-1');
  equal(expenses.getExpense(db, paid.id).payment_account_id, 'acct-cash-drawer', 'later mapping changes do not rewrite an existing expense payment account');
  const replayedPaid = expenses.createExpense(db, paidRequest, 'manager-1', 'expense-request-0001');
  equal(replayedPaid.id, paid.id, 'retry with the same idempotency key returns the original expense');
  equal(replayedPaid.payment_account_id, 'acct-cash-drawer', 'idempotent retry retains the original payment account snapshot after mapping changes');
  equal((db.prepare('SELECT COUNT(*) AS count FROM accounting_expenses WHERE idempotency_key = ?').get('expense-request-0001') as any).count, 1, 'idempotent retry does not create a duplicate expense');
  throws(() => expenses.createExpense(db, { ...paidRequest, amount_minor: 12001 }, 'manager-1', 'expense-request-0001'),
    /already used with a different expense payload/i, 'reusing an idempotency key with changed content is rejected');
  expenses.saveExpenseCategory(db, { name: 'Utilities', expense_account_id: 'acct-payment-fees' }, 'manager-1', category.id);
  equal(expenses.getExpense(db, unpaid.id).expense_account_id, 'acct-operating-expenses', 'category remapping does not rewrite an existing draft expense account');
  equal(expenses.getExpense(db, paid.id).expense_account_id, 'acct-operating-expenses', 'category remapping does not rewrite a paid expense account');
  const edited = expenses.updateDraftExpense(db, unpaid.id, {
    category_id: category.id, expense_date: '2026-10-11', amount_minor: 275000, currency_code: 'IRR',
    description: 'Corrected electricity bill', payee: 'Electric Company', reference_number: 'ELEC-2026-10',
    payment_status: 'paid', payment_method_key: 'cash', payment_date: '2026-10-11',
  }, 'manager-1');
  equal(edited.amount_minor, 275000, 'draft expense can be edited');
  equal(edited.expense_account_id, 'acct-operating-expenses', 'editing a draft keeps its original account snapshot when category is unchanged');
  equal(edited.payment_account_id, 'acct-bank', 'changing a draft to paid snapshots the currently mapped payment account');
  const expenseAuditAfterEdit = JSON.parse((db.prepare("SELECT after_json FROM accounting_audit_log WHERE entity_type='expense' AND entity_id=? ORDER BY id DESC LIMIT 1").get(unpaid.id) as any).after_json);
  equal(expenseAuditAfterEdit.payment_account_id, 'acct-bank', 'expense audit after-snapshot records the selected payment account');
  equal(expenseAuditAfterEdit.payee, 'Electric Company', 'expense edit audit snapshot includes the updated payee');
  equal(expenseAuditAfterEdit.reference_number, 'ELEC-2026-10', 'expense edit audit snapshot includes the updated reference number');
  const expenseAuditBeforeEdit = JSON.parse((db.prepare("SELECT before_json FROM accounting_audit_log WHERE entity_type='expense' AND entity_id=? ORDER BY id DESC LIMIT 1").get(unpaid.id) as any).before_json);
  equal(expenseAuditBeforeEdit.payee, null, 'expense edit audit before-snapshot preserves the previous payee');
  equal(expenseAuditBeforeEdit.reference_number, null, 'expense edit audit before-snapshot preserves the previous reference number');
  equal((db.prepare("SELECT COUNT(*) AS count FROM accounting_audit_log WHERE entity_type='expense' AND entity_id=?").get(unpaid.id) as any).count, 2, 'expense creation and edit are both audited');
  equal((db.prepare("SELECT COUNT(*) AS count FROM accounting_audit_log WHERE entity_type='expense_category' AND entity_id=?").get(category.id) as any).count, 2, 'expense category creation and remapping are audited');
  equal((db.prepare("SELECT COUNT(*) AS count FROM accounting_audit_log WHERE entity_type='payment_method_mapping' AND entity_id='cash'").get() as any).count, 2, 'payment account mapping changes are audited');
  const mappingAudit = db.prepare("SELECT before_json, after_json FROM accounting_audit_log WHERE entity_type='payment_method_mapping' AND entity_id='cash' ORDER BY id DESC LIMIT 1").get() as any;
  equal(JSON.parse(mappingAudit.before_json).account_id, 'acct-cash-drawer', 'mapping audit preserves the previous account');
  equal(JSON.parse(mappingAudit.after_json).account_id, 'acct-bank', 'mapping audit records the new account');
  throws(() => expenses.assertAccountingDate('2026-02-30'), /real calendar date/i, 'invalid calendar days are rejected');
  console.log('Accounting expense foundation: ' + checks + ' assertions passed.');
} catch (error) {
  console.error('Accounting expense foundation failed:', error); process.exitCode = 1;
} finally {
  try { closeDatabase(); } catch {}
  Module._load = originalLoad;
  fs.rmSync(activeTestDir, { recursive: true, force: true });
}
