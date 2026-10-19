import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getAccountingMinorUnitFactor, resolveTenantCurrency } from '../countries';
import { now, parseDbTimestamp } from '../db';
import { AccountingExpenseError, assertAccountingDate } from './expenses';
import { createDraftJournalEntry, postJournalEntry } from './ledger';

type DB = Database.Database;

function fail(code: string, message: string, statusCode = 400): never {
  throw new AccountingExpenseError(code, message, statusCode);
}

function configuredCurrency(db: DB): string {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key IN ('country','currency')").all() as Array<{ key: string; value: string | null }>;
  const settings = Object.fromEntries(rows.map((row) => [row.key, row.value ?? undefined]));
  try {
    return resolveTenantCurrency(settings.currency, settings.country ?? '');
  } catch {
    fail('accounting_currency_unconfigured', 'Configure store country and currency before reconciling accounting balances.', 409);
  }
}

function textValue(value: unknown, field: string, maxLength = 300): string {
  if (typeof value !== 'string') fail('invalid_reconciliation_input', field + ' is required.');
  const valueText = value.trim();
  if (!valueText || valueText.length > maxLength) fail('invalid_reconciliation_input', field + ' must contain 1 to ' + maxLength + ' characters.');
  return valueText;
}

function optionalText(value: unknown, field: string, maxLength = 160): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') fail('invalid_reconciliation_input', field + ' must be text.');
  const valueText = value.trim();
  if (!valueText) return null;
  if (valueText.length > maxLength) fail('invalid_reconciliation_input', field + ' must be at most ' + maxLength + ' characters.');
  return valueText;
}

function minorUnits(value: unknown, currency: string): number | null {
  const numeric = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() ? Number(value) : Number.NaN);
  const factor = getAccountingMinorUnitFactor(currency);
  const amount = Math.round(numeric * factor);
  if (!Number.isFinite(numeric) || numeric < 0 || !Number.isSafeInteger(amount) || !Number.isSafeInteger(factor) || factor <= 0) return null;
  return amount;
}

function safeJson(value: unknown): any {
  if (typeof value !== 'string' || !value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function asPaymentLines(value: unknown): any[] | null {
  const parsed = safeJson(value);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') return [parsed];
  return parsed === null ? null : [];
}

function legacyPaymentIsMonetary(payment: any): boolean {
  const method = String(payment?.method ?? '').trim().toLowerCase();
  if (['wallet', 'loyalty', 'credit', 'store_credit', 'store-credit', 'store credit', 'loyalty_wallet', 'loyalty-wallet'].includes(method)) return false;
  const customId = Number(payment?.payment_method_id);
  return method === 'cash' || method === 'card' || (Number.isSafeInteger(customId) && customId > 0);
}

function balanceOnDate(db: DB, accountId: string, entryDate: string, normalBalance: string): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN ? = 'debit'
      THEN line.debit_minor - line.credit_minor
      ELSE line.credit_minor - line.debit_minor END), 0) AS balance_minor
    FROM accounting_journal_lines line
    JOIN accounting_journal_entries entry ON entry.id = line.journal_entry_id
    WHERE line.account_id = ? AND entry.status = 'posted' AND entry.entry_date <= ?
  `).get(normalBalance, accountId, entryDate) as { balance_minor: number };
  if (!Number.isSafeInteger(Number(row.balance_minor))) fail('ledger_balance_unsafe', 'The account balance exceeds safe integer precision; no adjustment was posted.', 409);
  return Number(row.balance_minor);
}

const ADJUSTMENT_SELECT = `
  SELECT adjustment.id, adjustment.account_id, account.account_code, account.name AS account_name,
    account.account_type, adjustment.adjustment_date, adjustment.system_balance_minor,
    adjustment.verified_balance_minor, adjustment.difference_minor, adjustment.currency_code,
    adjustment.reason, adjustment.source_reference, adjustment.journal_entry_id,
    entry.entry_number, entry.status AS journal_status, adjustment.idempotency_key,
    adjustment.created_by, adjustment.created_at
  FROM accounting_reconciliation_adjustments adjustment
  JOIN accounting_accounts account ON account.id = adjustment.account_id
  JOIN accounting_journal_entries entry ON entry.id = adjustment.journal_entry_id
