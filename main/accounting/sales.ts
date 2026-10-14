import type Database from 'better-sqlite3';
import { getCurrencyMinorUnitFactor, resolveRegionalSnapshot, resolveTenantCurrency } from '../countries';
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

function accountingDate(db: DB, timestamp: string): string {
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
  const factor = getCurrencyMinorUnitFactor(currency);
  const minor = Math.round(numeric * factor);
  if (!Number.isFinite(numeric) || !Number.isSafeInteger(minor) || numeric < 0 || !Number.isSafeInteger(factor) || factor <= 0) {
    fail('accounting_amount_invalid', label + ' is not a valid non-negative store-currency amount.', 409);
  }
  // Persisted POS values are already rounded by the store's currency helpers.
  // This boundary converts them once to integer minor units for the ledger.
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
  if (!Number.isFinite(created)) fail('accounting_source_date_invalid', 'The source bill has an invalid creation timestamp.', 409);
  // SQLite timestamps have one-second precision. Treat a source stamped exactly
  // at cutover as legacy to avoid accidentally recognizing historical revenue.
  return created <= cutoff;
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
 * Order cancellation must not silently leave a posted sale/receivable behind.
 * Until a linked accounting adjustment/reversal workflow exists, reject the
 * operational status transition if any bill on the order was financially finalized.
 */
export function assertOrderCancellationAccountingSafe(db: DB, orderId: string | number): void {
  const bill = db.prepare(
    'SELECT id, bill_number FROM bills WHERE order_id = ? AND accounting_finalized_at IS NOT NULL LIMIT 1',
  ).get(orderId) as { id: number; bill_number: string } | undefined;
  if (bill) {
    fail(
      'order_has_finalized_accounting_bill',
      'This order has a financially finalized bill (' + bill.bill_number + '). Complete the refund/reconciliation or approved accounting-adjustment workflow before cancelling the order.',
      409,
    );
  }
}

/**
 * Finalizes the current persisted bill snapshot and recognizes the sale exactly once.
 * Discounts, operational charges and bill rounding are netted into sales revenue for
 * this basic management-accounting release. Persisted tax is split into the generic
 * persisted bill tax snapshot; this is not a jurisdiction-specific tax filing.
 */
/**
 * Locks the bill snapshot for audit/anti-mutation protection only. It never creates
 * a journal. Revenue is recorded only when actual money is accepted through a real
 * payment method (cash/card/custom); loyalty and discounts are outside accounting.
 */
export function finalizeBillSale(db: DB, billId: string | number, actorId: string | null): any {
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
export function postCollectionPaymentLines(db: DB, billId: string | number, paymentLines: any[], actorId: string | null): void {
  if (!paymentLines.length) return;
  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(billId) as any;
  if (!bill) fail('bill_not_found', 'Bill was not found.', 404);
  if (isBeforeAccountingCutover(db, bill.created_at)) {
    for (const payment of paymentLines) {
      const eventId = typeof payment?.payment_event_id === 'string' ? payment.payment_event_id.trim() : '';
      if (eventId && payment?.method !== 'wallet' && payment?.method !== 'loyalty') auditPreCutoverEvent(db, 'payment:' + eventId, 'skipped_pre_cutover_payment', actorId, {
        bill_id: String(bill.id), payment_event_id: eventId, amount: payment.amount, method: payment.method,
        reason: 'Bill predates accounting cutover; historical money receipts are intentionally not backfilled.',
      });
    }
    return;
  }
  // Wallet-only batches must not even finalize the accounting snapshot.
  if (paymentLines.every((payment) => payment?.method === 'wallet' || payment?.method === 'loyalty')) return;
  if (!bill.accounting_finalized_at) finalizeBillSale(db, billId, actorId);
  const currency = configuredCurrency(db);
  const revenueId = postingAccountBySystemKey(db, 'sales_revenue', 'revenue');
  for (const payment of paymentLines) {
    if (payment?.method === 'wallet' || payment?.method === 'loyalty') continue;
    const eventId = typeof payment?.payment_event_id === 'string' ? payment.payment_event_id.trim() : '';
    if (!eventId) fail('payment_event_identity_missing', 'A new payment line has no stable payment_event_id; receipt posting was blocked.', 409);
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
  if (['cash', 'card'].includes(lower)) return lower;
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

function resolveRefundPaymentKey(db: DB, method: unknown): string {
  if (typeof method !== 'string' || !method.trim()) fail('refund_method_required', 'Refund method is required.', 409);
  const value = method.trim();
  const lower = value.toLowerCase();
  if (lower === 'cash' || lower === 'card') return lower;
  if (lower === 'wallet' || lower === 'loyalty') return 'loyalty';
  const customId = /^custom:([1-9]\\d*)$/.exec(lower);
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
    if (String(refund.method || '').toLowerCase() === 'wallet' || String(refund.method || '').toLowerCase() === 'loyalty') {
      return { posted: false, reason: 'non_monetary_wallet_refund_ignored' };
    }
    if (isBeforeAccountingCutover(db, bill.created_at)) {
      auditPreCutoverEvent(db, 'refund:' + String(refund.id), 'skipped_pre_cutover_refund', actorId, {
        refund_id: String(refund.id), bill_id: String(bill.id),
        reason: 'Source bill predates accounting cutover; historic monetary refunds are not backfilled.',
      });
      return { posted: false, reason: 'pre_cutover_bill' };
    }
    const currency = configuredCurrency(db);
    const amountMinor = Number(refund.amount_cents);
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) fail('refund_amount_invalid', 'The committed refund has an invalid amount.', 409);
    const payout = mappedPaymentAccount(db, resolveRefundPaymentKey(db, refund.method));
    const contraRevenue = postingAccountBySystemKey(db, 'sales_discounts', 'revenue');
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
