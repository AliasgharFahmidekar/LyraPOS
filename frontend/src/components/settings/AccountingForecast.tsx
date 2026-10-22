'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale } from 'use-intl';
import api from '@/lib/api';

type ForecastEvent = {
  id: string; date: string; kind: string; description: string; counterparty: string | null;
  status: string; source: string; direction: 'incoming' | 'outgoing'; amount_minor: number;
  cash_in_minor: number; cash_out_minor: number; actual_cash_in_minor?: number; actual_cash_out_minor?: number; projected_income_minor: number;
  projected_expense_minor: number; recognized_unpaid_minor: number; principal_minor?: number;
  interest_minor?: number; fees_minor?: number; liability_reduction_minor?: number;
  projected_liquid_balance_minor: number;
};
type Forecast = {
  from: string; to: string; currency_code: string; accounting_fraction_digits: number;
  starting_liquid_balance_minor: number; projected_ending_liquid_balance_minor: number;
  summary: { expected_inflows_minor: number; expected_outflows_minor: number; actual_inflows_minor: number; actual_outflows_minor: number; projected_income_minor: number;
    projected_expense_minor: number; recognized_unpaid_minor: number; loan_principal_due_minor: number };
  events: ForecastEvent[];
  policy: { message: string };
};
const localDate = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const plusDays = (days: number) => { const date = new Date(); date.setDate(date.getDate() + days); return localDate(date); };

