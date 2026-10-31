'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useLocale } from 'use-intl';
import { useAuthStore } from '@/store/auth';
import { formatAccountingMoney, getCurrencyUnitAdapter, parseAccountingAmountToMinor } from '@/lib/countries';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import { accountingSystemAccountName, accountingErrorMessage, accountingStatusLabel, formatAccountingDate } from '@/lib/accounting-i18n';
import { JalaliDateInput } from '@/components/ui/JalaliDateInput';

type Account = { id: string; system_key?: string | null; account_code: string; name: string; account_type: string; is_active: number; is_postable: number };
type Occurrence = { id: string; occurrence_number: number; due_date: string; future_item_id: string; status: string; last_error_message: string | null };
type Schedule = {
  id: string; frequency: 'monthly' | 'every_n_days'; interval_days: number | null; first_due_date: string;
  occurrence_count: number; amount_minor: number; currency_code: string; description: string; counterparty: string | null;
  classification_account_name: string; auto_register: number; status: string; generated_occurrences: number;
  settled_occurrences: number; registered_occurrences: number; cancelled_occurrences: number; occurrences: Occurrence[];
};
const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
export function AccountingRecurringObligations() {
  const locale = useLocale();
  const tenant = useAuthStore((state) => state.currentTenant);
  const fa = locale.toLowerCase().startsWith('fa');
  const [accounts,setAccounts] = useState<Account[]>([]);
  const [schedules,setSchedules] = useState<Schedule[]>([]);
  const [currency,setCurrency] = useState('IRR');
  const [fractionDigits,setFractionDigits] = useState(0);
  const [frequency,setFrequency] = useState<'monthly'|'every_n_days'>('monthly');
  const [intervalDays,setIntervalDays] = useState('30');
  const [firstDueDate,setFirstDueDate] = useState(today());
  const [occurrenceCount,setOccurrenceCount] = useState('12');
  const [amount,setAmount] = useState('');
  const [description,setDescription] = useState('');
  const [counterparty,setCounterparty] = useState('');
  const [accountId,setAccountId] = useState('');
  const [autoRegister,setAutoRegister] = useState(false);
  const [busy,setBusy] = useState(false);
  const t = fa ? {
    title:'تعهدات تکرارشونده', note:'این برنامه برای هر سررسید یک مورد قابل پیگیری می‌سازد. ثبت سررسید به معنی پرداخت واقعی نیست؛ هزینه و خروج وجه فقط پس از تأیید پرداخت ثبت می‌شود.',
    add:'تعهد جدید', frequency:'تناوب', monthly:'ماهانه', every:'هر چند روز', interval:'فاصله (روز)', first:'اولین سررسید', count:'تعداد دفعات', amount:'مبلغ', description:'شرح تعهد', counterparty:'طرف حساب', account:'حساب هزینه', auto:'ثبت خودکار رویداد سررسید', save:'ثبت برنامه', list:'برنامه‌های ثبت‌شده', empty:'برنامه‌ای ثبت نشده است',
    active:'فعال', cancelled:'لغوشده', generated:'تعداد دفعات', settled:'پرداخت‌شده', cancel:'لغو برنامه', reason:'دلیل لغو برنامه', date:'تاریخ', status:'وضعیت', due:'در انتظار سررسید', awaiting_confirmation:'در انتظار تأیید', failed:'خطا؛ نیازمند بررسی', cancelled_item:'لغوشده', registered_item:'سررسید ثبت‌شده؛ پرداخت نشده', settled_item:'پرداخت‌شده', required:'شرح، مبلغ، حساب و تاریخ معتبر را وارد کنید.', saved:'برنامه ثبت شد.', failedMessage:'عملیات انجام نشد؛ حساب‌ها و اطلاعات را بررسی کنید.', everyNote:'هر چند روز یک‌بار', manual:'دستی', automatic:'خودکار'
  } : {
    title:'Recurring obligations', note:'The schedule creates one trackable item per due date. Due registration is not an actual payment; expense and cash outflow are recorded only after payment is confirmed.',
    add:'New obligation', frequency:'Frequency', monthly:'Monthly', every:'Every N days', interval:'Interval (days)', first:'First due date', count:'Number of occurrences', amount:'Amount', description:'Description', counterparty:'Counterparty', account:'Expense account', auto:'Automatically register due events', save:'Save schedule', list:'Saved schedules', empty:'No schedules recorded',
    active:'Active', cancelled:'Cancelled', generated:'Occurrences', settled:'Paid', cancel:'Cancel schedule', reason:'Cancellation reason', date:'Date', status:'Status', due:'Scheduled', awaiting_confirmation:'Awaiting confirmation', failed:'Failed; review required', cancelled_item:'Cancelled', registered_item:'Due registered; unpaid', settled_item:'Paid', required:'Enter a valid date, amount, description, and expense account.', saved:'Schedule saved.', failedMessage:'Operation failed. Check the inputs and accounts.', everyNote:'Repeat every N calendar days', manual:'Manual', automatic:'Automatic'
  };
  const load = useCallback(async () => {
    const [accountResponse,scheduleResponse] = await Promise.all([
      api.get('/accounting/accounts?types=expense'), api.get('/accounting/recurring-obligations'),
    ]);
    const rows: Account[] = accountResponse.data.accounts || [];
    setAccounts(rows);
    setCurrency(accountResponse.data.currency_code || 'IRR');
    setFractionDigits(Number(accountResponse.data.accounting_fraction_digits ?? 0));
    setSchedules(scheduleResponse.data.schedules || []);
    setAccountId(current => rows.some(a=>a.id===current && a.is_active===1 && a.is_postable===1) ? current : (rows.find(a=>a.is_active===1 && a.is_postable===1)?.id || ''));
  },[]);
  useEffect(() => { void Promise.resolve().then(()=>load()).catch(()=>toast.error(t.failedMessage)); },[load,t.failedMessage]);
  const preferences = useMemo(() => ({ currencyDisplay: tenant?.currency_display, digits: tenant?.number_digits, calendar: tenant?.calendar }), [tenant?.currency_display, tenant?.number_digits, tenant?.calendar]);
  const unitAdapter = useMemo(() => getCurrencyUnitAdapter(currency, tenant?.country, preferences), [currency, tenant?.country, preferences]);
  const money = useCallback((minor: number) => formatAccountingMoney(minor, {
    currency, fractionDigits, locale, countryCode: tenant?.country, preferences,
  }), [currency, fractionDigits, locale, tenant?.country, preferences]);
  const expenseAccounts=accounts.filter(a=>a.account_type==='expense' && a.is_active===1 && a.is_postable===1);
  function amountMinor(value: string): number | null {
    return parseAccountingAmountToMinor(value, {
      currency, fractionDigits, locale, countryCode: tenant?.country,
      preferences,
    });
  }
  async function create(e:FormEvent) {
    e.preventDefault();
    const minor=amountMinor(amount);
    const interval=Number(intervalDays), count=Number(occurrenceCount);
    if(!minor || !firstDueDate || !description.trim() || !accountId || !Number.isSafeInteger(count) || count<1 || count>120 ||
      (frequency==='every_n_days' && (!Number.isSafeInteger(interval)||interval<1||interval>366))) { toast.error(t.required); return; }
    setBusy(true);
    try {
      const key=typeof crypto!=='undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Date.now())+'-'+Math.random();
      await api.post('/accounting/recurring-obligations',{
        frequency, interval_days:frequency==='every_n_days'?interval:null, first_due_date:firstDueDate, occurrence_count:count,
        amount_minor:minor,currency_code:currency,description:description.trim(),counterparty:counterparty.trim()||null,
        classification_account_id:accountId,auto_register:autoRegister,
      },{headers:{'Idempotency-Key':key}});
      setAmount(''); setDescription(''); setCounterparty('');
      toast.success(t.saved); await load();
    } catch { toast.error(t.failedMessage); } finally { setBusy(false); }
  }
  async function cancel(schedule:Schedule) {
    const reason=window.prompt(t.reason);
    if(!reason?.trim()) return;
    setBusy(true);
    try { await api.post('/accounting/recurring-obligations/'+encodeURIComponent(schedule.id)+'/cancel',{reason:reason.trim()}); await load(); }
    catch { toast.error(t.failedMessage); } finally { setBusy(false); }
  }
  const statusText=(s:string) => s==='scheduled'?t.due:s==='awaiting_confirmation'?t.awaiting_confirmation:s==='failed'?t.failed:s==='cancelled'?t.cancelled_item:s==='registered'?t.registered_item:s==='settled'?t.settled_item:accountingStatusLabel(s, locale, t.failed);
  return <section dir={fa?'rtl':'ltr'} className="w-full max-w-6xl space-y-5">
    <h2 className="text-xl font-semibold">{t.title}</h2>
    <p className="rounded-lg border border-border p-3 text-sm text-muted-foreground">{t.note}</p>
    <form onSubmit={e=>void create(e)} className="rounded-xl border border-border bg-card p-4 space-y-3">
      <h3 className="font-semibold">{t.add}</h3>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <label className="space-y-1 text-sm"><span>{t.frequency}</span><select value={frequency} onChange={e=>setFrequency(e.target.value as 'monthly'|'every_n_days')} className="w-full rounded-lg border border-border bg-card px-3 py-2"><option value="monthly">{t.monthly}</option><option value="every_n_days">{t.every}</option></select></label>
        {frequency==='every_n_days' && <label className="space-y-1 text-sm"><span>{t.interval}</span><input type="number" min="1" max="366" required value={intervalDays} onChange={e=>setIntervalDays(e.target.value)} className="w-full rounded-lg border border-border bg-card px-3 py-2" /></label>}
        <label className="space-y-1 text-sm"><span>{t.first}</span><JalaliDateInput jalali={locale.toLowerCase().startsWith('fa')} required value={firstDueDate} onChange={setFirstDueDate} className="w-full rounded-lg border border-border bg-card px-3 py-2" /></label>
        <label className="space-y-1 text-sm"><span>{t.count}</span><input type="number" min="1" max="120" required value={occurrenceCount} onChange={e=>setOccurrenceCount(e.target.value)} className="w-full rounded-lg border border-border bg-card px-3 py-2" /></label>
        <label className="space-y-1 text-sm"><span>{t.amount} · {unitAdapter.label}</span><input required inputMode="decimal" value={amount} onChange={e=>setAmount(e.target.value)} className="w-full rounded-lg border border-border bg-card px-3 py-2" /></label>
        <label className="space-y-1 text-sm"><span>{t.description}</span><input required maxLength={500} value={description} onChange={e=>setDescription(e.target.value)} className="w-full rounded-lg border border-border bg-card px-3 py-2" /></label>
        <label className="space-y-1 text-sm"><span>{t.counterparty}</span><input maxLength={200} value={counterparty} onChange={e=>setCounterparty(e.target.value)} className="w-full rounded-lg border border-border bg-card px-3 py-2" /></label>
        <label className="space-y-1 text-sm"><span>{t.account}</span><select required value={accountId} onChange={e=>setAccountId(e.target.value)} className="w-full rounded-lg border border-border bg-card px-3 py-2"><option value="">—</option>{expenseAccounts.map(a=><option key={a.id} value={a.id}>{a.account_code} · {accountingSystemAccountName(a.system_key, a.name, locale)}</option>)}</select></label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={autoRegister} onChange={e=>setAutoRegister(e.target.checked)} />{t.auto}</label>
      </div>
      <p className="text-xs text-muted-foreground">{autoRegister?t.automatic:t.manual} · {t.everyNote}</p>
      <button disabled={busy||!expenseAccounts.length} className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{t.save}</button>
    </form>
    <div className="rounded-xl border border-border bg-card p-4 space-y-4">
      <h3 className="font-semibold">{t.list}</h3>
      {!schedules.length ? <p className="text-sm text-muted-foreground">{t.empty}</p> : schedules.map(s=><article key={s.id} className="rounded-lg border border-border p-3 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h4 className="font-medium">{s.description}</h4><p className="text-sm text-muted-foreground">{s.counterparty||'—'} · {accountingSystemAccountName(accounts.find((a) => a.name === s.classification_account_name)?.system_key, s.classification_account_name, locale)} · {money(s.amount_minor)} · {s.frequency==='monthly'?t.monthly:t.every+' '+s.interval_days}</p><p className="text-xs text-muted-foreground">{t.first}: {formatAccountingDate(s.first_due_date, locale, tenant?.calendar)} · {t.generated}: {s.generated_occurrences}/{s.occurrence_count} · {t.settled}: {s.settled_occurrences||0}</p></div>
          <div className="flex items-center gap-2"><span className="text-sm">{s.status==='active'?t.active:t.cancelled}</span>{s.status==='active'&&<button type="button" disabled={busy} onClick={()=>void cancel(s)} className="inline-flex min-h-9 items-center rounded-md border border-border px-3 py-1.5 text-sm font-medium text-brand hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50">{t.cancel}</button>}</div>
        </div>
        <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b"><th className="p-2 text-start">#</th><th className="p-2 text-start">{t.date}</th><th className="p-2 text-start">{t.amount}</th><th className="p-2 text-start">{t.status}</th></tr></thead><tbody>{s.occurrences.map(o=><tr key={o.id} className="border-b border-border/60"><td className="p-2">{o.occurrence_number}</td><td className="p-2">{formatAccountingDate(o.due_date, locale, tenant?.calendar)}</td><td className="p-2">{money(s.amount_minor)}</td><td className="p-2">{statusText(o.status)}{o.last_error_message?<span className="block text-xs text-destructive">{accountingErrorMessage(o.last_error_message, locale, t.failedMessage)}</span>:null}</td></tr>)}</tbody></table></div>
      </article>)}
    </div>
  </section>;
}
