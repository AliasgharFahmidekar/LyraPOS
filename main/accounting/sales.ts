import type Database from 'better-sqlite3';
import { getAccountingMinorUnitFactor, getCurrencyMinorUnitFactor, resolveRegionalSnapshot, resolveTenantCurrency } from '../countries';
import { localDateInTimezone, now, parseDbTimestamp, tenantBusinessDayStartTime } from '../db';
import { createDraftJournalEntry, postJournalEntry } from './ledger';

type DB = Database.Database;

export class AccountingPostingError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 409) {
    super(message);
    this.name = 'AccountingPostingError';
  }
}

function fail(code: string, message: string, statusCode = 409): never {
  throw new AccountingPostingError(code, message, statusCode);
}

function configuredCurrency(db: DB): string {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key IN ('country','currency')").all() as Array<{ key: string; value: string | null }>;
  const settings = Object.fromEntries(rows.map((row) => [row.key, row.value ?? undefined]));
  try {
    return resolveTenantCurrency(settings.currency, settings.country ?? '');
  } catch {
    fail('accounting_currency_unconfigured', 'Configure the store country and currency before posting sales to accounting.', 409);
  }
}

export function accountingDate(db: DB, timestamp: string): string {
  const parsed = parseDbTimestamp(timestamp);
  if (!Number.isFinite(parsed.getTime())) fail('accounting_date_invalid', 'The source event has an invalid timestamp.', 409);
  const rows = db.prepare("SELECT key, value FROM settings WHERE key IN ('country','currency','timezone')").all() as Array<{ key: string; value: string | null }>;
  const settings = Object.fromEntries(rows.map((row) => [row.key, row.value ?? undefined]));
  const regional = resolveRegionalSnapshot({
    country: settings.country,
    currency: settings.currency,
    timezone: settings.timezone,
  });
  return localDateInTimezone(parsed, regional.timezone, tenantBusinessDayStartTime(db));
}

function toMinorUnits(value: unknown, currency: string, label: string): number {
  const numeric = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() ? Number(value) : Number.NaN);
  const factor = getAccountingMinorUnitFactor(currency);
  const minor = Math.round(numeric * factor);
  if (!Number.isFinite(numeric) || !Number.isSafeInteger(minor) || numeric < 0 || !Number.isSafeInteger(factor) || factor <= 0) {
    fail('accounting_amount_invalid', label + ' is not a valid non-negative store-currency amount.', 409);
  }
  // Persisted POS values are already rounded by the store's currency helpers.
  // This boundary converts them once to integer ledger units. For IRR, the
  // stored amount is already in whole rials; UI fraction-digit preferences do
  // not create a fractional rial denomination.
  return minor;
}

function postingAccountBySystemKey(db: DB, key: string, expectedType: string): string {
  const account = db.prepare(
    'SELECT id, account_type, is_active, is_postable FROM accounting_accounts WHERE system_key = ?',
  ).get(key) as { id: string; account_type: string; is_active: number; is_postable: number } | undefined;
  if (!account || account.is_active !== 1 || account.is_postable !== 1 || account.account_type !== expectedType) {
    fail('accounting_system_account_unavailable', 'Required accounting account "' + key + '" is missing, inactive, or has an invalid type.', 409);
  }
  return account.id;
}

function mappedPaymentAccount(db: DB, methodKey: string): { id: string; type: string } {
  const mapping = db.prepare(
    'SELECT a.id, a.account_type, a.is_active, a.is_postable FROM accounting_payment_method_mappings AS m JOIN accounting_accounts AS a ON a.id = m.account_id WHERE m.payment_method_key = ?',
  ).get(methodKey) as { id: string; account_type: string; is_active: number; is_postable: number } | undefined;
  const expectedType = 'asset';
  if (!mapping) fail('payment_mapping_required', 'Map payment method "' + methodKey + '" to an accounting account before recording this financial event.', 409);
  if (mapping.is_active !== 1 || mapping.is_postable !== 1 || mapping.account_type !== expectedType) {
    fail('payment_mapping_invalid', 'The accounting mapping for "' + methodKey + '" must target an active postable ' + expectedType + ' account.', 409);
  }
  return { id: mapping.id, type: mapping.account_type };
}

