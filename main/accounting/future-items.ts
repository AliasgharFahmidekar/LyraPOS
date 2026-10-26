import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { resolveTenantCurrency } from '../countries';
import { createDraftJournalEntry, postJournalEntry } from './ledger';
import { isLiquidAccountSystemKey } from './chart-of-accounts';
import { accountingDate } from './sales';

type DB = Database.Database;
type RecordType = 'receipt' | 'cheque';
type Direction = 'incoming' | 'outgoing';
type FutureStatus = 'scheduled' | 'awaiting_confirmation' | 'registered' | 'settled' | 'cancelled' | 'failed';

export class FutureItemError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400) {
    super(message);
    this.name = 'FutureItemError';
  }
}

function fail(code: string, message: string, statusCode = 400): never {
  throw new FutureItemError(code, message, statusCode);
}

function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') fail('invalid_' + field, field + ' is required.');
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    fail('invalid_' + field, field + ' must be between 1 and ' + max + ' characters.');
  }
  return normalized;
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') fail('invalid_' + field, field + ' must be text.');
  const normalized = value.trim();
  if (normalized.length > max) fail('invalid_' + field, field + ' must not exceed ' + max + ' characters.');
  return normalized || null;
}

function accountingDateValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail('invalid_' + field, field + ' must use YYYY-MM-DD format.');
  }
  const parsed = new Date(value + 'T00:00:00.000Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    fail('invalid_' + field, field + ' must be a real calendar date.');
  }
  return value;
}

function getStoreCurrency(db: DB): string {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key IN ('country', 'currency')")
    .all() as Array<{ key: string; value: string | null }>;
  const settings = Object.fromEntries(rows.map((row) => [row.key, row.value ?? undefined]));
  try {
    return resolveTenantCurrency(settings.currency, settings.country ?? '');
  } catch {
    fail('accounting_currency_not_configured', 'Configure the store country and currency before recording future financial items.', 409);
  }
}

function assertAccount(db: DB, accountId: unknown, types: string[]): { id: string; account_type: string; system_key: string | null; normal_balance: string } {
  const id = requiredText(accountId, 'classification_account_id', 100);
  const account = db.prepare(
    'SELECT id, account_type, system_key, normal_balance, is_active, is_postable FROM accounting_accounts WHERE id = ?',
  ).get(id) as { id: string; account_type: string; system_key: string | null; normal_balance: string; is_active: number; is_postable: number } | undefined;
  if (!account) fail('account_not_found', 'The selected accounting account was not found.', 404);
  if (account.is_active !== 1) fail('account_inactive', 'Choose an active accounting account.', 409);
  if (account.is_postable !== 1) fail('account_not_postable', 'Choose a posting account, not a grouping account.', 409);
  if (!types.includes(account.account_type)) {
    fail('invalid_account_type', 'This direction requires an account of type: ' + types.join(' or ') + '.', 400);
  }
  const expectedNormalBalance = account.account_type === 'revenue' ? 'credit'
    : (account.account_type === 'expense' || account.account_type === 'asset') ? 'debit' : null;
  if (expectedNormalBalance && account.normal_balance !== expectedNormalBalance) {
    fail('invalid_account_normal_balance', 'The selected account has an incompatible normal balance for its account type.', 400);
  }
  return account;
}

function assertFutureClassification(db: DB, accountId: unknown, direction: Direction) {
  const account = assertAccount(db, accountId, direction === 'incoming' ? ['revenue'] : ['expense']);
  if (direction === 'incoming' && ['sales_revenue', 'sales_returns', 'sales_discounts'].includes(account.system_key ?? '')) {
    fail('invalid_future_income_account', 'Future receipts must use a non-POS income account. POS sales, returns, and discounts are recorded by their own workflows.', 400);
  }
  return account;
}

function systemAccount(db: DB, systemKey: string, expectedType: string): string {
  const account = db.prepare(
    'SELECT id, account_type, is_active, is_postable FROM accounting_accounts WHERE system_key = ?',
  ).get(systemKey) as { id: string; account_type: string; is_active: number; is_postable: number } | undefined;
  if (!account || account.account_type !== expectedType || account.is_active !== 1 || account.is_postable !== 1) {
    fail('accounting_system_account_unavailable', 'The required accounting control account "' + systemKey + '" is unavailable.', 409);
  }
  return account.id;
}

