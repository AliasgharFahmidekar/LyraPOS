'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocale } from 'use-intl';
import { useAuthStore } from '@/store/auth';
import api from '@/lib/api';
import { formatAccountingMoney } from '@/lib/countries';
import { accountingSystemAccountName, accountingSystemAccountNameByCode, accountingSystemDescription, accountingAuditActionLabel, accountingDiagnosticText, formatAccountingDate } from '@/lib/accounting-i18n';
import { JalaliDateInput } from '@/components/ui/JalaliDateInput';

type ReportLine = {
  journal_entry_id: string;
  entry_number: string;
  entry_date: string;
  description: string;
  currency_code: string;
  source_type: string | null;
  source_event: string | null;
  line_no: number;
  account_id: string;
  account_code: string;
  account_name: string;
  line_description: string | null;
  debit_minor: number;
  credit_minor: number;
};
type LiquidAccount = {
  id: string;
  system_key: string;
  account_code: string;
  name: string;
  balance_minor: number;
  period_debit_minor: number;
  period_credit_minor: number;
  period_net_movement_minor: number;
};
type ManagementReport = {
  from: string | null;
  to: string | null;
  currency_code: string;
  accounting_fraction_digits: number;
  summary: {
    pos_sales_revenue_minor: number;
    monetary_refunds_minor: number;
    sales_revenue_less_refunds_minor: number;
    other_income_minor: number;
    posted_expenses_minor: number;
    loan_interest_fees_paid_minor: number;
    tax_payments_expense_minor: number;
    result_before_cogs_minor: number;
    net_profit_loss_minor: number;
  };
  reporting_policy: {
    sales_revenue_basis: 'actual_monetary_receipts';
    tax_treatment: 'tax_payments_are_expenses_when_paid';
    message: string;
  };
  profit_limitations: {
    cogs_available: boolean;
    net_profit_available: boolean;
    message: string;
  };
  liquid_accounts: LiquidAccount[];
  movements: { entries_count: number; limit: number; page: number; page_size: number; total_pages: number; truncated: boolean; lines: ReportLine[] };
  pre_cutover_exceptions: { count: number; samples: Array<{ id: number; entity_id: string; action: string; created_at: string; details?: { reason?: string; bill_id?: string; method?: string } | null }> };
};

