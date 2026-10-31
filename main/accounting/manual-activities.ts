import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { RegionalNotConfiguredError, resolveTenantCurrency } from '../countries';
import { AccountingExpenseError, assertAccountingDate } from './expenses';
import { createDraftJournalEntry, postJournalEntry } from './ledger';
import { isLiquidAccountSystemKey } from './chart-of-accounts';

type DB = Database.Database;
type ActivityType = 'other_income' | 'owner_contribution' | 'owner_drawing';
function fail(code: string, message: string, statusCode = 400): never {
  throw new AccountingExpenseError(code, message, statusCode);
}
function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    fail('invalid_' + field, field + ' is required and must not exceed ' + max + ' characters.');
  }
  return value.trim();
}
function configuredCurrency(db: DB): string {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key IN ('country', 'currency')").all() as { key: string; value: string | null }[];
  const settings = Object.fromEntries(rows.map((row) => [row.key, row.value ?? undefined]));
  try { return resolveTenantCurrency(settings.currency, settings.country ?? ''); }
  catch (error) {
    if (error instanceof RegionalNotConfiguredError) fail('regional_not_configured', 'Configure the store country and currency before recording this accounting activity.', 409);
    throw error;
  }
}
function activeAccount(db: DB, value: unknown, types: string[], field: string): any {
  const id = requiredText(value, field, 100);
  const account = db.prepare('SELECT id, system_key, account_type, is_active, is_postable FROM accounting_accounts WHERE id=?').get(id) as any;
  if (!account) fail('account_not_found', 'The selected accounting account was not found.', 404);
  if (account.is_active !== 1) fail('account_inactive', 'Choose an active accounting account.', 409);
  if (account.is_postable !== 1) fail('account_not_postable', 'Choose a posting account, not a grouping account.');
  if (!types.includes(account.account_type)) fail('invalid_account_type', 'The selected account has an incompatible type.');
  return account;
}
function liquidAsset(db: DB, value: unknown): string {
  const account = activeAccount(db, value, ['asset'], 'asset_account_id');
  if (!isLiquidAccountSystemKey(account.system_key)) {
    fail('invalid_liquid_asset', 'Use a configured cash, bank, or payment-clearing account. Unclassified custom assets, inventory, and receivables are not payment accounts.');
  }
  return account.id;
}
const ACTIVITY_SELECT = `
  SELECT entry.id, entry.entry_number, entry.entry_date, entry.description, entry.currency_code, entry.status,
    entry.source_event AS activity_type, entry.created_at, entry.posted_at,
    debit.account_id AS debit_account_id, debitAccount.name AS debit_account_name,
    credit.account_id AS credit_account_id, creditAccount.name AS credit_account_name,
    CASE WHEN entry.source_event='owner_drawing' THEN debit.debit_minor ELSE credit.credit_minor END AS amount_minor
  FROM accounting_journal_entries entry
  JOIN accounting_journal_lines debit ON debit.journal_entry_id=entry.id AND debit.debit_minor>0
  JOIN accounting_accounts debitAccount ON debitAccount.id=debit.account_id
  JOIN accounting_journal_lines credit ON credit.journal_entry_id=entry.id AND credit.credit_minor>0
  JOIN accounting_accounts creditAccount ON creditAccount.id=credit.account_id
`;
export function listManualAccountingActivities(db: DB, filters: { from?: unknown; to?: unknown; limit?: unknown } = {}): any[] {
  const clauses = ["entry.source_type='accounting_manual_activity'", "entry.status='posted'", "entry.source_event IN ('other_income','owner_contribution','owner_drawing')"];
  const values: unknown[] = [];
  if (filters.from) { clauses.push('entry.entry_date >= ?'); values.push(assertAccountingDate(filters.from, 'from')); }
  if (filters.to) { clauses.push('entry.entry_date <= ?'); values.push(assertAccountingDate(filters.to, 'to')); }
  const limit = filters.limit === undefined ? 100 : Number(filters.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) fail('invalid_limit', 'Limit must be an integer from 1 to 500.');
  return db.prepare(ACTIVITY_SELECT + ' WHERE ' + clauses.join(' AND ') + ' ORDER BY entry.entry_date DESC, entry.entry_number DESC LIMIT ?').all(...values, limit);
}
export function createManualAccountingActivity(db: DB, input: any, actorId: string | null, idempotencyInput: unknown): any {
  const idempotencyKey = requiredText(idempotencyInput, 'idempotency_key', 128);
  const type = input?.activity_type as ActivityType;
  if (!['other_income', 'owner_contribution', 'owner_drawing'].includes(type)) fail('invalid_activity_type', 'Choose other income, owner contribution, or owner drawing.');
  const amountMinor = input?.amount_minor;
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) fail('invalid_amount', 'Amount must be a positive safe integer in currency minor units.');
  const entryDate = assertAccountingDate(input?.entry_date, 'entry_date');
  const description = requiredText(input?.description, 'description', 500);
  const currencyCode = configuredCurrency(db);
  const assetAccountId = liquidAsset(db, input?.asset_account_id);
  let debitAccountId: string;
  let creditAccountId: string;
  if (type === 'other_income') {
    const income = activeAccount(db, input?.income_account_id, ['revenue'], 'income_account_id');
    if (['sales_revenue', 'sales_returns', 'sales_discounts'].includes(income.system_key || '')) {
      fail('invalid_other_income_account', 'Manual other income must not use POS sales, sales returns, or sales discounts accounts.');
    }
    debitAccountId = assetAccountId; creditAccountId = income.id;
  } else if (type === 'owner_contribution') {
    const capital = activeAccount(db, 'acct-owner-capital', ['equity'], 'owner_capital_account');
    if (capital.system_key !== 'owner_capital') fail('owner_capital_account_unavailable', 'The owner-capital system account is unavailable.', 409);
    debitAccountId = assetAccountId; creditAccountId = capital.id;
  } else {
    const drawings = activeAccount(db, 'acct-owner-drawings', ['equity'], 'owner_drawings_account');
    if (drawings.system_key !== 'owner_drawings') fail('owner_drawings_account_unavailable', 'The owner-drawings system account is unavailable.', 409);
    debitAccountId = drawings.id; creditAccountId = assetAccountId;
  }
  const stableSourceId = createHash('sha256').update('accounting-manual-activity:' + idempotencyKey).digest('hex').slice(0, 40);
  const result = db.transaction(() => {
    const journal = createDraftJournalEntry(db, {
      entryDate, description, currencyCode,
      lines: [
        { accountId: debitAccountId, debitMinor: amountMinor, creditMinor: 0, description },
        { accountId: creditAccountId, debitMinor: 0, creditMinor: amountMinor, description },
      ],
      createdBy: actorId, sourceType: 'accounting_manual_activity', sourceId: stableSourceId,
      sourceEvent: type, idempotencyKey: 'accounting-manual-activity:' + idempotencyKey,
    });
    const posted = postJournalEntry(db, journal.id, actorId);
    return { id: posted.id, duplicate: journal.duplicate || posted.duplicate };
  })();
  const saved = db.prepare(ACTIVITY_SELECT + " WHERE entry.id=? AND entry.source_type='accounting_manual_activity' LIMIT 1").get(result.id) as any;
  if (!saved || saved.status !== 'posted') fail('activity_journal_invalid', 'Accounting activity was not finalized.', 409);
  return { ...saved, duplicate: result.duplicate };
}
