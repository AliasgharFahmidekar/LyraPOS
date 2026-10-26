'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  Banknote, Building2, ChevronLeft, CircleAlert, CircleCheck, Eye, Landmark,
  Pencil, Plus, Search, Wallet, X,
} from 'lucide-react';
import { useLocale } from 'use-intl';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { formatAccountingMoney } from '@/lib/countries';
import { accountingSystemAccountName, accountingSystemDescription, accountingErrorMessage, formatAccountingDate } from '@/lib/accounting-i18n';
import { JalaliDateInput } from '@/components/ui/JalaliDateInput';

type AccountKind = 'cash' | 'bank' | 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
type Account = {
  id: string; system_key: string | null; account_code: string; name: string; account_type: string;
  normal_balance: string; parent_account_id: string | null; is_system: number; is_active: number;
  is_postable: number; description: string | null; balance_minor: number; transaction_count: number;
  is_liquid: boolean; account_kind: AccountKind;
};
type LedgerLine = {
  journal_entry_id: string; entry_number: string; entry_date: string; description: string;
  line_description: string | null; debit_minor: number; credit_minor: number; balance_change_minor: number;
  balance_after_minor: number; source_type: string | null; line_no: number;
};
type AccountHistory = { account: Account; transactions: LedgerLine[] };