function paymentMethodKey(db: DB, payment: any): string {
  if (payment?.method === 'wallet' || payment?.method === 'loyalty') fail('non_monetary_payment_ignored', 'Loyalty wallet value is not an accounting payment method.', 409);
  if (payment?.payment_method_id !== undefined && payment?.payment_method_id !== null) {
    const id = Number(payment.payment_method_id);
    const method = db.prepare('SELECT id, is_active FROM payment_methods WHERE id = ?').get(id) as { id: number; is_active: number } | undefined;
    if (!Number.isSafeInteger(id) || id <= 0 || !method || method.is_active !== 1) {
      fail('payment_method_unavailable', 'The custom payment method is missing or inactive.', 409);
    }
    return 'custom:' + id;
  }
  if (payment?.method === 'cash' || payment?.method === 'card') return payment.method;
  fail('payment_mapping_required', 'This payment line does not resolve to an approved built-in or custom accounting payment key.', 409);
}

function isBeforeAccountingCutover(db: DB, sourceCreatedAt: unknown): boolean {
  const setting = db.prepare("SELECT value FROM settings WHERE key = 'accounting_cutover_at'").get() as { value: string | null } | undefined;
  const cutoff = setting?.value ? parseDbTimestamp(setting.value).getTime() : Number.NaN;
  const created = typeof sourceCreatedAt === 'string' ? parseDbTimestamp(sourceCreatedAt).getTime() : Number.NaN;
  // If the cutover has not been recorded, fail closed for automatic posting.
  if (!Number.isFinite(cutoff)) fail('accounting_cutover_missing', 'The accounting cutover is not configured; automatic posting is disabled.', 409);
  if (!Number.isFinite(created)) fail('accounting_source_date_invalid', 'The accounting event has an invalid timestamp.', 409);
  // SQLite timestamps have one-second precision. Treat a source stamped exactly
  // at cutover as legacy to avoid accidentally recognizing historical revenue.
  return created <= cutoff;
}

export function isAutomaticSalesPostingEnabled(db: DB): boolean {
  const setting = db.prepare("SELECT value FROM settings WHERE key = 'accounting_auto_post_sales'").get() as { value: string | null } | undefined;
  // Missing, malformed, or explicitly false values all fail closed to disabled.
  return setting?.value === 'true' || setting?.value === '1';
}

function auditPreCutoverEvent(db: DB, entityId: string, action: string, actorId: string | null, details: unknown): void {
  const exists = db.prepare('SELECT 1 FROM accounting_audit_log WHERE entity_type = ? AND entity_id = ? AND action = ? LIMIT 1')
    .get('accounting_source_event', entityId, action);
  if (exists) return;
  db.prepare('INSERT INTO accounting_audit_log (entity_type, entity_id, action, actor_user_id, before_json, after_json) VALUES (?,?,?,?,?,?)')
    .run('accounting_source_event', entityId, action, actorId, null, JSON.stringify(details));
}

function snapshotFields(bill: any, currencyCode: string): Record<string, unknown> {
  return {
    bill_id: String(bill.id),
    bill_number: String(bill.bill_number ?? ''),
    order_id: String(bill.order_id),
    currency_code: currencyCode,
    subtotal: Number(bill.subtotal ?? 0),
    tax_amount: Number(bill.tax_amount ?? 0),
    tax_breakdown: bill.tax_breakdown ?? null,
    tax_snapshot: bill.tax_snapshot ?? null,
    discount_amount: Number(bill.discount_amount ?? 0),
    discount_type: bill.discount_type ?? null,
    discount_value: Number(bill.discount_value ?? 0),
    discount_reason: bill.discount_reason ?? null,
    delivery_charge: Number(bill.delivery_charge ?? 0),
    packaging_charge: Number(bill.packaging_charge ?? 0),
    service_charge: Number(bill.service_charge ?? 0),
    table_charge: Number(bill.table_charge ?? 0),
    takeaway_charge: Number(bill.takeaway_charge ?? 0),
    round_off: Number(bill.round_off ?? 0),
    total: Number(bill.total ?? 0),
    split_group_id: bill.split_group_id == null ? null : String(bill.split_group_id),
    split_label: bill.split_label ?? null,
  };
}

