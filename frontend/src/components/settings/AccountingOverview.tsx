'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowDownLeft, ArrowUpRight, Banknote, CalendarClock, CircleAlert,
  Landmark, RefreshCw, Wallet, ArrowLeftRight, FileBarChart2, BarChart3,
} from 'lucide-react';
import { useLocale } from 'use-intl';
import { useAuthStore } from '@/store/auth';
import api from '@/lib/api';
import { formatMoney, getCurrencyUnitAdapter } from '@/lib/countries';

type ReportLine = {
  journal_entry_id: string; entry_number: string; entry_date: string; description: string;
  account_code: string; account_name: string; line_description: string | null;
  debit_minor: number; credit_minor: number; source_type: string | null;
};
type LiquidAccount = {
  id: string; account_code: string; name: string; balance_minor: number; system_key?: string | null;
};
type Report = {
  from: string | null; to: string | null; currency_code: string; accounting_fraction_digits: number;
  summary: {
    sales_revenue_less_refunds_minor: number; other_income_minor: number; posted_expenses_minor: number;
    result_before_cogs_minor: number;
  };
  profit_limitations: { cogs_available: boolean; net_profit_available: boolean; message: string };
  liquid_accounts: LiquidAccount[];
  daily_trend: { granularity: 'day' | 'month'; points: Array<{ period: string; income_minor: number; expense_minor: number }> };
  movements: { lines: ReportLine[]; truncated: boolean };
};
type ForecastEvent = {
  id: string; date: string; kind: string; description: string; counterparty: string | null;
  status: string; amount_minor: number; direction: 'incoming' | 'outgoing';
};
type Forecast = { currency_code: string; events: ForecastEvent[] };
type LoanAttentionSource = { id: string; lender: string; status: string; installments: Array<{ id: string; due_date: string; principal_minor: number; interest_minor: number; fees_minor: number; status: string }> };
type FutureAttentionSource = { id: string; record_type: 'receipt' | 'cheque'; direction: 'incoming' | 'outgoing'; due_date: string; amount_minor: number; description: string; counterparty: string | null; status: string };
type AttentionItem = { id: string; title: string; dueDate: string; amount: number; view: string; status: string };

const localDate = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const today = () => localDate(new Date());
const monthStart = () => today().slice(0, 8) + '01';
const afterDays = (days: number) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return localDate(date);
};