const today = () => {
  const date = new Date();
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
const monthStart = () => today().slice(0, 8) + '01';

export function AccountingReports() {
  const locale = useLocale();
  const tenant = useAuthStore((state) => state.currentTenant);
  const isPersian = locale.toLowerCase().startsWith('fa');
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const [report, setReport] = useState<ManagementReport | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const t = useMemo(() => isPersian ? {
    title: 'گزارش‌های مدیریتی',
    from: 'از تاریخ',
    to: 'تا تاریخ',
    refresh: 'به‌روزرسانی گزارش',
    sales: 'درآمد فروش ثبت‌شده در دفتر کل',
    refunds: 'بازپرداخت‌های واقعی',
    netSales: 'درآمد فروش پس از برگشت',
    otherIncome: 'سایر درآمدهای ثبت‌شده',
    expenses: 'هزینه‌های پرداخت‌شده ثبت‌شده در دفتر کل',
    loanCosts: 'از هزینه‌ها: سود و کارمزد وام پرداخت‌شده',
    loanAccrualNote: 'سود و کارمزد قسط در سررسید به بدهی وام اضافه می‌شود؛ اما در جمع هزینه‌های پرداخت‌شده فقط پس از تأیید پرداخت واقعی محاسبه می‌شود.',
    taxPayments: 'مالیات پرداخت‌شده (هزینه)',
    result: 'سود/زیان خالص طبق هزینه‌های ثبت‌شده',
    notNetProfit: 'بهای تمام‌شده موجودی کالا لحاظ نمی‌شود.',
    cogsWarning: 'فرمول: دریافت واقعی فروش پس از برگشت + سایر درآمدهای ثبت‌شده − هزینه‌های واقعاً پرداخت‌شده و ثبت‌شده. طبق سیاست فعلی، بهای تمام‌شده و ارزش موجودی کالا محاسبه نمی‌شود؛ بنابراین این نتیجه، سود خالص مبتنی بر بهای موجودی یا سود قانونی تعهدی نیست.',
    taxPolicy: 'درآمد فروش بر اساس پول واقعی دریافت‌شده محاسبه می‌شود. مالیات زمانی که واقعاً پرداخت شود، به‌عنوان هزینه ثبت می‌شود و دوباره از درآمد فروش کم نمی‌شود.',
    excluded: 'آورده و برداشت مالک، مانده افتتاحیه و انتقال بین حساب‌ها در درآمد یا هزینه محاسبه نشده‌اند.',
    liquidAccounts: 'مانده حساب‌های نقدی، بانکی و واسط',
    account: 'حساب',
    balance: 'مانده تا تاریخ انتخاب‌شده',
    debitMovement: 'گردش بدهکار در بازه',
    creditMovement: 'گردش بستانکار در بازه',
    movements: 'گردش دفتر کل در بازه انتخاب‌شده',
    date: 'تاریخ کاری',
    entry: 'سند',
    description: 'شرح سند',
    accountName: 'نام حساب',
    debit: 'بدهکار',
    credit: 'بستانکار',
    noMovements: 'در این بازه سند ثبت‌شده‌ای وجود ندارد.',
    previousPage: 'صفحه قبل', nextPage: 'صفحه بعد',
    pageStatus: (start: number, end: number, total: number, current: number, pages: number) =>
      `نمایش ${start} تا ${end} از ${total} سند · صفحه ${current} از ${pages}`,
    exceptions: 'استثناهای دریافت/بازپرداخت پیش از شروع حسابداری',
    exceptionCount: 'تعداد استثناهای ثبت‌شده',
    noExceptions: 'استثنای پیش از شروع حسابداری ثبت نشده است.',
    reason: 'دلیل',
    loading: 'در حال تهیه گزارش…',
    error: 'گزارش بارگذاری نشد. تاریخ‌ها و تنظیمات پولی فروشگاه را بررسی کنید.',
    period: 'بازه گزارش بر اساس تاریخ کاری حسابداری است.',
  } : {
    title: 'Management reports',
    from: 'From date',
    to: 'To date',
    refresh: 'Refresh report',
    sales: 'POS sales revenue posted to ledger',
    refunds: 'Actual monetary refunds',
    netSales: 'Sales revenue after refunds',
    otherIncome: 'Posted other income',
    expenses: 'Paid expenses posted to ledger',
    loanCosts: 'Included in expenses: loan interest and fees paid',
    loanAccrualNote: 'Loan interest and fees are accrued to the loan liability on the due date, but enter paid-expense totals only after actual payment is confirmed.',
    taxPayments: 'Taxes paid (expense)',
    result: 'Net profit/loss under recorded-expense policy',
    notNetProfit: 'Inventory cost is excluded.',
    cogsWarning: 'Formula: actual sales receipts after refunds + posted other income − actually paid/posted expenses. Stock valuation and cost of goods sold are not tracked, so this is not COGS-based or statutory accrual profit.',
    taxPolicy: 'Sales revenue is based on actual money received. Tax is recorded as an expense when it is actually paid and is not deducted from sales revenue a second time.',
    excluded: 'Owner contributions/drawings, opening balances, and inter-account transfers are excluded from income and expense.',
    liquidAccounts: 'Cash, bank and clearing balances',
    account: 'Account',
    balance: 'Balance through selected end date',
    debitMovement: 'Debits in period',
    creditMovement: 'Credits in period',
    movements: 'General ledger movements for selected period',
    date: 'Business date',
    entry: 'Entry',
    description: 'Entry description',
    accountName: 'Account',
    debit: 'Debit',
    credit: 'Credit',
    noMovements: 'No posted entries in this period.',
    previousPage: 'Previous page', nextPage: 'Next page',
    pageStatus: (start: number, end: number, total: number, current: number, pages: number) =>
      `Showing ${start}–${end} of ${total} entries · Page ${current} of ${pages}`,
    exceptions: 'Pre-cutover receipt/refund exceptions',
    exceptionCount: 'Recorded exceptions',
    noExceptions: 'No pre-cutover receipt/refund exceptions are recorded.',
    reason: 'Reason',
    loading: 'Preparing report…',
    error: 'Could not load the report. Check the dates and the store currency configuration.',
    period: 'The report period uses the accounting business date.',
  }, [isPersian]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const response = await api.get('/accounting/reports', {
        params: { ...(from ? { from } : {}), ...(to ? { to } : {}), limit: 50, page },
      });
      setReport(response.data as ManagementReport);
    } catch {
      setReport(null);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [from, to, page]);

  useEffect(() => {
    // Load server state when the selected reporting period changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const money = useCallback((minor: number) => {
    if (!report) return '—';
    return formatAccountingMoney(minor, {
      currency: report.currency_code,
      fractionDigits: report.accounting_fraction_digits,
      locale,
      countryCode: tenant?.country,
      preferences: { currencyDisplay: tenant?.currency_display, digits: tenant?.number_digits, calendar: tenant?.calendar },
    });
  }, [locale, report, tenant?.country, tenant?.currency_display, tenant?.number_digits, tenant?.calendar]);

  const currentPage = report?.movements.page || page;
  const pageSize = report?.movements.page_size || report?.movements.limit || 50;
  const movementCount = report?.movements.entries_count || 0;
  const totalPages = Math.max(1, report?.movements.total_pages || Math.ceil(movementCount / pageSize));
  const firstMovement = movementCount === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const lastMovement = Math.min(currentPage * pageSize, movementCount);

  const cardClass = 'rounded-xl border border-border bg-card p-4 space-y-3';
  const inputClass = 'w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground';

  return <section className="w-full max-w-6xl space-y-5" dir={isPersian ? 'rtl' : 'ltr'}>
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div><h2 className="text-xl font-semibold">{t.title}</h2><p className="mt-1 text-sm text-muted-foreground">{t.period}</p></div>
      <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); void load(); }}>
        <label className="space-y-1 text-sm"><span className="block">{t.from}</span><JalaliDateInput jalali={locale.toLowerCase().startsWith('fa')} className={inputClass} value={from} max={to || undefined} onChange={(nextValue) => { setFrom(nextValue); setPage(1); }} /></label>
        <label className="space-y-1 text-sm"><span className="block">{t.to}</span><JalaliDateInput jalali={locale.toLowerCase().startsWith('fa')} className={inputClass} value={to} min={from || undefined} onChange={(nextValue) => { setTo(nextValue); setPage(1); }} /></label>
        <button disabled={loading} className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{loading ? t.loading : t.refresh}</button>
      </form>
    </div>

    {error && <div role="alert" className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm">{t.error}</div>}
    {loading && !report && <div className={cardClass}><p className="text-sm text-muted-foreground">{t.loading}</p></div>}

    {report && <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {[
          [t.sales, report.summary.pos_sales_revenue_minor],
          [t.refunds, report.summary.monetary_refunds_minor],
          [t.netSales, report.summary.sales_revenue_less_refunds_minor],
          [t.otherIncome, report.summary.other_income_minor],
          [t.expenses, report.summary.posted_expenses_minor],
          [t.loanCosts, report.summary.loan_interest_fees_paid_minor],
          [t.taxPayments, report.summary.tax_payments_expense_minor],
          [t.result, report.summary.net_profit_loss_minor],
        ].map(([label, value]) => <div key={String(label)} className={cardClass}>
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="text-xl font-semibold tabular-nums">{money(Number(value))}</p>
          {label === t.result && <p className="text-xs text-muted-foreground">{t.notNetProfit}</p>}
        </div>)}
      </div>

      <div className="rounded-xl border border-border bg-card p-4 text-sm">
        <p className="font-semibold">{t.notNetProfit}</p>
        <p className="mt-1">{t.cogsWarning}</p>
        <p className="mt-1">{t.taxPolicy}</p>
        <p className="mt-1">{t.loanAccrualNote}</p>
        <p className="mt-1">{t.excluded}</p>
      </div>

      <div className={cardClass}>
        <h3 className="font-semibold">{t.liquidAccounts}</h3>
        {report.liquid_accounts.length === 0 ? <p className="text-sm text-muted-foreground">{t.noMovements}</p> : <div className="overflow-x-auto">
          <table className="w-full text-sm"><thead><tr className="border-b">
            <th className="p-2 text-start">{t.account}</th><th className="p-2 text-end">{t.balance}</th><th className="p-2 text-end">{t.debitMovement}</th><th className="p-2 text-end">{t.creditMovement}</th>
          </tr></thead><tbody>{report.liquid_accounts.map((account) => <tr key={account.id} className="border-b border-border/60">
            <td className="p-2">{account.account_code} · {accountingSystemAccountName(account.system_key, account.name, locale)}</td><td className="p-2 text-end whitespace-nowrap tabular-nums">{money(account.balance_minor)}</td><td className="p-2 text-end whitespace-nowrap tabular-nums">{money(account.period_debit_minor)}</td><td className="p-2 text-end whitespace-nowrap tabular-nums">{money(account.period_credit_minor)}</td>
          </tr>)}</tbody></table>
        </div>}
      </div>

      <div className={cardClass}>
        <h3 className="font-semibold">{t.movements}</h3>
        {report.movements.lines.length === 0 ? <p className="text-sm text-muted-foreground">{t.noMovements}</p> : <div className="overflow-x-auto">
          <table className="w-full text-sm"><thead><tr className="border-b">
            <th className="p-2 text-start">{t.date}</th><th className="p-2 text-start">{t.entry}</th><th className="p-2 text-start">{t.description}</th><th className="p-2 text-start">{t.accountName}</th><th className="p-2 text-end">{t.debit}</th><th className="p-2 text-end">{t.credit}</th>
          </tr></thead><tbody>{report.movements.lines.map((line) => <tr key={line.journal_entry_id + ':' + line.line_no} className="border-b border-border/60">
            <td className="p-2 whitespace-nowrap">{formatAccountingDate(line.entry_date, locale, tenant?.calendar)}</td><td className="p-2 whitespace-nowrap">{line.entry_number}</td><td className="p-2 min-w-40">{accountingSystemDescription(line.line_description || line.description, locale)}</td><td className="p-2">{line.account_code} · {accountingSystemAccountNameByCode(line.account_code, line.account_name, locale)}</td><td className="p-2 text-end whitespace-nowrap tabular-nums">{line.debit_minor ? money(line.debit_minor) : '—'}</td><td className="p-2 text-end whitespace-nowrap tabular-nums">{line.credit_minor ? money(line.credit_minor) : '—'}</td>
          </tr>)}</tbody></table>
        </div>}
        {movementCount > 0 && <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-3">
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {t.pageStatus(firstMovement, lastMovement, movementCount, currentPage, totalPages)}
          </p>
          <div className="flex items-center gap-2">
            <button type="button" className="rounded-lg border border-border px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-40"
              disabled={loading || currentPage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
              {t.previousPage}
            </button>
            <button type="button" className="rounded-lg border border-border px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-40"
              disabled={loading || currentPage >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}>
              {t.nextPage}
            </button>
          </div>
        </div>}
      </div>

      <div className={cardClass}>
        <h3 className="font-semibold">{t.exceptions}</h3>
        <p className="text-sm">{t.exceptionCount}: <strong>{report.pre_cutover_exceptions.count}</strong></p>
        {report.pre_cutover_exceptions.samples.length === 0 ? <p className="text-sm text-muted-foreground">{t.noExceptions}</p> : <div className="overflow-x-auto">
          <table className="w-full text-sm"><thead><tr className="border-b"><th className="p-2 text-start">{t.date}</th><th className="p-2 text-start">{t.entry}</th><th className="p-2 text-start">{t.reason}</th></tr></thead>
            <tbody>{report.pre_cutover_exceptions.samples.map((exception) => <tr key={exception.id} className="border-b border-border/60">
              <td className="p-2 whitespace-nowrap">{formatAccountingDate(exception.created_at, locale, tenant?.calendar)}</td><td className="p-2">{accountingAuditActionLabel(exception.action, locale)} · {exception.entity_id}</td><td className="p-2">{accountingDiagnosticText(exception.details?.reason, locale)}</td>
            </tr>)}</tbody></table>
        </div>}
      </div>
    </>}
  </section>;
}