function writeAndPostJournal(db: DB, input: Parameters<typeof createDraftJournalEntry>[1]): { id: string; entryNumber: string; duplicate: boolean } {
  // The ledger validates payload hash against an existing source/idempotency key.
  // A retry with the same source and same amounts returns the original journal;
  // a reused identity with changed amounts is a conflict, never silently accepted.
  const created = createDraftJournalEntry(db, input);
  const posted = postJournalEntry(db, created.id, input.createdBy);
  if (posted.status !== 'posted') fail('accounting_post_failed', 'The accounting journal was not posted.', 409);
  return { id: posted.id, entryNumber: posted.entryNumber, duplicate: Boolean(created.duplicate || posted.duplicate) };
}

/**
 * Whether the ledger contains an actually posted monetary receipt for this bill.
 * A partial receipt is enough to block ordinary commercial-line edits, but an
 * explicitly supported discount may still reduce the outstanding balance as
 * long as the revised bill total does not fall below money already received.
 */
export function hasAccountingRecordedMonetaryReceipt(db: DB, billId: string | number): boolean {
  const billKey = String(billId).replace(/[%_]/g, '');
  const row = db.prepare(`
    SELECT 1
    FROM accounting_journal_entries
    WHERE source_type='bill_payment'
      AND source_event='money_received'
      AND status='posted'
      AND source_id LIKE ?
    LIMIT 1
  `).get(billKey + ':%');
  return Boolean(row);
}

/**
 * Order cancellation must not silently leave a monetary receipt journal without an adjustment.
 * Until a linked accounting adjustment/reversal workflow exists, reject the
 * operational status transition if any bill on the order has a journaled money receipt.
 */
export function assertOrderCancellationAccountingSafe(db: DB, orderId: string | number): void {
  const bill = db.prepare(
    `SELECT b.id, b.bill_number
     FROM bills b
     WHERE b.order_id = ?
       AND EXISTS (
         SELECT 1 FROM accounting_journal_entries e
         WHERE e.source_type = 'bill_payment'
           AND e.source_event = 'money_received'
           AND e.source_id LIKE CAST(b.id AS TEXT) || ':%'
       )
     LIMIT 1`,
  ).get(orderId) as { id: number; bill_number: string } | undefined;
  if (bill) {
    fail(
      'order_has_finalized_accounting_bill',
      'This order has an accounting-recorded monetary receipt for bill (' + bill.bill_number + '). Complete the refund/reconciliation or approved accounting-adjustment workflow before cancelling the order.',
      409,
    );
  }
}

/**
 * Locks the bill snapshot for audit/anti-mutation protection only. It never creates
 * a journal. Revenue is recorded only when actual money is accepted through a real
 * payment method (cash/card/custom); loyalty and discounts are outside accounting.
 */
