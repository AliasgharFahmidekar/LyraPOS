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
const transfers = require('../main/accounting/transfers');
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
  equal(getCurrentSchemaVersion(), 118, 'fresh install reaches the latest schema version 118');
  for (const table of ['accounting_expense_categories','accounting_payment_method_mappings','accounting_expenses']) {
    ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), 'migration creates ' + table);
  }
  const seededCategories = expenses.listExpenseCategories(db);
  ok(seededCategories.some((category: any) => category.id === 'expense-category-general' && category.expense_account_id === 'acct-operating-expenses'), 'general expenses is available as the safe default category');
  ok(seededCategories.some((category: any) => category.id === 'expense-category-tax-payments' && category.expense_account_id === 'acct-tax-expenses'), 'tax payments can be recorded against the dedicated tax expense account');
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
  equal(expenses.listPaymentAccountMappings(db).some((item: any) => item.payment_method_key === 'loyalty'), false, 'loyalty wallet is not exposed as an accounting mapping');
  throws(() => expenses.setPaymentAccountMapping(db, 'loyalty', 'acct-customer-advances', 'manager-1'), /supported existing payment method/i, 'loyalty wallet cannot be configured as an accounting payment method');
  equal(mapping.account_id, 'acct-cash-drawer', 'cash maps to cash drawer');
  throws(() => expenses.setPaymentAccountMapping(db, 'cash', 'acct-operating-expenses', 'manager-1'), /requires an account of type: asset/i, 'cash cannot map to expense account');
  throws(() => expenses.setPaymentAccountMapping(db, 'custom:999999', 'acct-bank', 'manager-1'), /custom payment method does not exist/i, 'unknown custom payment methods are rejected');

  const customMethod = db.prepare("INSERT INTO payment_methods (name,is_active,sort_order,created_at,updated_at) VALUES ('Online Transfer',1,10,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").run();
  const customKey = 'custom:' + Number(customMethod.lastInsertRowid);
  const customMapping = expenses.setPaymentAccountMapping(db, customKey, 'acct-bank', 'manager-1');
  db.prepare(`
    INSERT INTO accounting_accounts
      (id, system_key, account_code, name, account_type, normal_balance, parent_account_id, is_system, is_active, is_postable)
    VALUES ('acct-custom-nonliquid-test', NULL, '1198', 'Unclassified custom asset', 'asset', 'debit', 'acct-assets', 0, 1, 1)
  `).run();
  throws(() => expenses.setPaymentAccountMapping(db, customKey, 'acct-custom-nonliquid-test', 'manager-1'),
    /configured cash, bank, or payment-clearing/i, 'custom payment methods cannot map to an unclassified custom asset');
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
    category_id: category.id, expense_date: '2026-10-11', due_date: '2000-01-01', amount_minor: 250000, currency_code: 'IRR',
    description: 'Monthly electricity', payment_status: 'unpaid',
  }, 'manager-1');
  equal(unpaid.status, 'draft', 'new expense starts as draft');
  equal(unpaid.payment_status, 'unpaid', 'unpaid expense needs no payment mapping');
  equal(unpaid.payment_method_key, null, 'unpaid expense has no payment method');
  equal(unpaid.due_date, '2000-01-01', 'optional due date is persisted for unpaid expenses');
  equal(unpaid.is_overdue, 1, 'unpaid draft with a past due date is reported overdue');
  ok(expenses.listExpenses(db, { overdue: 'true' }).some((row: any) => row.id === unpaid.id), 'overdue filter includes an unpaid draft past its due date');
  throws(() => expenses.createExpense(db, {
    category_id: category.id, expense_date: '2026-10-11', due_date: '2026-02-30', amount_minor: 100, currency_code: 'IRR', description: 'Invalid due date',
  }, 'manager-1'), /real calendar date/i, 'impossible due dates are rejected');
  throws(() => db.prepare("UPDATE accounting_expenses SET due_date='2026-02-30' WHERE id=?").run(unpaid.id),
    /due date must be a real calendar date/i, 'database rejects impossible due dates even when bypassing the service');
  throws(() => expenses.postExpense(db, unpaid.id, 'manager-1'), /only expenses already marked as paid/i, 'unpaid draft cannot be posted');
  equal((db.prepare("SELECT COUNT(*) AS count FROM accounting_journal_entries WHERE source_type='expense' AND source_id=?").get(unpaid.id) as any).count,
    0, 'unpaid expense creates no journal and cannot reduce cash');
  equal(expenses.listExpenses(db, { category_id: category.id }).length, 2, 'expense list filters by category after multiple expenses exist');
  throws(() => expenses.listExpenses(db, { status: 'unexpected' }), /status filter must be/i, 'invalid expense status filters are rejected');
  throws(() => expenses.listExpenses(db, { payment_status: 'unexpected' }), /payment status filter must be/i, 'invalid payment status filters are rejected');
  equal(expenses.getExpense(db, unpaid.id).id, unpaid.id, 'expense detail resolves the created record');
  const cancelPayload = {
    category_id: category.id, expense_date: '2026-10-11', due_date: '2000-01-01', amount_minor: 1234,
    currency_code: 'IRR', description: 'Draft to cancel', payment_status: 'unpaid',
  };
  const cancelDraft = expenses.createExpense(db, cancelPayload, 'manager-1', 'cancel-draft-test-key');
  const cancelled = expenses.cancelDraftExpense(db, cancelDraft.id, 'Entered by mistake', 'manager-1');
  equal(cancelled.status, 'cancelled', 'unpaid draft can be cancelled');
  equal(expenses.getExpense(db, cancelDraft.id).status, 'cancelled', 'cancelled draft retains an inspectable identity');
  equal(expenses.listExpenses(db, {}).some((row: any) => row.id === cancelDraft.id), false, 'cancelled draft is omitted from the active expense list');
  const cancelledRetry = expenses.createExpense(db, cancelPayload, 'manager-1', 'cancel-draft-test-key');
  equal(cancelledRetry.id, cancelDraft.id, 'retrying the original request after cancellation cannot recreate a duplicate expense');
  equal(cancelledRetry.status, 'cancelled', 'idempotent retry returns the cancelled state');
  equal(expenses.cancelDraftExpense(db, cancelDraft.id, 'Entered by mistake', 'manager-1').duplicate, true, 'identical cancellation retry is idempotent');
  const cancellationAudit = db.prepare("SELECT action,after_json FROM accounting_audit_log WHERE entity_type='expense' AND entity_id=? ORDER BY id DESC LIMIT 1").get(cancelDraft.id) as any;
  equal(cancellationAudit.action, 'cancelled', 'cancelling a draft records an audit action');
  equal(JSON.parse(cancellationAudit.after_json).cancellation_reason, 'Entered by mistake', 'cancellation audit keeps the reason');
  equal((db.prepare("SELECT COUNT(*) AS count FROM accounting_journal_entries WHERE source_type='expense' AND source_id=?").get(cancelDraft.id) as any).count, 0, 'cancelling an unpaid draft creates no journal');
  throws(() => expenses.cancelDraftExpense(db, customPaid.id, 'Try cancel paid', 'manager-1'), /only draft expenses can be cancelled|paid expense cannot be cancelled/i, 'a paid expense cannot be cancelled or deleted');
  throws(() => db.prepare('UPDATE accounting_expenses SET cancelled_at=NULL WHERE id=?').run(cancelDraft.id), /cancelled expense history is immutable/i, 'database prevents a cancelled draft from being reactivated');
  throws(() => db.prepare('UPDATE accounting_expenses SET amount_minor=amount_minor+1 WHERE id=?').run(cancelDraft.id), /cancelled expense details are immutable/i, 'database prevents editing the financial values of a cancelled draft');
  throws(() => db.prepare('DELETE FROM accounting_expenses WHERE id=?').run(cancelDraft.id), /cancelled expense identity and idempotency keys cannot be deleted/i, 'database preserves cancellation and idempotency identity');

  throws(() => expenses.createExpense(db, {
    category_id: category.id, expense_date: '2026-02-30', amount_minor: 100, currency_code: 'IRR', description: 'Invalid date',
  }, 'manager-1'), /real calendar date/i, 'impossible expense dates are rejected');
  throws(() => expenses.createExpense(db, {
    category_id: category.id, expense_date: '2026-10-11', amount_minor: 0, currency_code: 'IRR', description: 'Zero amount',
  }, 'manager-1'), /positive safe integer/i, 'zero amount is rejected');
  const unmappedMethod = db.prepare("INSERT INTO payment_methods (name,is_active,sort_order,created_at,updated_at) VALUES ('Unmapped Test Method',1,20,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").run();
  const unmappedMethodKey = 'custom:' + Number(unmappedMethod.lastInsertRowid);
  // Ensure the fixture really represents an unmapped payment method.
  db.prepare('DELETE FROM accounting_payment_method_mappings WHERE payment_method_key = ?').run(unmappedMethodKey);
  equal(
    (db.prepare('SELECT COUNT(*) AS count FROM accounting_payment_method_mappings WHERE payment_method_key = ?').get(unmappedMethodKey) as any).count,
    0,
    'unmapped-method fixture has no accounting mapping before expense creation',
  );
  const paidWithoutMethodMapping = expenses.createExpense(db, {
    category_id: category.id, expense_date: '2026-10-11', amount_minor: 100, currency_code: 'IRR', description: 'Paid without method-specific mapping',
    payment_status: 'paid', payment_method_key: unmappedMethodKey, payment_date: '2026-10-11',
  }, 'manager-1');
  equal(paidWithoutMethodMapping.payment_account_id, expenses.getDefaultPaymentAccountMapping(db).account_id,
    'paid expense without a method-specific mapping snapshots the configured default payment account');
  equal((db.prepare('SELECT COUNT(*) AS count FROM accounting_payment_method_mappings WHERE payment_method_key = ?').get(unmappedMethodKey) as any).count, 0,
    'using the default account does not create a permanent method-specific mapping');
  equal(paidWithoutMethodMapping.status, 'posted', 'a paid expense is posted automatically during creation');
  equal(!!paidWithoutMethodMapping.posted_journal_entry_id, true, 'automatic payment posting links the journal to the expense');
  equal((db.prepare("SELECT COUNT(*) AS count FROM accounting_journal_entries WHERE source_type='expense' AND source_id=? AND source_event='expense_paid'").get(paidWithoutMethodMapping.id) as any).count, 1,
    'a paid expense creates exactly one journal during creation');

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
  equal(paid.status, 'posted', 'paid expense is saved already posted');
  equal(paid.payment_account_id, 'acct-cash-drawer', 'expense detail snapshots the mapped payment account');
  expenses.setPaymentAccountMapping(db, 'cash', 'acct-bank', 'manager-1');
  equal(expenses.getExpense(db, paid.id).payment_account_id, 'acct-cash-drawer', 'later mapping changes do not rewrite an existing expense payment account');
  const replayedPaid = expenses.createExpense(db, paidRequest, 'manager-1', 'expense-request-0001');
  equal(replayedPaid.id, paid.id, 'retry with the same idempotency key returns the original expense');
  equal(replayedPaid.payment_account_id, 'acct-cash-drawer', 'idempotent retry retains the original payment account snapshot after mapping changes');
  equal((db.prepare('SELECT COUNT(*) AS count FROM accounting_expenses WHERE idempotency_key = ?').get('expense-request-0001') as any).count, 1, 'idempotent retry does not create a duplicate expense');
  throws(() => expenses.createExpense(db, { ...paidRequest, amount_minor: 12001 }, 'manager-1', 'expense-request-0001'),
    /already used with a different expense payload/i, 'reusing an idempotency key with changed content is rejected');

  const postedPaid = expenses.postExpense(db, paid.id, 'manager-1');
  equal(postedPaid.status, 'posted', 'paid expense is posted with its journal during creation');
  equal(postedPaid.duplicate, true, 'calling post after automatic posting safely returns the existing entry');
  const paidJournal = db.prepare('SELECT id, status, entry_date, currency_code, source_type, source_id, source_event FROM accounting_journal_entries WHERE id=?')
    .get(postedPaid.posted_journal_entry_id) as any;
  equal(paidJournal.status, 'posted', 'expense journal is finalized in the same posting transaction');
  equal(paidJournal.entry_date, '2026-10-11', 'expense journal uses the actual payment date');
  equal(paidJournal.source_event, 'expense_paid', 'expense journal has a stable source event');
  const paidLines = db.prepare('SELECT account_id,debit_minor,credit_minor FROM accounting_journal_lines WHERE journal_entry_id=? ORDER BY line_no')
    .all(paidJournal.id) as any[];
  equal(paidLines.length, 2, 'paid expense creates a two-line double-entry journal');
  equal(paidLines[0].account_id, 'acct-operating-expenses', 'expense journal debits the snapshotted expense account');
  equal(paidLines[0].debit_minor, 12000, 'expense debit matches exact integer amount');
  equal(paidLines[1].account_id, 'acct-cash-drawer', 'expense journal credits the original mapped payment account');
  equal(paidLines[1].credit_minor, 12000, 'payment credit matches exact integer amount');
  const postedRetry = expenses.postExpense(db, paid.id, 'manager-1');
  equal(postedRetry.duplicate, true, 'reposting the same expense is idempotent');
  equal(postedRetry.posted_journal_entry_id, paidJournal.id, 'retry returns the existing posted journal');
  equal((db.prepare("SELECT COUNT(*) AS count FROM accounting_journal_entries WHERE source_type='expense' AND source_id=? AND source_event='expense_paid'").get(paid.id) as any).count,
    1, 'expense posting retry cannot create a second journal');
  throws(() => db.prepare('UPDATE accounting_expenses SET amount_minor=amount_minor+1 WHERE id=?').run(paid.id),
    /posted accounting expense details are immutable/i, 'SQL guard protects posted expense amount from direct mutation');
  throws(() => db.prepare("UPDATE accounting_expenses SET status='draft', posted_journal_entry_id=NULL WHERE id=?").run(paid.id),
    /invalid accounting expense state transition|posted expense journal identity is immutable/i, 'SQL guard prevents unposting a posted expense');

  throws(() => expenses.reverseExpense(db, paid.id, 'Backdated correction', '2026-10-10', 'manager-1'),
    /reversal must be dated on or after the original posted expense/i, 'reversal cannot be backdated before the original posted journal');
  equal(expenses.getExpense(db, paid.id).status, 'posted', 'rejected backdated reversal leaves the original expense unchanged');
  const reversedPaid = expenses.reverseExpense(db, paid.id, 'Duplicate entry correction', '2026-10-12', 'manager-1');
  equal(reversedPaid.status, 'reversed', 'reversal marks the expense reversed without editing the original journal');
  equal(reversedPaid.reversal_reason, 'Duplicate entry correction', 'reversal reason is recorded on the expense');
  ok(!!reversedPaid.reversal_journal_entry_id, 'reversal stores a separate journal reference');
  const reversalJournal = db.prepare('SELECT status,source_event FROM accounting_journal_entries WHERE id=?').get(reversedPaid.reversal_journal_entry_id) as any;
  equal(reversalJournal.status, 'posted', 'reversal journal is posted');
  equal(reversalJournal.source_event, 'expense_reversal', 'reversal journal has a distinct idempotent source event');
  const reversalLines = db.prepare('SELECT account_id,debit_minor,credit_minor FROM accounting_journal_lines WHERE journal_entry_id=? ORDER BY line_no')
    .all(reversedPaid.reversal_journal_entry_id) as any[];
  equal(reversalLines.length, 2, 'reversal has the same number of lines as the original journal');
  equal(reversalLines[0].account_id, paidLines[0].account_id, 'reversal preserves the original debit account');
  equal(reversalLines[0].debit_minor, 0, 'reversal credits the original debit');
  equal(reversalLines[0].credit_minor, 12000, 'reversal credit exactly negates the original debit');
  equal(reversalLines[1].debit_minor, 12000, 'reversal debit exactly negates the original payment credit');
  equal(reversalLines[1].credit_minor, 0, 'reversal removes the original credit side');
  equal(expenses.reverseExpense(db, paid.id, 'Duplicate entry correction', '2026-10-12', 'manager-1').duplicate, true,
    'retrying an identical reversal returns the existing reversal');
  throws(() => expenses.reverseExpense(db, paid.id, 'Different reason', '2026-10-12', 'manager-1'),
    /already been reversed with a different reason or date/i, 'a reversal cannot be silently repurposed with another reason');
  equal((db.prepare("SELECT COUNT(*) AS count FROM accounting_journal_entries WHERE source_type='expense' AND source_id=?").get(paid.id) as any).count,
    2, 'posting and reversal together produce exactly two source journals');
  throws(() => db.prepare('DELETE FROM accounting_expenses WHERE id=?').run(paid.id),
    /posted accounting expenses cannot be deleted/i, 'SQL guard prevents deleting a reversed financial record');
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
  equal((db.prepare("SELECT COUNT(*) AS count FROM accounting_audit_log WHERE entity_type='expense' AND entity_id=?").get(unpaid.id) as any).count, 3, 'expense creation, edit, and automatic posting are audited');
  equal((db.prepare("SELECT COUNT(*) AS count FROM accounting_audit_log WHERE entity_type='expense_category' AND entity_id=?").get(category.id) as any).count, 2, 'expense category creation and remapping are audited');
  equal((db.prepare("SELECT COUNT(*) AS count FROM accounting_audit_log WHERE entity_type='payment_method_mapping' AND entity_id='cash'").get() as any).count, 2, 'payment account mapping changes are audited');
  const mappingAudit = db.prepare("SELECT before_json, after_json FROM accounting_audit_log WHERE entity_type='payment_method_mapping' AND entity_id='cash' ORDER BY id DESC LIMIT 1").get() as any;
  equal(JSON.parse(mappingAudit.before_json).account_id, 'acct-cash-drawer', 'mapping audit preserves the previous account');
  equal(JSON.parse(mappingAudit.after_json).account_id, 'acct-bank', 'mapping audit records the new account');
  equal(edited.status, 'posted', 'changing an unpaid draft to paid immediately posts it');
  const postedEditedExpense = expenses.postExpense(db, unpaid.id, 'manager-1');
  equal(postedEditedExpense.status, 'posted', 'the changed expense already has a posted journal');
  equal(postedEditedExpense.duplicate, true, 'manual retry after edit does not post a second journal');
  equal(postedEditedExpense.payment_account_id, 'acct-bank', 'edited expense posts to the snapshotted mapped account');
  equal((db.prepare("SELECT COUNT(*) AS count FROM accounting_journal_entries WHERE source_type='expense' AND source_id=? AND source_event='expense_paid'").get(unpaid.id) as any).count,
    1, 'edited expense receives one posted journal');
  throws(() => expenses.updateDraftExpense(db, unpaid.id, { description: 'change after posting' }, 'manager-1'),
    /posted or reversed expenses cannot be edited/i, 'service rejects edits after expense posting');
  throws(() => expenses.assertAccountingDate('2026-02-30'), /real calendar date/i, 'invalid calendar days are rejected');
  const transferInput = { source_account_id: 'acct-cash-drawer', destination_account_id: 'acct-bank', amount_minor: 4500, entry_date: '2026-10-12', description: 'Cash deposit to bank' };
  const transfer = transfers.createCashBankTransfer(db, transferInput, 'manager-1', 'transfer-test-001');
  equal(transfer.status, 'posted', 'cash/bank transfer posts a journal immediately');
  equal(transfer.amount_minor, 4500, 'transfer keeps exact integer minor units');
  equal(transfer.source_account_id, 'acct-cash-drawer', 'transfer credits its source account');
  equal(transfer.destination_account_id, 'acct-bank', 'transfer debits its destination account');
  equal(transfer.duplicate, false, 'first transfer request is not marked duplicate');
  const transferRetry = transfers.createCashBankTransfer(db, transferInput, 'manager-1', 'transfer-test-001');
  equal(transferRetry.id, transfer.id, 'identical transfer retry returns the original journal');
  equal(transferRetry.duplicate, true, 'identical transfer retry is marked duplicate');
  equal((db.prepare("SELECT COUNT(*) AS count FROM accounting_journal_entries WHERE source_type='cash_bank_transfer' AND source_event='transfer'").get() as any).count, 1, 'transfer retry cannot create duplicate journals');
  const transferLines = db.prepare('SELECT account_id,debit_minor,credit_minor FROM accounting_journal_lines WHERE journal_entry_id=? ORDER BY line_no').all(transfer.id) as any[];
  equal(transferLines.length, 2, 'transfer has exactly two journal lines');
  equal(transferLines[0].account_id, 'acct-bank', 'transfer debits destination account');
  equal(transferLines[0].debit_minor, 4500, 'transfer destination debit equals transfer amount');
  equal(transferLines[1].account_id, 'acct-cash-drawer', 'transfer credits source account');
  equal(transferLines[1].credit_minor, 4500, 'transfer source credit equals transfer amount');
  equal(transfers.listCashBankTransfers(db).length, 1, 'transfer history lists the posted transfer once');
  throws(() => transfers.createCashBankTransfer(db, { ...transferInput, destination_account_id: 'acct-cash-drawer' }, 'manager-1', 'transfer-same-account'),
    /must be different/i, 'transfer rejects identical source and destination accounts');
  throws(() => transfers.createCashBankTransfer(db, { ...transferInput, amount_minor: 0 }, 'manager-1', 'transfer-zero'),
    /positive safe integer/i, 'transfer rejects zero amounts');
  const inventoryAccount = db.prepare("SELECT id FROM accounting_accounts WHERE system_key='inventory'").get() as { id: string } | undefined;
  if (inventoryAccount) throws(() => transfers.createCashBankTransfer(db, { ...transferInput, source_account_id: inventoryAccount.id }, 'manager-1', 'transfer-inventory'),
    /configured cash, bank, or payment-clearing/i, 'transfer rejects inventory accounts as cash/bank accounts');
  throws(() => transfers.createCashBankTransfer(db, { ...transferInput, amount_minor: 4600 }, 'manager-1', 'transfer-test-001'),
    /different payload/i, 'reusing a transfer idempotency key with a changed amount is rejected');
  // Phase 6 correction control: a posted expense cannot be reversed into a closed period.
  // The safe correction is a separate, reasoned reversal in a later open period.
  const closedCorrectionExpense = expenses.createExpense(db, {
    category_id: category.id, expense_date: '2030-01-01', amount_minor: 2000,
    currency_code: 'IRR', description: 'Closed-period reversal gate regression',
    payment_status: 'paid', payment_method_key: 'cash', payment_date: '2030-01-01',
  }, 'manager-1', 'phase6-closed-period-reversal');
  const closedCorrectionPosted = expenses.postExpense(db, closedCorrectionExpense.id, 'manager-1');
  equal(closedCorrectionPosted.status, 'posted', 'control expense is posted before the period is closed');
  db.prepare("INSERT INTO accounting_period_closures (id, period_start, period_end, status, close_reason, closed_by) VALUES ('expense-reversal-closed-period', '2030-01-01', '2030-01-01', 'closed', 'Phase 6 reversal regression', 'manager-1')").run();
  throws(() => expenses.createExpense(db, {
    category_id: category.id, expense_date: '2030-01-01', amount_minor: 2222, currency_code: 'IRR',
    description: 'Atomic paid expense must roll back', payment_status: 'paid', payment_method_key: 'cash', payment_date: '2030-01-01',
  }, 'manager-1'), /Accounting period is closed/i, 'paid expense creation fails if its journal cannot post in a closed period');
  equal((db.prepare("SELECT COUNT(*) AS count FROM accounting_expenses WHERE description='Atomic paid expense must roll back'").get() as any).count, 0,
    'failed automatic posting rolls back the newly created expense row');
  equal((db.prepare("SELECT COUNT(*) AS count FROM accounting_journal_entries WHERE source_type='expense' AND source_event='expense_paid' AND entry_date='2030-01-01' AND description LIKE '%Atomic paid expense must roll back%'").get() as any).count, 0,
    'failed automatic posting leaves no orphan journal');
  throws(() => expenses.reverseExpense(db, closedCorrectionExpense.id, 'Invalid same-period correction', '2030-01-01', 'manager-1'),
    /Accounting period is closed/i, 'reversal cannot be posted inside a closed accounting period');
  equal(expenses.getExpense(db, closedCorrectionExpense.id).status, 'posted', 'rejected closed-period reversal leaves the original expense state unchanged');
  equal((db.prepare("SELECT COUNT(*) AS count FROM accounting_journal_entries WHERE source_type='expense' AND source_id=? AND source_event='expense_reversal'").get(closedCorrectionExpense.id) as any).count, 0,
    'rejected closed-period reversal creates no reversal journal');
  const laterCorrection = expenses.reverseExpense(db, closedCorrectionExpense.id, 'Correct in later open period', '2030-01-02', 'manager-1');
  equal(laterCorrection.status, 'reversed', 'same expense can be corrected with a separately audited later-period reversal');
  equal((db.prepare('SELECT entry_date FROM accounting_journal_entries WHERE id=?').get(laterCorrection.reversal_journal_entry_id) as any).entry_date, '2030-01-02',
    'controlled correction is dated in the later open period');
  equal((db.prepare('SELECT status FROM accounting_journal_entries WHERE id=?').get(closedCorrectionPosted.posted_journal_entry_id) as any).status, 'posted',
    'controlled correction preserves the immutable original posted journal');


  // Global default is configurable; clearing a method-specific assignment activates it.
  {
    const fallbackDb = resetDb();
    const seededDefault = expenses.getDefaultPaymentAccountMapping(fallbackDb);
    equal(seededDefault.account_id, 'acct-payment-clearing', 'migration seeds Payment Clearing as the default payment account');
    const changedDefault = expenses.setDefaultPaymentAccountMapping(fallbackDb, 'acct-bank', 'manager-1');
    equal(changedDefault.account_id, 'acct-bank', 'manager can change the global default payment account');
    throws(() => expenses.setDefaultPaymentAccountMapping(fallbackDb, 'acct-inventory', 'manager-1'),
      /configured cash, bank, or payment-clearing accounts/i, 'global default cannot target inventory or another non-liquid account');

    expenses.setPaymentAccountMapping(fallbackDb, 'cash', '', 'manager-1');
    equal(expenses.listPaymentAccountMappings(fallbackDb).find((row: any) => row.payment_method_key === 'cash')?.account_id, null,
      'blank per-method mapping restores configured-default behavior');
    const categoryRow = expenses.listExpenseCategories(fallbackDb).find((row: any) => row.is_active === 1);
    const basePayload = {
      category_id: categoryRow.id, expense_date: '2026-10-11', amount_minor: 1000, currency_code: 'IRR',
      description: 'Payment uses default account', payment_status: 'paid', payment_method_key: 'cash', payment_date: '2026-10-11',
    };
    const fallbackPaid = expenses.createExpense(fallbackDb, basePayload, 'manager-1');
    equal(fallbackPaid.payment_account_id, 'acct-bank', 'paid expense with no method mapping uses configured default');
    expenses.setPaymentAccountMapping(fallbackDb, 'cash', 'acct-cash-drawer', 'manager-1');
    const explicitPaid = expenses.createExpense(fallbackDb, { ...basePayload, description: 'Payment uses explicitly selected account', payment_account_id: 'acct-cash-drawer' }, 'manager-1');
    equal(explicitPaid.payment_account_id, 'acct-cash-drawer', 'expense uses the account selected directly by the user');
    const explicitJournal = fallbackDb.prepare("SELECT id FROM accounting_journal_entries WHERE source_type='expense' AND source_id=? AND source_event='expense_paid'").get(explicitPaid.id) as { id: string };
    equal((fallbackDb.prepare('SELECT account_id FROM accounting_journal_lines WHERE journal_entry_id=? AND credit_minor=1000').get(explicitJournal.id) as any).account_id, 'acct-cash-drawer', 'journal credits the explicitly selected source account');
    throws(() => expenses.createExpense(fallbackDb, { ...basePayload, description: 'Reject invalid selected account', payment_account_id: 'acct-inventory' }, 'manager-1'),
      /cash, bank, or payment-clearing/i, 'direct account selection rejects non-liquid accounting accounts');
  }

  console.log('Accounting expense foundation: ' + checks + ' assertions passed.');
} catch (error) {
  console.error('Accounting expense foundation failed:', error); process.exitCode = 1;
} finally {
  try { closeDatabase(); } catch {}
  Module._load = originalLoad;
  fs.rmSync(activeTestDir, { recursive: true, force: true });
}
