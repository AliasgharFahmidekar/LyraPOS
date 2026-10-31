import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { resolveTenantCurrency } from '../countries';
import { createFutureItem, cancelFutureItem } from './future-items';

type DB = Database.Database;
type Frequency = 'monthly' | 'every_n_days';

export class RecurringObligationError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400) {
    super(message);
    this.name = 'RecurringObligationError';
  }
}
function fail(code: string, message: string, statusCode = 400): never {
  throw new RecurringObligationError(code, message, statusCode);
}
function textValue(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') fail('invalid_' + field, field + ' must be text.');
  const v = value.trim();
  if (!v || v.length > max) fail('invalid_' + field, field + ' must be between 1 and ' + max + ' characters.');
  return v;
}
function dateValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('invalid_' + field, field + ' must use YYYY-MM-DD.');
  const d = new Date(value + 'T00:00:00.000Z');
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== value) fail('invalid_' + field, field + ' must be a real calendar date.');
  return value;
}
function storeSettings(db: DB): Record<string, string> {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key IN ('country', 'currency')").all() as {key:string;value:string|null}[];
  return Object.fromEntries(rows.map(r => [r.key, r.value ?? '']));
}
function storeCurrency(db: DB): string {
  const s = storeSettings(db);
  try { return resolveTenantCurrency(s.currency, s.country); }
  catch { fail('accounting_currency_not_configured', 'Configure the store country and currency before creating a recurring obligation.', 409); }
}
function assertExpenseAccount(db: DB, idInput: unknown): string {
  const id = textValue(idInput, 'classification_account_id', 100);
  const row = db.prepare('SELECT id, account_type, is_active, is_postable, normal_balance FROM accounting_accounts WHERE id=?').get(id) as any;
  if (!row) fail('account_not_found', 'The selected expense account does not exist.', 404);
  if (row.account_type !== 'expense' || row.normal_balance !== 'debit' || row.is_active !== 1 || row.is_postable !== 1) {
    fail('invalid_expense_account', 'Recurring obligations require an active, postable expense account with debit normal balance.');
  }
  return id;
}
function sha(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function isoAddDays(date: string, days: number): string {
  const d = new Date(date + 'T12:00:00.000Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function calendarParts(date: string): {year:number;month:number;day:number} {
  const parts = new Intl.DateTimeFormat('en-u-ca-persian', {year:'numeric',month:'numeric',day:'numeric',timeZone:'UTC'}).formatToParts(new Date(date + 'T12:00:00.000Z'));
  const get = (type:string) => Number(parts.find(p=>p.type===type)?.value);
  return {year:get('year'),month:get('month'),day:get('day')};
}
function findPersianDate(year: number, month: number, day: number, near: string): string {
  const center = new Date(near + 'T12:00:00.000Z');
  for (let delta=-20; delta<=20; delta++) {
    const candidate = new Date(center.getTime());
    candidate.setUTCDate(candidate.getUTCDate()+delta);
    const iso = candidate.toISOString().slice(0,10);
    const p = calendarParts(iso);
    if (p.year===year && p.month===month && p.day===day) return iso;
  }
  fail('recurrence_calendar_error', 'Could not safely resolve the requested Jalali recurrence date.', 409);
}
function monthlyDate(firstDueDate: string, offset: number, isIran: boolean): string {
  if (offset===0) return firstDueDate;
  if (!isIran) {
    const first = new Date(firstDueDate + 'T12:00:00.000Z');
    const year = first.getUTCFullYear();
    const month = first.getUTCMonth();
    const originalDay = first.getUTCDate();
    const target = new Date(Date.UTC(year, month + offset, 1, 12));
    const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth()+1, 0, 12)).getUTCDate();
    target.setUTCDate(Math.min(originalDay,last));
    return target.toISOString().slice(0,10);
  }
  const p = calendarParts(firstDueDate);
  const absoluteMonth = p.year * 12 + (p.month - 1) + offset;
  const targetYear = Math.floor(absoluteMonth / 12);
  const targetMonth = absoluteMonth % 12 + 1;
  const approx = isoAddDays(firstDueDate, Math.round(offset * 30.436875));
  for (let day = Math.min(p.day,31); day >= 1; day--) {
    try { return findPersianDate(targetYear,targetMonth,day,approx); } catch { /* try the prior valid day */ }
  }
  return fail('recurrence_calendar_error', 'Could not resolve the Jalali recurrence date.', 409);
}
function dueDateFor(db: DB, frequency: Frequency, first: string, intervalDays: number | null, index: number): string {
  const settings = storeSettings(db);
  const isIran = /^(IR|IRN|Iran|ایران)$/i.test(settings.country);
  if (frequency === 'every_n_days') return isoAddDays(first, (intervalDays || 1) * index);
  return monthlyDate(first, index, isIran);
}
function scheduleRow(db: DB, id: string): any {
  const row = db.prepare('SELECT * FROM accounting_recurring_schedules WHERE id=?').get(id) as any;
  if (!row) fail('recurring_schedule_not_found', 'Recurring obligation schedule was not found.', 404);
  return row;
}
export function createRecurringObligation(db: DB, input: any, actorId: string | null, idempotencyKeyInput: unknown): any {
  const frequency = input?.frequency;
  if (frequency !== 'monthly' && frequency !== 'every_n_days') fail('invalid_frequency', 'Frequency must be monthly or every_n_days.');
  const firstDueDate = dateValue(input?.first_due_date, 'first_due_date');
  const count = input?.occurrence_count;
  if (!Number.isSafeInteger(count) || count < 1 || count > 120) fail('invalid_occurrence_count', 'Occurrence count must be an integer from 1 to 120.');
  const intervalDays = frequency === 'every_n_days' ? input?.interval_days : null;
  if (frequency === 'every_n_days' && (!Number.isSafeInteger(intervalDays) || intervalDays < 1 || intervalDays > 366)) {
    fail('invalid_interval_days', 'Every-N-days interval must be an integer from 1 to 366.');
  }
  if (frequency === 'monthly' && input?.interval_days !== undefined && input.interval_days !== null) {
    fail('invalid_interval_days', 'Monthly schedules do not accept interval_days.');
  }
  const amountMinor = input?.amount_minor;
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) fail('invalid_amount', 'Amount must be a positive integer in store currency accounting units.');
  const currency = storeCurrency(db);
  if (input?.currency_code !== undefined && String(input.currency_code).trim().toUpperCase() !== currency) fail('currency_mismatch', 'Recurring obligations must use configured store currency.', 409);
  const description = textValue(input?.description, 'description', 500);
  const counterparty = input?.counterparty == null || input.counterparty === '' ? null : textValue(input.counterparty, 'counterparty', 200);
  const accountId = assertExpenseAccount(db, input?.classification_account_id);
  const autoRegister = input?.auto_register === undefined ? false : input.auto_register;
  if (typeof autoRegister !== 'boolean') fail('invalid_auto_register', 'auto_register must be true or false.');
  const idempotencyKey = textValue(idempotencyKeyInput, 'idempotency_key', 200);
  const payload = {frequency, intervalDays, firstDueDate, count, amountMinor, currency, description, counterparty, accountId, autoRegister};
  const payloadHash = sha(payload);
  return db.transaction(() => {
    const old = db.prepare('SELECT * FROM accounting_recurring_schedules WHERE idempotency_key=?').get(idempotencyKey) as any;
    if (old) {
      if (old.payload_hash !== payloadHash) fail('idempotency_conflict', 'Idempotency key reused with different recurring schedule data.', 409);
      return { ...old, duplicate: true };
    }
    const id = randomUUID();
    db.prepare(`INSERT INTO accounting_recurring_schedules
      (id, direction, frequency, interval_days, first_due_date, occurrence_count, amount_minor, currency_code,
       description, counterparty, classification_account_id, auto_register, idempotency_key, payload_hash, created_by)
      VALUES (?, 'outgoing', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, frequency, intervalDays, firstDueDate, count, amountMinor, currency, description, counterparty, accountId,
        autoRegister ? 1 : 0, idempotencyKey, payloadHash, actorId);
    const insertOccurrence = db.prepare('INSERT INTO accounting_recurring_occurrences (id, schedule_id, occurrence_number, due_date, future_item_id) VALUES (?, ?, ?, ?, ?)');
    for (let i=0; i<count; i++) {
      const dueDate = dueDateFor(db, frequency, firstDueDate, intervalDays, i);
      const future = createFutureItem(db, {
        record_type: 'cheque', direction: 'outgoing', due_date: dueDate, amount_minor: amountMinor,
        currency_code: currency, description, counterparty, reference_number: null,
        classification_account_id: accountId, auto_register: autoRegister,
      }, actorId, 'recurring:' + id + ':' + (i+1));
      insertOccurrence.run(randomUUID(), id, i+1, dueDate, future.id);
    }
    return { ...scheduleRow(db,id), duplicate: false, generated_occurrences: count };
  })();
}
export function listRecurringObligations(db: DB, filters: any = {}): any[] {
  const status = filters?.status == null || filters.status === '' ? null : String(filters.status);
  if (status && !['active','cancelled'].includes(status)) fail('invalid_status','Unknown recurring schedule status.');
  const id = filters?.id == null || filters.id === '' ? null : textValue(filters.id,'id',100);
  const rows = db.prepare(`SELECT s.*, a.account_code AS classification_account_code, a.name AS classification_account_name,
    COUNT(o.id) AS generated_occurrences,
    SUM(CASE WHEN f.status='settled' THEN 1 ELSE 0 END) AS settled_occurrences,
    SUM(CASE WHEN f.status='registered' THEN 1 ELSE 0 END) AS registered_occurrences,
    SUM(CASE WHEN f.status='cancelled' THEN 1 ELSE 0 END) AS cancelled_occurrences
    FROM accounting_recurring_schedules s
    JOIN accounting_accounts a ON a.id=s.classification_account_id
    LEFT JOIN accounting_recurring_occurrences o ON o.schedule_id=s.id
    LEFT JOIN accounting_future_items f ON f.id=o.future_item_id
    WHERE (? IS NULL OR s.status=?) AND (? IS NULL OR s.id=?)
    GROUP BY s.id ORDER BY s.first_due_date, s.created_at, s.id`)
    .all(status,status,id,id) as any[];
  return rows.map(row => ({...row, occurrences: db.prepare(`SELECT o.id, o.occurrence_number, o.due_date, f.id AS future_item_id,
      f.status AS status, f.due_journal_entry_id, f.settlement_journal_entry_id, f.last_error_code, f.last_error_message
      FROM accounting_recurring_occurrences o JOIN accounting_future_items f ON f.id=o.future_item_id
      WHERE o.schedule_id=? ORDER BY o.occurrence_number`).all(row.id)}));
}
export function cancelRecurringObligation(db: DB, idInput: unknown, reasonInput: unknown, actorId: string | null): any {
  const id = textValue(idInput,'id',100);
  const reason = textValue(reasonInput,'reason',500);
  return db.transaction(() => {
    const schedule = scheduleRow(db,id);
    if (schedule.status === 'cancelled') {
      if (schedule.cancellation_reason === reason) return {...schedule, duplicate:true};
      fail('recurring_schedule_already_cancelled','Schedule is already cancelled with a different reason.',409);
    }
    const rows = db.prepare('SELECT o.future_item_id, f.status FROM accounting_recurring_occurrences o JOIN accounting_future_items f ON f.id=o.future_item_id WHERE o.schedule_id=?').all(id) as any[];
    for (const row of rows) {
      if (['scheduled','awaiting_confirmation','failed'].includes(row.status)) {
        cancelFutureItem(db,row.future_item_id,reason,actorId);
      }
      // Already registered/settled occurrences remain intact. Their posted journals are never edited or erased.
    }
    db.prepare("UPDATE accounting_recurring_schedules SET status='cancelled', cancelled_by=?, cancellation_reason=?, cancelled_at=CURRENT_TIMESTAMP WHERE id=? AND status='active'")
      .run(actorId,reason,id);
    return {...scheduleRow(db,id),duplicate:false};
  })();
}
