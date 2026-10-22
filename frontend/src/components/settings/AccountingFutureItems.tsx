'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useLocale } from 'use-intl';
import api from '@/lib/api';
import toast from 'react-hot-toast';

type Account = { id: string; account_code: string; name: string; account_type: string; system_key?: string | null; is_active: number; is_postable: number; is_liquid?: boolean };
type FutureItem = {
  id: string; record_type: 'receipt' | 'cheque'; direction: 'incoming' | 'outgoing'; due_date: string;
  amount_minor: number; currency_code: string; description: string; counterparty: string | null; reference_number: string | null;
  classification_account_id: string; classification_account_name: string; settlement_account_id: string | null;
  settlement_account_name: string | null; auto_register: number; status: string; last_error_message: string | null;
  due_entry_number: string | null; settlement_entry_number: string | null;
};
const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const labels = {
  fa: {
    title: 'دریافت‌ها و چک‌های آتی', add: 'ثبت مورد جدید', type: 'نوع سند', receipt: 'دریافت آتی', cheque: 'چک',
    direction: 'جهت', incoming: 'دریافتی', outgoing: 'پرداختی', due: 'تاریخ سررسید', amount: 'مبلغ',
    description: 'شرح', counterparty: 'طرف حساب', reference: 'شماره چک / پیگیری', classification: 'حساب درآمد یا هزینه',
    auto: 'ثبت حسابداری خودکار در سررسید', create: 'ثبت مورد', list: 'فهرست دریافت‌ها و چک‌ها', status: 'وضعیت',
    register: 'ثبت رویداد سررسید', settle: 'تأیید وصول / پرداخت واقعی', cancel: 'لغو', date: 'تاریخ',
    settlementAccount: 'حساب واقعی صندوق / بانک', empty: 'موردی ثبت نشده است', scheduled: 'در انتظار سررسید',
    awaiting_confirmation: 'در انتظار تأیید ثبت', registered: 'ثبت‌شده؛ تسویه نشده', settled: 'وصول / پرداخت‌شده',
    cancelled: 'لغوشده', failed: 'خطا؛ نیازمند تلاش مجدد', dueEntry: 'سند سررسید', settlementEntry: 'سند تسویه',
    note: 'سررسید به معنی وصول پول یا پرداخت واقعی نیست. درآمد/هزینه و گردش صندوق یا بانک فقط پس از تأیید تسویه واقعی ثبت می‌شود.',
    settlementDate: 'تاریخ وصول / پرداخت واقعی', cancelReason: 'دلیل لغو', actions: 'عملیات', required: 'فیلدهای ضروری و مبلغ معتبر را وارد کنید.',
    saved: 'مورد ثبت شد.', failedMessage: 'عملیات انجام نشد؛ اطلاعات و وضعیت حسابداری را بررسی کنید.', account: 'حساب تسویه',
  },
  en: {
    title: 'Future receipts & cheques', add: 'Add future item', type: 'Record type', receipt: 'Future receipt', cheque: 'Cheque',
    direction: 'Direction', incoming: 'Incoming', outgoing: 'Outgoing', due: 'Due date', amount: 'Amount',
    description: 'Description', counterparty: 'Counterparty', reference: 'Cheque / reference number', classification: 'Income or expense account',
    auto: 'Automatically register the due accounting event', create: 'Save item', list: 'Future items', status: 'Status',
    register: 'Register due event', settle: 'Confirm actual settlement', cancel: 'Cancel', date: 'Date',
    settlementAccount: 'Actual cash / bank account', empty: 'No future items recorded', scheduled: 'Scheduled',
    awaiting_confirmation: 'Awaiting registration confirmation', registered: 'Registered; not settled', settled: 'Settled',
    cancelled: 'Cancelled', failed: 'Failed; retry required', dueEntry: 'Due journal', settlementEntry: 'Settlement journal',
    note: 'A due date does not prove that money was received or paid. Income/expense and cash/bank movement are recorded only after actual settlement is confirmed.',
    settlementDate: 'Actual settlement date', cancelReason: 'Cancellation reason', actions: 'Actions', required: 'Complete required fields and enter a valid amount.',
    saved: 'Future item saved.', failedMessage: 'Operation failed. Check the inputs and accounting state.', account: 'Settlement account',
  },
};
export function AccountingFutureItems() {
  const locale = useLocale();
  const fa = locale.toLowerCase().startsWith('fa');
  const t = fa ? labels.fa : labels.en;
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [items, setItems] = useState<FutureItem[]>([]);
  const [currency, setCurrency] = useState('IRR');
  const [digits, setDigits] = useState(0);
  const [recordType, setRecordType] = useState<'receipt' | 'cheque'>('receipt');
  const [dueDate, setDueDate] = useState(today());
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [counterparty, setCounterparty] = useState('');
  const [reference, setReference] = useState('');
  const [classificationAccount, setClassificationAccount] = useState('');
  const [autoRegister, setAutoRegister] = useState(false);
  const [settlementDate, setSettlementDate] = useState(today());
  const [settlementAccount, setSettlementAccount] = useState('');
  const [busy, setBusy] = useState(false);
  const token = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random());
  const load = useCallback(async () => {
    const [accountResponse, itemResponse] = await Promise.all([
      api.get('/accounting/accounts'), api.get('/accounting/future-items?limit=500'),
    ]);
    const rows: Account[] = accountResponse.data.accounts || [];
    setAccounts(rows);
    const code = accountResponse.data.currency_code || 'IRR';
    setCurrency(code);
    try { setDigits(new Intl.NumberFormat(locale, { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits); } catch { setDigits(0); }
    setItems(itemResponse.data.items || []);
    const liquid = rows.filter((a) => a.account_type === 'asset' && a.is_active === 1 && a.is_postable === 1 && ['cash_drawer', 'bank_accounts', 'payment_clearing'].includes(a.system_key || ''));
    setSettlementAccount((current) => liquid.some((a) => a.id === current) ? current : (liquid[0]?.id || ''));
    const income = rows.find((a) => a.account_type === 'revenue' && a.is_active === 1 && a.is_postable === 1 && !['sales_revenue', 'sales_returns', 'sales_discounts'].includes(a.system_key || ''));
    const expense = rows.find((a) => a.account_type === 'expense' && a.is_active === 1 && a.is_postable === 1);
    setClassificationAccount((current) => rows.some((a) => a.id === current && a.account_type === (recordType === 'receipt' ? 'revenue' : 'expense') && a.is_active === 1 && a.is_postable === 1) ? current : (recordType === 'receipt' ? income?.id : expense?.id) || '');
  }, [locale, recordType]);
  useEffect(() => { void load().catch(() => toast.error(t.failedMessage)); }, [load, t.failedMessage]);
  const money = useMemo(() => (minor: number) => new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: digits }).format(minor / (10 ** digits)), [locale, currency, digits]);
  const selectClass = 'w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground';
  const inputClass = selectClass;
  const cardClass = 'rounded-xl border border-border bg-card p-4 space-y-3';
  function amountToMinor(value: string): number | null {
    const normalized = value.trim().replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[٬,]/g, '').replace(/٫/g, '.');
    if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
    const [whole, fraction = ''] = normalized.split('.');
    if (fraction.length > digits) return null;
    const result = Number(whole) * (10 ** digits) + Number((fraction + '0'.repeat(digits)).slice(0, digits) || '0');
    return Number.isSafeInteger(result) && result > 0 ? result : null;
  }
  async function createItem(e: FormEvent) {
    e.preventDefault();
    const amountMinor = amountToMinor(amount);
    if (!amountMinor || !dueDate || !description.trim() || !classificationAccount) { toast.error(t.required); return; }
    setBusy(true);
    try {
      await api.post('/accounting/future-items', {
        record_type: recordType, direction: recordType === 'receipt' ? 'incoming' : 'outgoing', due_date: dueDate,
        amount_minor: amountMinor, currency_code: currency, description: description.trim(),
        counterparty: counterparty.trim() || null, reference_number: reference.trim() || null,
        classification_account_id: classificationAccount, auto_register: autoRegister,
      }, { headers: { 'Idempotency-Key': token() } });
      setAmount(''); setDescription(''); setCounterparty(''); setReference('');
      toast.success(t.saved); await load();
    } catch { toast.error(t.failedMessage); } finally { setBusy(false); }
  }
  async function register(item: FutureItem) {
    setBusy(true);
    try { await api.post('/accounting/future-items/' + encodeURIComponent(item.id) + '/register', {}); await load(); }
    catch { toast.error(t.failedMessage); } finally { setBusy(false); }
  }
  async function settle(item: FutureItem) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(settlementDate) || !settlementAccount) { toast.error(t.required); return; }
    setBusy(true);
    try {
      await api.post('/accounting/future-items/' + encodeURIComponent(item.id) + '/settle', {
        settlement_date: settlementDate, settlement_account_id: settlementAccount,
      }, { headers: { 'Idempotency-Key': token() } });
      await load();
    } catch { toast.error(t.failedMessage); } finally { setBusy(false); }
  }
  async function cancel(item: FutureItem) {
    const reason = window.prompt(t.cancelReason);
    if (!reason?.trim()) return;
    setBusy(true);
    try { await api.post('/accounting/future-items/' + encodeURIComponent(item.id) + '/cancel', { reason: reason.trim() }); await load(); }
    catch { toast.error(t.failedMessage); } finally { setBusy(false); }
  }
  const classificationAccounts = accounts.filter((a) => a.account_type === (recordType === 'receipt' ? 'revenue' : 'expense') && a.is_active === 1 && a.is_postable === 1 && (recordType !== 'receipt' || !['sales_revenue', 'sales_returns', 'sales_discounts'].includes(a.system_key || '')));
  const settlementAccounts = accounts.filter((a) => a.account_type === 'asset' && a.is_active === 1 && a.is_postable === 1 && ['cash_drawer', 'bank_accounts', 'payment_clearing'].includes(a.system_key || ''));
  const statusLabel = (status: string) => (t as Record<string, string>)[status] || status;
  return <section dir={fa ? 'rtl' : 'ltr'} className="w-full max-w-6xl space-y-5">
    <h2 className="text-xl font-semibold">{t.title}</h2>
    <p className="rounded-lg border border-border p-3 text-sm text-muted-foreground">{t.note}</p>
    <form className={cardClass} onSubmit={(e) => void createItem(e)}>
      <h3 className="font-semibold">{t.add}</h3>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <label className="space-y-1 text-sm"><span>{t.type}</span><select value={recordType} onChange={(e) => setRecordType(e.target.value as 'receipt' | 'cheque')} className={selectClass}><option value="receipt">{t.receipt}</option><option value="cheque">{t.cheque}</option></select></label>
        <label className="space-y-1 text-sm"><span>{t.due}</span><input required type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={inputClass} /></label>
        <label className="space-y-1 text-sm"><span>{t.amount} · {currency}</span><input required inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={inputClass} /></label>
        <label className="space-y-1 text-sm"><span>{t.description}</span><input required value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} /></label>
        <label className="space-y-1 text-sm"><span>{t.counterparty}</span><input value={counterparty} onChange={(e) => setCounterparty(e.target.value)} className={inputClass} /></label>
        <label className="space-y-1 text-sm"><span>{t.reference}</span><input value={reference} onChange={(e) => setReference(e.target.value)} className={inputClass} /></label>
        <label className="space-y-1 text-sm"><span>{t.classification}</span><select required value={classificationAccount} onChange={(e) => setClassificationAccount(e.target.value)} className={selectClass}><option value="">—</option>{classificationAccounts.map(a => <option key={a.id} value={a.id}>{a.account_code} · {a.name}</option>)}</select></label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={autoRegister} onChange={(e) => setAutoRegister(e.target.checked)} />{t.auto}</label>
      </div>
      <button disabled={busy || !classificationAccounts.length} className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{t.create}</button>
    </form>
    <div className={cardClass}><h3 className="font-semibold">{t.list}</h3><div className="grid grid-cols-1 gap-3 md:grid-cols-2"><label className="space-y-1 text-sm"><span>{t.settlementDate}</span><input type="date" value={settlementDate} onChange={(e) => setSettlementDate(e.target.value)} className={inputClass} /></label><label className="space-y-1 text-sm"><span>{t.settlementAccount}</span><select value={settlementAccount} onChange={(e) => setSettlementAccount(e.target.value)} className={selectClass}>{settlementAccounts.map(a => <option key={a.id} value={a.id}>{a.account_code} · {a.name}</option>)}</select></label></div>{items.length === 0 ? <p className="text-sm text-muted-foreground">{t.empty}</p> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b"><th className="p-2 text-start">{t.due}</th><th className="p-2 text-start">{t.type}</th><th className="p-2 text-start">{t.description}</th><th className="p-2 text-start">{t.counterparty}</th><th className="p-2 text-start">{t.amount}</th><th className="p-2 text-start">{t.classification}</th><th className="p-2 text-start">{t.status}</th><th className="p-2 text-start">{t.dueEntry}</th><th className="p-2 text-start">{t.settlementEntry}</th><th className="p-2 text-start">{t.actions}</th></tr></thead><tbody>{items.map(item => <tr key={item.id} className="border-b border-border/60 align-top"><td className="p-2 whitespace-nowrap">{item.due_date}</td><td className="p-2">{item.record_type === 'receipt' ? t.receipt : t.cheque}</td><td className="p-2">{item.description}{item.reference_number ? <span className="block text-xs text-muted-foreground">{item.reference_number}</span> : null}{item.last_error_message ? <span className="block text-xs text-destructive">{item.last_error_message}</span> : null}</td><td className="p-2">{item.counterparty || '—'}</td><td className="p-2 whitespace-nowrap">{money(item.amount_minor)}</td><td className="p-2">{item.classification_account_name}</td><td className="p-2">{statusLabel(item.status)}</td><td className="p-2">{item.due_entry_number || '—'}</td><td className="p-2">{item.settlement_entry_number || '—'}</td><td className="p-2 whitespace-nowrap">{['scheduled','awaiting_confirmation','failed'].includes(item.status) && <><button type="button" disabled={busy || item.due_date > today()} onClick={() => void register(item)} className="me-2 text-brand underline disabled:opacity-40">{t.register}</button><button type="button" disabled={busy} onClick={() => void cancel(item)} className="text-brand underline">{t.cancel}</button></>}{item.status === 'registered' && <button type="button" disabled={busy} onClick={() => void settle(item)} className="text-brand underline">{t.settle}</button>}</td></tr>)}</tbody></table></div>}</div>
  </section>;
}