function assertLiquidSettlementAccount(db: DB, accountId: unknown): string {
  const account = assertAccount(db, accountId, ['asset']);
  if (!isLiquidAccountSystemKey(account.system_key)) {
    fail('invalid_settlement_account', 'Settlement must use an active cash, bank, or payment-clearing account.', 400);
  }
  return account.id;
}

function actor(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : 'system';
}

function auditActor(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function itemById(db: DB, idInput: unknown): any {
  const id = requiredText(idInput, 'future_item_id', 100);
  const row = db.prepare('SELECT * FROM accounting_future_items WHERE id = ?').get(id) as any;
  if (!row) fail('future_item_not_found', 'Future receipt/cheque was not found.', 404);
  return row;
}

function businessDate(db: DB): string {
  try {
    return accountingDate(db, new Date().toISOString());
  } catch {
    fail('accounting_date_unavailable', 'The store business date could not be resolved safely.', 409);
  }
}

function inputFingerprint(input: {
  recordType: RecordType;
  direction: Direction;
  dueDate: string;
  amountMinor: number;
  currencyCode: string;
  description: string;
  counterparty: string | null;
  referenceNumber: string | null;
  classificationAccountId: string;
  autoRegister: boolean;
}): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export function createFutureItem(db: DB, input: any, actorId: string | null, idempotencyKeyInput: unknown): any {
  const recordType = input?.record_type;
  if (recordType !== 'receipt' && recordType !== 'cheque') fail('invalid_record_type', 'Record type must be receipt or cheque.');
  const direction = input?.direction;
  if (direction !== 'incoming' && direction !== 'outgoing') fail('invalid_direction', 'Direction must be incoming or outgoing.');
  if (recordType === 'receipt' && direction !== 'incoming') {
    fail('invalid_direction', 'A receipt must be incoming; use a cheque record for a future payment.');
  }
  const dueDate = accountingDateValue(input?.due_date, 'due_date');
  const amountMinor = input?.amount_minor;
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    fail('invalid_amount', 'Amount must be a positive integer in the store currency accounting units.');
  }
  const storeCurrency = getStoreCurrency(db);
  const currency = input?.currency_code === undefined ? storeCurrency
    : (typeof input.currency_code === 'string' ? input.currency_code.trim().toUpperCase() : '');
  if (currency !== storeCurrency) fail('currency_mismatch', 'Future items must use the configured store currency (' + storeCurrency + ').', 409);
  const description = requiredText(input?.description, 'description', 500);
  const counterparty = optionalText(input?.counterparty, 'counterparty', 200);
  const referenceNumber = optionalText(input?.reference_number, 'reference_number', 160);
  const account = assertFutureClassification(db, input?.classification_account_id, direction);
  const autoRegister = input?.auto_register === undefined ? false : input.auto_register;
  if (typeof autoRegister !== 'boolean') fail('invalid_auto_register', 'Automatic registration must be true or false.');
  const idempotencyKey = requiredText(idempotencyKeyInput, 'idempotency_key', 200);
  const fingerprintInput = {
    recordType, direction, dueDate, amountMinor, currencyCode: storeCurrency, description,
    counterparty, referenceNumber, classificationAccountId: account.id, autoRegister,
  };
  const payloadHash = inputFingerprint(fingerprintInput);
  return db.transaction(() => {
    const existing = db.prepare('SELECT * FROM accounting_future_items WHERE idempotency_key = ?')
      .get(idempotencyKey) as any;
    if (existing) {
      if (existing.payload_hash !== payloadHash) {
        fail('idempotency_conflict', 'This idempotency key was already used with a different future-item payload.', 409);
      }
      return { ...existing, duplicate: true };
    }
    const id = randomUUID();
    db.prepare(
      'INSERT INTO accounting_future_items (id, record_type, direction, due_date, amount_minor, currency_code, description, counterparty, reference_number, classification_account_id, auto_register, idempotency_key, payload_hash, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      id, recordType, direction, dueDate, amountMinor, storeCurrency, description, counterparty,
      referenceNumber, account.id, autoRegister ? 1 : 0, idempotencyKey, payloadHash, auditActor(actorId),
    );
    return { ...itemById(db, id), duplicate: false };
  })();
}