export function AccountingForecast() {
  const locale = useLocale();
  const fa = locale.toLowerCase().startsWith('fa');
  const [from, setFrom] = useState(() => localDate(new Date()));
  const [to, setTo] = useState(() => plusDays(89));
  const [data, setData] = useState<Forecast | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const t = fa ? {
    title: 'پیش‌بینی جریان نقدی و تعهدات', from: 'از تاریخ', to: 'تا تاریخ', refresh: 'به‌روزرسانی',
    starting: 'مانده نقد و بانک در ابتدای بازه', ending: 'مانده نقد و بانک پیش‌بینی‌شده در پایان بازه',
    inflows: 'دریافت‌های مورد انتظار', outflows: 'پرداخت‌های مورد انتظار', actualInflows: 'دریافت نقدی واقعی در بازه', actualOutflows: 'پرداخت نقدی واقعی در بازه', income: 'درآمد پیش‌بینی‌شده',
    expenses: 'هزینه‌های پیش‌بینی‌شده', unpaid: 'تعهدات ثبت‌شده اما پرداخت‌نشده', principal: 'اصل وام سررسیدشونده',
    events: 'رویدادهای مالی آینده', date: 'سررسید', description: 'شرح', status: 'وضعیت', amount: 'مبلغ',
    balance: 'مانده نقدی پیش‌بینی‌شده', noEvents: 'در این بازه رویداد مالی ثبت‌شده یا آینده‌ای وجود ندارد.', posted: 'ثبت‌شده در دفتر کل', actualMovement: 'گردش واقعی نقد و بانک',
    note: 'این گزارش فقط پیش‌بینی است و هیچ سند حسابداری ایجاد یا تغییری در دفتر کل اعمال نمی‌کند. سررسید به معنی پرداخت واقعی نیست؛ اصل قسط وام هزینه سود و زیان محسوب نمی‌شود.',
    error: 'پیش‌بینی بارگذاری نشد. بازه تاریخ و تنظیمات پولی فروشگاه را بررسی کنید.',
    scheduled: 'برنامه‌ریزی‌شده', awaiting_confirmation: 'در انتظار تأیید', registered: 'ثبت تعهد / پرداخت‌نشده', failed: 'نیازمند بررسی',
  } : {
    title: 'Cash flow & obligations forecast', from: 'From date', to: 'To date', refresh: 'Refresh',
    starting: 'Starting liquid balance', ending: 'Projected ending liquid balance', inflows: 'Expected inflows',
    outflows: 'Expected outflows', income: 'Projected income', expenses: 'Projected expenses',
    unpaid: 'Registered but unpaid obligations', principal: 'Loan principal due', events: 'Future financial events',
    date: 'Due date', description: 'Description', status: 'Status', amount: 'Amount',
    balance: 'Projected liquid balance', noEvents: 'No posted or future financial events exist in this range.', posted: 'Posted to ledger', actualMovement: 'Actual cash/bank movement',
    note: 'This is a forecast only. It does not create or change ledger entries. A due date is not proof of payment; loan principal is not a profit-and-loss expense.',
    error: 'Forecast could not be loaded. Check the date range and store currency settings.',
    scheduled: 'Scheduled', awaiting_confirmation: 'Awaiting confirmation', registered: 'Registered / unpaid', failed: 'Needs review',
  };
  const load = useCallback(async () => {
    setLoading(true); setError(false);
    try {
      const response = await api.get('/accounting/forecast', { params: { from, to } });
      setData(response.data as Forecast);
    } catch { setData(null); setError(true); }
    finally { setLoading(false); }
  }, [from, to]);
  useEffect(() => {
    // Load forecast for the selected horizon.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  const money = useCallback((minor: number) => {
    if (!data) return '—';
    const digits = data.accounting_fraction_digits;
    return new Intl.NumberFormat(locale, { style: 'currency', currency: data.currency_code, minimumFractionDigits: digits, maximumFractionDigits: digits })
      .format(minor / (10 ** digits));
  }, [data, locale]);
  const card = 'rounded-xl border border-border bg-card p-4 space-y-2';
  const input = 'w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground';
  const labelForStatus = (status: string) => status === 'posted' ? t.posted : ((t as any)[status] ?? status);
  const kindLabel = (event: ForecastEvent) => {
    if (event.kind === 'loan_installment') return fa ? 'قسط وام' : 'Loan installment';
    if (event.source === 'ledger') return t.actualMovement;
    return event.direction === 'incoming' ? (fa ? 'دریافت آینده' : 'Future receipt') : (fa ? 'پرداخت آینده' : 'Future payment');
  };
  return <section className="w-full max-w-6xl space-y-5" dir={fa ? 'rtl' : 'ltr'}>
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div><h2 className="text-xl font-semibold">{t.title}</h2><p className="mt-1 text-sm text-muted-foreground">{data ? data.from + ' — ' + data.to : ''}</p></div>
      <form className="flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); void load(); }}>
        <label className="space-y-1 text-sm"><span className="block">{t.from}</span><input className={input} type="date" value={from} max={to} onChange={event => setFrom(event.target.value)} /></label>
        <label className="space-y-1 text-sm"><span className="block">{t.to}</span><input className={input} type="date" value={to} min={from} onChange={event => setTo(event.target.value)} /></label>
        <button disabled={loading} className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{loading ? '…' : t.refresh}</button>
      </form>
    </div>
    {error && <div role="alert" className="rounded-xl border border-destructive/40 p-4 text-sm">{t.error}</div>}
    {data && <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {[
          [t.starting, data.starting_liquid_balance_minor], [t.inflows, data.summary.expected_inflows_minor],
          [t.outflows, data.summary.expected_outflows_minor], [t.actualInflows, data.summary.actual_inflows_minor],
          [t.actualOutflows, data.summary.actual_outflows_minor], [t.ending, data.projected_ending_liquid_balance_minor],
          [t.income, data.summary.projected_income_minor], [t.expenses, data.summary.projected_expense_minor],
          [t.unpaid, data.summary.recognized_unpaid_minor], [t.principal, data.summary.loan_principal_due_minor],
        ].map(([name, value]) => <div key={String(name)} className={card}><p className="text-sm text-muted-foreground">{name}</p><p className="text-xl font-semibold tabular-nums">{money(Number(value))}</p></div>)}
      </div>
      <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 text-sm">{t.note}</div>
      <div className={card}>
        <h3 className="font-semibold">{t.events}</h3>
        {data.events.length === 0 ? <p className="text-sm text-muted-foreground">{t.noEvents}</p> : <div className="overflow-x-auto">
          <table className="w-full text-sm"><thead><tr className="border-b">
            <th className="p-2 text-start">{t.date}</th><th className="p-2 text-start">{t.description}</th>
            <th className="p-2 text-start">{t.status}</th><th className="p-2 text-end">{t.amount}</th><th className="p-2 text-end">{t.balance}</th>
          </tr></thead><tbody>{data.events.map(event => <tr key={event.source + ':' + event.id} className="border-b border-border/60">
            <td className="p-2 whitespace-nowrap">{event.date}</td>
            <td className="p-2"><div>{kindLabel(event)} — {event.description}</div>{event.counterparty && <div className="text-xs text-muted-foreground">{event.counterparty}</div>}</td>
            <td className="p-2 whitespace-nowrap">{labelForStatus(event.status)}</td>
            <td className="p-2 text-end tabular-nums">{money(event.amount_minor)}</td>
            <td className="p-2 text-end tabular-nums">{money(event.projected_liquid_balance_minor)}</td>
          </tr>)}</tbody></table>
        </div>}
      </div>
      <p className="text-xs text-muted-foreground">{data.policy.message}</p>
    </>}
  </section>;
}
