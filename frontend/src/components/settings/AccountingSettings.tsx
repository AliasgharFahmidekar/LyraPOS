'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocale } from 'use-intl';
import api from '@/lib/api';
import toast from 'react-hot-toast';

type Account = { id: string; account_code: string; name: string; account_type: string; is_active: number; is_postable: number };
type Category = { id: string; name: string; expense_account_id: string; expense_account_name: string; is_active: number };
type Mapping = { payment_method_key: string; payment_method_name: string; account_id: string | null; payment_method_active?: boolean };
type Expense = { id: string; expense_date: string; amount_minor: number; currency_code: string; description: string; category_name: string; payment_status: string; status: string };
type Transfer = { id: string; entry_number: string; entry_date: string; description: string; currency_code: string; amount_minor: number; source_account_name: string; destination_account_name: string };
const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const labels = {
  en: { title: 'Accounting', expenses: 'Expenses', transfers: 'Cash / bank transfers', setup: 'Categories & account mapping', amount: 'Amount', date: 'Date', description: 'Description', category: 'Category', payee: 'Payee (optional)', reference: 'Reference (optional)', paid: 'Paid', unpaid: 'Unpaid', method: 'Payment method', paymentDate: 'Payment date', createExpense: 'Record expense', post: 'Post to ledger', reverse: 'Reverse', reversalReason: 'Reason for reversal', reversalDate: 'Reversal accounting date (YYYY-MM-DD)', status: 'Status', draft: 'Draft', posted: 'Posted', reversed: 'Reversed', transferFrom: 'From account', transferTo: 'To account', transfer: 'Record transfer', history: 'Transfer history', categoryName: 'New category name', expenseAccount: 'Expense account', createCategory: 'Add category', mapping: 'Payment method → accounting account', noRows: 'No records yet', loadFailed: 'Could not load accounting data.', saveFailed: 'Could not save the accounting record.', required: 'Complete all required fields with a valid amount and date.', amountHint: 'Enter an amount in the store currency.', reversalConfirm: 'This creates a separate reversing journal; the original entry remains unchanged.', duplicateAccounts: 'Source and destination must differ.' },
  fa: { title: 'حسابداری', expenses: 'هزینه‌ها', transfers: 'انتقال صندوق و بانک', setup: 'دسته‌بندی و نگاشت حساب‌ها', amount: 'مبلغ', date: 'تاریخ', description: 'شرح', category: 'دسته‌بندی', payee: 'پرداخت به (اختیاری)', reference: 'شماره پیگیری (اختیاری)', paid: 'پرداخت‌شده', unpaid: 'پرداخت‌نشده', method: 'روش پرداخت', paymentDate: 'تاریخ پرداخت', createExpense: 'ثبت هزینه', post: 'ثبت در دفتر کل', reverse: 'برگشت سند', reversalReason: 'دلیل برگشت', reversalDate: 'تاریخ حسابداری برگشت (سال-ماه-روز)', status: 'وضعیت', draft: 'پیش‌نویس', posted: 'ثبت‌شده', reversed: 'برگشت‌خورده', transferFrom: 'حساب مبدأ', transferTo: 'حساب مقصد', transfer: 'ثبت انتقال', history: 'تاریخچه انتقال‌ها', categoryName: 'نام دسته‌بندی جدید', expenseAccount: 'حساب هزینه', createCategory: 'افزودن دسته‌بندی', mapping: 'روش پرداخت ← حسابداری', noRows: 'هنوز رکوردی ثبت نشده است', loadFailed: 'بارگذاری اطلاعات حسابداری انجام نشد.', saveFailed: 'ذخیره اطلاعات حسابداری انجام نشد.', required: 'فیلدهای ضروری، مبلغ معتبر و تاریخ را کامل کنید.', amountHint: 'مبلغ را با واحد پول فروشگاه وارد کنید.', reversalConfirm: 'این عملیات سند معکوس جداگانه می‌سازد و سند اصلی را تغییر نمی‌دهد.', duplicateAccounts: 'حساب مبدأ و مقصد باید متفاوت باشند.' }
};
function amountToMinor(value: string, digits: number): number | null {
  const normalized = value.trim().replace(/,/g, '');
  if (!/^\\d+(\\.\\d+)?$/.test(normalized)) return null;
  const parts = normalized.split('.');
  const fraction = parts[1] || '';
  if (fraction.length > digits) return null;
  const minor = Number(parts[0]) * (10 ** digits) + Number((fraction + '0'.repeat(digits)).slice(0, digits) || '0');
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}
export function AccountingSettings({ isAdmin }: { isAdmin: boolean }) {
  const locale = useLocale();
  const t = locale.toLowerCase().startsWith('fa') ? labels.fa : labels.en;
  const [tab, setTab] = useState<'expenses' | 'transfers' | 'setup'>('expenses');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [currency, setCurrency] = useState('IRR');
  const [categories, setCategories] = useState<Category[]>([]);
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [expenseDate, setExpenseDate] = useState(today());
  const [paymentDate, setPaymentDate] = useState(today());
  const [payee, setPayee] = useState('');
  const [reference, setReference] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [paymentStatus, setPaymentStatus] = useState<'paid' | 'unpaid'>('paid');
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [newCategory, setNewCategory] = useState('');
  const [newCategoryAccount, setNewCategoryAccount] = useState('');
  const [sourceAccount, setSourceAccount] = useState('');
  const [destinationAccount, setDestinationAccount] = useState('');
  const [transferAmount, setTransferAmount] = useState('');
  const [transferDate, setTransferDate] = useState(today());
  const [transferDescription, setTransferDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const digits = useMemo(() => {
    try { return new Intl.NumberFormat(locale, { style: 'currency', currency }).resolvedOptions().maximumFractionDigits; } catch { return 0; }
  }, [currency, locale]);
  const load = useCallback(async () => {
    const results = await Promise.all([
      api.get('/accounting/accounts'), api.get('/accounting/expense-categories?include_inactive=true'),
      api.get('/accounting/payment-account-mappings'), api.get('/accounting/expenses?limit=100'), api.get('/accounting/transfers?limit=100')
    ]);
    const accountRows: Account[] = results[0].data.accounts || [];
    const categoryRows: Category[] = results[1].data.categories || [];
    setAccounts(accountRows); if (results[0].data.currency_code) setCurrency(results[0].data.currency_code);
    setCategories(categoryRows); setMappings(results[2].data.mappings || []);
    setExpenses(results[3].data.expenses || []); setTransfers(results[4].data.transfers || []);
    const assets = accountRows.filter((a) => a.account_type === 'asset' && a.is_active === 1 && a.is_postable === 1);
    setSourceAccount((v) => assets.some((a) => a.id === v) ? v : (assets[0]?.id || ''));
    setDestinationAccount((v) => assets.some((a) => a.id === v) ? v : (assets[1]?.id || assets[0]?.id || ''));
    setCategoryId((v) => categoryRows.some((c) => c.id === v && c.is_active === 1) ? v : (categoryRows.find((c) => c.is_active === 1)?.id || ''));
    setNewCategoryAccount((v) => accountRows.some((a) => a.id === v && a.account_type === 'expense' && a.is_active === 1 && a.is_postable === 1) ? v : (accountRows.find((a) => a.account_type === 'expense' && a.is_active === 1 && a.is_postable === 1)?.id || ''));
  }, []);
  useEffect(() => { void load().catch(() => toast.error(t.loadFailed)); }, [load, t.loadFailed]);
  const money = (minor: number) => new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: digits }).format(minor / (10 ** digits));
  const selectClass = 'w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground';
  const inputClass = selectClass;
  const cardClass = 'rounded-xl border border-border bg-card p-4 space-y-3';
  const token = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random());

  async function saveExpense() {
    const minor = amountToMinor(amount, digits);
    if (!categoryId || !description.trim() || minor === null) { toast.error(t.required); return; }
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { category_id: categoryId, amount_minor: minor, currency_code: currency, description: description.trim(), expense_date: expenseDate, payment_status: paymentStatus, payee: payee.trim() || null, reference_number: reference.trim() || null };
      if (paymentStatus === 'paid') Object.assign(payload, { payment_method_key: paymentMethod, payment_date: paymentDate });
      const response = await api.post('/accounting/expenses', payload, { headers: { 'Idempotency-Key': token() } });
      if (paymentStatus === 'paid' && response.data.expense.status === 'draft') await api.post('/accounting/expenses/' + response.data.expense.id + '/post', {});
      setAmount(''); setDescription(''); setPayee(''); setReference(''); await load();
    } catch { toast.error(t.saveFailed); } finally { setBusy(false); }
  }
  async function reverseExpense(expense: Expense) {
    const reason = window.prompt(t.reversalReason);
    if (!reason || !reason.trim()) return;
    const reversalDate = window.prompt(t.reversalDate, today());
    if (!reversalDate) return;
    if (!window.confirm(t.reversalConfirm)) return;
    setBusy(true);
    try { await api.post('/accounting/expenses/' + expense.id + '/reverse', { reason: reason.trim(), reversal_date: reversalDate }); await load(); }
    catch { toast.error(t.saveFailed); } finally { setBusy(false); }
  }
  async function saveTransfer() {
    const minor = amountToMinor(transferAmount, digits);
    if (!sourceAccount || !destinationAccount || sourceAccount === destinationAccount || !transferDescription.trim() || minor === null) { toast.error(sourceAccount === destinationAccount ? t.duplicateAccounts : t.required); return; }
    setBusy(true);
    try {
      await api.post('/accounting/transfers', { source_account_id: sourceAccount, destination_account_id: destinationAccount, amount_minor: minor, entry_date: transferDate, description: transferDescription.trim() }, { headers: { 'Idempotency-Key': token() } });
      setTransferAmount(''); setTransferDescription(''); await load();
    } catch { toast.error(t.saveFailed); } finally { setBusy(false); }
  }
  async function saveCategory() {
    if (!newCategory.trim() || !newCategoryAccount) { toast.error(t.required); return; }
    setBusy(true);
    try { await api.post('/accounting/expense-categories', { name: newCategory.trim(), expense_account_id: newCategoryAccount }); setNewCategory(''); await load(); }
    catch { toast.error(t.saveFailed); } finally { setBusy(false); }
  }
  async function saveMapping(key: string, accountId: string) {
    setBusy(true);
    try { await api.put('/accounting/payment-account-mappings/' + encodeURIComponent(key), { account_id: accountId }); await load(); }
    catch { toast.error(t.saveFailed); } finally { setBusy(false); }
  }
  const activeAssets = accounts.filter((a) => a.account_type === 'asset' && a.is_active === 1 && a.is_postable === 1);
  const activeExpenses = accounts.filter((a) => a.account_type === 'expense' && a.is_active === 1 && a.is_postable === 1);
  const activeCategories = categories.filter((c) => c.is_active === 1);
  if (!isAdmin) return null;
  return <section className="w-full max-w-5xl space-y-5" dir={locale.toLowerCase().startsWith('fa') ? 'rtl' : 'ltr'}>
    <h2 className="text-xl font-semibold">{t.title}</h2>
    <div className="flex flex-wrap gap-2" role="tablist">
      {(['expenses', 'transfers', 'setup'] as const).map((key) => <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)} className={tab === key ? 'rounded-lg border border-brand bg-brand/10 px-4 py-2 text-sm text-brand' : 'rounded-lg border border-border px-4 py-2 text-sm'}>{t[key]}</button>)}
    </div>
    {tab === 'expenses' && <div className="space-y-5">
      <form className={cardClass} onSubmit={(e) => { e.preventDefault(); void saveExpense(); }}>
        <h3 className="font-semibold">{t.createExpense}</h3><p className="text-xs text-muted-foreground">{t.amountHint} · {currency}</p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <label className="space-y-1 text-sm"><span>{t.amount}</span><input required value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" className={inputClass} /></label>
          <label className="space-y-1 text-sm"><span>{t.date}</span><input required type="date" value={expenseDate} onChange={(e) => setExpenseDate(e.target.value)} className={inputClass} /></label>
          <label className="space-y-1 text-sm"><span>{t.category}</span><select required value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className={selectClass}><option value="">—</option>{activeCategories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label className="space-y-1 text-sm"><span>{t.description}</span><input required value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} /></label>
          <label className="space-y-1 text-sm"><span>{t.payee}</span><input value={payee} onChange={(e) => setPayee(e.target.value)} className={inputClass} /></label>
          <label className="space-y-1 text-sm"><span>{t.reference}</span><input value={reference} onChange={(e) => setReference(e.target.value)} className={inputClass} /></label>
          <label className="space-y-1 text-sm"><span>{t.status}</span><select value={paymentStatus} onChange={(e) => setPaymentStatus(e.target.value as 'paid' | 'unpaid')} className={selectClass}><option value="paid">{t.paid}</option><option value="unpaid">{t.unpaid}</option></select></label>
          {paymentStatus === 'paid' && <><label className="space-y-1 text-sm"><span>{t.method}</span><select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)} className={selectClass}>{mappings.filter((m) => m.payment_method_active !== false).map((m) => <option key={m.payment_method_key} value={m.payment_method_key}>{m.payment_method_name}</option>)}</select></label><label className="space-y-1 text-sm"><span>{t.paymentDate}</span><input required type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} className={inputClass} /></label></>}
        </div><button disabled={busy || !activeCategories.length} className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{t.createExpense}</button>
      </form>
      <div className={cardClass}><h3 className="font-semibold">{t.expenses}</h3>{expenses.length === 0 ? <p className="text-sm text-muted-foreground">{t.noRows}</p> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b"><th className="p-2 text-start">{t.date}</th><th className="p-2 text-start">{t.description}</th><th className="p-2 text-start">{t.category}</th><th className="p-2 text-start">{t.amount}</th><th className="p-2 text-start">{t.status}</th><th /></tr></thead><tbody>{expenses.map((e) => <tr key={e.id} className="border-b border-border/60"><td className="p-2">{e.expense_date}</td><td className="p-2">{e.description}</td><td className="p-2">{e.category_name}</td><td className="p-2 whitespace-nowrap">{money(e.amount_minor)}</td><td className="p-2">{t[e.status as 'draft' | 'posted' | 'reversed'] || e.status} · {e.payment_status === 'paid' ? t.paid : t.unpaid}</td><td className="p-2 whitespace-nowrap">{e.status === 'draft' && e.payment_status === 'paid' && <button type="button" disabled={busy} onClick={() => { void api.post('/accounting/expenses/' + e.id + '/post').then(() => load()).catch(() => toast.error(t.saveFailed)); }} className="text-brand underline">{t.post}</button>}{e.status === 'posted' && <button type="button" disabled={busy} onClick={() => void reverseExpense(e)} className="ms-2 text-brand underline">{t.reverse}</button>}</td></tr>)}</tbody></table></div>}</div>
    </div>}
    {tab === 'transfers' && <div className="space-y-5">
      <form className={cardClass} onSubmit={(e) => { e.preventDefault(); void saveTransfer(); }}><h3 className="font-semibold">{t.transfer}</h3><p className="text-xs text-muted-foreground">{t.amountHint} · {currency}</p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <label className="space-y-1 text-sm"><span>{t.transferFrom}</span><select value={sourceAccount} onChange={(e) => setSourceAccount(e.target.value)} className={selectClass}>{activeAssets.map((a) => <option key={a.id} value={a.id}>{a.account_code} · {a.name}</option>)}</select></label>
          <label className="space-y-1 text-sm"><span>{t.transferTo}</span><select value={destinationAccount} onChange={(e) => setDestinationAccount(e.target.value)} className={selectClass}>{activeAssets.map((a) => <option key={a.id} value={a.id}>{a.account_code} · {a.name}</option>)}</select></label>
          <label className="space-y-1 text-sm"><span>{t.amount}</span><input required value={transferAmount} onChange={(e) => setTransferAmount(e.target.value)} inputMode="decimal" className={inputClass} /></label>
          <label className="space-y-1 text-sm"><span>{t.date}</span><input required type="date" value={transferDate} onChange={(e) => setTransferDate(e.target.value)} className={inputClass} /></label>
          <label className="space-y-1 text-sm md:col-span-2"><span>{t.description}</span><input required value={transferDescription} onChange={(e) => setTransferDescription(e.target.value)} className={inputClass} /></label>
        </div><button disabled={busy || activeAssets.length < 2} className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{t.transfer}</button>
      </form>
      <div className={cardClass}><h3 className="font-semibold">{t.history}</h3>{transfers.length === 0 ? <p className="text-sm text-muted-foreground">{t.noRows}</p> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b"><th className="p-2 text-start">{t.date}</th><th className="p-2 text-start">{t.description}</th><th className="p-2 text-start">{t.transferFrom}</th><th className="p-2 text-start">{t.transferTo}</th><th className="p-2 text-start">{t.amount}</th></tr></thead><tbody>{transfers.map((x) => <tr key={x.id} className="border-b border-border/60"><td className="p-2">{x.entry_date}</td><td className="p-2">{x.description}</td><td className="p-2">{x.source_account_name}</td><td className="p-2">{x.destination_account_name}</td><td className="p-2 whitespace-nowrap">{money(x.amount_minor)}</td></tr>)}</tbody></table></div>}</div>
    </div>}
    {tab === 'setup' && <div className="space-y-5">
      <form className={cardClass} onSubmit={(e) => { e.preventDefault(); void saveCategory(); }}><h3 className="font-semibold">{t.setup}</h3><div className="grid grid-cols-1 gap-3 md:grid-cols-2"><label className="space-y-1 text-sm"><span>{t.categoryName}</span><input value={newCategory} onChange={(e) => setNewCategory(e.target.value)} className={inputClass} required /></label><label className="space-y-1 text-sm"><span>{t.expenseAccount}</span><select value={newCategoryAccount} onChange={(e) => setNewCategoryAccount(e.target.value)} className={selectClass}>{activeExpenses.map((a) => <option key={a.id} value={a.id}>{a.account_code} · {a.name}</option>)}</select></label></div><button disabled={busy || !activeExpenses.length} className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{t.createCategory}</button><div className="space-y-2">{categories.map((c) => <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3 text-sm"><span>{c.name}</span><span className="text-muted-foreground">{c.expense_account_name} · {c.is_active ? '✓' : '—'}</span></div>)}</div></form>
      <div className={cardClass}><h3 className="font-semibold">{t.mapping}</h3>{mappings.map((m) => <label key={m.payment_method_key} className="grid grid-cols-1 gap-2 border-b border-border/60 py-2 text-sm md:grid-cols-2"><span>{m.payment_method_name}</span><select disabled={busy} value={m.account_id || ''} onChange={(e) => void saveMapping(m.payment_method_key, e.target.value)} className={selectClass}><option value="">—</option>{accounts.filter((a) => (m.payment_method_key === 'loyalty' ? a.account_type === 'liability' : a.account_type === 'asset') && a.is_active === 1 && a.is_postable === 1).map((a) => <option key={a.id} value={a.id}>{a.account_code} · {a.name}</option>)}</select></label>)}</div>
    </div>}
  </section>;
}