export function listFutureItems(db: DB, filters: any = {}): { items: any[]; limit: number } {
  const from = filters?.from === undefined || filters.from === '' ? undefined : accountingDateValue(filters.from, 'from');
  const to = filters?.to === undefined || filters.to === '' ? undefined : accountingDateValue(filters.to, 'to');
  if (from && to && from > to) fail('invalid_date_range', 'from must be on or before to.');
  const limit = filters?.limit === undefined ? 500 : Number(filters.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 2000) fail('invalid_limit', 'limit must be between 1 and 2000.');
  const status = filters?.status === undefined || filters.status === '' ? null : String(filters.status);
  const validStatuses: FutureStatus[] = ['scheduled', 'awaiting_confirmation', 'registered', 'settled', 'cancelled', 'failed'];
  if (status !== null && !validStatuses.includes(status as FutureStatus)) fail('invalid_status', 'Unknown future-item status.');
  const direction = filters?.direction === undefined || filters.direction === '' ? null : String(filters.direction);
  if (direction !== null && direction !== 'incoming' && direction !== 'outgoing') fail('invalid_direction', 'Direction must be incoming or outgoing.');
  const conditions: string[] = [];
  const args: unknown[] = [];
  if (from) { conditions.push('item.due_date >= ?'); args.push(from); }
  if (to) { conditions.push('item.due_date <= ?'); args.push(to); }
  if (status) { conditions.push('item.status = ?'); args.push(status); }
  if (direction) { conditions.push('item.direction = ?'); args.push(direction); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const items = db.prepare(
    'SELECT item.*, account.account_code AS classification_account_code, account.name AS classification_account_name, ' +
    'settlement.account_code AS settlement_account_code, settlement.name AS settlement_account_name, ' +
    'due.entry_number AS due_entry_number, settlement_entry.entry_number AS settlement_entry_number ' +
    'FROM accounting_future_items AS item ' +
    'JOIN accounting_accounts AS account ON account.id = item.classification_account_id ' +
    'LEFT JOIN accounting_accounts AS settlement ON settlement.id = item.settlement_account_id ' +
    'LEFT JOIN accounting_journal_entries AS due ON due.id = item.due_journal_entry_id ' +
    'LEFT JOIN accounting_journal_entries AS settlement_entry ON settlement_entry.id = item.settlement_journal_entry_id ' +
    where + ' ORDER BY item.due_date, item.created_at, item.id LIMIT ?',
  ).all(...args, limit) as any[];
  return { items, limit };
}

function postDueJournal(db: DB, item: any, postedBy: string, entryDate: string = item.due_date): { id: string; entryNumber: string } {
  const classification = assertFutureClassification(db, item.classification_account_id, item.direction);
  const controlAccount = item.direction === 'incoming'
    ? systemAccount(db, 'accounts_receivable', 'asset')
    : systemAccount(db, 'accounts_payable', 'liability');
  const amount = Number(item.amount_minor);
  const lines = item.direction === 'incoming'
    ? [
      { accountId: controlAccount, debitMinor: amount, creditMinor: 0, description: 'Future receipt/cheque receivable' },
      {
        accountId: systemAccount(db, 'future_receipt_clearing', 'liability'),
        debitMinor: 0, creditMinor: amount,
        description: 'Receipt pending actual settlement; not recognized as income yet',
      },
    ]
    : [
      {
        accountId: systemAccount(db, 'future_payment_clearing', 'asset'),
        debitMinor: amount, creditMinor: 0,
        description: 'Payment pending actual settlement; not recognized as paid expense yet',
      },
      { accountId: controlAccount, debitMinor: 0, creditMinor: amount, description: 'Future payment/cheque payable' },
    ];
  const draft = createDraftJournalEntry(db, {
    entryDate,
    description: (item.direction === 'incoming' ? 'Future receipt: ' : 'Future payment: ') + item.description,
    currencyCode: item.currency_code,
    lines,
    createdBy: postedBy,
    sourceType: 'accounting_future_item',
    sourceId: item.id,
    sourceEvent: 'due_registration',
    idempotencyKey: 'future-item:' + item.id + ':due-registration',
  });
  const posted = postJournalEntry(db, draft.id, postedBy);
  if (posted.status !== 'posted') fail('future_item_posting_failed', 'The due journal did not reach posted status.', 409);
  return { id: posted.id, entryNumber: posted.entryNumber };
}

function registerFutureItemInternal(db: DB, idInput: unknown, actorIdInput: unknown, asOfDateInput?: unknown): any {
  const id = requiredText(idInput, 'future_item_id', 100);
  const asOfDate = asOfDateInput === undefined ? businessDate(db) : accountingDateValue(asOfDateInput, 'as_of_date');
  return db.transaction(() => {
    const item = itemById(db, id);
    if (item.status === 'registered' || item.status === 'settled') return { ...item, duplicate: true };
    if (item.status === 'cancelled') fail('future_item_cancelled', 'A cancelled future item cannot be registered.', 409);
    if (!['scheduled', 'awaiting_confirmation', 'failed'].includes(item.status)) {
      fail('future_item_invalid_state', 'This future item cannot be registered from its current state.', 409);
    }
    if (item.due_date > asOfDate) fail('future_item_not_due', 'This item cannot be registered before its due date.', 409);
    const postedBy = actor(actorIdInput);
    const journal = postDueJournal(db, item, postedBy);
    db.prepare(
      "UPDATE accounting_future_items SET status='registered', due_journal_entry_id=?, registered_at=CURRENT_TIMESTAMP, registered_by=?, status_actor_id=?, last_error_code=NULL, last_error_message=NULL WHERE id=?",
    ).run(journal.id, postedBy, postedBy, id);
    return { ...itemById(db, id), duplicate: false, due_entry_number: journal.entryNumber };
  })();
}

function markFutureItemFailed(db: DB, id: string, actorIdInput: unknown, error: unknown): void {
  const code = typeof (error as any)?.code === 'string' && (error as any).code.trim()
    ? String((error as any).code).trim().slice(0, 100)
    : 'future_item_posting_failed';
  const message = String((error as any)?.message || 'Future-item registration failed.').slice(0, 500);
  const postedBy = actor(actorIdInput);
  db.transaction(() => {
    const item = db.prepare('SELECT id, status FROM accounting_future_items WHERE id=?').get(id) as { id: string; status: FutureStatus } | undefined;
    if (!item || ['registered', 'settled', 'cancelled'].includes(item.status)) return;
    db.prepare(
      "UPDATE accounting_future_items SET status='failed', last_error_code=?, last_error_message=?, status_actor_id=? WHERE id=?",
    ).run(code, message, postedBy, id);
  })();
}

export function registerFutureItem(db: DB, idInput: unknown, actorIdInput: unknown, asOfDateInput?: unknown): any {
  const id = requiredText(idInput, 'future_item_id', 100);
  try {
    return registerFutureItemInternal(db, id, actorIdInput, asOfDateInput);
  } catch (error) {
    // Validation/state failures are not posting failures: a premature click must not
    // mutate a still-scheduled item into the retry-needed state.
    const code = typeof (error as any)?.code === 'string' ? String((error as any).code) : '';
    if (!['future_item_not_due', 'future_item_cancelled', 'future_item_invalid_state', 'future_item_not_found', 'invalid_as_of_date', 'accounting_date_unavailable'].includes(code)) {
      markFutureItemFailed(db, id, actorIdInput, error);
    }
    throw error;
  }
}

export function processDueFutureItems(db: DB, asOfDateInput?: unknown): { checked: number; awaitingConfirmation: number; registered: number; failed: number } {
  const asOfDate = asOfDateInput === undefined ? businessDate(db) : accountingDateValue(asOfDateInput, 'as_of_date');
  const due = db.prepare(
    "SELECT id, auto_register, status FROM accounting_future_items WHERE due_date <= ? AND status IN ('scheduled', 'failed') ORDER BY due_date, created_at, id",
  ).all(asOfDate) as Array<{ id: string; auto_register: number; status: FutureStatus }>;
  let awaitingConfirmation = 0;
  let registered = 0;
  let failed = 0;
  for (const item of due) {
    // Failed items remain visible for an explicit retry; automatic catch-up runs
    // once for still-scheduled records and never loops forever over the same failure.
    if (item.status === 'failed') continue;
    if (item.auto_register !== 1) {
      db.transaction(() => {
        const current = db.prepare('SELECT status, due_date FROM accounting_future_items WHERE id=?').get(item.id) as any;
        if (current?.status !== 'scheduled' || current.due_date > asOfDate) return;
        db.prepare(
          "UPDATE accounting_future_items SET status='awaiting_confirmation', status_actor_id='system' WHERE id=? AND status='scheduled'",
        ).run(item.id);
        awaitingConfirmation++;
      })();
      continue;
    }
    try {
      const result = registerFutureItemInternal(db, item.id, 'system', asOfDate);
      if (!result.duplicate) registered++;
    } catch (error) {
      try { markFutureItemFailed(db, item.id, 'system', error); } catch { /* keep the original error visible in logs */ }
      failed++;
    }
  }
  return { checked: due.length, awaitingConfirmation, registered, failed };
}

export function settleFutureItem(db: DB, idInput: unknown, input: any, actorIdInput: unknown, idempotencyKeyInput: unknown): any {
  const id = requiredText(idInput, 'future_item_id', 100);
  const settlementDate = accountingDateValue(input?.settlement_date, 'settlement_date');
  if (settlementDate > businessDate(db)) {
    fail('future_settlement_date', 'Actual settlement date cannot be in the future. Keep the item as a future receipt/cheque until settlement is confirmed.', 400);
  }
  const settlementAccountId = assertLiquidSettlementAccount(db, input?.settlement_account_id);
  const idempotencyKey = requiredText(idempotencyKeyInput, 'idempotency_key', 200);
  const settledBy = actor(actorIdInput);
  return db.transaction(() => {
    let item = itemById(db, id);
    const settlementPayloadHash = createHash('sha256').update(JSON.stringify({
      futureItemId: id, settlementDate, settlementAccountId, amountMinor: item.amount_minor, currencyCode: item.currency_code,
    })).digest('hex');
    if (item.status === 'settled') {
      if (item.settlement_idempotency_key === idempotencyKey) {
        if (item.settlement_payload_hash !== settlementPayloadHash) {
          fail('idempotency_conflict', 'The same settlement idempotency key was reused with a different settlement payload.', 409);
        }
        return { ...item, duplicate: true };
      }
      fail('future_item_already_settled', 'This item has already been settled.', 409);
    }
    if (item.status === 'cancelled') fail('future_item_cancelled', 'A cancelled item cannot be settled.', 409);
    const earlySettlement = settlementDate < item.due_date;
    if (earlySettlement && !['scheduled', 'awaiting_confirmation', 'failed'].includes(item.status)) {
      fail('future_item_invalid_state', 'This item cannot be settled early from its current state.', 409);
    }
    if (!earlySettlement && item.status !== 'registered') {
      fail('future_item_not_registered', 'Register the due event before recording settlement on or after the due date.', 409);
    }
    if (earlySettlement) {
      // Preserve the schema invariant: a settled item must have a registered due journal.
      // For early settlement, record that clearing/receivable step on the actual settlement
      // date (not the future due date), then settle it below in the same transaction.
      const dueJournal = postDueJournal(db, item, settledBy, settlementDate);
      db.prepare(
        "UPDATE accounting_future_items SET status='registered', due_journal_entry_id=?, registered_at=CURRENT_TIMESTAMP, registered_by=?, status_actor_id=? WHERE id=?",
      ).run(dueJournal.id, settledBy, settledBy, id);
      item = itemById(db, id);
    }
    if (!earlySettlement && item.status !== 'registered') {
      fail('future_item_not_registered', 'Register the due event before recording settlement on or after the due date.', 409);
    }
    const controlAccount = item.direction === 'incoming'
      ? systemAccount(db, 'accounts_receivable', 'asset')
      : systemAccount(db, 'accounts_payable', 'liability');
    const incomingClassification = item.direction === 'incoming'
      ? assertFutureClassification(db, item.classification_account_id, 'incoming')
      : null;
    const incomingClearingAccount = item.direction === 'incoming'
      ? systemAccount(db, 'future_receipt_clearing', 'liability')
      : null;
    const outgoingClassification = item.direction === 'outgoing'
      ? assertFutureClassification(db, item.classification_account_id, 'outgoing')
      : null;
    const outgoingClearingAccount = item.direction === 'outgoing'
      ? systemAccount(db, 'future_payment_clearing', 'asset')
      : null;
    const amount = Number(item.amount_minor);
    const lines = item.direction === 'incoming'
      ? [
        { accountId: settlementAccountId, debitMinor: amount, creditMinor: 0, description: 'Actual future receipt/cheque settlement' },
        { accountId: controlAccount, debitMinor: 0, creditMinor: amount, description: 'Clear registered future receipt receivable' },
        { accountId: incomingClearingAccount!, debitMinor: amount, creditMinor: 0, description: 'Release receipt clearing balance after actual settlement' },
        { accountId: incomingClassification!.id, debitMinor: 0, creditMinor: amount, description: item.description },
      ]
      : [
        { accountId: controlAccount, debitMinor: amount, creditMinor: 0, description: 'Settle registered payable' },
        { accountId: settlementAccountId, debitMinor: 0, creditMinor: amount, description: 'Actual future payment/cheque settlement' },
        { accountId: outgoingClassification!.id, debitMinor: amount, creditMinor: 0, description: item.description },
        { accountId: outgoingClearingAccount!, debitMinor: 0, creditMinor: amount, description: 'Recognize expense only after actual payment' },
      ];
    const draft = createDraftJournalEntry(db, {
      entryDate: settlementDate,
      description: 'Settlement: ' + item.description,
      currencyCode: item.currency_code,
      lines,
      createdBy: settledBy,
      sourceType: 'accounting_future_item',
      sourceId: id,
      sourceEvent: 'settlement',
      idempotencyKey,
    });
    const posted = postJournalEntry(db, draft.id, settledBy);
    if (posted.status !== 'posted') fail('future_item_settlement_failed', 'The settlement journal did not reach posted status.', 409);
    db.prepare(
      "UPDATE accounting_future_items SET status='settled', settlement_journal_entry_id=?, settlement_idempotency_key=?, settlement_payload_hash=?, settlement_account_id=?, settled_at=CURRENT_TIMESTAMP, settled_by=?, status_actor_id=? WHERE id=?",
    ).run(posted.id, idempotencyKey, settlementPayloadHash, settlementAccountId, settledBy, settledBy, id);
    return { ...itemById(db, id), duplicate: posted.duplicate, settlement_entry_number: posted.entryNumber, ...(earlySettlement ? { early_settlement: true } : {}) };
  })();
}

export function cancelFutureItem(db: DB, idInput: unknown, reasonInput: unknown, actorIdInput: unknown): any {
  const id = requiredText(idInput, 'future_item_id', 100);
  const reason = requiredText(reasonInput, 'reason', 500);
  const cancelledBy = actor(actorIdInput);
  return db.transaction(() => {
    const item = itemById(db, id);
    if (!['scheduled', 'awaiting_confirmation', 'failed'].includes(item.status)) {
      fail('future_item_already_registered', 'A registered item cannot be cancelled; use the controlled correction workflow.', 409);
    }
    db.prepare(
      "UPDATE accounting_future_items SET status='cancelled', cancelled_at=CURRENT_TIMESTAMP, cancelled_by=?, cancellation_reason=?, status_actor_id=?, last_error_code=NULL, last_error_message=NULL WHERE id=?",
    ).run(cancelledBy, reason, cancelledBy, id);
    return itemById(db, id);
  })();
}
