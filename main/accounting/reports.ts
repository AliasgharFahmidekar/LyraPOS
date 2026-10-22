import type Database from 'better-sqlite3';
import { getAccountingMinorUnitFactor, resolveTenantCurrency } from '../countries';
import { AccountingExpenseError, assertAccountingDate } from './expenses';

type DB = Database.Database;

type ReportFilters = {
  from?: unknown;
  to?: unknown;
  limit?: unknown;
};

function fail(code: string, message: string, statusCode = 400): never {
  throw new AccountingExpenseError(code, message, statusCode);
}

function safeTotal(value: unknown, label: string): number {
  const amount = Number(value ?? 0);
  if (!Number.isSafeInteger(amount)) {
    fail('accounting_report_precision_overflow', 'The ' + label + ' total exceeds safe integer precision. Narrow the date range before retrying.', 409);
  }
  return amount;
}

function configuredRegion(db: DB): { currencyCode: string; fractionDigits: number } {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key IN ('country', 'currency')").all() as Array<{ key: string; value: string | null }>;
  const settings = Object.fromEntries(rows.map((row) => [row.key, row.value ?? undefined]));
  try {
    const currencyCode = resolveTenantCurrency(settings.currency, settings.country ?? '');
    const factor = getAccountingMinorUnitFactor(currencyCode);
    if (!Number.isSafeInteger(factor) || factor < 1) {
      fail('accounting_currency_invalid', 'The configured accounting currency has an invalid ledger unit.');
    }
    return { currencyCode, fractionDigits: Math.round(Math.log10(factor)) };
  } catch (error) {
    if (error instanceof AccountingExpenseError) throw error;
    fail('accounting_region_unconfigured', 'Configure a valid store country and currency before viewing accounting reports.', 409);
  }
}

function dateRange(filters: ReportFilters): { from: string | null; to: string | null; limit: number } {
  const from = filters.from == null || filters.from === '' ? null : assertAccountingDate(filters.from, 'from');
  const to = filters.to == null || filters.to === '' ? null : assertAccountingDate(filters.to, 'to');
  if (from && to && from > to) fail('invalid_date_range', 'The start date must not be later than the end date.');
  const limit = filters.limit === undefined ? 50 : Number(filters.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    fail('invalid_limit', 'Report movement limit must be an integer from 1 to 100.');
  }
  return { from, to, limit };
}

function periodWhere(alias: string, range: { from: string | null; to: string | null }): { sql: string; values: string[] } {
  const clauses: string[] = [];
  const values: string[] = [];
  if (range.from) { clauses.push(alias + '.entry_date >= ?'); values.push(range.from); }
  if (range.to) { clauses.push(alias + '.entry_date <= ?'); values.push(range.to); }
  return { sql: clauses.length ? ' AND ' + clauses.join(' AND ') : '', values };
}

function sumLedgerLines(
  db: DB,
  expression: string,
  predicate: string,
  range: { from: string | null; to: string | null },
  extraValues: unknown[] = [],
): number {
  const dates = periodWhere('entry', range);
  const row = db.prepare(
    'SELECT COALESCE(SUM(' + expression + '), 0) AS amount_minor ' +
    'FROM accounting_journal_entries entry ' +
    'JOIN accounting_journal_lines line ON line.journal_entry_id = entry.id ' +
    'JOIN accounting_accounts account ON account.id = line.account_id ' +
    "WHERE entry.status = 'posted' AND " + predicate + dates.sql,
  ).get(...extraValues, ...dates.values) as { amount_minor: number | null };
  return safeTotal(row?.amount_minor, 'ledger report');
}

function postedEntryCount(db: DB, range: { from: string | null; to: string | null }): number {
  const dates = periodWhere('entry', range);
  const row = db.prepare("SELECT COUNT(*) AS count FROM accounting_journal_entries entry WHERE entry.status='posted'" + dates.sql)
    .get(...dates.values) as { count: number };
  return Number(row.count);
}

