import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getAccountingSourceEventReconciliation } from './source-reconciliation';
import { AccountingExpenseError, assertAccountingDate } from './expenses';

type DB = Database.Database;
function fail(code: string, message: string, statusCode = 400): never {
  throw new AccountingExpenseError(code, message, statusCode);
}
function requiredText(value: unknown, field: string, max = 500): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    fail('invalid_' + field, field + ' is required and must not exceed ' + max + ' characters.');
  }
  return value.trim();
}
function audit(db: DB, id: string, action: string, actorId: string | null, before: unknown, after: unknown): void {
  db.prepare('INSERT INTO accounting_audit_log (entity_type, entity_id, action, actor_user_id, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?)')
    .run('accounting_period', id, action, actorId, before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after));
}
type PeriodRow = {
  id: string; period_start: string; period_end: string; status: 'closed' | 'reopened';
  close_reason: string; closed_by: string | null; closed_at: string; reopen_reason: string | null;
  reopened_by: string | null; reopened_at: string | null;
};
function snapshot(row: PeriodRow): Record<string, unknown> { return { ...row }; }

export function listAccountingPeriods(db: DB): PeriodRow[] {
  return db.prepare('SELECT id, period_start, period_end, status, close_reason, closed_by, closed_at, reopen_reason, reopened_by, reopened_at FROM accounting_period_closures ORDER BY period_start DESC, closed_at DESC')
    .all() as PeriodRow[];
}

/** Close an exact inclusive date range only when its ledger and source events are reconciled. */
export function closeAccountingPeriod(db: DB, input: any, actorId: string | null): any {
  const start = assertAccountingDate(input?.period_start, 'period_start');
  const end = assertAccountingDate(input?.period_end, 'period_end');
  if (start > end) fail('invalid_period_range', 'Period start must be on or before period end.');
  const reason = requiredText(input?.reason, 'reason');
  return db.transaction(() => {
    const existing = db.prepare('SELECT * FROM accounting_period_closures WHERE period_start=? AND period_end=?')
      .get(start, end) as PeriodRow | undefined;
    if (existing?.status === 'closed') {
      if (existing.close_reason !== reason) fail('period_close_conflict', 'This period is already closed with a different reason.', 409);
      return { ...existing, duplicate: true };
    }
    if (existing?.status === 'reopened') {
      const draftsBeforeReclose = db.prepare("SELECT COUNT(*) AS count FROM accounting_journal_entries WHERE status='draft' AND entry_date BETWEEN ? AND ?")
        .get(start, end) as { count: number };
      if (draftsBeforeReclose.count > 0) fail('period_has_draft_journals', 'Resolve draft journal entries before closing this period again.', 409);
    }

    const drafts = db.prepare("SELECT COUNT(*) AS count FROM accounting_journal_entries WHERE status='draft' AND entry_date BETWEEN ? AND ?")
      .get(start, end) as { count: number };
    if (drafts.count > 0) fail('period_has_draft_journals', 'Resolve or remove draft journal entries in this period before closing it.', 409);
    const expenses = db.prepare("SELECT COUNT(*) AS count FROM accounting_expenses WHERE status='draft' AND ((expense_date BETWEEN ? AND ?) OR (payment_date BETWEEN ? AND ?))")
      .get(start, end, start, end) as { count: number };
    if (expenses.count > 0) fail('period_has_unposted_expenses', 'Post or resolve draft expenses in this period before closing it.', 409);

    const reconciliation = getAccountingSourceEventReconciliation(db, { from: start, to: end, limit: 2000 });
    const allowedStatuses = new Set(['posted_once', 'skipped_pre_cutover', 'excluded_non_monetary']);
    const unresolvedCount = Object.entries(reconciliation.summary)
      .filter(([status, count]) => !allowedStatuses.has(status) && count > 0)
      .reduce((total, [, count]) => total + count, 0);
    if (unresolvedCount > 0) {
      fail('period_has_source_exceptions', 'Resolve source-event reconciliation exceptions before closing this period (' + unresolvedCount + ' unresolved).', 409);
    }

    if (existing?.status === 'reopened') {
      db.prepare("UPDATE accounting_period_closures SET status='closed', close_reason=?, closed_by=?, closed_at=CURRENT_TIMESTAMP, reopen_reason=NULL, reopened_by=NULL, reopened_at=NULL WHERE id=? AND status='reopened'")
        .run(reason, actorId, existing.id);
      const saved = db.prepare('SELECT * FROM accounting_period_closures WHERE id=?').get(existing.id) as PeriodRow;
      audit(db, existing.id, 'reclosed', actorId, snapshot(existing), snapshot(saved));
      return { ...saved, duplicate: false };
    }
    const id = randomUUID();
    db.prepare("INSERT INTO accounting_period_closures (id, period_start, period_end, status, close_reason, closed_by) VALUES (?, ?, ?, 'closed', ?, ?)")
      .run(id, start, end, reason, actorId);
    const saved = db.prepare('SELECT * FROM accounting_period_closures WHERE id=?').get(id) as PeriodRow;
    audit(db, id, 'closed', actorId, null, snapshot(saved));
    return { ...saved, duplicate: false };
  })();
}

/** Reopening is a privileged, reasoned action; the close history remains in the audit log. */
export function reopenAccountingPeriod(db: DB, idInput: unknown, reasonInput: unknown, actorId: string | null): any {
  const id = requiredText(idInput, 'period_id', 100);
  const reason = requiredText(reasonInput, 'reason');
  return db.transaction(() => {
    const current = db.prepare('SELECT * FROM accounting_period_closures WHERE id=?').get(id) as PeriodRow | undefined;
    if (!current) fail('period_not_found', 'Accounting period close record was not found.', 404);
    if (current.status === 'reopened') {
      if (current.reopen_reason !== reason) fail('period_reopen_conflict', 'This period was already reopened with a different reason.', 409);
      return { ...current, duplicate: true };
    }
    db.prepare("UPDATE accounting_period_closures SET status='reopened', reopen_reason=?, reopened_by=?, reopened_at=CURRENT_TIMESTAMP WHERE id=? AND status='closed'")
      .run(reason, actorId, id);
    const saved = db.prepare('SELECT * FROM accounting_period_closures WHERE id=?').get(id) as PeriodRow;
    audit(db, id, 'reopened', actorId, snapshot(current), snapshot(saved));
    return { ...saved, duplicate: false };
  })();
}
