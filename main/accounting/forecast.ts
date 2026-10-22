import type Database from 'better-sqlite3';
import { getAccountingMinorUnitFactor, resolveTenantCurrency } from '../countries';
import { AccountingExpenseError, assertAccountingDate } from './expenses';
import { accountingDate } from './sales';

type DB = Database.Database;
type ForecastFilters = { from?: unknown; to?: unknown; horizon_days?: unknown };

function fail(code: string, message: string, statusCode = 400): never {
  throw new AccountingExpenseError(code, message, statusCode);
}
function total(value: unknown, label: string): number {
  const result = Number(value ?? 0);
  if (!Number.isSafeInteger(result)) fail('accounting_forecast_precision_overflow', 'The ' + label + ' exceeds safe integer precision.', 409);
  return result;
}
function currency(db: DB): { currencyCode: string; fractionDigits: number } {
  const rows = db.prepare("SELECT key,value FROM settings WHERE key IN ('country','currency')").all() as Array<{key:string;value:string|null}>;
  const settings = Object.fromEntries(rows.map(row => [row.key, row.value ?? undefined]));
  try {
    const code = resolveTenantCurrency(settings.currency, settings.country ?? '');
    const factor = getAccountingMinorUnitFactor(code);
    if (!Number.isSafeInteger(factor) || factor < 1) fail('accounting_currency_invalid', 'Configured currency has an invalid ledger unit.');
    return { currencyCode: code, fractionDigits: Math.round(Math.log10(factor)) };
  } catch (error) {
    if (error instanceof AccountingExpenseError) throw error;
    fail('accounting_region_unconfigured', 'Configure a valid store country and currency before viewing forecasts.', 409);
  }
}
function dateAdd(date: string, days: number): string {
  const d = new Date(date + 'T12:00:00.000Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function dateRange(db: DB, filters: ForecastFilters): { from: string; to: string; days: number } {
  const today = accountingDate(db, new Date().toISOString());
  const from = filters.from == null || filters.from === '' ? today : assertAccountingDate(filters.from, 'from');
  let to: string;
  if (filters.to != null && filters.to !== '') to = assertAccountingDate(filters.to, 'to');
  else {
    const days = filters.horizon_days === undefined ? 90 : Number(filters.horizon_days);
    if (!Number.isSafeInteger(days) || days < 1 || days > 366) fail('invalid_horizon_days', 'Forecast horizon must be an integer from 1 to 366 days.');
    to = dateAdd(from, days - 1);
  }
  if (from > to) fail('invalid_date_range', 'Forecast start date must not be after the end date.');
  const days = Math.round((new Date(to + 'T12:00:00.000Z').getTime() - new Date(from + 'T12:00:00.000Z').getTime()) / 86400000) + 1;
  if (days > 366) fail('forecast_range_too_large', 'Forecast range cannot exceed 366 days.');
  return { from, to, days };
}
function liquidBalance(db: DB, asOf: string): number {
  const row = db.prepare(
    "SELECT COALESCE(SUM(CASE WHEN a.normal_balance='debit' THEN l.debit_minor-l.credit_minor ELSE l.credit_minor-l.debit_minor END),0) AS balance " +
    "FROM accounting_journal_lines l JOIN accounting_journal_entries e ON e.id=l.journal_entry_id " +
    "JOIN accounting_accounts a ON a.id=l.account_id WHERE e.status='posted' AND e.entry_date<=? " +
    "AND a.system_key IN ('cash_drawer','bank_accounts','payment_clearing')",
  ).get(asOf) as {balance:number};
  return total(row.balance, 'starting liquid balance');
}

/** Read-only cash-flow and obligation forecast. No journals or statuses are changed. */
export function getAccountingForecast(db: DB, filters: ForecastFilters = {}): any {
  const range = dateRange(db, filters);
  const { currencyCode, fractionDigits } = currency(db);
  const startingLiquidBalance = liquidBalance(db, range.from);
  const events: any[] = [];
  const futureRows = db.prepare(
    "SELECT f.id, f.direction, f.record_type, f.due_date, f.amount_minor, f.currency_code, f.description, f.counterparty, f.status, " +
    "f.classification_account_id, a.name AS classification_account_name " +
    "FROM accounting_future_items f LEFT JOIN accounting_accounts a ON a.id=f.classification_account_id " +
    "WHERE f.due_date>=? AND f.due_date<=? AND f.status IN ('scheduled','awaiting_confirmation','registered','failed') " +
    "ORDER BY f.due_date, f.created_at, f.id",
  ).all(range.from, range.to) as any[];
  for (const row of futureRows) {
    if (row.currency_code !== currencyCode) fail('forecast_currency_mismatch', 'A future item uses a currency different from the configured store currency.', 409);
    const amount = total(row.amount_minor, 'future item amount');
    events.push({
      id: row.id, date: row.due_date, kind: row.direction === 'incoming' ? 'future_receipt' : 'future_payment',
      description: row.description, counterparty: row.counterparty, status: row.status, source: 'future_item',
      direction: row.direction, amount_minor: amount, cash_in_minor: row.direction === 'incoming' ? amount : 0,
      cash_out_minor: row.direction === 'outgoing' ? amount : 0,
      projected_income_minor: row.direction === 'incoming' ? amount : 0,
      projected_expense_minor: row.direction === 'outgoing' && row.status !== 'registered' ? amount : 0,
      recognized_unpaid_minor: row.status === 'registered' ? amount : 0,
      classification_account_name: row.classification_account_name,
    });
  }
  const loanRows = db.prepare(
    "SELECT i.id, i.loan_id, i.due_date, i.principal_minor, i.interest_minor, i.fees_minor, i.currency_code, i.status, " +
    "l.lender, l.currency_code AS loan_currency_code " +
    "FROM accounting_loan_installments i JOIN accounting_loans l ON l.id=i.loan_id " +
    "WHERE i.due_date>=? AND i.due_date<=? AND i.status IN ('scheduled','awaiting_confirmation','registered','failed') " +
    "ORDER BY i.due_date, i.created_at, i.id",
  ).all(range.from, range.to) as any[];
  for (const row of loanRows) {
    if (row.currency_code !== currencyCode || row.loan_currency_code !== currencyCode) fail('forecast_currency_mismatch', 'A loan installment uses a currency different from the configured store currency.', 409);
    const principal = total(row.principal_minor, 'loan principal installment');
    const interest = total(row.interest_minor, 'loan interest installment');
    const fees = total(row.fees_minor, 'loan fee installment');
    const outflow = total(principal + interest + fees, 'loan installment total');
    events.push({
      id: row.id, date: row.due_date, kind: 'loan_installment', description: 'Loan installment — ' + row.lender,
      counterparty: row.lender, status: row.status, source: 'loan', direction: 'outgoing',
      amount_minor: outflow, principal_minor: principal, interest_minor: interest, fees_minor: fees,
      cash_in_minor: 0, cash_out_minor: outflow, projected_income_minor: 0,
      projected_expense_minor: row.status === 'registered' ? 0 : total(interest + fees, 'projected loan costs'),
      recognized_unpaid_minor: row.status === 'registered' ? total(interest + fees, 'accrued loan costs') : 0,
      liability_reduction_minor: principal,
    });
  }
  events.sort((a,b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  let runningBalance = startingLiquidBalance;
  const byDate = new Map<string, any>();
  for (const event of events) {
    runningBalance = total(runningBalance + event.cash_in_minor - event.cash_out_minor, 'projected liquid balance');
    event.projected_liquid_balance_minor = runningBalance;
    const day = byDate.get(event.date) ?? {
      date: event.date, expected_inflows_minor: 0, expected_outflows_minor: 0,
      projected_income_minor: 0, projected_expense_minor: 0, recognized_unpaid_minor: 0,
      loan_principal_due_minor: 0, projected_liquid_balance_minor: startingLiquidBalance, event_count: 0,
    };
    day.expected_inflows_minor = total(day.expected_inflows_minor + event.cash_in_minor, 'daily expected inflows');
    day.expected_outflows_minor = total(day.expected_outflows_minor + event.cash_out_minor, 'daily expected outflows');
    day.projected_income_minor = total(day.projected_income_minor + event.projected_income_minor, 'daily projected income');
    day.projected_expense_minor = total(day.projected_expense_minor + event.projected_expense_minor, 'daily projected expense');
    day.recognized_unpaid_minor = total(day.recognized_unpaid_minor + event.recognized_unpaid_minor, 'daily recognized unpaid obligations');
    day.loan_principal_due_minor = total(day.loan_principal_due_minor + (event.principal_minor ?? 0), 'daily loan principal');
    day.projected_liquid_balance_minor = runningBalance;
    day.event_count++;
    byDate.set(event.date, day);
  }
  const summary = events.reduce((acc, event) => {
    acc.expected_inflows_minor = total(acc.expected_inflows_minor + event.cash_in_minor, 'forecast inflows');
    acc.expected_outflows_minor = total(acc.expected_outflows_minor + event.cash_out_minor, 'forecast outflows');
    acc.projected_income_minor = total(acc.projected_income_minor + event.projected_income_minor, 'forecast income');
    acc.projected_expense_minor = total(acc.projected_expense_minor + event.projected_expense_minor, 'forecast expenses');
    acc.recognized_unpaid_minor = total(acc.recognized_unpaid_minor + event.recognized_unpaid_minor, 'recognized unpaid obligations');
    acc.loan_principal_due_minor = total(acc.loan_principal_due_minor + (event.principal_minor ?? 0), 'loan principal due');
    return acc;
  }, {expected_inflows_minor:0, expected_outflows_minor:0, projected_income_minor:0, projected_expense_minor:0, recognized_unpaid_minor:0, loan_principal_due_minor:0});
  return {
    from: range.from, to: range.to, days: range.days, currency_code: currencyCode, accounting_fraction_digits: fractionDigits,
    starting_liquid_balance_minor: startingLiquidBalance,
    projected_ending_liquid_balance_minor: total(startingLiquidBalance + summary.expected_inflows_minor - summary.expected_outflows_minor, 'projected ending liquid balance'),
    summary, daily: Array.from(byDate.values()), events,
    policy: {
      read_only: true,
      actual_ledger_unchanged: true,
      message: 'Forecasts are estimates, not posted income, paid expenses, or confirmed bank movements. Registered-but-unsettled items are shown as recognized unpaid obligations; only actual settlement changes the liquid-account ledger. Loan principal repayments reduce liabilities, not profit; only interest and fees are potential expenses.',
    },
  };
}
