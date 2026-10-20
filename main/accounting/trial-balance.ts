import type Database from 'better-sqlite3';
import { getAccountingMinorUnitFactor, resolveTenantCurrency } from '../countries';
import { AccountingExpenseError, assertAccountingDate } from './expenses';

type DB = Database.Database;

function fail(code: string, message: string, statusCode = 400): never {
  throw new AccountingExpenseError(code, message, statusCode);
}

function safeTotal(value: unknown, label: string): number {
  const amount = Number(value ?? 0);
  if (!Number.isSafeInteger(amount)) {
    fail('trial_balance_precision_overflow', 'The ' + label + ' exceeds safe integer precision. Narrow the date range before retrying.', 409);
  }
  return amount;
}

function configuredCurrency(db: DB): { currencyCode: string; fractionDigits: number } {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key IN ('country', 'currency')").all() as Array<{ key: string; value: string | null }>;
  const settings = Object.fromEntries(rows.map((row) => [row.key, row.value ?? undefined]));
  try {
    const currencyCode = resolveTenantCurrency(settings.currency, settings.country ?? '');
    const factor = getAccountingMinorUnitFactor(currencyCode);
    if (!Number.isSafeInteger(factor) || factor < 1) fail('accounting_currency_invalid', 'The configured accounting currency has an invalid ledger unit.', 409);
    return { currencyCode, fractionDigits: Math.round(Math.log10(factor)) };
  } catch (error) {
    if (error instanceof AccountingExpenseError) throw error;
    fail('accounting_region_unconfigured', 'Configure a valid store country and currency before viewing accounting reports.', 409);
  }
}

/**
 * Read-only trial balance computed only from posted journal lines.
 * Opening and closing values use each account's configured normal balance.
 * It checks journal integrity but never mutates or repairs ledger data.
 */