function liquidAccountBalances(db: DB, range: { from: string | null; to: string | null }): any[] {
  const accounts = db.prepare(
    "SELECT id, system_key, account_code, name, account_type, normal_balance FROM accounting_accounts " +
    "WHERE system_key IN ('cash_drawer','bank_accounts','payment_clearing') ORDER BY account_code",
  ).all() as Array<{ id: string; system_key: string; account_code: string; name: string; account_type: string; normal_balance: string }>;

  const balanceQuery = db.prepare(
    'SELECT COALESCE(SUM(CASE WHEN account.normal_balance = \'debit\' THEN line.debit_minor - line.credit_minor ELSE line.credit_minor - line.debit_minor END),0) AS balance_minor ' +
    'FROM accounting_journal_lines line JOIN accounting_journal_entries entry ON entry.id=line.journal_entry_id ' +
    'JOIN accounting_accounts account ON account.id=line.account_id WHERE entry.status=\'posted\' AND line.account_id=?' +
    (range.to ? ' AND entry.entry_date <= ?' : ''),
  );
  const periodQuery = db.prepare(
    'SELECT COALESCE(SUM(line.debit_minor),0) AS debit_minor, COALESCE(SUM(line.credit_minor),0) AS credit_minor ' +
    'FROM accounting_journal_lines line JOIN accounting_journal_entries entry ON entry.id=line.journal_entry_id ' +
    'WHERE entry.status=\'posted\' AND line.account_id=?' +
    (range.from ? ' AND entry.entry_date >= ?' : '') +
    (range.to ? ' AND entry.entry_date <= ?' : ''),
  );

  return accounts.map((account) => {
    const balanceParams = range.to ? [account.id, range.to] : [account.id];
    const periodParams: unknown[] = [account.id];
    if (range.from) periodParams.push(range.from);
    if (range.to) periodParams.push(range.to);
    const balance = balanceQuery.get(...balanceParams) as { balance_minor: number };
    const movement = periodQuery.get(...periodParams) as { debit_minor: number; credit_minor: number };
    return {
      ...account,
      balance_minor: safeTotal(balance.balance_minor, 'liquid account balance'),
      period_debit_minor: safeTotal(movement.debit_minor, 'liquid account debit movement'),
      period_credit_minor: safeTotal(movement.credit_minor, 'liquid account credit movement'),
      period_net_movement_minor: safeTotal(Number(movement.debit_minor) - Number(movement.credit_minor), 'liquid account net movement'),
    };
  });
}

function preCutoverExceptions(db: DB): { count: number; samples: any[] } {
  const predicate = "entity_type='accounting_source_event' AND action IN ('skipped_pre_cutover_payment','skipped_pre_cutover_refund')";
  const count = db.prepare('SELECT COUNT(*) AS count FROM accounting_audit_log WHERE ' + predicate).get() as { count: number };
  const rows = db.prepare(
    'SELECT id, entity_id, action, created_at, after_json FROM accounting_audit_log WHERE ' + predicate + ' ORDER BY id DESC LIMIT 25',
  ).all() as Array<{ id: number; entity_id: string; action: string; created_at: string; after_json: string | null }>;
  return {
    count: Number(count.count),
    samples: rows.map((row) => {
      let details: any = null;
      try { details = row.after_json ? JSON.parse(row.after_json) : null; } catch { details = null; }
      return { id: row.id, entity_id: row.entity_id, action: row.action, created_at: row.created_at, details };
    }),
  };
}

/**
 * Read-only Phase 5 management report.
 *
 * All financial totals are derived from posted journal lines. Sales revenue uses
 * actual monetary receipts; tax payments are recorded as expenses when paid.
 */