export function finalizeBillSale(db: DB, billId: string | number, actorId: string | null): any {
  void actorId; // Finalization is an audit snapshot, not a journal posting.
  return db.transaction(() => {
    const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(billId) as any;
    if (!bill) fail('bill_not_found', 'Bill was not found.', 404);
    if (isBeforeAccountingCutover(db, bill.created_at)) {
      fail('pre_cutover_bill', 'This bill predates accounting cutover and will not be backfilled automatically.', 409);
    }
    const currency = configuredCurrency(db);
    if (bill.accounting_finalized_at) {
      const snapshot = (() => { try { return JSON.parse(bill.accounting_snapshot_json || '{}'); } catch { return {}; } })();
      const expected = snapshot.fields;
      const current = snapshotFields(bill, currency);
      if (!expected || JSON.stringify(expected) !== JSON.stringify(current)) {
        fail('finalized_bill_snapshot_mismatch', 'The persisted bill no longer matches its immutable accounting snapshot.', 409);
      }
      return { billId: String(bill.id), journalEntryId: null, duplicate: true };
    }
    const fields = snapshotFields(bill, currency);
    const finalizedAt = now();
    const snapshotJson = JSON.stringify({ version: 2, fields, finalizedAt, journalEntryId: null, policy: 'cash-received-only' });
    db.prepare('UPDATE bills SET accounting_finalized_at = ?, accounting_snapshot_json = ?, accounting_sale_journal_entry_id = NULL, updated_at = ? WHERE id = ? AND accounting_finalized_at IS NULL')
      .run(finalizedAt, snapshotJson, finalizedAt, bill.id);
    const saved = db.prepare('SELECT accounting_finalized_at FROM bills WHERE id = ?').get(bill.id) as any;
    if (!saved?.accounting_finalized_at) fail('sale_finalization_race', 'Bill finalization did not persist.', 409);
    return { billId: String(bill.id), journalEntryId: null, duplicate: false };
  })();
}

/** Posts only real money received through cash/card/custom payment methods.
 * Loyalty-wallet lines are intentionally ignored: neither wallet credits nor
 * redemptions create accounting entries. Discounts are not posted separately.
 */
function canFinalizeBillSnapshot(db: DB, bill: any): boolean {
  if (!bill || bill.accounting_finalized_at) return false;
  // Snapshot finalization is intentionally separate from cash-receipt recognition.
  // A legacy bill can still receive post-cutover money, but must not be backfilled
  // as a newly finalized commercial sale.
  try {
    return !isBeforeAccountingCutover(db, bill.created_at);
  } catch {
    return false;
  }
}

