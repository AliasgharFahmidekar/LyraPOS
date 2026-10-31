import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

type SqliteDatabase = Database.Database;

export interface AccountingJournalLineInput {
  accountId: string;
  debitMinor: number;
  creditMinor: number;
  description?: string | null;
}

export interface CreateDraftJournalEntryInput {
  entryDate: string;
  description: string;
  currencyCode: string;
  lines: AccountingJournalLineInput[];
  createdBy?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  sourceEvent?: string | null;
  idempotencyKey?: string | null;
}

export interface AccountingJournalEntryResult {
  id: string;
  entryNumber: string;
  status: 'draft' | 'posted';
  duplicate: boolean;
}

interface NormalizedLine {
  accountId: string;
  debitMinor: number;
  creditMinor: number;
  description: string | null;
}

interface NormalizedEntry {
  entryDate: string;
  description: string;
  currencyCode: string;
  lines: NormalizedLine[];
  createdBy: string | null;
  sourceType: string | null;
  sourceId: string | null;
  sourceEvent: string | null;
  idempotencyKey: string | null;
  payloadHash: string;
}

interface ExistingEntry {
  id: string;
  entry_number: string;
  status: 'draft' | 'posted';
  payload_hash: string;
}

export class AccountingLedgerError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'AccountingLedgerError';
  }
}

function fail(code: string, message: string): never {
  throw new AccountingLedgerError(code, message);
}