`;

function listAdjustments(db: DB, limit = 100): any[] {
  const bounded = Math.max(1, Math.min(250, Math.trunc(limit)));
  return db.prepare(ADJUSTMENT_SELECT + ' ORDER BY adjustment.created_at DESC, adjustment.id DESC LIMIT ?').all(bounded);
}

/**
 * A read-only reconciliation snapshot. Legacy POS events are displayed as exceptions
 * instead of being backfilled, and cash closure comparisons are only calculated when
 * the opening-balance record predates that closure.
 */
export function getAccountingReconciliationOverview(db: DB, input: { limit?: unknown } = {}): any {
  const cutover = db.prepare("SELECT value FROM settings WHERE key='accounting_cutover_at'").get() as { value: string | null } | undefined;
  const cutoverAt = cutover?.value || null;
  if (cutoverAt && !Number.isFinite(parseDbTimestamp(cutoverAt).getTime())) {
    fail('accounting_cutover_invalid', 'The configured accounting cutover timestamp is invalid.', 409);
  }
  const currencyCode = configuredCurrency(db);
  const limitValue = input.limit === undefined ? 50 : Number(input.limit);
  const limit = Number.isInteger(limitValue) && limitValue >= 1 && limitValue <= 250 ? limitValue : 50;

  const auditRows = db.prepare(`
    SELECT id, entity_type, entity_id, action, actor_user_id, before_json, after_json, created_at
    FROM accounting_audit_log
    WHERE entity_type='accounting_source_event'
      AND action IN ('skipped_pre_cutover_payment','skipped_pre_cutover_refund')
    ORDER BY id DESC
    LIMIT ?
  `).all(limit) as any[];
  const auditExceptions = auditRows.map((row) => ({ ...row, before: safeJson(row.before_json), details: safeJson(row.after_json) }));

  const paymentByMethod = new Map<string, { method: string; count: number; amount_minor: number }>();
  const legacyPaymentSamples: any[] = [];
  let legacyPaymentCount = 0;
  let legacyPaymentAmount = 0;
  let unclassifiedPaymentCount = 0;
  let malformedPaymentDetailsCount = 0;
  if (cutoverAt) {
    const bills = db.prepare(`
      SELECT id, bill_number, created_at, payment_details
      FROM bills
      WHERE datetime(created_at) <= datetime(?)
      ORDER BY created_at DESC, id DESC
    `).all(cutoverAt) as any[];
    for (const bill of bills) {
      const lines = asPaymentLines(bill.payment_details);
      if (lines === null) {
        if (bill.payment_details && bill.payment_details !== '[]') malformedPaymentDetailsCount++;
        continue;
      }
      for (let index = 0; index < lines.length; index++) {
        const payment = lines[index];
        if (!payment || typeof payment !== 'object') { malformedPaymentDetailsCount++; continue; }
        const method = String(payment.method ?? '').trim().toLowerCase();
        if (method === 'wallet' || method === 'loyalty' || method === 'credit') continue;
        const amount = minorUnits(payment.amount, currencyCode);
        if (amount === null || amount <= 0) {
          if (payment.amount !== undefined && Number(payment.amount) > 0) unclassifiedPaymentCount++;
          continue;
        }
        if (!legacyPaymentIsMonetary(payment)) {
          if (method || Number(payment.amount) > 0) unclassifiedPaymentCount++;
          continue;
        }
        const label = method === 'cash' || method === 'card'
          ? method
          : 'custom:' + String(payment.payment_method_id);
        const current = paymentByMethod.get(label) || { method: label, count: 0, amount_minor: 0 };
        current.count++;
        current.amount_minor += amount;
        paymentByMethod.set(label, current);
        legacyPaymentCount++;
        legacyPaymentAmount += amount;
        if (legacyPaymentSamples.length < limit) {
          legacyPaymentSamples.push({
            source_key: String(payment.payment_event_id || ('legacy:' + bill.id + ':' + index)),
            bill_id: String(bill.id), bill_number: bill.bill_number ?? null,
            bill_created_at: bill.created_at, payment_timestamp: payment.timestamp ?? null,
            method: label, amount_minor: amount, status: 'not_backfilled_pre_cutover',
          });
        }
      }
    }
  }

  const legacyRefundRows = cutoverAt ? db.prepare(`
    SELECT refund.id, refund.bill_id, bill.bill_number, bill.created_at AS bill_created_at,
      refund.method, refund.amount_cents AS amount_minor, refund.reason, refund.created_at
    FROM refunds refund
    JOIN bills bill ON bill.id = refund.bill_id
    WHERE datetime(bill.created_at) <= datetime(?)
      AND lower(trim(COALESCE(refund.method,''))) NOT IN ('wallet','loyalty','credit','store_credit','store-credit','store credit','loyalty_wallet','loyalty-wallet')
    ORDER BY refund.created_at DESC, refund.id DESC
  `).all(cutoverAt) as any[] : [];
  const legacyRefundCount = legacyRefundRows.length;
  const legacyRefundAmount = legacyRefundRows.reduce((total, row) => {
    const amount = Number(row.amount_minor);
    return Number.isSafeInteger(amount) && amount > 0 && Number.isSafeInteger(total + amount) ? total + amount : total;
  }, 0);

  const cashOpening = db.prepare(`
    SELECT opening_date, created_at FROM accounting_opening_balances WHERE account_id='acct-cash-drawer' LIMIT 1
  `).get() as { opening_date: string; created_at: string } | undefined;
  const cashMapping = db.prepare("SELECT account_id FROM accounting_payment_method_mappings WHERE payment_method_key='cash'").get() as { account_id: string } | undefined;
  const cashMappingMatchesDrawer = cashMapping?.account_id === 'acct-cash-drawer';
  const closures = db.prepare(`
    SELECT id, scope, business_date, period_start, period_end, opening_float_cents,
      expected_cash_cents, counted_cash_cents, variance_cents, gross_collected_cents,
      refunded_cents, net_collected_cents, notes, created_at
    FROM cash_closures
    ORDER BY period_end DESC, id DESC
    LIMIT 50
  `).all() as any[];
  const cashCheckpoints = closures.slice(0, limit).map((closure) => {
    const closeTime = parseDbTimestamp(String(closure.period_end)).getTime();
    const openingPredatesClose = !!cashOpening
      && Number.isFinite(parseDbTimestamp(cashOpening.created_at).getTime())
      && Number.isFinite(closeTime)
      && parseDbTimestamp(cashOpening.created_at).getTime() <= closeTime;
    const balance = openingPredatesClose
      ? db.prepare(`
          SELECT COALESCE(SUM(line.debit_minor - line.credit_minor), 0) AS balance_minor
          FROM accounting_journal_lines line
          JOIN accounting_journal_entries entry ON entry.id=line.journal_entry_id
          WHERE line.account_id='acct-cash-drawer'
            AND entry.status='posted'
            AND entry.entry_date <= ?
            AND datetime(entry.posted_at) <= datetime(?)
        `).get(String(closure.business_date), String(closure.period_end)) as { balance_minor: number }
      : null;
    const drawerMovements = openingPredatesClose
      ? db.prepare(`
          SELECT COUNT(*) AS count
          FROM cash_drawer_movements
          WHERE voided_at IS NULL
            AND movement_type IN ('opening_float','pay_in','pay_out','safe_drop')
            AND datetime(created_at) > datetime(?)
            AND datetime(created_at) <= datetime(?)
        `).get(String(cashOpening!.created_at), String(closure.period_end)) as { count: number }
      : null;
    const drawerMovementCount = drawerMovements ? Number(drawerMovements.count) : null;
    const ledgerBalanceMinor = balance ? Number(balance.balance_minor) : null;
    const canCompare = ledgerBalanceMinor !== null && Number.isSafeInteger(ledgerBalanceMinor)
      && Number.isSafeInteger(Number(closure.counted_cash_cents));
    const difference = canCompare ? Number(closure.counted_cash_cents) - ledgerBalanceMinor! : null;
    const comparisonStatus = !cashOpening ? 'opening_balance_missing'
      : !openingPredatesClose ? 'close_before_opening_balance'
        : !canCompare ? 'balance_not_comparable'
          : drawerMovementCount! > 0 ? 'requires_review_drawer_movements'
            : !cashMappingMatchesDrawer ? 'requires_review_cash_mapping'
              : difference === 0 ? 'matched' : 'difference';
    return {
      ...closure,
      ledger_balance_minor: canCompare ? ledgerBalanceMinor : null,
      difference_minor: difference,
      unclassified_drawer_movement_count: drawerMovementCount,
      comparison_status: comparisonStatus,
    };
  });

  const adjustmentRows = listAdjustments(db, limit);
  return {
    currency_code: currencyCode,
    cutover_at: cutoverAt,
    cutover_configured: !!cutoverAt,
    legacy: {
      payment_count: legacyPaymentCount,
      payment_total_minor: legacyPaymentAmount,
      payment_by_method: [...paymentByMethod.values()].sort((a, b) => a.method.localeCompare(b.method)),
      payment_samples: legacyPaymentSamples,
      payment_samples_truncated: legacyPaymentCount > legacyPaymentSamples.length,
      unclassified_payment_count: unclassifiedPaymentCount,
      malformed_payment_details_count: malformedPaymentDetailsCount,
      refund_count: legacyRefundCount,
      refund_total_minor: legacyRefundAmount,
      refund_samples: legacyRefundRows.slice(0, limit),
      refund_samples_truncated: legacyRefundRows.length > limit,
    },
    audit_exceptions: auditExceptions,
    cash_checkpoints: cashCheckpoints,
    cash_mapping_account_id: cashMapping?.account_id ?? null,
    cash_mapping_matches_drawer: cashMappingMatchesDrawer,
    adjustments: adjustmentRows,
    adjustment_account_available: !!db.prepare("SELECT 1 FROM accounting_accounts WHERE system_key='reconciliation_adjustment_equity' AND is_active=1 AND is_postable=1 AND account_type='equity'").get(),
  };
}

export function createReconciliationAdjustment(
  db: DB,
  input: any,
  actorId: string | null,
  idempotencyInput: unknown,
): any {
  const idempotencyKey = textValue(idempotencyInput, 'Idempotency-Key', 200);
  const accountId = textValue(input?.account_id, 'account_id', 100);
  const adjustmentDate = assertAccountingDate(input?.adjustment_date, 'adjustment_date');
  const verifiedBalance = input?.verified_balance_minor;
  if (!Number.isSafeInteger(verifiedBalance) || verifiedBalance < 0) {
    fail('invalid_verified_balance', 'Verified balance must be a non-negative safe integer in store-currency minor units.');
  }
  const reason = textValue(input?.reason, 'reason', 500);
  const sourceReference = optionalText(input?.source_reference, 'source_reference', 160);
  const currencyCode = configuredCurrency(db);
  const payload = { account_id: accountId, adjustment_date: adjustmentDate, verified_balance_minor: verifiedBalance, currency_code: currencyCode, reason, source_reference: sourceReference };
  const payloadHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');

  return db.transaction(() => {
    const existing = db.prepare('SELECT id, payload_hash FROM accounting_reconciliation_adjustments WHERE idempotency_key=?')
      .get(idempotencyKey) as { id: string; payload_hash: string } | undefined;
    if (existing) {
      if (existing.payload_hash !== payloadHash) fail('idempotency_key_conflict', 'This idempotency key was already used for a different reconciliation adjustment.', 409);
      const record = db.prepare(ADJUSTMENT_SELECT + ' WHERE adjustment.id=?').get(existing.id) as any;
      if (!record || record.journal_status !== 'posted') fail('reconciliation_adjustment_corrupt', 'The original reconciliation adjustment is missing or is not posted.', 409);
      return { ...record, duplicate: true };
    }

    const account = db.prepare(`
      SELECT id, account_code, name, account_type, normal_balance, system_key, is_active, is_postable
      FROM accounting_accounts WHERE id=?
    `).get(accountId) as any;
    if (!account) fail('account_not_found', 'The reconciliation account was not found.', 404);
    if (account.is_active !== 1 || account.is_postable !== 1) fail('account_not_postable', 'Choose an active, postable account for reconciliation.', 409);
    if (!['asset', 'liability'].includes(account.account_type) || account.system_key === 'inventory'
      || account.system_key === 'opening_balance_equity' || account.system_key === 'reconciliation_adjustment_equity') {
      fail('invalid_reconciliation_account', 'Reconciliation adjustments can target asset or liability accounts, but not inventory or balancing-equity accounts.', 400);
    }
    const balancingAccount = db.prepare(`
      SELECT id FROM accounting_accounts WHERE system_key='reconciliation_adjustment_equity'
        AND account_type='equity' AND normal_balance='credit' AND is_active=1 AND is_postable=1
    `).get() as { id: string } | undefined;
    if (!balancingAccount) fail('reconciliation_account_unavailable', 'The reconciliation adjustment equity account is not configured.', 409);

    const systemBalance = balanceOnDate(db, account.id, adjustmentDate, account.normal_balance);
    const difference = verifiedBalance - systemBalance;
    if (!Number.isSafeInteger(difference)) fail('balance_difference_unsafe', 'The balance difference exceeds safe integer precision.', 409);
    if (difference === 0) fail('no_reconciliation_difference', 'The verified balance matches the posted ledger balance; no adjustment is needed.', 409);
    const amount = Math.abs(difference);
    const targetIsDebit = (account.normal_balance === 'debit') === (difference > 0);
    const description = ('Reconciliation adjustment — ' + account.name + ' — ' + reason).slice(0, 500);
    const sourceId = createHash('sha256').update('accounting-reconciliation-adjustment:' + idempotencyKey).digest('hex').slice(0, 40);
    const targetLine = {
      accountId: account.id,
      debitMinor: targetIsDebit ? amount : 0,
      creditMinor: targetIsDebit ? 0 : amount,
      description: 'Verified balance correction: ' + reason,
    };
    const offsetLine = {
      accountId: balancingAccount.id,
      debitMinor: targetIsDebit ? 0 : amount,
      creditMinor: targetIsDebit ? amount : 0,
      description: 'Reconciliation equity offset',
    };
    const journal = createDraftJournalEntry(db, {
      entryDate: adjustmentDate, description, currencyCode,
      lines: [targetLine, offsetLine], createdBy: actorId,
      sourceType: 'accounting_reconciliation_adjustment',
      sourceId, sourceEvent: 'balance_adjustment',
      idempotencyKey: 'accounting-reconciliation-adjustment:' + idempotencyKey,
    });
    if (journal.duplicate) fail('reconciliation_adjustment_journal_conflict', 'A journal already exists without its reconciliation record.', 409);
    const posted = postJournalEntry(db, journal.id, actorId);
    if (posted.status !== 'posted') fail('reconciliation_adjustment_post_failed', 'The reconciliation journal could not be posted.', 409);

    const id = randomUUID();
    db.prepare(`
      INSERT INTO accounting_reconciliation_adjustments
        (id, account_id, adjustment_date, system_balance_minor, verified_balance_minor,
         difference_minor, currency_code, reason, source_reference, journal_entry_id,
         idempotency_key, payload_hash, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, account.id, adjustmentDate, systemBalance, verifiedBalance, difference, currencyCode,
      reason, sourceReference, posted.id, idempotencyKey, payloadHash, actorId);
    db.prepare(`
      INSERT INTO accounting_audit_log
        (entity_type, entity_id, action, actor_user_id, before_json, after_json)
      VALUES ('accounting_reconciliation_adjustment', ?, 'posted_adjustment', ?, ?, ?)
    `).run(id, actorId, JSON.stringify({ account_id: account.id, system_balance_minor: systemBalance }),
      JSON.stringify({ verified_balance_minor: verifiedBalance, difference_minor: difference, journal_entry_id: posted.id, reason, source_reference: sourceReference }));
    return { ...(db.prepare(ADJUSTMENT_SELECT + ' WHERE adjustment.id=?').get(id) as any), duplicate: false };
  })();
}