export function postCollectionPaymentLines(db: DB, billId: string | number, paymentLines: any[], actorId: string | null): void {
  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(billId) as any;
  if (!bill) fail('bill_not_found', 'Bill was not found.', 404);
  if (paymentLines.length && !isAutomaticSalesPostingEnabled(db)) {
    // Keep the POS collection path independent from accounting validation while
    // automatic posting is off. The payment itself is already committed by POS;
    // this path records an audit note but must never reject collection.
    paymentLines.forEach((payment, index) => {
      if (payment?.method === 'wallet' || payment?.method === 'loyalty') return;
      const eventId = typeof payment?.payment_event_id === 'string' ? payment.payment_event_id.trim() : '';
      const eventTimestamp = typeof payment?.timestamp === 'string' && payment.timestamp.trim()
        ? payment.timestamp.trim()
        : now();
      const auditId = eventId ? 'payment:' + eventId : 'payment:unidentified:' + String(bill.id) + ':' + String(index);
      auditPreCutoverEvent(db, auditId, 'skipped_auto_sales_posting', actorId, {
        bill_id: String(bill.id),
        payment_event_id: eventId || null,
        amount: payment?.amount ?? null,
        method: payment?.method ?? null,
        event_timestamp: eventTimestamp,
        reason: 'Automatic sales posting was disabled in accounting settings; no journal was created.',
      });
    });
    return;
  }
  if (!paymentLines.length) {
    // A supported discount may consume the remaining balance after a prior real-money
    // partial receipt. When POS subsequently closes that bill without applying more
    // cash (the tender is returned as change), lock the final commercial snapshot now.
    // Do not finalize pre-cutover bills merely because a later payment was collected.
    if (bill.payment_status === 'paid' && !bill.accounting_finalized_at
      && hasAccountingRecordedMonetaryReceipt(db, billId) && canFinalizeBillSnapshot(db, bill)) {
      finalizeBillSale(db, billId, actorId);
    }
    return;
  }

  // Cutover is determined per monetary event timestamp, not by bill creation time.
  // A bill may predate the accounting ledger but receive a new real-money payment
  // after cutover; that receipt must be posted without backfilling the old bill.
  const eligiblePaymentLines: any[] = [];
  for (const payment of paymentLines) {
    if (payment?.method === 'wallet' || payment?.method === 'loyalty') continue;
    const eventId = typeof payment?.payment_event_id === 'string' ? payment.payment_event_id.trim() : '';
    const eventTimestamp = typeof payment?.timestamp === 'string' && payment.timestamp.trim()
      ? payment.timestamp.trim()
      : now();
    if (isBeforeAccountingCutover(db, eventTimestamp)) {
      if (eventId) auditPreCutoverEvent(db, 'payment:' + eventId, 'skipped_pre_cutover_payment', actorId, {
        bill_id: String(bill.id), payment_event_id: eventId, amount: payment.amount, method: payment.method,
        event_timestamp: eventTimestamp,
        reason: 'The receipt event timestamp predates accounting cutover; historical money receipts are intentionally not backfilled.',
      });
      continue;
    }
    if (!eventId) fail('payment_event_identity_missing', 'A new payment line has no stable payment_event_id; receipt posting was blocked.', 409);
    eligiblePaymentLines.push({ ...payment, timestamp: eventTimestamp });
  }
  // Wallet-only or historical-only batches must not create accounting entries.
  if (!eligiblePaymentLines.length) return;

  // Snapshot finalization and money-receipt recognition are separate. With the
  // opt-in setting enabled, lock a fully settled bill before posting its receipts.
  if (bill.payment_status === 'paid' && canFinalizeBillSnapshot(db, bill)) finalizeBillSale(db, billId, actorId);
  const currency = configuredCurrency(db);
  const revenueId = postingAccountBySystemKey(db, 'sales_revenue', 'revenue');
  for (const payment of eligiblePaymentLines) {
    const eventId = String(payment.payment_event_id);
    const amountMinor = toMinorUnits(payment.amount, currency, 'Applied payment amount');
    if (amountMinor <= 0) continue;
    const key = paymentMethodKey(db, payment);
    const account = mappedPaymentAccount(db, key);
    writeAndPostJournal(db, {
      entryDate: accountingDate(db, String(payment.timestamp || now())),
      description: 'Money received for bill ' + bill.bill_number + ' (' + key + ')',
      currencyCode: currency,
      lines: [
        { accountId: account.id, debitMinor: amountMinor, creditMinor: 0, description: 'Actual money received through payment method' },
        { accountId: revenueId, debitMinor: 0, creditMinor: amountMinor, description: 'Revenue recognized from actual money received' },
      ],
      createdBy: actorId,
      sourceType: 'bill_payment',
      sourceId: String(bill.id) + ':' + eventId,
      sourceEvent: 'money_received',
      idempotencyKey: 'payment:' + eventId,
    });
  }
}

function resolveRefundPaymentKey(db: DB, method: unknown): string {
  if (typeof method !== 'string' || !method.trim()) fail('refund_method_required', 'Refund method is required.', 409);
  const value = method.trim();
  const lower = value.toLowerCase();
  if (lower === 'cash' || lower === 'card') return lower;
  if (lower === 'wallet' || lower === 'loyalty') fail('non_monetary_refund_ignored', 'Loyalty wallet refunds are outside accounting.', 409);
  const customId = /^custom:([1-9]\d*)$/.exec(lower);
  if (customId) {
    const row = db.prepare('SELECT id, is_active FROM payment_methods WHERE id = ?').get(Number(customId[1])) as any;
    if (!row || row.is_active !== 1) fail('refund_method_unavailable', 'The selected custom refund method is missing or inactive.', 409);
    return 'custom:' + row.id;
  }
  const matches = db.prepare('SELECT id FROM payment_methods WHERE lower(name) = lower(?) AND is_active = 1 ORDER BY id').all(value) as Array<{ id: number }>;
  if (matches.length !== 1) fail('refund_method_unmapped', 'The refund method must match exactly one active payment method or use cash, card, or custom:<id>.', 409);
  return 'custom:' + matches[0].id;
}