export function getAccountingTrialBalance(db: DB, filters: { from?: unknown; to?: unknown } = {}): {
  from: string | null;
  to: string | null;
  currency_code: string;
  fraction_digits: number;
  accounts: Array<{
    id: string; account_code: string; name: string; account_type: string;
    normal_balance: string; is_active: number; is_postable: number;
    opening_balance_minor: number; period_debit_minor: number; period_credit_minor: number;
    closing_balance_minor: number; closing_debit_minor: number; closing_credit_minor: number;
  }>;
  totals: {
    opening_debit_minor: number; opening_credit_minor: number;
    period_debit_minor: number; period_credit_minor: number;
    closing_debit_minor: number; closing_credit_minor: number;
  };
  integrity: {
    balanced: boolean; posted_journal_count: number; unbalanced_journal_count: number;
    unbalanced_journals: Array<{ id: string; entry_number: string; entry_date: string; debit_minor: number; credit_minor: number; line_count: number }>;
  };
  read_only: true;
} {
  const from = filters.from == null || filters.from === '' ? null : assertAccountingDate(filters.from, 'from');
  const to = filters.to == null || filters.to === '' ? null : assertAccountingDate(filters.to, 'to');
  if (from && to && from > to) fail('invalid_date_range', 'The start date must not be later than the end date.');
  const currency = configuredCurrency(db);
  const accounts = db.prepare(
    'SELECT id, account_code, name, account_type, normal_balance, is_active, is_postable FROM accounting_accounts ORDER BY account_code, id',
  ).all() as Array<{ id: string; account_code: string; name: string; account_type: string; normal_balance: string; is_active: number; is_postable: number }>;

  const openingQuery = db.prepare(
    "SELECT COALESCE(SUM(CASE WHEN account.normal_balance='debit' THEN line.debit_minor-line.credit_minor ELSE line.credit_minor-line.debit_minor END),0) AS balance_minor " +
    "FROM accounting_journal_lines line JOIN accounting_journal_entries entry ON entry.id=line.journal_entry_id " +
    "JOIN accounting_accounts account ON account.id=line.account_id WHERE entry.status='posted' AND line.account_id=? AND (? IS NULL OR entry.entry_date < ?)",
  );
  const periodQuery = db.prepare(
    "SELECT COALESCE(SUM(line.debit_minor),0) AS debit_minor, COALESCE(SUM(line.credit_minor),0) AS credit_minor " +
    "FROM accounting_journal_lines line JOIN accounting_journal_entries entry ON entry.id=line.journal_entry_id " +
    "WHERE entry.status='posted' AND line.account_id=? AND (? IS NULL OR entry.entry_date >= ?) AND (? IS NULL OR entry.entry_date <= ?)",
  );
  const closingQuery = db.prepare(
    "SELECT COALESCE(SUM(CASE WHEN account.normal_balance='debit' THEN line.debit_minor-line.credit_minor ELSE line.credit_minor-line.debit_minor END),0) AS balance_minor " +
    "FROM accounting_journal_lines line JOIN accounting_journal_entries entry ON entry.id=line.journal_entry_id " +
    "JOIN accounting_accounts account ON account.id=line.account_id WHERE entry.status='posted' AND line.account_id=? AND (? IS NULL OR entry.entry_date <= ?)",
  );

  const resultAccounts = accounts.map((account) => {
    const opening = safeTotal((openingQuery.get(account.id, from, from) as { balance_minor: number }).balance_minor, 'opening balance');
    const movement = periodQuery.get(account.id, from, from, to, to) as { debit_minor: number; credit_minor: number };
    const debit = safeTotal(movement.debit_minor, 'period debits');
    const credit = safeTotal(movement.credit_minor, 'period credits');
    const closing = safeTotal((closingQuery.get(account.id, to, to) as { balance_minor: number }).balance_minor, 'closing balance');
    const openingDebit = Math.max(0, opening);
    const openingCredit = Math.max(0, -opening);
    const closingDebit = Math.max(0, closing);
    const closingCredit = Math.max(0, -closing);
    return {
      ...account,
      opening_balance_minor: openingDebit - openingCredit,
      period_debit_minor: debit,
      period_credit_minor: credit,
      closing_balance_minor: closing,
      closing_debit_minor: closingDebit,
      closing_credit_minor: closingCredit,
    };
  });

  // Integrity is checked per posted journal, not inferred from aggregate totals (which can hide offsetting errors).
  const integrityWhere: string[] = ["entry.status='posted'"];
  const integrityParams: unknown[] = [];
  if (from) { integrityWhere.push('entry.entry_date >= ?'); integrityParams.push(from); }
  if (to) { integrityWhere.push('entry.entry_date <= ?'); integrityParams.push(to); }
  const integrityRows = db.prepare(
    'SELECT entry.id, entry.entry_number, entry.entry_date, COALESCE(SUM(line.debit_minor),0) AS debit_minor, ' +
    'COALESCE(SUM(line.credit_minor),0) AS credit_minor, COUNT(line.id) AS line_count ' +
    'FROM accounting_journal_entries entry LEFT JOIN accounting_journal_lines line ON line.journal_entry_id=entry.id ' +
    'WHERE ' + integrityWhere.join(' AND ') + ' GROUP BY entry.id, entry.entry_number, entry.entry_date ' +
    'HAVING COALESCE(SUM(line.debit_minor),0) <> COALESCE(SUM(line.credit_minor),0) OR COUNT(line.id) < 2 ' +
    'ORDER BY entry.entry_date, entry.entry_number LIMIT 100',
  ).all(...integrityParams) as Array<{ id: string; entry_number: string; entry_date: string; debit_minor: number; credit_minor: number; line_count: number }>;
  const countQuery = db.prepare("SELECT COUNT(*) AS count FROM accounting_journal_entries entry WHERE entry.status='posted'" +
    (from ? ' AND entry.entry_date >= ?' : '') + (to ? ' AND entry.entry_date <= ?' : ''));
  const countParams: unknown[] = [];
  if (from) countParams.push(from);
  if (to) countParams.push(to);
  const journalCount = Number((countQuery.get(...countParams) as { count: number }).count);

  const totals = resultAccounts.reduce((acc, account) => ({
    opening_debit_minor: acc.opening_debit_minor + Math.max(0, account.opening_balance_minor),
    opening_credit_minor: acc.opening_credit_minor + Math.max(0, -account.opening_balance_minor),
    period_debit_minor: acc.period_debit_minor + account.period_debit_minor,
    period_credit_minor: acc.period_credit_minor + account.period_credit_minor,
    closing_debit_minor: acc.closing_debit_minor + account.closing_debit_minor,
    closing_credit_minor: acc.closing_credit_minor + account.closing_credit_minor,
  }), { opening_debit_minor: 0, opening_credit_minor: 0, period_debit_minor: 0, period_credit_minor: 0, closing_debit_minor: 0, closing_credit_minor: 0 });
  for (const key of Object.keys(totals) as Array<keyof typeof totals>) safeTotal(totals[key], 'trial balance totals');

  return {
    from, to, currency_code: currency.currencyCode, fraction_digits: currency.fractionDigits,
    accounts: resultAccounts, totals,
    integrity: {
      balanced: integrityRows.length === 0,
      posted_journal_count: journalCount,
      unbalanced_journal_count: integrityRows.length,
      unbalanced_journals: integrityRows.map((row) => ({
        ...row,
        debit_minor: safeTotal(row.debit_minor, 'journal debit'),
        credit_minor: safeTotal(row.credit_minor, 'journal credit'),
      })),
    },
    read_only: true,
  };
}