function optionalText(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

function normalizeAndValidate(input: CreateDraftJournalEntryInput): NormalizedEntry {
  if (!input || typeof input !== 'object') fail('invalid_input', 'A journal entry is required.');

  const entryDate = typeof input.entryDate === 'string' ? input.entryDate.trim() : '';
  const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(entryDate)
    ? new Date(entryDate + 'T00:00:00.000Z')
    : new Date(Number.NaN);
  if (!Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== entryDate) {
    fail('invalid_entry_date', 'Entry date must be a real calendar date in YYYY-MM-DD format.');
  }

  const description = typeof input.description === 'string' ? input.description.trim() : '';
  if (!description) fail('description_required', 'A journal description is required.');

  const currencyCode = typeof input.currencyCode === 'string' ? input.currencyCode.trim().toUpperCase() : '';
  if (!/^[A-Z]{3}$/.test(currencyCode)) {
    fail('invalid_currency', 'Currency code must be a three-letter uppercase code.');
  }

  if (!Array.isArray(input.lines) || input.lines.length < 2) {
    fail('insufficient_lines', 'A balanced journal entry requires at least two lines.');
  }

  const lines: NormalizedLine[] = input.lines.map((line, index) => {
    if (!line || typeof line.accountId !== 'string' || !line.accountId.trim()) {
      fail('invalid_account', 'Journal line ' + (index + 1) + ' must select an account.');
    }
    if (!Number.isSafeInteger(line.debitMinor) || !Number.isSafeInteger(line.creditMinor)
      || line.debitMinor < 0 || line.creditMinor < 0
      || (line.debitMinor === 0 && line.creditMinor === 0)
      || (line.debitMinor > 0 && line.creditMinor > 0)) {
      fail('invalid_line_amount', 'Each journal line must contain one positive integer amount on exactly one side.');
    }
    return {
      accountId: line.accountId.trim(),
      debitMinor: line.debitMinor,
      creditMinor: line.creditMinor,
      description: optionalText(line.description),
    };
  });

  const debitTotal = lines.reduce((total, line) => total + BigInt(line.debitMinor), 0n);
  const creditTotal = lines.reduce((total, line) => total + BigInt(line.creditMinor), 0n);
  if (debitTotal <= 0n || debitTotal > BigInt(Number.MAX_SAFE_INTEGER)
    || creditTotal > BigInt(Number.MAX_SAFE_INTEGER) || debitTotal !== creditTotal) {
    fail('unbalanced_entry', 'Total debits must equal total credits and be greater than zero.');
  }

  const sourceType = optionalText(input.sourceType);
  const sourceId = optionalText(input.sourceId);
  const sourceEvent = optionalText(input.sourceEvent);
  const sourceParts = [sourceType, sourceId, sourceEvent];
  if (sourceParts.some(Boolean) && sourceParts.some((value) => !value)) {
    fail('incomplete_source_reference', 'Source type, source id and source event must be provided together.');
  }

  const idempotencyKey = optionalText(input.idempotencyKey);
  if (idempotencyKey && idempotencyKey.length > 200) {
    fail('idempotency_key_too_long', 'Idempotency key must not exceed 200 characters.');
  }

  const payloadHash = createHash('sha256').update(JSON.stringify({
    entryDate,
    description,
    currencyCode,
    sourceType,
    sourceId,
    sourceEvent,
    lines,
  })).digest('hex');

  return {
    entryDate,
    description,
    currencyCode,
    lines,
    createdBy: optionalText(input.createdBy),
    sourceType,
    sourceId,
    sourceEvent,
    idempotencyKey,
    payloadHash,
  };
}

function assertAccountsCanBePosted(db: SqliteDatabase, lines: NormalizedLine[]): void {
  const query = db.prepare('SELECT id, is_active, is_postable FROM accounting_accounts WHERE id = ?');
  for (const line of lines) {
    const account = query.get(line.accountId) as
      | { id: string; is_active: number; is_postable: number }
      | undefined;
    if (!account) fail('account_not_found', 'Accounting account not found: ' + line.accountId);
    if (account.is_active !== 1) fail('account_inactive', 'Accounting account is inactive: ' + line.accountId);
    if (account.is_postable !== 1) fail('account_not_postable', 'Accounting account is a grouping account: ' + line.accountId);
  }
}

function findExistingEntry(db: SqliteDatabase, input: NormalizedEntry): ExistingEntry | undefined {
  const byKey = input.idempotencyKey
    ? db.prepare('SELECT id, entry_number, status, payload_hash FROM accounting_journal_entries WHERE idempotency_key = ?')
      .get(input.idempotencyKey) as ExistingEntry | undefined
    : undefined;

  const bySource = input.sourceType && input.sourceId && input.sourceEvent
    ? db.prepare('SELECT id, entry_number, status, payload_hash FROM accounting_journal_entries WHERE source_type = ? AND source_id = ? AND source_event = ?')
      .get(input.sourceType, input.sourceId, input.sourceEvent) as ExistingEntry | undefined
    : undefined;

  if (byKey && bySource && byKey.id !== bySource.id) {
    fail('idempotency_conflict', 'Idempotency key and source event refer to different journal entries.');
  }
  const existing = byKey || bySource;
  if (!existing) return undefined;
  if (existing.payload_hash !== input.payloadHash) {
    fail('idempotency_conflict', 'The same idempotency key or source event was already used with a different payload.');
  }
  return existing;
}

function audit(
  db: SqliteDatabase,
  entityId: string,
  action: string,
  actorUserId: string | null,
  before: unknown,
  after: unknown,
): void {
  db.prepare(
    'INSERT INTO accounting_audit_log (entity_type, entity_id, action, actor_user_id, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    'journal_entry',
    entityId,
    action,
    actorUserId,
    before == null ? null : JSON.stringify(before),
    after == null ? null : JSON.stringify(after),
  );
}

export function createDraftJournalEntry(
  db: SqliteDatabase,
  input: CreateDraftJournalEntryInput,
): AccountingJournalEntryResult {
  const normalized = normalizeAndValidate(input);
  return db.transaction((): AccountingJournalEntryResult => {
    const existing = findExistingEntry(db, normalized);
    if (existing) {
      return { id: existing.id, entryNumber: existing.entry_number, status: existing.status, duplicate: true };
    }

    const closedPeriod = db.prepare("SELECT 1 FROM accounting_period_closures WHERE status='closed' AND ? BETWEEN period_start AND period_end LIMIT 1").get(normalized.entryDate);
    if (closedPeriod) fail('period_closed', 'Accounting period is closed; reopen it with a reason before recording or posting entries.');
    assertAccountsCanBePosted(db, normalized.lines);
    db.prepare("INSERT OR IGNORE INTO accounting_sequences (name, value) VALUES ('journal-entry', 0)").run();
    db.prepare('UPDATE accounting_sequences SET value = value + 1 WHERE name = ?').run('journal-entry');
    const sequence = db.prepare('SELECT value FROM accounting_sequences WHERE name = ?').get('journal-entry') as { value: number };
    const entryNumber = 'JE-' + String(sequence.value).padStart(6, '0');
    const id = randomUUID();

    db.prepare(
      'INSERT INTO accounting_journal_entries (id, entry_number, entry_date, description, currency_code, source_type, source_id, source_event, idempotency_key, payload_hash, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      id, entryNumber, normalized.entryDate, normalized.description, normalized.currencyCode,
      normalized.sourceType, normalized.sourceId, normalized.sourceEvent, normalized.idempotencyKey,
      normalized.payloadHash, normalized.createdBy,
    );

    const insertLine = db.prepare(
      'INSERT INTO accounting_journal_lines (id, journal_entry_id, line_no, account_id, description, debit_minor, credit_minor) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    normalized.lines.forEach((line, index) => {
      insertLine.run(randomUUID(), id, index + 1, line.accountId, line.description, line.debitMinor, line.creditMinor);
    });

    audit(db, id, 'draft_created', normalized.createdBy, null, {
      entryNumber,
      entryDate: normalized.entryDate,
      description: normalized.description,
      currencyCode: normalized.currencyCode,
      lineCount: normalized.lines.length,
      totalDebitMinor: Number(normalized.lines.reduce((total, line) => total + BigInt(line.debitMinor), 0n)),
      sourceType: normalized.sourceType,
      sourceId: normalized.sourceId,
      sourceEvent: normalized.sourceEvent,
    });
    return { id, entryNumber, status: 'draft', duplicate: false };
  })();
}

