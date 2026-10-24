import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { RegionalNotConfiguredError, resolveTenantCurrency } from '../countries';
import { assertAccountingDate, AccountingExpenseError } from './expenses';
import { createDraftJournalEntry, postJournalEntry } from './ledger';
import { isLiquidAccountSystemKey } from './chart-of-accounts';

type DB = Database.Database;
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
  try {
    return resolveTenantCurrency(settings.currency, settings.country ?? '');
  } catch (error) {
    if (error instanceof RegionalNotConfiguredError) fail('regional_not_configured', 'Configure the store country and currency before recording transfers.', 409);
    throw error;
  }
}
function transferAccount(db: DB, value: unknown): string {
  const id = requiredText(value, 'account_id', 100);
  const row = db.prepare('SELECT id, system_key, account_type, is_active, is_postable FROM accounting_accounts WHERE id=?').get(id) as
    { id: string; system_key: string | null; account_type: string; is_active: number; is_postable: number } | undefined;
  if (!row) fail('account_not_found', 'Accounting account was not found.', 404);
  if (row.account_type !== 'asset') fail('invalid_transfer_account_type', 'Transfers can only use asset accounts.');
  if (!isLiquidAccountSystemKey(row.system_key)) {
    fail('invalid_transfer_account_type', 'Transfers can only use configured cash, bank, or payment-clearing accounts; unclassified custom assets are not eligible.');
  }
  if (row.is_active !== 1) fail('account_inactive', 'Choose an active accounting account.', 409);
  if (row.is_postable !== 1) fail('account_not_postable', 'Choose a posting account, not a grouping account.', 409);
  return row.id;
}
const TRANSFER_SELECT =
  "SELECT entry.id, entry.entry_number, entry.entry_date, entry.description, entry.currency_code, entry.status, " +
  "source.account_id AS source_account_id, sourceAccount.name AS source_account_name, " +
  "destination.account_id AS destination_account_id, destinationAccount.name AS destination_account_name, " +
  "source.credit_minor AS amount_minor " +
  "FROM accounting_journal_entries entry " +
  "JOIN accounting_journal_lines source ON source.journal_entry_id=entry.id AND source.credit_minor>0 " +
  "JOIN accounting_accounts sourceAccount ON sourceAccount.id=source.account_id " +
  "JOIN accounting_journal_lines destination ON destination.journal_entry_id=entry.id AND destination.debit_minor>0 " +
  "JOIN accounting_accounts destinationAccount ON destinationAccount.id=destination.account_id ";
export function listCashBankTransfers(db: DB, filters: { from?: unknown; to?: unknown; limit?: unknown } = {}): any[] {
  const clauses = ["entry.source_type='cash_bank_transfer'", "entry.source_event='transfer'", "entry.status='posted'"];
  const values: unknown[] = [];
  if (filters.from) { clauses.push('entry.entry_date >= ?'); values.push(assertAccountingDate(filters.from, 'from')); }
  if (filters.to) { clauses.push('entry.entry_date <= ?'); values.push(assertAccountingDate(filters.to, 'to')); }
  const limit = filters.limit === undefined ? 100 : Number(filters.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) fail('invalid_limit', 'Limit must be an integer from 1 to 500.');
  return db.prepare(TRANSFER_SELECT + 'WHERE ' + clauses.join(' AND ') + ' ORDER BY entry.entry_date DESC, entry.entry_number DESC LIMIT ?').all(...values, limit);
}
export function createCashBankTransfer(db: DB, input: any, actorId: string | null, idempotencyInput: unknown): any {
  const idempotencyKey = requiredText(idempotencyInput, 'idempotency_key', 128);
  const sourceAccountId = transferAccount(db, input?.source_account_id);
  const destinationAccountId = transferAccount(db, input?.destination_account_id);
  if (sourceAccountId === destinationAccountId) fail('same_transfer_account', 'Source and destination accounts must be different.');
  const amountMinor = input?.amount_minor;
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) fail('invalid_amount', 'Amount must be a positive safe integer in currency minor units.');
  const entryDate = assertAccountingDate(input?.entry_date, 'entry_date');
  const description = requiredText(input?.description, 'description', 500);
  const currencyCode = configuredCurrency(db);
  const stableSourceId = createHash('sha256').update('cash-bank-transfer:' + idempotencyKey).digest('hex').slice(0, 40);
  const result = db.transaction(() => {
    const journal = createDraftJournalEntry(db, {
      entryDate, description, currencyCode,
      lines: [
        { accountId: destinationAccountId, debitMinor: amountMinor, creditMinor: 0, description },
        { accountId: sourceAccountId, debitMinor: 0, creditMinor: amountMinor, description },
      ],
      createdBy: actorId, sourceType: 'cash_bank_transfer', sourceId: stableSourceId, sourceEvent: 'transfer',
      idempotencyKey: 'cash-bank-transfer:' + idempotencyKey,
    });
    const posted = postJournalEntry(db, journal.id, actorId);
    return { id: posted.id, duplicate: journal.duplicate || posted.duplicate };
  })();
  const saved = db.prepare(TRANSFER_SELECT + "WHERE entry.id=? AND entry.source_type='cash_bank_transfer' AND entry.source_event='transfer' LIMIT 1").get(result.id) as any;
  if (!saved || saved.status === 'draft') fail('transfer_journal_invalid', 'Transfer journal was not finalized.', 409);
  return { ...saved, duplicate: result.duplicate };
}
