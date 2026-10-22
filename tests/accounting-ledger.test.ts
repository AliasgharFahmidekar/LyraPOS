import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
let activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-accounting-ledger-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => activeTestDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const dbModule = require('../main/db');
const { initDatabase, getDatabase, getCurrentSchemaVersion, MIGRATIONS, closeDatabase } = dbModule;
const { createDraftJournalEntry, postJournalEntry } = require('../main/accounting/ledger');
const originalMigrations = MIGRATIONS.slice();

let assertionCount = 0;

function check(condition: unknown, message: string): void {
  assert.ok(condition, message);
  assertionCount++;
}
function equal(actual: unknown, expected: unknown, message: string): void {
  assert.equal(actual, expected, message);
  assertionCount++;
}
function throws(operation: () => unknown, expected: RegExp, message: string): void {
  assert.throws(operation, expected, message);
  assertionCount++;
}
function tableExists(db: any, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

function assertAccountingSeedAccounts(db: any, context: string): void {
  const accounts = db.prepare(
    'SELECT id, system_key, account_code, is_postable, is_system FROM accounting_accounts ORDER BY account_code',
  ).all() as Array<{
    id: string;
    system_key: string | null;
    account_code: string;
    is_postable: number;
    is_system: number;
  }>;

  // A required-subset assertion alone can silently permit accidental extra
  // seeded/system accounts. Keep a complete allowlist for the v108 system
  // chart while still allowing owners to create their own non-system accounts.
  const expectedSystemAccountIds = [
    'acct-assets',
    'acct-cash-drawer',
    'acct-bank',
    'acct-payment-clearing',
    'acct-receivables',
    'acct-inventory',
    'acct-liabilities',
    'acct-payables',
    'acct-customer-advances',
    'acct-equity',
    'acct-owner-capital',
    'acct-owner-drawings',
    'acct-opening-balance-equity',
    'acct-reconciliation-adjustment-equity',
    'acct-income',
    'acct-sales-revenue',
    'acct-sales-discounts',
    'acct-other-income',
    'acct-expenses',
    'acct-cogs',
    'acct-operating-expenses',
    'acct-payment-fees',
    'acct-sales-tax-payable',
    'acct-sales-returns',
    'acct-tax-expenses',
  ].sort();
  const actualSystemAccountIds = accounts.filter((account) => account.is_system === 1).map((account) => account.id).sort();
  equal(
    actualSystemAccountIds.join(','),
    expectedSystemAccountIds.join(','),
    context + ': exact v108 system chart has no missing or unexpected system accounts',
  );
  const requiredAccounts = [
    { id: 'acct-assets', systemKey: 'assets', accountCode: '1000', isPostable: 0 },
    { id: 'acct-cash-drawer', systemKey: 'cash_drawer', accountCode: '1010', isPostable: 1 },
    { id: 'acct-bank', systemKey: 'bank_accounts', accountCode: '1020', isPostable: 1 },
    { id: 'acct-payment-clearing', systemKey: 'payment_clearing', accountCode: '1030', isPostable: 1 },
    { id: 'acct-sales-revenue', systemKey: 'sales_revenue', accountCode: '4010', isPostable: 1 },
    { id: 'acct-sales-tax-payable', systemKey: 'sales_tax_payable', accountCode: '2040', isPostable: 1 },
    { id: 'acct-sales-returns', systemKey: 'sales_returns', accountCode: '4040', isPostable: 1 },
    { id: 'acct-tax-expenses', systemKey: 'tax_expenses', accountCode: '5040', isPostable: 1 },
    { id: 'acct-reconciliation-adjustment-equity', systemKey: 'reconciliation_adjustment_equity', accountCode: '3060', isPostable: 1 },
  ];

  for (const required of requiredAccounts) {
    const account = accounts.find((candidate) => candidate.id === required.id);
    check(!!account, context + ': required system account is seeded: ' + required.id);
    if (!account) continue;
    equal(account.system_key, required.systemKey, context + ': stable system key for ' + required.id);
    equal(account.account_code, required.accountCode, context + ': stable account code for ' + required.id);
    equal(account.is_postable, required.isPostable, context + ': posting capability for ' + required.id);
  }

  equal(
    new Set(accounts.map((account) => account.account_code)).size,
    accounts.length,
    context + ': account codes remain unique',
  );
}
function runPendingMigrations(): void {
  const db = getDatabase();
  for (const migration of MIGRATIONS) {
    if (migration.version <= getCurrentSchemaVersion()) continue;
    db.transaction(() => {
      migration.up();
      db.pragma('user_version = ' + migration.version);
    })();
  }
}
function isNativeAbiMismatch(error: any): boolean {
  return error?.code === 'ERR_DLOPEN_FAILED'
    && String(error?.message || '').includes('NODE_MODULE_VERSION');
}

function freshInstallChecks(): void {
  activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-accounting-fresh-'));
  initDatabase();
  const db = getDatabase();

  equal(getCurrentSchemaVersion(), 111, 'fresh install reaches schema version 111');
  for (const table of [
    'accounting_accounts', 'accounting_sequences', 'accounting_journal_entries',
    'accounting_journal_lines', 'accounting_audit_log', 'accounting_opening_balances', 'accounting_reconciliation_adjustments', 'accounting_period_closures',
  ]) check(tableExists(db, table), 'fresh install creates ' + table);
  const billColumns = (db.pragma('table_info(bills)') as Array<{ name: string }>).map((column) => column.name);
  check(billColumns.includes('accounting_finalized_at'), 'migration v105 adds bill accounting finalization field');
  check(billColumns.includes('accounting_snapshot_json'), 'migration v105 adds immutable bill accounting snapshot');
  check(billColumns.includes('accounting_sale_journal_entry_id'), 'migration v105 links sale journal from bill');
  check(!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='accounting_finalized_bill_amounts_immutable'").get(), 'migration v105 protects finalized bill amounts');
  const cashMapping = db.prepare("SELECT account_id FROM accounting_payment_method_mappings WHERE payment_method_key='cash'").get() as any;
  equal(cashMapping.account_id, 'acct-cash-drawer', 'migration v105 safely seeds the cash mapping');
  const cardMapping = db.prepare("SELECT account_id FROM accounting_payment_method_mappings WHERE payment_method_key='card'").get() as any;
  equal(cardMapping.account_id, 'acct-payment-clearing', 'migration v105 safely seeds the card-clearing mapping');
  const customMethod = db.prepare("INSERT INTO payment_methods (name,is_active,sort_order,created_at,updated_at) VALUES ('Accounting test custom method',1,10,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").run();
  const customMapping = db.prepare('SELECT account_id FROM accounting_payment_method_mappings WHERE payment_method_key = ?').get('custom:' + Number(customMethod.lastInsertRowid)) as any;
  equal(customMapping.account_id, 'acct-payment-clearing', 'new custom payment methods receive a conservative clearing-account mapping');

  const expenseColumns = (db.pragma('table_info(accounting_expenses)') as Array<{ name: string }>).map((column) => column.name);
  check(expenseColumns.includes('reversal_journal_entry_id'), 'fresh install includes expense reversal journal link');
  check(expenseColumns.includes('reversal_reason'), 'fresh install includes expense reversal reason');
  for (const trigger of ['accounting_expense_posted_fields_immutable', 'accounting_expense_state_transition_guard', 'accounting_expense_posted_delete_guard']) {
    check(!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(trigger), 'fresh install creates ' + trigger);
  }

  assertAccountingSeedAccounts(db, 'fresh install');
  check(!!db.prepare("SELECT 1 FROM accounting_accounts WHERE id='acct-opening-balance-equity' AND system_key='opening_balance_equity' AND account_type='equity' AND is_postable=1").get(), 'migration v106 seeds a dedicated opening-balance equity account');
  for (const trigger of ['accounting_opening_balances_immutable_update', 'accounting_opening_balances_immutable_delete']) {
    check(!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(trigger), 'migration v106 creates ' + trigger);
  }
  check(!!db.prepare("SELECT 1 FROM accounting_accounts WHERE id='acct-reconciliation-adjustment-equity' AND system_key='reconciliation_adjustment_equity' AND account_type='equity' AND is_postable=1").get(), 'migration v107 seeds a dedicated reconciliation equity offset');
  const taxExpenseAccount = db.prepare("SELECT id, account_type, system_key, is_postable FROM accounting_accounts WHERE id='acct-tax-expenses'").get() as any;
  check(!!taxExpenseAccount, 'migration v108 seeds a dedicated tax-payment expense account');
  equal(taxExpenseAccount.account_type, 'expense', 'tax-payment account is an expense account');
  equal(taxExpenseAccount.system_key, 'tax_expenses', 'tax-payment account has a stable system key');
  equal(taxExpenseAccount.is_postable, 1, 'tax-payment account accepts posted expenses');
  const generalExpenseCategory = db.prepare("SELECT id, expense_account_id FROM accounting_expense_categories WHERE id='expense-category-general'").get() as any;
  check(!!generalExpenseCategory, 'migration v108 seeds a general expense category for ordinary expenses');
  equal(generalExpenseCategory.expense_account_id, 'acct-operating-expenses', 'general expense category maps to operating expenses');
  const taxExpenseCategory = db.prepare("SELECT id, expense_account_id FROM accounting_expense_categories WHERE id='expense-category-tax-payments'").get() as any;
  check(!!taxExpenseCategory, 'migration v108 seeds a tax payment expense category');
  equal(taxExpenseCategory.expense_account_id, 'acct-tax-expenses', 'tax payment category maps to the dedicated expense account');
  for (const trigger of [
    'accounting_journal_entries_closed_period_insert_guard',
    'accounting_journal_entries_closed_period_guard',
    'accounting_period_closures_no_delete',
    'accounting_closed_period_posted_entry_update_guard',
    'accounting_closed_period_posted_entry_delete_guard',
    'accounting_closed_period_posted_line_insert_guard',
    'accounting_closed_period_posted_line_update_guard',
    'accounting_closed_period_posted_line_delete_guard',
  ]) {
    check(!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(trigger), 'migration v110 creates ' + trigger);
  }
  for (const trigger of ['accounting_reconciliation_adjustments_immutable_update', 'accounting_reconciliation_adjustments_immutable_delete']) {
    check(!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(trigger), 'migration v107 creates ' + trigger);
  }

  throws(
    () => db.prepare("UPDATE accounting_accounts SET is_system = 0 WHERE id = 'acct-cash-drawer'").run(),
    /system or posted accounting account definitions are immutable/i,
    'system account cannot be demoted to bypass the delete guard',
  );
  throws(
    () => db.prepare("UPDATE accounting_accounts SET system_key = 'cash_drawer_reassigned' WHERE id = 'acct-bank'").run(),
    /system or posted accounting account definitions are immutable/i,
    'system account key cannot be changed',
  );
  throws(
    () => db.prepare("DELETE FROM accounting_accounts WHERE id = 'acct-bank'").run(),
    /system accounting accounts cannot be deleted/i,
    'system account deletion remains blocked',
  );
  equal(
    (db.prepare("SELECT is_system FROM accounting_accounts WHERE id = 'acct-cash-drawer'").get() as any).is_system,
    1,
    'failed system-account demotion leaves the system flag intact',
  );
  equal(
    (db.prepare("SELECT system_key FROM accounting_accounts WHERE id = 'acct-bank'").get() as any).system_key,
    'bank_accounts',
    'failed system-key edit leaves the stable key intact',
  );

  const baseInput = {
    entryDate: '2026-10-10',
    description: 'Test opening balance',
    currencyCode: 'IRR',
    idempotencyKey: 'test:opening-balance:001',
    lines: [
      { accountId: 'acct-cash-drawer', debitMinor: 125000, creditMinor: 0, description: 'Cash received' },
      { accountId: 'acct-owner-capital', debitMinor: 0, creditMinor: 125000, description: 'Owner capital' },
    ],
  };
  const created = createDraftJournalEntry(db, baseInput);
  equal(created.status, 'draft', 'new journal starts as draft');
  equal(created.duplicate, false, 'first request is not a duplicate');
  check(/^JE-\d{6}$/.test(created.entryNumber), 'journal number uses atomic sequence');

  const totals = db.prepare(
    'SELECT SUM(debit_minor) AS debits, SUM(credit_minor) AS credits, COUNT(*) AS lines FROM accounting_journal_lines WHERE journal_entry_id = ?',
  ).get(created.id) as { debits: number; credits: number; lines: number };
  equal(totals.lines, 2, 'two lines are written');
  equal(totals.debits, 125000, 'debits stored as integer minor units');
  equal(totals.credits, 125000, 'credits stored as integer minor units');

  const posted = postJournalEntry(db, created.id, 'test-owner');
  equal(posted.status, 'posted', 'balanced journal can be posted');
  equal(posted.duplicate, false, 'first post is not a duplicate');
  const secondPost = postJournalEntry(db, created.id, 'test-owner');
  equal(secondPost.duplicate, true, 'repeated posting request is idempotent');

  const retry = createDraftJournalEntry(db, baseInput);
  equal(retry.id, created.id, 'same idempotency key returns original journal');
  equal(retry.duplicate, true, 'same idempotency key is marked duplicate');
  equal(retry.status, 'posted', 'retry does not downgrade posted status');
  throws(
    () => createDraftJournalEntry(db, { ...baseInput, description: 'Different payload' }),
    /different payload/i,
    'same idempotency key with different payload is rejected',
  );

  const sourceInput = {
    ...baseInput,
    idempotencyKey: 'test:bill:42:recognized',
    sourceType: 'bill',
    sourceId: '42',
    sourceEvent: 'recognized',
    description: 'Source uniqueness test',
    lines: [
      { accountId: 'acct-cash-drawer', debitMinor: 500, creditMinor: 0 },
      { accountId: 'acct-sales-revenue', debitMinor: 0, creditMinor: 500 },
    ],
  };
  const sourceEntry = createDraftJournalEntry(db, sourceInput);
  const sourceRetry = createDraftJournalEntry(db, { ...sourceInput, idempotencyKey: 'different-key' });
  equal(sourceRetry.id, sourceEntry.id, 'source event prevents duplicate entries even with a changed retry key');
  equal(sourceRetry.duplicate, true, 'source retry returns duplicate result');

  throws(
    () => createDraftJournalEntry(db, {
      entryDate: '2026-10-10', description: 'Group account test', currencyCode: 'IRR',
      lines: [
        { accountId: 'acct-assets', debitMinor: 100, creditMinor: 0 },
        { accountId: 'acct-sales-revenue', debitMinor: 0, creditMinor: 100 },
      ],
    }),
    /grouping account/i,
    'group accounts cannot be used for journal lines',
  );

  throws(
    () => createDraftJournalEntry(db, {
      entryDate: '2026-10-10', description: 'Invalid account test', currencyCode: 'IRR',
      idempotencyKey: 'test:invalid-account',
      lines: [
        { accountId: 'missing-account', debitMinor: 100, creditMinor: 0 },
        { accountId: 'acct-sales-revenue', debitMinor: 0, creditMinor: 100 },
      ],
    }),
    /account not found/i,
    'unknown accounts are rejected',
  );

  throws(
    () => createDraftJournalEntry(db, {
      entryDate: '2026-10-10', description: 'Unbalanced test', currencyCode: 'IRR',
      lines: [
        { accountId: 'acct-cash-drawer', debitMinor: 101, creditMinor: 0 },
        { accountId: 'acct-sales-revenue', debitMinor: 0, creditMinor: 100 },
      ],
    }),
    /total debits must equal total credits/i,
    'unbalanced journal is rejected',
  );

  throws(
    () => createDraftJournalEntry(db, {
      entryDate: '2026-02-30', description: 'Invalid date test', currencyCode: 'IRR',
      lines: [
        { accountId: 'acct-cash-drawer', debitMinor: 100, creditMinor: 0 },
        { accountId: 'acct-sales-revenue', debitMinor: 0, creditMinor: 100 },
      ],
    }),
    /real calendar date/i,
    'impossible calendar date is rejected',
  );

  throws(
    () => createDraftJournalEntry(db, {
      entryDate: '2026-10-10', description: 'Invalid currency test', currencyCode: 'IR',
      lines: [
        { accountId: 'acct-cash-drawer', debitMinor: 100, creditMinor: 0 },
        { accountId: 'acct-sales-revenue', debitMinor: 0, creditMinor: 100 },
      ],
    }),
    /three-letter uppercase/i,
    'currency format is validated',
  );

  const entriesBeforeFailure = (db.prepare('SELECT COUNT(*) AS count FROM accounting_journal_entries').get() as any).count;
  const auditBeforeFailure = (db.prepare('SELECT COUNT(*) AS count FROM accounting_audit_log').get() as any).count;
  // Trigger failure on audit insert to verify transaction rollback of header, lines and sequence.
  db.prepare("CREATE TRIGGER test_fail_accounting_audit BEFORE INSERT ON accounting_audit_log BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END").run();
  throws(
    () => createDraftJournalEntry(db, {
      entryDate: '2026-10-10', description: 'Atomic rollback', currencyCode: 'IRR',
      idempotencyKey: 'test:rollback',
      lines: [
        { accountId: 'acct-cash-drawer', debitMinor: 100, creditMinor: 0 },
        { accountId: 'acct-sales-revenue', debitMinor: 0, creditMinor: 100 },
      ],
    }),
    /injected audit failure/i,
    'audit failure aborts the complete journal transaction',
  );
  db.prepare('DROP TRIGGER test_fail_accounting_audit').run();
  equal((db.prepare('SELECT COUNT(*) AS count FROM accounting_journal_entries').get() as any).count, entriesBeforeFailure,
    'failed journal transaction leaves no header or lines');
  equal((db.prepare('SELECT COUNT(*) AS count FROM accounting_audit_log').get() as any).count, auditBeforeFailure,
    'failed journal transaction leaves no partial audit event');

  throws(
    () => createDraftJournalEntry(db, {
      entryDate: '2026-10-10', description: 'Fractional minor unit test', currencyCode: 'IRR',
      lines: [
        { accountId: 'acct-cash-drawer', debitMinor: 1.5, creditMinor: 0 },
        { accountId: 'acct-sales-revenue', debitMinor: 0, creditMinor: 1.5 },
      ],
    }),
    /positive integer amount/i,
    'fractional minor-unit amounts are rejected',
  );

  const rawEntryId = 'raw-invalid-post-attempt';
  db.prepare(
    'INSERT INTO accounting_journal_entries (id, entry_number, entry_date, description, currency_code, payload_hash) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(rawEntryId, 'JE-TEST-INVALID', '2026-10-10', 'Invalid direct post attempt', 'IRR', 'a'.repeat(64));
  throws(
    () => db.prepare(
      'INSERT INTO accounting_journal_lines (id, journal_entry_id, line_no, account_id, debit_minor, credit_minor) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('fractional-db-line', rawEntryId, 1, 'acct-cash-drawer', 1.5, 0),
    /check constraint failed/i,
    'SQLite rejects fractional minor-unit storage',
  );
  throws(
    () => db.prepare("UPDATE accounting_journal_entries SET status = 'posted', posted_at = CURRENT_TIMESTAMP WHERE id = ?").run(rawEntryId),
    /at least two lines/i,
    'SQL trigger rejects direct posting of an empty journal',
  );
  throws(
    () => db.prepare("UPDATE accounting_journal_entries SET description = 'tampered' WHERE id = ?").run(created.id),
    /posted accounting journal entries are immutable/i,
    'posted header is immutable',
  );
  throws(
    () => db.prepare(
      'INSERT INTO accounting_journal_lines (id, journal_entry_id, line_no, account_id, debit_minor, credit_minor) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('line-tamper-attempt', created.id, 3, 'acct-cash-drawer', 100, 0),
    /posted accounting journal lines are immutable/i,
    'posted entry cannot accept another line',
  );
  const postedLine = db.prepare(
    'SELECT id FROM accounting_journal_lines WHERE journal_entry_id = ? ORDER BY line_no LIMIT 1',
  ).get(created.id) as { id: string };
  throws(
    () => db.prepare("UPDATE accounting_journal_lines SET description = 'tampered' WHERE id = ?").run(postedLine.id),
    /posted accounting journal lines are immutable/i,
    'posted line cannot be changed',
  );
  throws(
    () => db.prepare('DELETE FROM accounting_journal_lines WHERE id = ?').run(postedLine.id),
    /posted accounting journal lines are immutable/i,
    'posted line cannot be deleted',
  );
  throws(
    () => db.prepare('DELETE FROM accounting_journal_entries WHERE id = ?').run(created.id),
    /posted accounting journal entries cannot be deleted/i,
    'posted entry cannot be deleted',
  );

  const auditActions = db.prepare(
    "SELECT action FROM accounting_audit_log WHERE entity_type = 'journal_entry' AND entity_id = ? ORDER BY id",
  ).all(created.id) as Array<{ action: string }>;
  equal(auditActions.map((row) => row.action).join(','), 'draft_created,posted', 'create and post create audit records');
  throws(
    () => db.prepare('DELETE FROM accounting_audit_log WHERE entity_id = ?').run(created.id),
    /append-only/i,
    'audit records cannot be deleted',
  );

  closeDatabase();
  fs.rmSync(activeTestDir, { recursive: true, force: true });
}

function upgradeFromPreviousSchemaChecks(): void {
  activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-accounting-upgrade-'));
  MIGRATIONS.length = 0;
  MIGRATIONS.push(...originalMigrations.filter((migration: any) => migration.version <= 99));
  initDatabase();

  let db = getDatabase();
  equal(getCurrentSchemaVersion(), 99, 'upgrade fixture is on schema version 99');
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)").run(
    'accounting_test_preserve_me', 'existing-value',
  );
  check(!tableExists(db, 'accounting_journal_entries'), 'pre-upgrade schema lacks new ledger table');

  MIGRATIONS.length = 0;
  MIGRATIONS.push(...originalMigrations);
  runPendingMigrations();
  db = getDatabase();
  equal(getCurrentSchemaVersion(), 111, 'existing database upgrades from v99 through schema version 111');
  equal(
    (db.prepare("SELECT value FROM settings WHERE key = 'accounting_test_preserve_me'").get() as any).value,
    'existing-value',
    'upgrade preserves existing user settings',
  );
  assertAccountingSeedAccounts(db, 'schema v99 to v111 upgrade');
  equal((db.prepare('PRAGMA integrity_check').get() as any).integrity_check, 'ok', 'upgraded database passes integrity_check');

  closeDatabase();
  fs.rmSync(activeTestDir, { recursive: true, force: true });
  MIGRATIONS.length = 0;
  MIGRATIONS.push(...originalMigrations);
}

function upgradeFromVersion100Checks(): void {
  activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-accounting-v100-upgrade-'));
  MIGRATIONS.length = 0;
  MIGRATIONS.push(...originalMigrations.filter((migration: any) => migration.version <= 100));
  initDatabase();

  let db = getDatabase();
  equal(getCurrentSchemaVersion(), 100, 'migration fixture starts at schema version 100');
  const legacyGuard = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'accounting_posted_account_definition_guard'",
  ).get() as { sql: string } | undefined;
  check(
    !!legacyGuard && !legacyGuard.sql.includes('is_system, system_key'),
    'v100 fixture contains the original account-definition guard',
  );

  MIGRATIONS.length = 0;
  MIGRATIONS.push(...originalMigrations);
  runPendingMigrations();
  db = getDatabase();
  equal(getCurrentSchemaVersion(), 111, 'v100 database upgrades through schema version 111');
  throws(
    () => db.prepare("UPDATE accounting_accounts SET is_system = 0 WHERE id = 'acct-cash-drawer'").run(),
    /system or posted accounting account definitions are immutable/i,
    'v101 migration blocks system-account demotion on existing databases',
  );
  throws(
    () => db.prepare("UPDATE accounting_accounts SET system_key = 'bank_key_reassigned' WHERE id = 'acct-bank'").run(),
    /system or posted accounting account definitions are immutable/i,
    'v101 migration blocks stable system-key changes on existing databases',
  );
  throws(
    () => db.prepare("DELETE FROM accounting_accounts WHERE id = 'acct-bank'").run(),
    /system accounting accounts cannot be deleted/i,
    'v100 upgrade keeps system-account deletion protection',
  );
  assertAccountingSeedAccounts(db, 'schema v100 to v111 upgrade');

  closeDatabase();
  fs.rmSync(activeTestDir, { recursive: true, force: true });
  MIGRATIONS.length = 0;
  MIGRATIONS.push(...originalMigrations);
}

function upgradeFromVersion102Checks(): void {
  activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-accounting-v102-upgrade-'));
  MIGRATIONS.length = 0;
  MIGRATIONS.push(...originalMigrations.filter((migration: any) => migration.version <= 102));
  initDatabase();

  let db = getDatabase();
  equal(getCurrentSchemaVersion(), 102, 'migration fixture starts at schema version 102');
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('country', 'IR', CURRENT_TIMESTAMP)").run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('currency', 'IRR', CURRENT_TIMESTAMP)").run();
  db.prepare('INSERT INTO accounting_expense_categories (id,name,expense_account_id) VALUES (?,?,?)')
    .run('expense-category-v102', 'Existing utilities', 'acct-operating-expenses');
  db.prepare('INSERT INTO accounting_expenses (id,category_id,expense_account_id,expense_date,amount_minor,currency_code,description,payment_status) VALUES (?,?,?,?,?,?,?,?)')
    .run('expense-v102-preserve', 'expense-category-v102', 'acct-operating-expenses', '2026-10-11', 2500, 'IRR', 'Pre-migration expense', 'unpaid');

  MIGRATIONS.length = 0;
  MIGRATIONS.push(...originalMigrations);
  runPendingMigrations();
  db = getDatabase();
  equal(getCurrentSchemaVersion(), 111, 'v102 database upgrades to schema version 111');
  assertAccountingSeedAccounts(db, 'schema v102 to v111 upgrade');
  const preserved = db.prepare("SELECT id,amount_minor,currency_code,idempotency_key,reversal_journal_entry_id,reversal_reason FROM accounting_expenses WHERE id='expense-v102-preserve'").get() as any;
  equal(preserved.id, 'expense-v102-preserve', 'upgrade preserves existing expense records');
  equal(preserved.amount_minor, 2500, 'upgrade preserves existing expense amount');
  equal(preserved.currency_code, 'IRR', 'upgrade preserves existing expense currency');
  equal(preserved.idempotency_key, null, 'pre-existing expenses keep a null optional idempotency key');
  equal(preserved.reversal_journal_entry_id, null, 'pre-existing expenses receive a null reversal journal link');
  equal(preserved.reversal_reason, null, 'pre-existing expenses receive no fabricated reversal reason');
  check(
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='accounting_expense_insert_guard'").get(),
    'v103 installs expense integrity guards',
  );
  check(
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='accounting_expense_state_transition_guard'").get(),
    'v104 installs expense lifecycle guards on upgrade',
  );
  equal((db.prepare('PRAGMA integrity_check').get() as any).integrity_check, 'ok', 'v102 to v111 upgrade passes integrity_check');

  closeDatabase();
  fs.rmSync(activeTestDir, { recursive: true, force: true });
  MIGRATIONS.length = 0;
  MIGRATIONS.push(...originalMigrations);
}

function upgradeFromVersion101Checks(): void {
  activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-accounting-v101-upgrade-'));
  MIGRATIONS.length = 0;
  MIGRATIONS.push(...originalMigrations.filter((migration: any) => migration.version <= 101));
  initDatabase();

  let db = getDatabase();
  equal(getCurrentSchemaVersion(), 101, 'migration fixture starts at schema version 101');
  check(!tableExists(db, 'accounting_expenses'), 'v101 fixture does not contain phase 2 expense tables');
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('accounting_v101_preserve_me', 'keep-me', CURRENT_TIMESTAMP)").run();

  MIGRATIONS.length = 0;
  MIGRATIONS.push(...originalMigrations);
  runPendingMigrations();
  db = getDatabase();
  equal(getCurrentSchemaVersion(), 111, 'v101 database upgrades through schema version 111');
  assertAccountingSeedAccounts(db, 'schema v101 to v111 upgrade');
  check(tableExists(db, 'accounting_expense_categories'), 'expense migration creates expense categories');
  check(tableExists(db, 'accounting_payment_method_mappings'), 'expense migration creates payment account mappings');
  check(tableExists(db, 'accounting_expenses'), 'expense migration creates expenses');
  equal(
    (db.prepare("SELECT value FROM settings WHERE key = 'accounting_v101_preserve_me'").get() as any).value,
    'keep-me',
    'v101 to v102 upgrade preserves pre-existing settings',
  );

  closeDatabase();
  fs.rmSync(activeTestDir, { recursive: true, force: true });
  MIGRATIONS.length = 0;
  MIGRATIONS.push(...originalMigrations);
}

function main(): void {
  console.log('LyraPOS accounting ledger foundation tests');
  try {
    try {
      freshInstallChecks();
      upgradeFromPreviousSchemaChecks();
      upgradeFromVersion100Checks();
      upgradeFromVersion101Checks();
      upgradeFromVersion102Checks();
    } catch (error: any) {
      if (isNativeAbiMismatch(error)) {
        console.log('SKIP: better-sqlite3 is built for a different native ABI.');
        process.exit(77);
      }
      throw error;
    }
    console.log('Passed ' + assertionCount + ' accounting ledger assertions.');
  } finally {
    try { closeDatabase(); } catch { }
    try { fs.rmSync(activeTestDir, { recursive: true, force: true }); } catch { }
    MIGRATIONS.length = 0;
    MIGRATIONS.push(...originalMigrations);
    try { Module._load = originalLoad; } catch { }
  }
}

main();
