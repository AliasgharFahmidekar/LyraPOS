import type Database from 'better-sqlite3';
import { accountingDate } from './sales';

type DB = Database.Database;
type ReconciliationStatus = 'posted_once' | 'missing_journal' | 'journal_not_posted' | 'duplicate_journals' | 'missing_source_identity' | 'skipped_pre_cutover' | 'excluded_non_monetary' | 'skipped_auto_posting';

type SourceEvent = {
  event_type: 'receipt' | 'refund' | 'expense';
  source_id: string;
  event_date: string | null;
  amount: number | null;
  method: string | null;
  status: ReconciliationStatus;
  journal_entry_ids: string[];
  reason: string | null;
};

function validDate(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw Object.assign(new Error(field + ' must use YYYY-MM-DD.'), { code: 'invalid_date', statusCode: 400 });
  }
  const date = new Date(value + 'T00:00:00.000Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw Object.assign(new Error(field + ' must be a real calendar date.'), { code: 'invalid_date', statusCode: 400 });
  }
  return value;
}

function wasSkippedBecauseAutoPostingDisabled(db: DB, entityId: string, action: string): boolean {
  return Boolean(db.prepare(
    "SELECT 1 FROM accounting_audit_log WHERE entity_type='accounting_source_event' AND entity_id=? AND action=? LIMIT 1",
  ).get(entityId, action));
}

function journalMatches(db: DB, sourceType: string, sourceId: string, sourceEvent: string): Array<{ id: string; entry_number: string; status: string }> {
  return db.prepare(
    'SELECT id, entry_number, status FROM accounting_journal_entries WHERE source_type=? AND source_id=? AND source_event=? ORDER BY created_at,id',
  ).all(sourceType, sourceId, sourceEvent) as Array<{ id: string; entry_number: string; status: string }>;
}

function statusFor(matches: Array<{ id: string; entry_number: string; status: string }>): Pick<SourceEvent, 'status' | 'journal_entry_ids' | 'reason'> {
  const ids = matches.map((entry) => entry.id);
  if (matches.length > 1) return { status: 'duplicate_journals', journal_entry_ids: ids, reason: 'More than one journal matches the source event; investigate without deleting or rewriting posted entries.' };
  if (!matches.length) return { status: 'missing_journal', journal_entry_ids: [], reason: 'No journal entry matches this operational source event.' };
  if (matches[0].status !== 'posted') return { status: 'journal_not_posted', journal_entry_ids: ids, reason: 'A matching journal exists but is not posted.' };
  return { status: 'posted_once', journal_entry_ids: ids, reason: null };
}

function parsePaymentDetails(raw: unknown): any[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') return [parsed];
  } catch { /* malformed legacy details are surfaced as source exceptions by the caller */ }
  return [];
}

function isWallet(method: unknown): boolean {
  return typeof method === 'string' && ['wallet', 'loyalty', 'credit', 'store_credit', 'loyalty_wallet'].includes(method.trim().toLowerCase().replace(/[\s-]+/g, '_'));
}

function inDateRange(date: string | null, from?: string, to?: string): boolean {
  const day = date?.slice(0, 10);
  return Boolean(day && (!from || day >= from) && (!to || day <= to));
}

/**
 * Source timestamps must be filtered by the same tenant business date used by
 * the posting path. An unparseable timestamp is included in every filtered
 * view and surfaced as an exception below; silently dropping it could let a
 * period close pass without reconciling an event whose date is unknown.
 */
function accountingEventDate(db: DB, timestamp: string | null): string | null {
  if (typeof timestamp !== 'string' || !timestamp.trim()) return null;
  try {
    return accountingDate(db, timestamp);
  } catch {
    return null;
  }
}

function inAccountingDateRange(db: DB, timestamp: string | null, from?: string, to?: string): boolean {
  const day = accountingEventDate(db, timestamp);
  if (!day) return true;
  return (!from || day >= from) && (!to || day <= to);
}

/**
 * Read-only source-event reconciliation. It reports exceptions; it never posts,
 * repairs, deletes or backfills accounting journals.
 */
