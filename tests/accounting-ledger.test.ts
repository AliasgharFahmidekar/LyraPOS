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

  equal(getCurrentSchemaVersion(), 101, 'fresh install reaches schema version 101');
  for (const table of [
    'accounting_accounts', 'accounting_sequences', 'accounting_journal_entries',
    'accounting_journal_lines', 'accounting_audit_log',
  ]) check(tableExists(db, table), 'fresh install creates ' + table);

  const accounts = db.prepare('SELECT id, account_code, is_postable FROM accounting_accounts ORDER BY account_code').all() as any[];
  equal(accounts.length, 20, 'migration seeds the starter chart of accounts');
  equal(new Set(accounts.map((account) => account.account_code)).size, accounts.length, 'starter account codes are unique');
  check(accounts.some((account) => account.id === 'acct-cash-drawer' && account.is_postable === 1), 'cash drawer is a postable account');
  check(accounts.some((account) => account.id === 'acct-assets' && account.is_postable === 0), 'group account is not postable');

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
  equal(getCurrentSchemaVersion(), 101, 'existing database upgrades from v99 through schema version 101');
  equal(
    (db.prepare("SELECT value FROM settings WHERE key = 'accounting_test_preserve_me'").get() as any).value,
    'existing-value',
    'upgrade preserves existing user settings',
  );
  equal((db.prepare('SELECT COUNT(*) AS count FROM accounting_accounts').get() as any).count, 20, 'upgrade seeds accounts');
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
  equal(getCurrentSchemaVersion(), 101, 'v100 database upgrades to schema version 101');
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
  equal(
    (db.prepare('SELECT COUNT(*) AS count FROM accounting_accounts').get() as any).count,
    20,
    'v100 to v101 upgrade preserves all seeded accounting accounts',
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