export function postJournalEntry(
  db: SqliteDatabase,
  entryId: string,
  postedBy?: string | null,
): AccountingJournalEntryResult {
  const actorId = optionalText(postedBy);
  return db.transaction((): AccountingJournalEntryResult => {
    const entry = db.prepare(
      'SELECT id, entry_number, entry_date, description, currency_code, status FROM accounting_journal_entries WHERE id = ?',
    ).get(entryId) as {
      id: string; entry_number: string; entry_date: string; description: string;
      currency_code: string; status: 'draft' | 'posted';
    } | undefined;

    if (!entry) fail('entry_not_found', 'Accounting journal entry was not found: ' + entryId);
    if (entry.status !== 'posted') {
      const closedPeriod = db.prepare("SELECT 1 FROM accounting_period_closures WHERE status='closed' AND ? BETWEEN period_start AND period_end LIMIT 1").get(entry.entry_date);
      if (closedPeriod) fail('period_closed', 'Accounting period is closed; reopen it with a reason before recording or posting entries.');
    }
    if (entry.status === 'posted') {
      return { id: entry.id, entryNumber: entry.entry_number, status: 'posted', duplicate: true };
    }

    const lines = db.prepare(
      'SELECT line.account_id, line.debit_minor, line.credit_minor, line.description, account.is_active, account.is_postable FROM accounting_journal_lines AS line JOIN accounting_accounts AS account ON account.id = line.account_id WHERE line.journal_entry_id = ? ORDER BY line.line_no',
    ).all(entryId) as Array<{
      account_id: string; debit_minor: number; credit_minor: number; description: string | null;
      is_active: number; is_postable: number;
    }>;
    const normalizedLines: NormalizedLine[] = lines.map((line) => ({
      accountId: line.account_id, debitMinor: line.debit_minor, creditMinor: line.credit_minor, description: line.description,
    }));
    if (normalizedLines.length < 2) fail('insufficient_lines', 'A balanced journal entry requires at least two lines.');
    for (const line of normalizedLines) {
      if (!Number.isSafeInteger(line.debitMinor) || !Number.isSafeInteger(line.creditMinor)
        || line.debitMinor < 0 || line.creditMinor < 0
        || (line.debitMinor === 0 && line.creditMinor === 0)
        || (line.debitMinor > 0 && line.creditMinor > 0)) {
        fail('invalid_line_amount', 'Stored journal lines must contain one positive integer amount on exactly one side.');
      }
    }
    for (const line of lines) {
      if (line.is_active !== 1) fail('account_inactive', 'An accounting entry contains an inactive account.');
      if (line.is_postable !== 1) fail('account_not_postable', 'An accounting entry contains a grouping account.');
    }

    const debitTotal = normalizedLines.reduce((total, line) => total + BigInt(line.debitMinor), 0n);
    const creditTotal = normalizedLines.reduce((total, line) => total + BigInt(line.creditMinor), 0n);
    if (debitTotal <= 0n || debitTotal !== creditTotal
      || debitTotal > BigInt(Number.MAX_SAFE_INTEGER) || creditTotal > BigInt(Number.MAX_SAFE_INTEGER)) {
      fail('unbalanced_entry', 'Total debits must equal total credits and be greater than zero.');
    }

    db.prepare(
      'UPDATE accounting_journal_entries SET status = ?, posted_by = ?, posted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = ?',
    ).run('posted', actorId, entryId, 'draft');
    audit(db, entryId, 'posted', actorId, { status: 'draft' }, {
      status: 'posted', entryNumber: entry.entry_number, entryDate: entry.entry_date, currencyCode: entry.currency_code,
    });
    return { id: entry.id, entryNumber: entry.entry_number, status: 'posted', duplicate: false };
  })();
}