export function getAccountingSourceEventReconciliation(db: DB, filters: { from?: unknown; to?: unknown; limit?: unknown } = {}): {
  from: string | null;
  to: string | null;
  events: SourceEvent[];
  summary: Record<string, number>;
  read_only: true;
} {
  const from = validDate(filters.from, 'from');
  const to = validDate(filters.to, 'to');
  if (from && to && from > to) throw Object.assign(new Error('from must be on or before to.'), { code: 'invalid_date_range', statusCode: 400 });
  const requestedLimit = filters.limit === undefined ? 500 : Number(filters.limit);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 2000) {
    throw Object.assign(new Error('limit must be an integer between 1 and 2000.'), { code: 'invalid_limit', statusCode: 400 });
  }

  const cutoffRow = db.prepare("SELECT value FROM settings WHERE key='accounting_cutover_at'").get() as { value: string | null } | undefined;
  const cutoff = cutoffRow?.value || null;
  const isPreCutover = (createdAt: string | null): boolean => {
    if (!cutoff || !createdAt) return false;
    const cutoffMs = Date.parse(cutoff.replace(' ', 'T') + (cutoff.includes('Z') || /[+-]\d\d:\d\d$/.test(cutoff) ? '' : 'Z'));
    const createdMs = Date.parse(createdAt.replace(' ', 'T') + (createdAt.includes('Z') || /[+-]\d\d:\d\d$/.test(createdAt) ? '' : 'Z'));
    return Number.isFinite(cutoffMs) && Number.isFinite(createdMs) && createdMs <= cutoffMs;
  };
  const events: SourceEvent[] = [];

  const bills = db.prepare(
    "SELECT id, created_at, payment_details FROM bills WHERE payment_details IS NOT NULL AND payment_details != '' ORDER BY id",
  ).all() as Array<{ id: number; created_at: string | null; payment_details: string }>;
  for (const bill of bills) {
    let parsed: any;
    try { parsed = JSON.parse(bill.payment_details); }
    catch {
      if (inAccountingDateRange(db, bill.created_at, from, to)) events.push({
        event_type: 'receipt', source_id: 'bill:' + String(bill.id), event_date: bill.created_at,
        amount: null, method: null, status: 'missing_source_identity', journal_entry_ids: [],
        reason: 'Bill payment_details is malformed JSON; source events cannot be safely reconciled.',
      });
      continue;
    }
    const payments = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? [parsed] : [];
    for (const payment of payments) {
      const method = typeof payment?.method === 'string' ? payment.method : null;
      if (isWallet(method)) continue;
      const amount = Number(payment?.amount);
      if (!Number.isFinite(amount) || amount <= 0) continue;
      const eventId = typeof payment?.payment_event_id === 'string' ? payment.payment_event_id.trim() : '';
      const sourceId = eventId ? String(bill.id) + ':' + eventId : 'bill:' + String(bill.id);
      const eventDate = typeof payment?.timestamp === 'string' && payment.timestamp.trim() ? payment.timestamp.trim() : null;
      if (!eventDate) {
        // A pre-cutover bill plus a legacy payment-details line with neither immutable
        // event ID nor timestamp is the one case covered by the explicit no-backfill
        // policy: exclude it as legacy, but keep it visible. New application payments
        // always carry both fields. If either is present/missing inconsistently, or the
        // parent bill is post-cutover, do not guess: keep it unresolved so period close
        // remains blocked pending evidence.
        if (!eventId && isPreCutover(bill.created_at)) {
          if (!inAccountingDateRange(db, bill.created_at, from, to)) continue;
          events.push({
            event_type: 'receipt', source_id: sourceId, event_date: null, amount, method,
            status: 'skipped_pre_cutover', journal_entry_ids: [],
            reason: 'Legacy payment line has no event ID or timestamp and its bill predates cutover; it is excluded under the no-backfill policy.',
          });
        } else {
          events.push({
            event_type: 'receipt', source_id: sourceId, event_date: null, amount, method,
            status: 'missing_source_identity', journal_entry_ids: [],
            reason: 'Receipt event has no timestamp; its cutover status and accounting business date cannot be established safely.',
          });
        }
        continue;
      }
      const eventDay = accountingEventDate(db, eventDate);
      if (!inAccountingDateRange(db, eventDate, from, to)) continue;
      if (!eventDay) {
        events.push({
          event_type: 'receipt', source_id: sourceId,
          event_date: eventDate, amount, method, status: 'missing_source_identity', journal_entry_ids: [],
          reason: 'Receipt timestamp cannot be mapped to the tenant accounting business date; manual review is required.',
        });
        continue;
      }
      if (isPreCutover(eventDate)) {
        events.push({ event_type: 'receipt', source_id: sourceId, event_date: eventDate, amount, method, status: 'skipped_pre_cutover', journal_entry_ids: [], reason: 'Receipt event timestamp predates the accounting cutover and is not automatically backfilled.' });
        continue;
      }
      if (!eventId) {
        events.push({ event_type: 'receipt', source_id: 'bill:' + String(bill.id), event_date: eventDate, amount, method, status: 'missing_source_identity', journal_entry_ids: [], reason: 'Monetary payment line has no stable payment_event_id; no automatic posting or repair was attempted.' });
        continue;
      }
      const match = statusFor(journalMatches(db, 'bill_payment', String(bill.id) + ':' + eventId, 'money_received'));
      const skipped = match.status === 'missing_journal'
        && wasSkippedBecauseAutoPostingDisabled(db, 'payment:' + eventId, 'skipped_auto_sales_posting');
      events.push({
        event_type: 'receipt',
        source_id: String(bill.id) + ':' + eventId,
        event_date: eventDate,
        amount,
        method,
        ...(skipped
          ? { status: 'skipped_auto_posting' as const, journal_entry_ids: [], reason: 'Automatic sales posting was disabled in accounting settings; no journal was expected.' }
          : match),
      });
    }
  }

  const refunds = db.prepare(
    'SELECT r.id, r.bill_id, r.amount_cents, r.method, r.created_at, b.created_at AS bill_created_at FROM refunds r JOIN bills b ON b.id=r.bill_id ORDER BY r.id',
  ).all() as Array<{ id: number; bill_id: number; amount_cents: number; method: string; created_at: string | null; bill_created_at: string | null }>;
  for (const refund of refunds) {
    if (isWallet(refund.method)) continue;
    const refundAccountingDay = accountingEventDate(db, refund.created_at);
    if (!inAccountingDateRange(db, refund.created_at, from, to)) continue;
    if (!refundAccountingDay) {
      events.push({
        event_type: 'refund', source_id: String(refund.id), event_date: refund.created_at,
        amount: Number(refund.amount_cents), method: refund.method, status: 'missing_source_identity',
        journal_entry_ids: [], reason: 'Refund timestamp cannot be mapped to the tenant accounting business date; manual review is required.',
      });
      continue;
    }
    if (isPreCutover(refund.created_at)) {
      events.push({ event_type: 'refund', source_id: String(refund.id), event_date: refund.created_at, amount: Number(refund.amount_cents), method: refund.method, status: 'skipped_pre_cutover', journal_entry_ids: [], reason: 'Refund event timestamp predates the accounting cutover and is not automatically backfilled.' });
      continue;
    }
    const match = statusFor(journalMatches(db, 'refund', String(refund.id), 'money_refunded'));
    const skipped = match.status === 'missing_journal'
      && wasSkippedBecauseAutoPostingDisabled(db, 'refund:' + String(refund.id), 'skipped_auto_refund_posting');
    events.push({
      event_type: 'refund',
      source_id: String(refund.id),
      event_date: refund.created_at,
      amount: Number(refund.amount_cents),
      method: refund.method,
      ...(skipped
        ? { status: 'skipped_auto_posting' as const, journal_entry_ids: [], reason: 'Automatic sales posting was disabled and the original sale had no posted receipt; no refund journal was expected.' }
        : match),
    });
  }

  const expenses = db.prepare(
    "SELECT id, payment_date, expense_date, amount_minor, payment_method_key, payment_status, status, posted_journal_entry_id FROM accounting_expenses WHERE payment_status='paid' ORDER BY id",
  ).all() as Array<{ id: string; payment_date: string | null; expense_date: string; amount_minor: number; payment_method_key: string | null; payment_status: string; status: string; posted_journal_entry_id: string | null }>;
  for (const expense of expenses) {
    const eventDate = expense.payment_date || expense.expense_date;
    if (!inDateRange(eventDate, from, to)) continue;
    const match = statusFor(journalMatches(db, 'expense', String(expense.id), 'expense_paid'));
    // Expense status/link inconsistencies are not hidden by the source lookup.
    if (expense.status === 'posted' && expense.posted_journal_entry_id && match.status === 'posted_once'
      && match.journal_entry_ids[0] !== expense.posted_journal_entry_id) {
      events.push({ event_type: 'expense', source_id: String(expense.id), event_date: eventDate, amount: Number(expense.amount_minor), method: expense.payment_method_key, status: 'duplicate_journals', journal_entry_ids: match.journal_entry_ids, reason: 'Expense link does not match the journal found by its source identity; review the records manually.' });
    } else {
      events.push({ event_type: 'expense', source_id: String(expense.id), event_date: eventDate, amount: Number(expense.amount_minor), method: expense.payment_method_key, ...match });
    }
  }

  events.sort((a, b) => String(b.event_date || '').localeCompare(String(a.event_date || '')) || a.event_type.localeCompare(b.event_type) || a.source_id.localeCompare(b.source_id));
  const summary: Record<string, number> = {};
  for (const event of events) summary[event.status] = (summary[event.status] || 0) + 1;
  return { from: from ?? null, to: to ?? null, events: events.slice(0, requestedLimit), summary, read_only: true };
}