export function AccountingAccounts() {
  const locale = useLocale();
  const tenant = useAuthStore((state) => state.currentTenant);
  const fa = locale.toLowerCase().startsWith('fa');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [currency, setCurrency] = useState(tenant?.currency || 'IRR');
  const [fractionDigits, setFractionDigits] = useState(0);
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<'all' | AccountKind>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<AccountKind>('bank');
  const [description, setDescription] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [historyAccount, setHistoryAccount] = useState<Account | null>(null);
  const [history, setHistory] = useState<AccountHistory | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const text = fa ? {
    title: 'حساب‌ها', subtitle: 'حساب‌های مالی و مانده ثبت‌شده آن‌ها را مدیریت کنید.',
    create: 'ایجاد حساب', search: 'جست‌وجوی نام یا کد حساب…', allTypes: 'همه انواع',
    allStatuses: 'همه وضعیت‌ها', active: 'فعال', inactive: 'غیرفعال',
    name: 'نام حساب', type: 'نوع حساب', code: 'کد حساب', balance: 'مانده فعلی',
    status: 'وضعیت', actions: 'عملیات', edit: 'ویرایش', history: 'مشاهده گردش',
    totalBalance: 'مجموع مانده حساب‌های نقدی و بانکی', activeCount: 'حساب‌های فعال',
    accountCount: 'تعداد کل حساب‌ها', liquidCount: 'حساب‌های نقدی و بانکی', noRows: 'حسابی با این مشخصات پیدا نشد.',
    failed: 'فهرست حساب‌ها بارگذاری نشد.', retry: 'تلاش دوباره', createTitle: 'ایجاد حساب جدید',
    editTitle: 'ویرایش حساب', nameRequired: 'نام حساب الزامی است.', description: 'توضیحات',
    kindCash: 'صندوق نقدی', kindBank: 'حساب بانکی', kindAsset: 'دارایی غیرنقدی',
    kindLiability: 'بدهی', kindEquity: 'سرمایه', kindRevenue: 'درآمد', kindExpense: 'هزینه',
    kind: 'دسته حساب', activeSwitch: 'حساب فعال است', save: 'ذخیره حساب', cancel: 'انصراف',
    created: 'حساب جدید ایجاد شد.', updated: 'اطلاعات حساب ذخیره شد.',
    saveError: 'ذخیره حساب انجام نشد. اطلاعات و وابستگی‌های حساب را بررسی کنید.',
    cashBankNote: 'حساب‌های نقدی و بانکی جدید در انتقال وجه و دریافت/پرداخت واقعی قابل استفاده‌اند. سایر حساب‌های دارایی، نقدی محسوب نمی‌شوند.',
    systemNote: 'حساب سیستمی است؛ نام و توضیحات قابل تغییرند اما ماهیت، کد و وضعیت آن ثابت می‌ماند.',
    dependenciesNote: 'حسابی که در تنظیمات پرداخت یا تعهدهای فعال استفاده می‌شود تا زمان رفع وابستگی قابل غیرفعال‌سازی نیست.',
    historyTitle: 'گردش حساب', currentBalance: 'مانده فعلی', ledger: 'گردش دفتر کل',
    date: 'تاریخ', descriptionCol: 'شرح', reference: 'شماره سند', debit: 'بدهکار', credit: 'بستانکار',
    noHistory: 'گردشی برای این حساب در بازه انتخاب‌شده وجود ندارد.',
    loadHistoryError: 'گردش حساب بارگذاری نشد.', all: 'همه', from: 'از تاریخ', to: 'تا تاریخ',
    accountType: 'نوع', accountActive: 'فعال', accountInactive: 'غیرفعال',
    close: 'بستن', newBalance: 'حساب جدید با مانده صفر ساخته می‌شود؛ برای ثبت مانده افتتاحیه از عملیات «مانده افتتاحیه» استفاده کنید.',
    disableConfirm: 'این حساب غیرفعال شود؟ حساب‌های تاریخی حذف نمی‌شوند و اگر وابستگی فعال داشته باشد، عملیات رد خواهد شد.',
    typeCashBank: 'حساب نقدی/بانکی', typeOther: 'حساب دفتر کل',
  } : {
    title: 'Accounts', subtitle: 'Manage financial accounts and their posted balances.',
    create: 'Create account', search: 'Search account name or code…', allTypes: 'All types',
    allStatuses: 'All statuses', active: 'Active', inactive: 'Inactive',
    name: 'Account name', type: 'Account type', code: 'Account code', balance: 'Current balance',
    status: 'Status', actions: 'Actions', edit: 'Edit', history: 'View ledger',
    totalBalance: 'Total cash and bank balance', activeCount: 'Active accounts',
    accountCount: 'Total accounts', liquidCount: 'Cash and bank accounts', noRows: 'No accounts match these filters.',
    failed: 'Could not load accounts.', retry: 'Retry', createTitle: 'Create account',
    editTitle: 'Edit account', nameRequired: 'Account name is required.', description: 'Description',
    kindCash: 'Cash drawer', kindBank: 'Bank account', kindAsset: 'Non-liquid asset',
    kindLiability: 'Liability', kindEquity: 'Equity', kindRevenue: 'Revenue', kindExpense: 'Expense',
    kind: 'Account category', activeSwitch: 'Account is active', save: 'Save account', cancel: 'Cancel',
    created: 'Account created.', updated: 'Account updated.',
    saveError: 'Could not save this account. Check the details and account dependencies.',
    cashBankNote: 'New cash/bank accounts can be used for transfers and real receipts/payments. Other asset accounts are not treated as liquid.',
    systemNote: 'This is a system account. Its name and description can be edited, but its type, code and active state are locked.',
    dependenciesNote: 'An account used by active payment settings or obligations cannot be deactivated until those dependencies are reassigned.',
    historyTitle: 'Account ledger', currentBalance: 'Current balance', ledger: 'General ledger movements',
    date: 'Date', descriptionCol: 'Description', reference: 'Journal', debit: 'Debit', credit: 'Credit',
    noHistory: 'No movements were found for this account in the selected period.',
    loadHistoryError: 'Could not load this account ledger.', all: 'All', from: 'From date', to: 'To date',
    accountType: 'Type', accountActive: 'Active', accountInactive: 'Inactive',
    close: 'Close', newBalance: 'New accounts start at zero. Use Opening balance to record a real opening balance.',
    disableConfirm: 'Deactivate this account? Historical entries are retained. Active dependencies will prevent deactivation.',
    typeCashBank: 'Cash/bank account', typeOther: 'General ledger account',
  };

  const money = useCallback((minor: number) => formatAccountingMoney(minor, {
    currency, fractionDigits, locale, countryCode: tenant?.country,
    preferences: { currencyDisplay: tenant?.currency_display, digits: tenant?.number_digits, calendar: tenant?.calendar },
  }), [fractionDigits, currency, locale, tenant?.country, tenant?.currency_display, tenant?.number_digits, tenant?.calendar]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const [listResponse, standardResponse] = await Promise.all([
        api.get('/accounting/accounts/managed'),
        api.get('/accounting/accounts'),
      ]);
      setAccounts((listResponse.data.accounts || []) as Account[]);
      setCurrency(standardResponse.data.currency_code || tenant?.currency || 'IRR');
      setFractionDigits(Number(standardResponse.data.accounting_fraction_digits ?? 0));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [tenant]);

  useEffect(() => { void Promise.resolve().then(() => load()); }, [load]);

  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase(locale);
    return accounts.filter((account) => {
      const typeMatches = kindFilter === 'all' || account.account_kind === kindFilter || account.account_type === kindFilter;
      const statusMatches = statusFilter === 'all' || (statusFilter === 'active' ? account.is_active === 1 : account.is_active !== 1);
      const textMatches = !normalizedQuery || account.name.toLocaleLowerCase(locale).includes(normalizedQuery) || account.account_code.toLocaleLowerCase(locale).includes(normalizedQuery);
      return typeMatches && statusMatches && textMatches;
    });
  }, [accounts, kindFilter, locale, query, statusFilter]);

  const liquidBalance = accounts.filter((account) => account.is_liquid).reduce((sum, account) => sum + (account.balance_minor || 0), 0);
  const activeCount = accounts.filter((account) => account.is_active === 1).length;
  const liquidAccountCount = accounts.filter((account) => account.is_liquid && account.is_active === 1).length;

  const kindName = (account: Account) => {
    if (account.account_kind === 'cash' || account.system_key === 'cash_drawer') return text.kindCash;
    if (account.account_kind === 'bank' || account.system_key === 'bank_accounts') return text.kindBank;
    const names: Record<string, string> = {
      asset: text.kindAsset, liability: text.kindLiability, equity: text.kindEquity,
      revenue: text.kindRevenue, expense: text.kindExpense,
    };
    return names[account.account_type] || account.account_type;
  };
  const dateText = (value: string) => formatAccountingDate(value, locale, tenant?.calendar);

  function openCreate() {
    setEditing(null); setName(''); setKind('bank'); setDescription(''); setIsActive(true); setModalOpen(true);
  }
  function openEdit(account: Account) {
    setEditing(account); setName(account.name); setKind(account.account_kind); setDescription(account.description || '');
    setIsActive(account.is_active === 1); setModalOpen(true);
  }
  async function saveAccount(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) { toast.error(text.nameRequired); return; }
    if (editing && editing.is_system === 1 && !isActive && editing.is_active === 1) {
      toast.error(text.systemNote); return;
    }
    if (editing && editing.is_active === 1 && !isActive && !window.confirm(text.disableConfirm)) return;
    setSaving(true);
    try {
      if (editing) {
        await api.put('/accounting/accounts/' + encodeURIComponent(editing.id), { name: name.trim(), description: description.trim(), is_active: isActive });
        toast.success(text.updated);
      } else {
        await api.post('/accounting/accounts', { name: name.trim(), account_kind: kind, description: description.trim(), is_active: isActive });
        toast.success(text.created);
      }
      setModalOpen(false);
      await load();
    } catch (error: unknown) {
      const message = (error as { response?: { data?: { error?: unknown } } })?.response?.data?.error;
      toast.error(accountingErrorMessage(message, locale, text.saveError));
    } finally {
      setSaving(false);
    }
  }

  async function openHistory(account: Account) {
    setHistoryAccount(account);
    setHistory(null);
    setHistoryLoading(true);
    try {
      const params = { limit: 200, ...(from ? { from } : {}), ...(to ? { to } : {}) };
      const response = await api.get('/accounting/accounts/' + encodeURIComponent(account.id) + '/transactions', { params });
      setHistory(response.data as AccountHistory);
    } catch { toast.error(text.loadHistoryError); }
    finally { setHistoryLoading(false); }
  }

  const filteredHistory = (history?.transactions || []).filter((line) =>
    (!from || line.entry_date >= from) && (!to || line.entry_date <= to));
  const typeOptions: Array<{ value: AccountKind; label: string }> = [
    { value: 'cash', label: text.kindCash }, { value: 'bank', label: text.kindBank },
    { value: 'asset', label: text.kindAsset }, { value: 'liability', label: text.kindLiability },
    { value: 'equity', label: text.kindEquity }, { value: 'revenue', label: text.kindRevenue },
    { value: 'expense', label: text.kindExpense },
  ];

  return (
    <section className="acct-accounts space-y-5" dir={fa ? 'rtl' : 'ltr'}>
      <header className="acct-page-heading">
        <div>
          <p className="acct-eyebrow">{fa ? 'حسابداری / دفتر حساب‌ها' : 'Accounting / Chart of accounts'}</p>
          <h1 className="acct-page-title">{text.title}</h1>
          <p className="acct-page-subtitle">{text.subtitle}</p>
        </div>
        <button type="button" className="acct-button acct-button-primary" onClick={openCreate}><Plus size={17} /> {text.create}</button>
      </header>

      <div className="acct-kpi-grid acct-kpi-grid-3">
        <article className="acct-kpi-card"><div className="acct-kpi-heading"><span>{text.totalBalance}</span><span className="acct-kpi-icon"><Wallet size={18} /></span></div><p className="acct-kpi-value">{money(liquidBalance)}</p></article>
        <article className="acct-kpi-card"><div className="acct-kpi-heading"><span>{text.activeCount}</span><span className="acct-kpi-icon is-positive"><CircleCheck size={18} /></span></div><p className="acct-kpi-value">{activeCount.toLocaleString(locale)}</p></article>
        <article className="acct-kpi-card"><div className="acct-kpi-heading"><span>{text.liquidCount}</span><span className="acct-kpi-icon"><Building2 size={18} /></span></div><p className="acct-kpi-value">{liquidAccountCount.toLocaleString(locale)}</p><p className="acct-kpi-foot">{text.accountCount}: {accounts.length.toLocaleString(locale)}</p></article>
      </div>

      <div className="acct-panel">
        <div className="acct-toolbar">
          <label className="acct-search-field"><Search size={17} /><input aria-label={text.search} placeholder={text.search} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          <select className="acct-select" aria-label={text.type} value={kindFilter} onChange={(event) => setKindFilter(event.target.value as typeof kindFilter)}>
            <option value="all">{text.allTypes}</option>
            {typeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <select className="acct-select" aria-label={text.status} value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}>
            <option value="all">{text.allStatuses}</option><option value="active">{text.active}</option><option value="inactive">{text.inactive}</option>
          </select>
        </div>
        {error && <div className="acct-alert acct-alert-danger"><CircleAlert size={18} /><span>{text.failed}</span><button type="button" className="acct-text-button" onClick={() => void load()}>{text.retry}</button></div>}
        {loading ? <div className="acct-empty">{fa ? 'در حال بارگذاری حساب‌ها…' : 'Loading accounts…'}</div> :
          filtered.length === 0 ? <div className="acct-empty"><Wallet size={25} /><span>{text.noRows}</span></div> :
            <div className="acct-table-wrap">
              <table className="acct-table">
                <thead><tr><th>{text.name}</th><th>{text.type}</th><th>{text.code}</th><th className="text-end">{text.balance}</th><th>{text.status}</th><th>{text.actions}</th></tr></thead>
                <tbody>{filtered.map((account) => <tr key={account.id}>
                  <td><div className="acct-account-cell"><span className={account.is_liquid ? 'acct-account-icon' : 'acct-account-icon is-muted'}>{account.account_kind === 'bank' ? <Landmark size={17} /> : account.account_kind === 'cash' ? <Banknote size={17} /> : <Wallet size={17} />}</span><span><strong>{accountingSystemAccountName(account.system_key, account.name, locale)}</strong>{account.description && <span className="acct-subtext block">{accountingSystemDescription(account.description, locale)}</span>}</span></div></td>
                  <td>{kindName(account)}</td>
                  <td><span className="acct-code">{account.account_code}</span></td>
                  <td className="text-end whitespace-nowrap tabular-nums acct-money">{money(account.balance_minor)}</td>
                  <td><span className={account.is_active === 1 ? 'acct-status is-active' : 'acct-status is-inactive'}>{account.is_active === 1 ? text.active : text.inactive}</span></td>
                  <td><div className="acct-row-actions">
                    <button type="button" className="acct-table-action" onClick={() => void openHistory(account)}><Eye size={15} /><span>{text.history}</span></button>
                    <button type="button" className="acct-table-action" onClick={() => openEdit(account)} aria-label={text.edit} title={text.edit}><Pencil size={15} /><span>{text.edit}</span></button>
                  </div></td>
                </tr>)}</tbody>
              </table>
            </div>}
      </div>

      {modalOpen && <div className="acct-modal-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setModalOpen(false); }}>
        <section className="acct-modal" role="dialog" aria-modal="true" aria-labelledby="acct-account-form-title" dir={fa ? 'rtl' : 'ltr'}>
          <div className="acct-modal-heading"><div><h2 id="acct-account-form-title">{editing ? text.editTitle : text.createTitle}</h2><p>{editing ? text.systemNote : text.newBalance}</p></div><button type="button" className="acct-icon-button" onClick={() => setModalOpen(false)} disabled={saving} aria-label={text.close}><X size={18} /></button></div>
          <form onSubmit={(event) => void saveAccount(event)} className="acct-form">
            <label className="acct-field"><span>{text.name} <b>*</b></span><input autoFocus required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} /></label>
            <label className="acct-field"><span>{text.kind}</span><select value={kind} disabled={Boolean(editing)} onChange={(event) => setKind(event.target.value as AccountKind)}>
              {typeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select></label>
            <label className="acct-field"><span>{text.description}</span><textarea rows={3} maxLength={500} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
            {editing ? <label className={editing.is_system === 1 ? 'acct-checkbox is-disabled' : 'acct-checkbox'}>
              <input type="checkbox" checked={isActive} disabled={saving || editing.is_system === 1} onChange={(event) => setIsActive(event.target.checked)} />
              <span>{text.activeSwitch}</span>
            </label> : <label className="acct-checkbox"><input type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} /><span>{text.activeSwitch}</span></label>}
            {!editing && <p className="acct-inline-note">{text.cashBankNote}</p>}
            {editing?.is_system === 1 && <p className="acct-inline-note">{text.systemNote}</p>}
            {editing && editing.is_active === 1 && !isActive && <p className="acct-inline-note is-warning">{text.dependenciesNote}</p>}
            <div className="acct-modal-actions"><button type="button" className="acct-button acct-button-secondary" onClick={() => setModalOpen(false)} disabled={saving}>{text.cancel}</button><button type="submit" className="acct-button acct-button-primary" disabled={saving || !name.trim()}>{saving ? (fa ? 'در حال ذخیره…' : 'Saving…') : text.save}</button></div>
          </form>
        </section>
      </div>}

      {historyAccount && <div className="acct-modal-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) { setHistoryAccount(null); setHistory(null); } }}>
        <section className="acct-history-drawer" role="dialog" aria-modal="true" aria-labelledby="acct-history-title" dir={fa ? 'rtl' : 'ltr'}>
          <div className="acct-modal-heading"><div><p className="acct-eyebrow">{historyAccount.account_code} · {kindName(historyAccount)}</p><h2 id="acct-history-title">{text.historyTitle}: {accountingSystemAccountName(historyAccount.system_key, historyAccount.name, locale)}</h2><p>{accountingSystemDescription(historyAccount.description, locale) || '—'}</p></div><button type="button" className="acct-icon-button" onClick={() => { setHistoryAccount(null); setHistory(null); }} aria-label={text.close}><X size={18} /></button></div>
          <div className="acct-history-balance"><span>{text.currentBalance}</span><strong>{money(history?.account.balance_minor ?? historyAccount.balance_minor)}</strong></div>
          <div className="acct-toolbar acct-history-filters">
            <label className="acct-field"><span>{text.from}</span><JalaliDateInput jalali={locale.toLowerCase().startsWith('fa')} value={from} max={to || undefined} onChange={(event) => setFrom(event.target.value)} /></label>
            <label className="acct-field"><span>{text.to}</span><JalaliDateInput jalali={locale.toLowerCase().startsWith('fa')} value={to} min={from || undefined} onChange={(event) => setTo(event.target.value)} /></label>
            <button type="button" className="acct-button acct-button-secondary" onClick={() => { setFrom(''); setTo(''); }}><X size={15} /> {text.all}</button>
            <button type="button" className="acct-button acct-button-primary" onClick={() => void openHistory(historyAccount)}>{fa ? 'اعمال بازه' : 'Apply range'}</button>
          </div>
          <h3 className="acct-history-section-title">{text.ledger}</h3>
          {historyLoading ? <p className="acct-empty">{fa ? 'در حال بارگذاری گردش حساب…' : 'Loading ledger…'}</p> :
            filteredHistory.length === 0 ? <p className="acct-empty">{text.noHistory}</p> :
              <div className="acct-table-wrap acct-history-table-wrap"><table className="acct-table">
                <thead><tr><th>{text.date}</th><th>{text.descriptionCol}</th><th>{text.reference}</th><th className="text-end">{text.debit}</th><th className="text-end">{text.credit}</th><th className="text-end">{text.balance}</th></tr></thead>
                <tbody>{filteredHistory.map((line) => <tr key={line.journal_entry_id + ':' + line.line_no}>
                  <td className="whitespace-nowrap">{dateText(line.entry_date)}</td><td>{accountingSystemDescription(line.line_description || line.description, locale)}</td><td>{line.entry_number}</td>
                  <td className="text-end whitespace-nowrap tabular-nums">{line.debit_minor ? money(line.debit_minor) : '—'}</td><td className="text-end whitespace-nowrap tabular-nums">{line.credit_minor ? money(line.credit_minor) : '—'}</td><td className="text-end whitespace-nowrap tabular-nums">{money(line.balance_after_minor)}</td>
                </tr>)}</tbody></table></div>}
          <div className="acct-drawer-footer"><span>{fa ? 'سوابق دفترکل حذف یا بازنویسی نمی‌شوند.' : 'Posted ledger history is retained and not overwritten.'}</span><button type="button" className="acct-button acct-button-secondary" onClick={() => { setHistoryAccount(null); setHistory(null); }}>{text.close}<ChevronLeft size={15} /></button></div>
        </section>
      </div>}
    </section>
  );
}