export function AccountingOverview({ onOpen }: { onOpen: (view: string) => void }) {
  const locale = useLocale();
  const tenant = useAuthStore((state) => state.currentTenant);
  const fa = locale.toLowerCase().startsWith('fa');
  const [report, setReport] = useState<Report | null>(null);
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [loanSources, setLoanSources] = useState<LoanAttentionSource[]>([]);
  const [futureSources, setFutureSources] = useState<FutureAttentionSource[]>([]);
  const [trendMode, setTrendMode] = useState<'day' | 'week' | 'month'>('week');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [period, setPeriod] = useState<'month' | 'today' | 'previous' | 'custom'>('month');
  const [customFrom, setCustomFrom] = useState(monthStart());
  const [customTo, setCustomTo] = useState(today());
  const [customRangeOpen, setCustomRangeOpen] = useState(false);

  const range = useMemo(() => {
    if (period === 'custom') return { from: customFrom, to: customTo };
    if (period === 'today') return { from: today(), to: today() };
    if (period === 'previous') {
      const now = new Date();
      const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const last = new Date(now.getFullYear(), now.getMonth(), 0);
      return { from: localDate(first), to: localDate(last) };
    }
    return { from: monthStart(), to: today() };
  }, [period, customFrom, customTo]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const [reportResult, forecastResult, loansResult, futureResult] = await Promise.allSettled([
        api.get('/accounting/reports', { params: { from: range.from, to: range.to, limit: 8 } }),
        api.get('/accounting/forecast', { params: { from: today(), to: afterDays(30) } }),
        api.get('/accounting/loans'),
        api.get('/accounting/future-items', { params: { limit: 500 } }),
      ]);
      if (reportResult.status !== 'fulfilled') throw reportResult.reason;
      setReport(reportResult.value.data as Report);
      setForecast(forecastResult.status === 'fulfilled' ? forecastResult.value.data as Forecast : null);
      setLoanSources(loansResult.status === 'fulfilled' ? (loansResult.value.data.loans || []) as LoanAttentionSource[] : []);
      setFutureSources(futureResult.status === 'fulfilled' ? (futureResult.value.data.items || []) as FutureAttentionSource[] : []);
    } catch {
      setError(true);
      setReport(null);
      setForecast(null);
    } finally {
      setLoading(false);
    }
  }, [range.from, range.to]);

  useEffect(() => { void load(); }, [load]);

  const currency = report?.currency_code || forecast?.currency_code || tenant?.currency || 'IRR';
  const unitFactor = 10 ** (report?.accounting_fraction_digits ?? 0);
  const money = useCallback((minor: number) => formatMoney(
    minor / unitFactor, currency, locale,
    { currencyDisplay: tenant?.currency_display, digits: tenant?.number_digits, calendar: tenant?.calendar },
  ), [currency, locale, tenant?.currency_display, tenant?.number_digits, tenant?.calendar, unitFactor]);
  const dateText = useCallback((value: string) => {
    try { return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(value + 'T12:00:00')); }
    catch { return value; }
  }, [locale]);

  const currentBalance = (report?.liquid_accounts || []).reduce((sum, account) => sum + account.balance_minor, 0);
  const receivedIncome = (report?.summary.sales_revenue_less_refunds_minor || 0) + (report?.summary.other_income_minor || 0);
  const paidExpenses = report?.summary.posted_expenses_minor || 0;
  const resultBeforeCogs = report?.summary.result_before_cogs_minor || 0;
  const recentLines = [...(report?.movements.lines || [])]
    .sort((a, b) => b.entry_date.localeCompare(a.entry_date) || b.entry_number.localeCompare(a.entry_number))
    .slice(0, 6);
  const upcoming = (forecast?.events || [])
    .filter((event) => event.date > today() && !['settled', 'cancelled'].includes(event.status))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 5);
  const attentionItems: AttentionItem[] = [
    ...loanSources.flatMap((loan) => loan.installments
      .filter((item) => item.due_date <= today() && !['settled', 'cancelled'].includes(item.status))
      .map((item) => ({ id: 'loan:' + item.id, title: (fa ? 'قسط وام · ' : 'Loan instalment · ') + loan.lender,
        dueDate: item.due_date, amount: item.principal_minor + item.interest_minor + item.fees_minor, view: 'loans', status: item.status }))),
    ...futureSources
      .filter((item) => item.due_date <= today() && !['settled', 'cancelled'].includes(item.status))
      .map((item) => ({ id: 'future:' + item.id, title: item.description || (item.record_type === 'cheque' ? (fa ? 'چک' : 'Cheque') : (fa ? 'دریافت آتی' : 'Future receipt')),
        dueDate: item.due_date, amount: item.amount_minor, view: 'futureItems', status: item.status })),
  ].sort((a, b) => a.dueDate.localeCompare(b.dueDate)).slice(0, 5);

  const unitAdapter = useMemo(() => getCurrencyUnitAdapter(currency, tenant?.country, {
    currencyDisplay: tenant?.currency_display, digits: tenant?.number_digits, calendar: tenant?.calendar,
  }), [currency, tenant?.country, tenant?.currency_display, tenant?.number_digits, tenant?.calendar]);
  const rawTrend = report?.daily_trend?.points || [];
  const groupedTrend = useMemo(() => {
    if (report?.daily_trend?.granularity === 'month') {
      return rawTrend.map((point) => ({ ...point, label: (() => { try { return new Intl.DateTimeFormat(locale, { month: 'short', year: '2-digit' }).format(new Date(point.period + '-01T12:00:00')); } catch { return point.period; } })() }));
    }
    const map = new Map<string, { period: string; label: string; income_minor: number; expense_minor: number }>();
    for (const point of rawTrend) {
      let key = point.period;
      if (trendMode === 'month') key = point.period.slice(0, 7);
      else if (trendMode === 'week') {
        const date = new Date(point.period + 'T00:00:00Z');
        const day = (date.getUTCDay() + 6) % 7;
        date.setUTCDate(date.getUTCDate() - day);
        key = date.toISOString().slice(0, 10);
      }
      const old = map.get(key) || { period: key, label: key, income_minor: 0, expense_minor: 0 };
      old.income_minor += point.income_minor; old.expense_minor += point.expense_minor;
      map.set(key, old);
    }
    return [...map.values()].sort((a, b) => a.period.localeCompare(b.period)).slice(-12).map((point) => ({
      ...point,
      label: (() => {
        try {
          const date = new Date((trendMode === 'month' ? point.period + '-01' : point.period) + 'T12:00:00');
          return new Intl.DateTimeFormat(locale, trendMode === 'month' ? { month: 'short', year: '2-digit' } : { day: 'numeric', month: 'short' }).format(date);
        } catch { return point.period; }
      })(),
    }));
  }, [rawTrend, report?.daily_trend?.granularity, trendMode, locale]);
  const attentionStatusText = (status: string) => {
    const faStatus: Record<string, string> = { scheduled: 'در انتظار سررسید', awaiting_confirmation: 'در انتظار تأیید', registered: 'سررسیدشده؛ پرداخت نشده', failed: 'نیازمند بررسی' };
    const enStatus: Record<string, string> = { scheduled: 'Scheduled', awaiting_confirmation: 'Awaiting confirmation', registered: 'Due; unpaid', failed: 'Needs review' };
    return (fa ? faStatus : enStatus)[status] || status;
  };
  const trendMax = Math.max(0, ...groupedTrend.map((point) => Math.max(point.income_minor, point.expense_minor)));
  const trendGrid = [1, 0.75, 0.5, 0.25, 0];
  const compactTrend = (minor: number) => new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 })
    .format(unitAdapter.toDisplay(minor / unitFactor));

  const text = fa ? {
    title: 'نمای کلی حسابداری',
    subtitle: 'وضعیت مالی فروشگاه را در یک نگاه بررسی کنید.',
    attention: 'موارد نیازمند رسیدگی', noAttention: 'در حال حاضر موردی برای رسیدگی وجود ندارد.', view: 'مشاهده',
    trend: 'روند درآمد و هزینه', trendNote: 'مبالغ ثبت‌شده در دفتر کل؛ بهای تمام‌شده کالا در این نمودار لحاظ نشده است.', day: 'روزانه', week: 'هفتگی', monthMode: 'ماهانه', noTrend: 'در این بازه داده‌ای برای ترسیم روند وجود ندارد.',
    incoming: 'درآمد', outgoing: 'هزینه',
    today: 'امروز', month: 'این ماه', previous: 'ماه گذشته', custom: 'بازه دلخواه', apply: 'اعمال بازه',
    balance: 'موجودی حساب‌های نقدی و بانکی', income: 'درآمد واقعی ثبت‌شده',
    expenses: 'هزینه‌های پرداخت‌شده', result: 'نتیجه پیش از بهای تمام‌شده',
    warning: 'این مبلغ سود خالص نیست؛ بهای تمام‌شده کالا در این گزارش محاسبه نمی‌شود.',
    accounts: 'حساب‌های نقدی و بانکی', allAccounts: 'مشاهده همه حساب‌ها', noAccounts: 'حساب نقدی یا بانکی برای نمایش وجود ندارد.',
    recent: 'آخرین گردش‌های دفتر کل', allReports: 'مشاهده گزارش‌ها', noMovements: 'در این بازه گردش ثبت‌شده‌ای وجود ندارد.',
    upcoming: 'سررسیدهای پیش‌رو', allForecast: 'مشاهده پیش‌بینی مالی', noUpcoming: 'در ۳۰ روز آینده تعهدی برای نمایش وجود ندارد.',
    date: 'تاریخ', description: 'شرح', account: 'حساب', debit: 'بدهکار', credit: 'بستانکار',
    due: 'سررسید', amount: 'مبلغ', incomeKind: 'دریافت', expenseKind: 'پرداخت', loading: 'در حال بارگذاری اطلاعات حسابداری…',
    error: 'اطلاعات نمای کلی بارگذاری نشد. اتصال داخلی برنامه و تنظیمات حسابداری را بررسی کنید.',
    retry: 'تلاش دوباره', registerExpense: 'ثبت هزینه', manageAccounts: 'مدیریت حساب‌ها',
    viewOperations: 'عملیات حسابداری', viewLoans: 'وام‌ها و اقساط',
  } : {
    title: 'Accounting overview', subtitle: 'Review the store’s financial position at a glance.',
    attention: 'Items needing attention', noAttention: 'There are no items that need attention right now.', view: 'View',
    trend: 'Income and expense trend', trendNote: 'Posted ledger amounts; cost of goods sold is not included.', day: 'Daily', week: 'Weekly', monthMode: 'Monthly', noTrend: 'There is no trend data for this period.',
    incoming: 'Income', outgoing: 'Expense',
    today: 'Today', month: 'This month', previous: 'Last month', custom: 'Custom range', apply: 'Apply range',
    balance: 'Cash and bank balances', income: 'Actual recorded income', expenses: 'Paid expenses',
    result: 'Result before cost of goods sold',
    warning: 'This is not net profit; inventory cost of goods sold is not calculated in this report.',
    accounts: 'Cash and bank accounts', allAccounts: 'View all accounts', noAccounts: 'There are no cash or bank accounts to show.',
    recent: 'Recent ledger movements', allReports: 'View reports', noMovements: 'No posted movements in this period.',
    upcoming: 'Upcoming due items', allForecast: 'View financial forecast', noUpcoming: 'No obligations to show in the next 30 days.',
    date: 'Date', description: 'Description', account: 'Account', debit: 'Debit', credit: 'Credit',
    due: 'Due date', amount: 'Amount', incomeKind: 'Incoming', expenseKind: 'Outgoing',
    loading: 'Loading accounting overview…', error: 'The overview could not be loaded. Check the local app service and accounting setup.',
    retry: 'Try again', registerExpense: 'Record expense', manageAccounts: 'Manage accounts',
    viewOperations: 'Accounting operations', viewLoans: 'Loans & instalments',
  };

  return (
    <section className="acct-overview space-y-5" dir={fa ? 'rtl' : 'ltr'}>
      <header className="acct-page-heading">
        <div>
          <p className="acct-eyebrow">{fa ? 'LyraPOS / امور مالی' : 'LyraPOS / Finance'}</p>
          <h1 className="acct-page-title">{text.title}</h1>
          <p className="acct-page-subtitle">{text.subtitle}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="acct-button acct-button-secondary" onClick={() => onOpen('accounts')}>
            <Wallet size={16} /> {text.manageAccounts}
          </button>
          <button type="button" className="acct-button acct-button-primary" onClick={() => onOpen('operations')}>
            <Banknote size={16} /> {text.registerExpense}
          </button>
        </div>
      </header>

      <div className="acct-period-bar" aria-label={fa ? 'بازه گزارش' : 'Report period'}>
        {(['today', 'month', 'previous', 'custom'] as const).map((key) => {
          const active = key === 'custom' ? (customRangeOpen || period === 'custom') : !customRangeOpen && period === key;
          const label = key === 'today' ? text.today : key === 'month' ? text.month : key === 'previous' ? text.previous : text.custom;
          return <button key={key} type="button" className={active ? 'acct-period-button is-active' : 'acct-period-button'}
            onClick={() => {
              if (key === 'custom') setCustomRangeOpen((value) => !value);
              else { setCustomRangeOpen(false); setPeriod(key); }
            }}>{label}</button>;
        })}
        {customRangeOpen && <form className="acct-custom-range" onSubmit={(event) => {
          event.preventDefault();
          if (!customFrom || !customTo || customFrom > customTo) return;
          setPeriod('custom');
          setCustomRangeOpen(false);
        }}>
          <label><span>{fa ? 'از تاریخ' : 'From'}</span><input type="date" value={customFrom} max={customTo} onChange={(event) => setCustomFrom(event.target.value)} required /></label>
          <label><span>{fa ? 'تا تاریخ' : 'To'}</span><input type="date" value={customTo} min={customFrom} onChange={(event) => setCustomTo(event.target.value)} required /></label>
          <button className="acct-button acct-button-primary" type="submit">{text.apply}</button>
        </form>}
        <button type="button" className="acct-icon-button" aria-label={fa ? 'به‌روزرسانی اطلاعات' : 'Refresh'} title={fa ? 'به‌روزرسانی اطلاعات' : 'Refresh'} onClick={() => void load()} disabled={loading}>
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {error && <div className="acct-alert acct-alert-danger" role="alert"><CircleAlert size={18} /><span>{text.error}</span><button className="acct-text-button" onClick={() => void load()} type="button">{text.retry}</button></div>}
      {loading && !report && <div className="acct-panel p-6 text-sm text-slate-500">{text.loading}</div>}

      {report && <>
        <section className="acct-panel acct-attention-panel">
          <div className="acct-panel-heading"><div className="acct-attention-title"><CircleAlert size={18} /><h2>{text.attention}</h2></div></div>
          {attentionItems.length === 0 ? <p className="acct-empty">{text.noAttention}</p> : <div className="acct-attention-list">
            {attentionItems.map((item) => <div className="acct-attention-row" key={item.id}>
              <span className="acct-attention-marker"><CircleAlert size={17} /></span>
              <div className="acct-attention-main"><strong>{item.title}</strong><span>{dateText(item.dueDate)} · {attentionStatusText(item.status)}</span></div>
              <strong className="acct-attention-amount">{money(item.amount)}</strong>
              <button type="button" className="acct-button acct-button-secondary" onClick={() => onOpen(item.view)}>{text.view}</button>
            </div>)}
          </div>}
        </section>
        <div className="acct-kpi-grid">
          <article className="acct-kpi-card">
            <div className="acct-kpi-heading"><span>{text.balance}</span><span className="acct-kpi-icon"><Wallet size={19} /></span></div>
            <p className="acct-kpi-value">{money(currentBalance)}</p>
            <p className="acct-kpi-foot">{fa ? 'مانده ثبت‌شده صندوق، بانک و حساب‌های واسط' : 'Posted cash, bank, and clearing balances'}</p>
          </article>
          <article className="acct-kpi-card">
            <div className="acct-kpi-heading"><span>{text.income}</span><span className="acct-kpi-icon is-positive"><ArrowDownLeft size={19} /></span></div>
            <p className="acct-kpi-value">{money(receivedIncome)}</p>
            <p className="acct-kpi-foot">{fa ? 'فروش پس از برگشت وجه + سایر درآمدها' : 'Sales after refunds plus other income'}</p>
          </article>
          <article className="acct-kpi-card">
            <div className="acct-kpi-heading"><span>{text.expenses}</span><span className="acct-kpi-icon is-negative"><ArrowUpRight size={19} /></span></div>
            <p className="acct-kpi-value">{money(paidExpenses)}</p>
            <p className="acct-kpi-foot">{fa ? 'فقط هزینه‌های ثبت‌شده و پرداخت‌شده' : 'Only posted and paid expenses'}</p>
          </article>
          <article className="acct-kpi-card">
            <div className="acct-kpi-heading"><span>{text.result}</span><span className="acct-kpi-icon"><FileBarChart2 size={19} /></span></div>
            <p className="acct-kpi-value">{money(resultBeforeCogs)}</p>
            <p className="acct-kpi-foot">{text.warning}</p>
          </article>
        </div>

        {!report.profit_limitations.net_profit_available && <div className="acct-alert acct-alert-warning">
          <CircleAlert size={18} /><span>{report.profit_limitations.message || text.warning}</span>
        </div>}

        <section className="acct-panel acct-trend-panel">
          <div className="acct-panel-heading acct-trend-heading">
            <div><h2>{text.trend}</h2><p>{text.trendNote}</p></div>
            <div className="acct-trend-controls" role="group" aria-label={text.trend}>
              {(['day', 'week', 'month'] as const).map((mode) => {
                const active = report.daily_trend?.granularity === 'month' ? mode === 'month' : trendMode === mode;
                return <button key={mode} type="button" disabled={report.daily_trend?.granularity === 'month' && mode !== 'month'}
                  className={active ? 'acct-period-button is-active' : 'acct-period-button'} onClick={() => setTrendMode(mode)}>
                  {mode === 'day' ? text.day : mode === 'week' ? text.week : text.monthMode}
                </button>;
              })}
            </div>
          </div>
          {groupedTrend.length === 0 ? <p className="acct-empty">{text.noTrend}</p> : <div className="acct-chart-wrap">
            <div className="acct-chart-legend"><span><i className="is-income" />{text.incoming}</span><span><i className="is-expense" />{text.outgoing}</span><span className="acct-chart-unit">{unitAdapter.label}</span></div>
            <svg className="acct-trend-chart" viewBox="0 0 840 250" role="img" aria-label={text.trend} preserveAspectRatio="xMidYMid meet">
              {trendGrid.map((factor) => {
                const y = 20 + (1 - factor) * 170;
                return <g key={factor}><line className="acct-chart-gridline" x1="78" x2="820" y1={y} y2={y} />
                  <text className="acct-chart-tick" x="68" y={y + 4} textAnchor="end">{compactTrend(trendMax * factor)}</text></g>;
              })}
              {groupedTrend.map((point, index) => {
                const plotWidth = 720 / groupedTrend.length;
                const center = 92 + plotWidth * (index + 0.5);
                const width = Math.min(23, plotWidth * 0.28);
                const incomeHeight = trendMax > 0 ? point.income_minor / trendMax * 170 : 0;
                const expenseHeight = trendMax > 0 ? point.expense_minor / trendMax * 170 : 0;
                return <g key={point.period}>
                  <rect className="acct-chart-income" x={center - width - 2} y={190 - incomeHeight} width={width} height={incomeHeight} rx="3">
                    <title>{point.label} · {text.incoming}: {money(point.income_minor)}</title>
                  </rect>
                  <rect className="acct-chart-expense" x={center + 2} y={190 - expenseHeight} width={width} height={expenseHeight} rx="3">
                    <title>{point.label} · {text.outgoing}: {money(point.expense_minor)}</title>
                  </rect>
                  <text className="acct-chart-label" x={center} y="218" textAnchor="middle">{point.label}</text>
                </g>;
              })}
              <line className="acct-chart-axis" x1="78" x2="820" y1="190" y2="190" />
            </svg>
          </div>}
        </section>

        <div className="acct-overview-columns">
          <section className="acct-panel">
            <div className="acct-panel-heading">
              <div><h2>{text.accounts}</h2><p>{fa ? 'مانده حساب‌های نقدی و بانکی متصل به دفتر کل' : 'Cash and bank accounts linked to the ledger'}</p></div>
              <button type="button" className="acct-link-button" onClick={() => onOpen('accounts')}>{text.allAccounts}</button>
            </div>
            {report.liquid_accounts.length === 0 ? <p className="acct-empty">{text.noAccounts}</p> :
              <div className="acct-account-list">
                {report.liquid_accounts.slice(0, 6).map((account) => <article className="acct-account-row" key={account.id}>
                  <div className="acct-account-icon">{account.system_key === 'bank_accounts' || String(account.system_key || '').startsWith('custom_liquid:bank:') ? <Landmark size={18} /> : <Wallet size={18} />}</div>
                  <div className="acct-account-meta"><strong>{account.name}</strong><span>{fa ? 'کد حساب' : 'Account code'}: {account.account_code}</span></div>
                  <strong className="acct-money">{money(account.balance_minor)}</strong>
                </article>)}
              </div>}
          </section>

          <section className="acct-panel">
            <div className="acct-panel-heading">
              <div><h2>{text.upcoming}</h2><p>{fa ? 'تعهدهای ثبت‌شده که هنوز تسویه نشده‌اند' : 'Recorded items not yet settled'}</p></div>
              <button type="button" className="acct-link-button" onClick={() => onOpen('forecast')}>{text.allForecast}</button>
            </div>
            {loading && !forecast ? <p className="acct-empty">{text.loading}</p> : upcoming.length === 0 ? <p className="acct-empty">{text.noUpcoming}</p> :
              <div className="acct-due-list">
                {upcoming.map((event) => <article className="acct-due-row" key={event.kind + ':' + event.id}>
                  <span className="acct-due-icon"><CalendarClock size={17} /></span>
                  <div className="acct-due-main"><strong>{event.description}</strong><span>{dateText(event.date)}{event.counterparty ? ' · ' + event.counterparty : ''}</span></div>
                  <div className="acct-due-amount"><strong>{money(event.amount_minor)}</strong><span>{event.direction === 'incoming' ? text.incomeKind : text.expenseKind}</span></div>
                </article>)}
              </div>}
          </section>
        </div>

        <section className="acct-panel">
          <div className="acct-panel-heading">
            <div><h2>{text.recent}</h2><p>{fa ? 'آخرین ردیف‌های دفتر کل در بازه انتخاب‌شده' : 'Latest general ledger lines in the selected period'}</p></div>
            <button type="button" className="acct-link-button" onClick={() => onOpen('reports')}>{text.allReports}</button>
          </div>
          {recentLines.length === 0 ? <p className="acct-empty">{text.noMovements}</p> : <div className="acct-table-wrap">
            <table className="acct-table">
              <thead><tr><th>{text.date}</th><th>{text.description}</th><th>{text.account}</th><th className="text-end">{text.debit}</th><th className="text-end">{text.credit}</th></tr></thead>
              <tbody>{recentLines.map((line) => <tr key={line.journal_entry_id + ':' + line.entry_number + ':' + line.account_code}>
                <td className="whitespace-nowrap">{dateText(line.entry_date)}</td>
                <td><div className="font-medium">{line.line_description || line.description}</div><span className="acct-subtext">{line.entry_number}</span></td>
                <td><div>{line.account_name}</div><span className="acct-subtext">{line.account_code}</span></td>
                <td className="text-end whitespace-nowrap tabular-nums">{line.debit_minor ? money(line.debit_minor) : '—'}</td>
                <td className="text-end whitespace-nowrap tabular-nums">{line.credit_minor ? money(line.credit_minor) : '—'}</td>
              </tr>)}</tbody>
            </table>
            {report.movements.truncated && <p className="acct-table-note">{fa ? 'نمایش گردش‌ها به سقف تعیین‌شده گزارش محدود شده است.' : 'The movement list is limited by the report’s configured cap.'}</p>}
          </div>}
        </section>

        <div className="acct-shortcuts">
          <button type="button" onClick={() => onOpen('operations')}><ArrowLeftRight size={17} /><span>{text.viewOperations}</span></button>
          <button type="button" onClick={() => onOpen('loans')}><CalendarClock size={17} /><span>{text.viewLoans}</span></button>
        </div>
      </>}
    </section>
  );
}