/**
 * Only actual monetary refunds through cash/card/custom methods affect accounting.
 * Wallet/store-credit refunds and loyalty activity are deliberately ignored.
 */
export function postCommittedRefund(db: DB, refundId: string | number, actorId: string | null): any {
  return db.transaction(() => {
    const refund = db.prepare('SELECT * FROM refunds WHERE id = ?').get(refundId) as any;
    if (!refund) fail('refund_not_found', 'Committed refund row was not found.', 404);
    const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(refund.bill_id) as any;
    if (!bill) fail('refund_bill_missing', 'The refund references a missing bill.', 409);
    const refundMethod = String(refund.method || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (['wallet', 'loyalty', 'credit', 'store_credit', 'loyalty_wallet'].includes(refundMethod)) {
      return { posted: false, reason: 'non_monetary_refund_ignored' };
    }
    // A refund must reverse revenue only when the original sale receipt was
    // actually posted. Turning off automatic sales posting must not create a
    // standalone negative-revenue journal for a sale absent from the ledger.
    // Check this before cutover validation so disabled accounting cannot block a POS refund.
    if (!isAutomaticSalesPostingEnabled(db) && !hasAccountingRecordedMonetaryReceipt(db, bill.id)) {
      auditPreCutoverEvent(db, 'refund:' + String(refund.id), 'skipped_auto_refund_posting', actorId, {
        refund_id: String(refund.id),
        bill_id: String(bill.id),
        event_timestamp: refund.created_at || null,
        reason: 'The original sale was not posted because automatic sales posting was disabled; no standalone refund journal was created.',
      });
      return { posted: false, reason: 'automatic_sales_posting_disabled' };
    }
    if (isBeforeAccountingCutover(db, refund.created_at || now())) {
      auditPreCutoverEvent(db, 'refund:' + String(refund.id), 'skipped_pre_cutover_refund', actorId, {
        refund_id: String(refund.id), bill_id: String(bill.id), event_timestamp: refund.created_at || null,
        reason: 'The refund event timestamp predates accounting cutover; historical monetary refunds are intentionally not backfilled.',
      });
      return { posted: false, reason: 'pre_cutover_bill' };
    }
    const currency = configuredCurrency(db);
    // refunds.amount_cents follows the legacy POS fraction-factor storage contract;
    // the accounting ledger uses canonical accounting minor units (whole rials for IRR).
    const storedRefundAmount = Number(refund.amount_cents);
    const legacyFactor = getCurrencyMinorUnitFactor(currency);
    const accountingFactor = getAccountingMinorUnitFactor(currency);
    const amountMinor = Math.round(storedRefundAmount * accountingFactor / legacyFactor);
    if (!Number.isSafeInteger(storedRefundAmount) || storedRefundAmount <= 0
      || !Number.isSafeInteger(legacyFactor) || legacyFactor <= 0
      || !Number.isSafeInteger(accountingFactor) || accountingFactor <= 0
      || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
      fail('refund_amount_invalid', 'The committed refund has an invalid amount in the configured accounting currency.', 409);
    }
    const payout = mappedPaymentAccount(db, resolveRefundPaymentKey(db, refund.method));
    const contraRevenue = postingAccountBySystemKey(db, 'sales_returns', 'revenue');
    writeAndPostJournal(db, {
      entryDate: accountingDate(db, String(refund.created_at || now())),
      description: 'Monetary refund for bill ' + bill.bill_number + ' (#' + String(refund.id) + ')',
      currencyCode: currency,
      lines: [
        { accountId: contraRevenue, debitMinor: amountMinor, creditMinor: 0, description: 'Reverse revenue for money refunded' },
        { accountId: payout.id, debitMinor: 0, creditMinor: amountMinor, description: 'Actual money paid out through refund method' },
      ],
      createdBy: actorId,
      sourceType: 'refund',
      sourceId: String(refund.id),
      sourceEvent: 'money_refunded',
      idempotencyKey: 'refund:' + String(refund.id),
    });
    return { posted: true, refundId: String(refund.id) };
  })();
}
