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
  equal(getCurrentSchemaVersion(), 104, 'fresh install reaches schema v104');
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
  throws(() => expenses.postExpense(db, unpaid.id, 'manager-1'), /only expenses already marked as paid/i, 'unpaid draft cannot be posted');
  equal((db.prepare("SELECT COUNT(*) AS count FROM accounting_journal_entries WHERE source_type='expense' AND source_id=?").get(unpaid.id) as any).count,
    0, 'unpaid expense creates no journal and cannot reduce cash');
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

  const postedPaid = expenses.postExpense(db, paid.id, 'manager-1');
  equal(postedPaid.status, 'posted', 'paid expense becomes posted after its journal commits');
  equal(postedPaid.duplicate, false, 'first expense post is not reported as a retry');
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
  equal((db.prepare("SELECT COUNT(*) AS count FROM accounting_audit_log WHERE entity_type='expense' AND entity_id=?").get(unpaid.id) as any).count, 2, 'expense creation and edit are both audited');
  equal((db.prepare("SELECT COUNT(*) AS count FROM accounting_audit_log WHERE entity_type='expense_category' AND entity_id=?").get(category.id) as any).count, 2, 'expense category creation and remapping are audited');
  equal((db.prepare("SELECT COUNT(*) AS count FROM accounting_audit_log WHERE entity_type='payment_method_mapping' AND entity_id='cash'").get() as any).count, 2, 'payment account mapping changes are audited');
  const mappingAudit = db.prepare("SELECT before_json, after_json FROM accounting_audit_log WHERE entity_type='payment_method_mapping' AND entity_id='cash' ORDER BY id DESC LIMIT 1").get() as any;
  equal(JSON.parse(mappingAudit.before_json).account_id, 'acct-cash-drawer', 'mapping audit preserves the previous account');
  equal(JSON.parse(mappingAudit.after_json).account_id, 'acct-bank', 'mapping audit records the new account');
  const postedEditedExpense = expenses.postExpense(db, unpaid.id, 'manager-1');
  equal(postedEditedExpense.status, 'posted', 'a draft edited to paid can be posted');
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
  throws(() => transfers.createCashBankTransfer(db, { ...transferInput, amount_minor: 4600 }, 'manager-1', 'transfer-test-001'),
    /different payload/i, 'reusing a transfer idempotency key with a changed amount is rejected');
  console.log('Accounting expense foundation: ' + checks + ' assertions passed.');
} catch (error) {
  console.error('Accounting expense foundation failed:', error); process.exitCode = 1;
} finally {
  try { closeDatabase(); } catch {}
  Module._load = originalLoad;
  fs.rmSync(activeTestDir, { recursive: true, force: true });
}