export function getAccountingManagementReport(db: DB, filters: ReportFilters = {}): any {
  const range = dateRange(filters);
  const { currencyCode, fractionDigits } = configuredRegion(db);
  const salesRevenueMinor = sumLedgerLines(
    db, 'line.credit_minor - line.debit_minor', "account.system_key='sales_revenue' AND entry.source_type='bill_payment' AND entry.source_event='money_received'", range,
  );
  const refundsMinor = sumLedgerLines(
    db, 'line.debit_minor - line.credit_minor', "account.system_key='sales_returns' AND entry.source_type='refund' AND entry.source_event='money_refunded'", range,
  );
  const otherIncomeMinor = sumLedgerLines(
    db,
    'line.credit_minor - line.debit_minor',
    "account.account_type='revenue' AND (" +
      "(entry.source_type='accounting_manual_activity' AND entry.source_event='other_income') OR " +
      "(entry.source_type='accounting_future_item' AND entry.source_event='settlement' AND EXISTS (" +
        "SELECT 1 FROM accounting_future_items AS future_item WHERE future_item.id=entry.source_id AND future_item.direction='incoming'" +
      "))" +
    ")",
    range,
  );
  const postedExpensesMinor = sumLedgerLines(
    db, 'line.debit_minor - line.credit_minor', "account.account_type='expense' AND COALESCE(account.system_key, '') <> 'cost_of_goods_sold'", range,
  );
  const taxPaymentsExpenseMinor = sumLedgerLines(
    db, 'line.debit_minor - line.credit_minor', "account.system_key='tax_expenses'", range,
  );

  // POS sales revenue is based on actual monetary receipts posted by the POS.
  // Tax paid later is an ordinary, separately posted expense; it is not deducted
  // from the receipt again. Owner equity, opening balances and transfers are excluded.
  const netSalesAfterRefundsMinor = safeTotal(salesRevenueMinor - refundsMinor, 'net sales after refunds');
  const resultBeforeCogsMinor = safeTotal(
    netSalesAfterRefundsMinor + otherIncomeMinor - postedExpensesMinor,
    'result before cost of goods sold',
  );

  const movementCount = postedEntryCount(db, range);
  const dates = periodWhere('selected', range);
  const movements = db.prepare(
    'SELECT entry.id AS journal_entry_id, entry.entry_number, entry.entry_date, entry.description, entry.currency_code, ' +
    'entry.source_type, entry.source_id, entry.source_event, entry.posted_at, line.line_no, line.account_id, ' +
    'account.account_code, account.name AS account_name, line.description AS line_description, line.debit_minor, line.credit_minor ' +
    'FROM accounting_journal_entries entry ' +
    'JOIN accounting_journal_lines line ON line.journal_entry_id=entry.id ' +
    'JOIN accounting_accounts account ON account.id=line.account_id ' +
    'WHERE entry.id IN (SELECT selected.id FROM accounting_journal_entries selected WHERE selected.status=\'posted\'' +
    dates.sql + ' ORDER BY selected.entry_date DESC, selected.entry_number DESC LIMIT ?) ' +
    'ORDER BY entry.entry_date DESC, entry.entry_number DESC, line.line_no ASC',
  ).all(...dates.values, range.limit);

  return {
    from: range.from,
    to: range.to,
    currency_code: currencyCode,
    accounting_fraction_digits: fractionDigits,
    summary: {
      pos_sales_revenue_minor: salesRevenueMinor,
      monetary_refunds_minor: refundsMinor,
      sales_revenue_less_refunds_minor: netSalesAfterRefundsMinor,
      other_income_minor: otherIncomeMinor,
      posted_expenses_minor: postedExpensesMinor,
      tax_payments_expense_minor: taxPaymentsExpenseMinor,
      result_before_cogs_minor: resultBeforeCogsMinor,
    },
    reporting_policy: {
      sales_revenue_basis: 'actual_monetary_receipts',
      tax_treatment: 'tax_payments_are_expenses_when_paid',
      future_item_recognition: 'future_item_income_and_expense_on_actual_settlement; due_registration_uses_clearing_accounts; cash_and_bank_change_only_on_actual_settlement',
      message: 'POS sales and future-item income/expense count only when actual monetary settlement is recorded. A due-but-uncollected incoming item is offset to the future-receipt clearing liability; a due-but-unpaid outgoing item is offset to a pending-payment clearing asset. Neither due-registration journal changes profit/loss or cash. Settlement records the actual cash/bank/clearing movement and recognizes the configured income or expense. Tax is recorded as an expense when paid and is not deducted a second time from sales revenue.',
    },
    profit_limitations: {
      cogs_available: false,
      net_profit_available: false,
      message: 'This management result is before inventory cost/COGS. Inventory value and cost of goods sold are not calculated yet, so this result is not net profit.',
    },
    liquid_accounts: liquidAccountBalances(db, range),
    movements: {
      entries_count: movementCount,
      limit: range.limit,
      truncated: movementCount > range.limit,
      lines: movements,
    },
    pre_cutover_exceptions: preCutoverExceptions(db),
  };
}
