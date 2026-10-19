'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocale } from 'use-intl';
import api from '@/lib/api';
import toast from 'react-hot-toast';

type Account = { id: string; system_key?: string | null; account_code: string; name: string; account_type: string; is_active: number; is_postable: number; is_liquid?: boolean };
type SourceClassification = 'cash_on_hand' | 'bank_balance' | 'accounts_receivable' | 'accounts_payable' | 'owner_equity' | 'other_asset' | 'other_liability' | 'other_equity';
type OpeningBalance = { id: string; account_id: string; account_code: string; account_name: string; opening_date: string; amount_minor: number; currency_code: string; source_classification: SourceClassification; journal_entry_id: string; entry_number: string };
type AccountTransaction = { journal_entry_id: string; entry_number: string; entry_date: string; description: string; line_description: string | null; currency_code: string; source_type: string | null; source_event: string | null; debit_minor: number; credit_minor: number; balance_after_minor: number };
type AccountHistory = { account: Account & { balance_minor: number }; transactions: AccountTransaction[] };
type ReconciliationOverview = { currency_code: string; cutover_at: string | null; cutover_configured: boolean; legacy: { payment_count: number; payment_total_minor: number; payment_by_method: Array<{ method: string; count: number; amount_minor: number }>; payment_samples: Array<{ source_key: string; bill_number?: string | null; method: string; amount_minor: number; status: string }>; payment_samples_truncated: boolean; unclassified_payment_count: number; malformed_payment_details_count: number; refund_count: number; refund_total_minor: number; refund_samples: any[]; refund_samples_truncated: boolean }; audit_exceptions: Array<{ id: number; entity_id: string; action: string; created_at: string; details: any }>; cash_checkpoints: Array<{ id: number; business_date: string; counted_cash_cents: number; ledger_balance_minor: number | null; difference_minor: number | null; comparison_status: string; unclassified_drawer_movement_count: number | null }>; adjustments: Array<{ id: string; account_code: string; account_name: string; adjustment_date: string; system_balance_minor: number; verified_balance_minor: number; difference_minor: number; reason: string; source_reference: string | null; entry_number: string; journal_status: string }>; adjustment_account_available: boolean };
function classificationForAccount(account?: Account): SourceClassification {
  const systemClassifications: Record<string, SourceClassification> = { cash_drawer: 'cash_on_hand', bank_accounts: 'bank_balance', accounts_receivable: 'accounts_receivable', accounts_payable: 'accounts_payable', owner_capital: 'owner_equity' };
  if (!account) return 'other_asset';
  if (account.system_key && systemClassifications[account.system_key]) return systemClassifications[account.system_key];
  return account.account_type === 'asset' ? 'other_asset' : account.account_type === 'liability' ? 'other_liability' : 'other_equity';
}
type Category = { id: string; name: string; expense_account_id: string; expense_account_name: string; is_active: number };
type Mapping = { payment_method_key: string; payment_method_name: string; account_id: string | null; payment_method_active?: boolean };
type Expense = { id: string; expense_date: string; amount_minor: number; currency_code: string; description: string; category_name: string; payment_status: string; status: string };
type Transfer = { id: string; entry_number: string; entry_date: string; description: string; currency_code: string; amount_minor: number; source_account_name: string; destination_account_name: string };
type Activity = { id: string; entry_number: string; entry_date: string; description: string; currency_code: string; activity_type: 'other_income' | 'owner_contribution' | 'owner_drawing'; amount_minor: number; debit_account_name: string; credit_account_name: string };
const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const labels = {
  en: { title: 'Accounting', activities: 'Income & owner equity', otherIncome: 'Other income', ownerContribution: 'Owner contribution', ownerDrawing: 'Owner drawing', incomeAccount: 'Income account', liquidAccount: 'Cash / bank account', activityHistory: 'Activity history', expenses: 'Expenses', transfers: 'Cash / bank transfers', setup: 'Categories & account mapping', amount: 'Amount', date: 'Date', description: 'Description', category: 'Category', payee: 'Payee (optional)', reference: 'Reference (optional)', paid: 'Paid', unpaid: 'Unpaid', method: 'Payment method', paymentDate: 'Payment date', createExpense: 'Record expense', post: 'Post to ledger', reverse: 'Reverse', reversalReason: 'Reason for reversal', reversalDate: 'Reversal accounting date (YYYY-MM-DD)', status: 'Status', draft: 'Draft', posted: 'Posted', reversed: 'Reversed', transferFrom: 'From account', transferTo: 'To account', transfer: 'Record transfer', history: 'Transfer history', categoryName: 'New category name', expenseAccount: 'Expense account', createCategory: 'Add category', mapping: 'Payment method → accounting account', noRows: 'No records yet', loadFailed: 'Could not load accounting data.', saveFailed: 'Could not save the accounting record.', required: 'Complete all required fields with a valid amount and date.', amountHint: 'Enter an amount in the store currency.', reversalConfirm: 'This creates a separate reversing journal; the original entry remains unchanged.', duplicateAccounts: 'Source and destination must differ.', openingBalances: 'Opening balances', accountHistory: 'Account ledger', reconciliation: 'Cutover reconciliation', bill: 'Bill', legacyEvents: 'Legacy events requiring review', legacyPayments: 'Pre-cutover real-money payments', legacyRefunds: 'Pre-cutover monetary refunds', paymentByMethod: 'Payments by method', sourceKey: 'Source event', cashCheckpoints: 'Cash closure comparisons', countedAtClose: 'Counted cash', cashBalanceAtClose: 'Ledger balance at close', matched: 'Matched', differenceFound: 'Difference found', reviewRequired: 'Manual review required', openingMissing: 'Opening cash balance missing', closeBeforeOpening: 'Close predates opening balance', notComparable: 'Not comparable', auditExceptions: 'Cutover audit exceptions', unclassifiedPayments: 'Unclassified payment lines', malformedPayments: 'Malformed payment details', adjustmentHistory: 'Reconciliation adjustments', verifiedBalance: 'Verified balance', reconciliationDate: 'Adjustment date', reason: 'Reason for adjustment', sourceReference: 'Evidence reference (optional)', createAdjustment: 'Post reconciliation adjustment', systemBalance: 'Ledger balance before adjustment', difference: 'Difference', noExceptions: 'No recorded cutover exceptions.', reconciliationNotice: 'Legacy sales, wallet activity and refunds are not backfilled automatically. Review the source and physical evidence before posting any adjustment. Adjustments use a separate equity account, never sales income or operating expense.', adjustmentAccountMissing: 'The reconciliation offset account is not configured; adjustments are disabled.', paymentSamples: 'Legacy payment samples', refundSamples: 'Legacy refund samples', unclassifiedDrawerMovements: 'Unclassified drawer movements', cutover: 'Cutover timestamp', openingBalanceTitle: 'Record opening balance', sourceClassification: 'Source classification', openingBalanceNotice: 'Only one opening balance is allowed per account. Corrections require a reviewed adjustment.', openingBalanceHistory: 'Recorded opening balances', currentBalance: 'Current balance', loadHistory: 'Load account history', entryNumber: 'Entry', debit: 'Debit', credit: 'Credit', runningBalance: 'Running balance', account: 'Account', noHistory: 'No posted transactions for this account.', cashOnHand: 'Cash on hand', bankBalance: 'Bank balance', accountsReceivable: 'Accounts receivable', accountsPayable: 'Accounts payable', ownerEquity: 'Owner equity', otherAsset: 'Other asset', otherLiability: 'Other liability', otherEquity: 'Other equity' },
  fa: { title: 'حسابداری', activities: 'درآمد متفرقه و سرمایه مالک', otherIncome: 'درآمد متفرقه', ownerContribution: 'آورده مالک', ownerDrawing: 'برداشت مالک', incomeAccount: 'حساب درآمد', liquidAccount: 'حساب صندوق / بانک', activityHistory: 'تاریخچه عملیات', expenses: 'هزینه‌ها', transfers: 'انتقال صندوق و بانک', setup: 'دسته‌بندی و نگاشت حساب‌ها', amount: 'مبلغ', date: 'تاریخ', description: 'شرح', category: 'دسته‌بندی', payee: 'پرداخت به (اختیاری)', reference: 'شماره پیگیری (اختیاری)', paid: 'پرداخت‌شده', unpaid: 'پرداخت‌نشده', method: 'روش پرداخت', paymentDate: 'تاریخ پرداخت', createExpense: 'ثبت هزینه', post: 'ثبت در دفتر کل', reverse: 'برگشت سند', reversalReason: 'دلیل برگشت', reversalDate: 'تاریخ حسابداری برگشت (سال-ماه-روز)', status: 'وضعیت', draft: 'پیش‌نویس', posted: 'ثبت‌شده', reversed: 'برگشت‌خورده', transferFrom: 'حساب مبدأ', transferTo: 'حساب مقصد', transfer: 'ثبت انتقال', history: 'تاریخچه انتقال‌ها', categoryName: 'نام دسته‌بندی جدید', expenseAccount: 'حساب هزینه', createCategory: 'افزودن دسته‌بندی', mapping: 'روش پرداخت ← حسابداری', noRows: 'هنوز رکوردی ثبت نشده است', loadFailed: 'بارگذاری اطلاعات حسابداری انجام نشد.', saveFailed: 'ذخیره اطلاعات حسابداری انجام نشد.', required: 'فیلدهای ضروری، مبلغ معتبر و تاریخ را کامل کنید.', amountHint: 'مبلغ را با واحد پول فروشگاه وارد کنید.', reversalConfirm: 'این عملیات سند معکوس جداگانه می‌سازد و سند اصلی را تغییر نمی‌دهد.', duplicateAccounts: 'حساب مبدأ و مقصد باید متفاوت باشند.', openingBalances: 'مانده‌های افتتاحیه', accountHistory: 'گردش حساب', reconciliation: 'تطبیق شروع حسابداری', bill: 'رسید', legacyEvents: 'رویدادهای قدیمی نیازمند بررسی', legacyPayments: 'دریافت‌های واقعی پیش از شروع حسابداری', legacyRefunds: 'بازپرداخت‌های نقدی قدیمی', paymentByMethod: 'دریافت بر اساس روش پرداخت', sourceKey: 'شناسه رویداد منبع', cashCheckpoints: 'مقایسه با بستن صندوق', countedAtClose: 'وجه شمارش‌شده', cashBalanceAtClose: 'مانده دفتر کل در زمان بستن', matched: 'تطبیق‌شده', differenceFound: 'اختلاف مشاهده شد', reviewRequired: 'نیازمند بررسی دستی', openingMissing: 'مانده افتتاحیه صندوق ثبت نشده', closeBeforeOpening: 'بستن صندوق پیش از مانده افتتاحیه است', notComparable: 'قابل مقایسه نیست', auditExceptions: 'استثناهای ثبت‌شده هنگام شروع حسابداری', unclassifiedPayments: 'خطوط پرداخت طبقه‌بندی‌نشده', malformedPayments: 'جزئیات پرداخت نامعتبر', adjustmentHistory: 'اسناد تعدیلی تطبیق', verifiedBalance: 'مانده تأییدشده', reconciliationDate: 'تاریخ سند تعدیل', reason: 'دلیل تعدیل', sourceReference: 'مرجع مدرک (اختیاری)', createAdjustment: 'ثبت سند تعدیل تطبیق', systemBalance: 'مانده دفتر کل پیش از تعدیل', difference: 'اختلاف', noExceptions: 'استثنای ثبت‌شده‌ای وجود ندارد.', reconciliationNotice: 'فروش‌ها، گردش کیف وفاداری و بازپرداخت‌های قدیمی به‌صورت خودکار وارد دفتر کل نمی‌شوند. قبل از ثبت تعدیل، اسناد منبع و شواهد واقعی را بررسی کنید. تعدیل از حساب جداگانه حقوق مالکانه استفاده می‌کند، نه درآمد فروش یا هزینه عملیاتی.', adjustmentAccountMissing: 'حساب مقابل تعدیل تطبیق تنظیم نشده است؛ ثبت تعدیل غیرفعال است.', paymentSamples: 'نمونه دریافت‌های قدیمی', refundSamples: 'نمونه بازپرداخت‌های قدیمی', unclassifiedDrawerMovements: 'گردش‌های صندوق با طبقه‌بندی نامشخص', cutover: 'زمان شروع حسابداری', openingBalanceTitle: 'ثبت مانده افتتاحیه', sourceClassification: 'طبقه‌بندی منشأ مانده', openingBalanceNotice: 'برای هر حساب فقط یک مانده افتتاحیه ثبت می‌شود؛ اصلاح آن نیازمند سند تعدیلیِ بررسی‌شده است.', openingBalanceHistory: 'مانده‌های افتتاحیه ثبت‌شده', currentBalance: 'مانده فعلی', loadHistory: 'نمایش گردش حساب', entryNumber: 'شماره سند', debit: 'بدهکار', credit: 'بستانکار', runningBalance: 'مانده پس از سند', account: 'حساب', noHistory: 'برای این حساب گردش ثبت‌شده‌ای وجود ندارد.', cashOnHand: 'وجه نقد صندوق', bankBalance: 'مانده بانک', accountsReceivable: 'مطالبات از مشتریان', accountsPayable: 'بدهی به تأمین‌کنندگان', ownerEquity: 'حقوق مالکانه', otherAsset: 'سایر دارایی', otherLiability: 'سایر بدهی', otherEquity: 'سایر حقوق مالکانه' }
};
function amountToMinor(value: string, digits: number, allowZero = false): number | null {
  const normalized = value.trim()
    .replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[٬,]/g, '')
    .replace(/٫/g, '.');
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const parts = normalized.split('.');
  const fraction = parts[1] || '';
  if (fraction.length > digits) return null;
  const minor = Number(parts[0]) * (10 ** digits) + Number((fraction + '0'.repeat(digits)).slice(0, digits) || '0');
  return Number.isSafeInteger(minor) && (allowZero ? minor >= 0 : minor > 0) ? minor : null;
}
type AccountingMode = 'operations' | 'settings';

export function AccountingSettings({ isAdmin, mode = 'operations' }: { isAdmin: boolean; mode?: AccountingMode }) {
  const locale = useLocale();
  const t = locale.toLowerCase().startsWith('fa') ? labels.fa : labels.en;
  const [tab, setTab] = useState<'expenses' | 'transfers' | 'activities' | 'openingBalances' | 'accountHistory' | 'reconciliation' | 'setup'>(mode === 'settings' ? 'setup' : 'expenses');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [currency, setCurrency] = useState('IRR');
  const [categories, setCategories] = useState<Category[]>([]);
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [openingBalances, setOpeningBalances] = useState<OpeningBalance[]>([]);
  const [openingAccount, setOpeningAccount] = useState('');
  const [openingAmount, setOpeningAmount] = useState('');
  const [openingDate, setOpeningDate] = useState(today());
  const [openingClassification, setOpeningClassification] = useState<SourceClassification>('cash_on_hand');
  const [openingDescription, setOpeningDescription] = useState('');
  const [historyAccountId, setHistoryAccountId] = useState('acct-cash-drawer');
  const [accountHistory, setAccountHistory] = useState<AccountHistory | null>(null);
  const [reconciliation, setReconciliation] = useState<ReconciliationOverview | null>(null);
  const [reconciliationAccount, setReconciliationAccount] = useState('acct-cash-drawer');
  const [reconciliationDate, setReconciliationDate] = useState(today());
  const [verifiedBalance, setVerifiedBalance] = useState('');
  const [reconciliationReason, setReconciliationReason] = useState('');
  const [reconciliationReference, setReconciliationReference] = useState('');
  const [activityType, setActivityType] = useState<Activity['activity_type']>('other_income');
  const [activityAmount, setActivityAmount] = useState('');
  const [activityDate, setActivityDate] = useState(today());
  const [activityDescription, setActivityDescription] = useState('');
  const [activityAssetAccount, setActivityAssetAccount] = useState('');
  const [activityIncomeAccount, setActivityIncomeAccount] = useState('');
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
  const expenseRequestKey = useRef('');
  const expenseRequestPayload = useRef('');
  const transferRequestKey = useRef('');
  const transferRequestPayload = useRef('');
  const activityRequestKey = useRef('');
  const activityRequestPayload = useRef('');
  const openingRequestKey = useRef('');
  const openingRequestPayload = useRef('');
  const reconciliationRequestKey = useRef('');
  const reconciliationRequestPayload = useRef('');
  const digits = useMemo(() => {
    try { return new Intl.NumberFormat(locale, { style: 'currency', currency }).resolvedOptions().maximumFractionDigits || 0; } catch { return 0; }
  }, [currency, locale]);
  const load = useCallback(async () => {
    const [accountsResponse, categoriesResponse, mappingsResponse, expensesResponse, transfersResponse, activitiesResponse, openingBalancesResponse, reconciliationResponse] = await Promise.all([
      api.get('/accounting/accounts'),
      api.get('/accounting/expense-categories?include_inactive=true'),
      api.get('/accounting/payment-account-mappings'),
      mode === 'operations' ? api.get('/accounting/expenses?limit=100') : Promise.resolve({ data: { expenses: [] as Expense[] } }),
      mode === 'operations' ? api.get('/accounting/transfers?limit=100') : Promise.resolve({ data: { transfers: [] as Transfer[] } }),
      mode === 'operations' ? api.get('/accounting/activities?limit=100') : Promise.resolve({ data: { activities: [] as Activity[] } }),
      mode === 'operations' ? api.get('/accounting/opening-balances?limit=100') : Promise.resolve({ data: { opening_balances: [] as OpeningBalance[] } }),
      mode === 'operations' ? api.get('/accounting/reconciliation?limit=50').catch(() => ({ data: null as ReconciliationOverview | null })) : Promise.resolve({ data: null as ReconciliationOverview | null }),
    ]);
    const accountRows: Account[] = accountsResponse.data.accounts || [];
    const categoryRows: Category[] = categoriesResponse.data.categories || [];
    setAccounts(accountRows); if (accountsResponse.data.currency_code) setCurrency(accountsResponse.data.currency_code);
    setCategories(categoryRows); setMappings(mappingsResponse.data.mappings || []);
    setExpenses(expensesResponse.data.expenses || []); setTransfers(transfersResponse.data.transfers || []); setActivities(activitiesResponse.data.activities || []); setOpeningBalances(openingBalancesResponse.data.opening_balances || []); setReconciliation(reconciliationResponse.data as ReconciliationOverview | null);
    const assets = accountRows.filter((a) => a.is_liquid === true && a.account_type === 'asset' && a.is_active === 1 && a.is_postable === 1);
    const openingAccounts = accountRows.filter((a) => ['asset', 'liability', 'equity'].includes(a.account_type) && a.is_active === 1 && a.is_postable === 1 && !['inventory', 'opening_balance_equity'].includes(a.system_key || ''));
    setSourceAccount((v) => assets.some((a) => a.id === v) ? v : (assets[0]?.id || ''));
    setDestinationAccount((v) => assets.some((a) => a.id === v) ? v : (assets[1]?.id || assets[0]?.id || ''));
    setActivityAssetAccount((v) => assets.some((a) => a.id === v) ? v : (assets[0]?.id || ''));
    setOpeningAccount((v) => openingAccounts.some((a) => a.id === v) ? v : (openingAccounts.find((a) => a.id === 'acct-cash-drawer')?.id || openingAccounts[0]?.id || ''));
    setHistoryAccountId((v) => accountRows.some((a) => a.id === v && a.is_active === 1 && a.is_postable === 1) ? v : (accountRows.find((a) => a.id === 'acct-cash-drawer')?.id || accountRows.find((a) => a.is_active === 1 && a.is_postable === 1)?.id || ''));
    setActivityIncomeAccount((v) => accountRows.some((a) => a.id === v && a.account_type === 'revenue' && a.is_active === 1 && a.is_postable === 1 && !['acct-sales-revenue','acct-sales-returns','acct-sales-discounts'].includes(a.id)) ? v : (accountRows.find((a) => a.account_type === 'revenue' && a.is_active === 1 && a.is_postable === 1 && !['acct-sales-revenue','acct-sales-returns','acct-sales-discounts'].includes(a.id))?.id || ''));
    setCategoryId((v) => categoryRows.some((c) => c.id === v && c.is_active === 1) ? v : (categoryRows.find((c) => c.is_active === 1)?.id || ''));
    setNewCategoryAccount((v) => accountRows.some((a) => a.id === v && a.account_type === 'expense' && a.is_active === 1 && a.is_postable === 1) ? v : (accountRows.find((a) => a.account_type === 'expense' && a.is_active === 1 && a.is_postable === 1)?.id || ''));
  }, [mode]);
  useEffect(() => {
    // Loading server state here is intentional; the state updates occur after the asynchronous request resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load().catch(() => toast.error(t.loadFailed));
  }, [load, t.loadFailed]);
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
      const payloadSignature = JSON.stringify(payload);
      if (expenseRequestPayload.current !== payloadSignature) {
        expenseRequestPayload.current = payloadSignature;
        expenseRequestKey.current = token();
      }
      const response = await api.post('/accounting/expenses', payload, { headers: { 'Idempotency-Key': expenseRequestKey.current } });
      if (paymentStatus === 'paid' && response.data.expense.status === 'draft') await api.post('/accounting/expenses/' + response.data.expense.id + '/post', {});
      expenseRequestKey.current = ''; expenseRequestPayload.current = '';
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
      const payload = { source_account_id: sourceAccount, destination_account_id: destinationAccount, amount_minor: minor, entry_date: transferDate, description: transferDescription.trim() };
      const payloadSignature = JSON.stringify(payload);
      if (transferRequestPayload.current !== payloadSignature) {
        transferRequestPayload.current = payloadSignature;
        transferRequestKey.current = token();
      }
      await api.post('/accounting/transfers', payload, { headers: { 'Idempotency-Key': transferRequestKey.current } });
      transferRequestKey.current = ''; transferRequestPayload.current = '';
      setTransferAmount(''); setTransferDescription(''); await load();
    } catch { toast.error(t.saveFailed); } finally { setBusy(false); }
  }
  async function saveActivity() {
    const minor = amountToMinor(activityAmount, digits);
    if (!activityAssetAccount || !activityDescription.trim() || minor === null || (activityType === 'other_income' && !activityIncomeAccount)) { toast.error(t.required); return; }
    setBusy(true);
    try {
      const payload = { activity_type: activityType, amount_minor: minor, entry_date: activityDate, description: activityDescription.trim(), asset_account_id: activityAssetAccount, ...(activityType === 'other_income' ? { income_account_id: activityIncomeAccount } : {}) };
      const signature = JSON.stringify(payload);
      if (activityRequestPayload.current !== signature) { activityRequestPayload.current = signature; activityRequestKey.current = token(); }
      await api.post('/accounting/activities', payload, { headers: { 'Idempotency-Key': activityRequestKey.current } });
      activityRequestKey.current = ''; activityRequestPayload.current = '';
      setActivityAmount(''); setActivityDescription(''); await load();
    } catch { toast.error(t.saveFailed); } finally { setBusy(false); }
  }
  async function saveOpeningBalance() {
    const minor = amountToMinor(openingAmount, digits);
    if (!openingAccount || !openingDate || minor === null) { toast.error(t.required); return; }
    setBusy(true);
    try {
      const payload = { account_id: openingAccount, entry_date: openingDate, amount_minor: minor, currency_code: currency, source_classification: openingClassification, description: openingDescription.trim() || undefined };
      const signature = JSON.stringify(payload);
      if (openingRequestPayload.current !== signature) { openingRequestPayload.current = signature; openingRequestKey.current = token(); }
      await api.post('/accounting/opening-balances', payload, { headers: { 'Idempotency-Key': openingRequestKey.current } });
      openingRequestKey.current = ''; openingRequestPayload.current = '';
      setOpeningAmount(''); setOpeningDescription(''); await load();
    } catch { toast.error(t.saveFailed); } finally { setBusy(false); }
  }
  async function saveReconciliationAdjustment() {
    const minor = amountToMinor(verifiedBalance, digits, true);
    if (!reconciliationAccount || !reconciliationDate || minor === null || !reconciliationReason.trim()) { toast.error(t.required); return; }
    setBusy(true);
    try {
      const payload = { account_id: reconciliationAccount, adjustment_date: reconciliationDate, verified_balance_minor: minor, reason: reconciliationReason.trim(), source_reference: reconciliationReference.trim() || undefined };
      const signature = JSON.stringify(payload);
      if (reconciliationRequestPayload.current !== signature) { reconciliationRequestPayload.current = signature; reconciliationRequestKey.current = token(); }
      await api.post('/accounting/reconciliation/adjustments', payload, { headers: { 'Idempotency-Key': reconciliationRequestKey.current } });
      reconciliationRequestPayload.current = ''; reconciliationRequestKey.current = '';
      setVerifiedBalance(''); setReconciliationReason(''); setReconciliationReference('');
      await load();
    } catch { toast.error(t.saveFailed); } finally { setBusy(false); }
  }
  async function loadAccountHistory() {
    if (!historyAccountId) { toast.error(t.required); return; }
    setBusy(true);
    try {
      const response = await api.get('/accounting/accounts/' + encodeURIComponent(historyAccountId) + '/transactions?limit=100');
      setAccountHistory(response.data as AccountHistory);
    } catch { toast.error(t.loadFailed); } finally { setBusy(false); }
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
  const activeLiquidAssets = activeAssets.filter((a) => a.is_liquid === true);
  const activeOpeningAccounts = accounts.filter((a) => ['asset', 'liability', 'equity'].includes(a.account_type) && a.is_active === 1 && a.is_postable === 1 && !['inventory', 'opening_balance_equity'].includes(a.system_key || ''));
  const activeExpenses = accounts.filter((a) => a.account_type === 'expense' && a.is_active === 1 && a.is_postable === 1);
  const activeCategories = categories.filter((c) => c.is_active === 1);
  if (!isAdmin) return null;
  return <section className="w-full max-w-5xl space-y-5" dir={locale.toLowerCase().startsWith('fa') ? 'rtl' : 'ltr'}>
    <h2 className="text-xl font-semibold">{t.title}</h2>
    <div className="flex flex-wrap gap-2" role="tablist">
      {(mode === 'settings' ? (['setup'] as const) : (['expenses', 'transfers', 'activities', 'openingBalances', 'accountHistory', 'reconciliation'] as const)).map((key) => <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)} className={tab === key ? 'rounded-lg border border-brand bg-brand/10 px-4 py-2 text-sm text-brand' : 'rounded-lg border border-border px-4 py-2 text-sm'}>{t[key]}</button>)}
    </div>
    {mode === 'operations' && tab === 'expenses' && <div className="space-y-5">
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
    {mode === 'operations' && tab === 'activities' && <div className="space-y-5">
      <form className={cardClass} onSubmit={(e) => { e.preventDefault(); void saveActivity(); }}>
        <h3 className="font-semibold">{t.activities}</h3><p className="text-xs text-muted-foreground">{t.amountHint} · {currency}</p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <label className="space-y-1 text-sm"><span>{t.status}</span><select value={activityType} onChange={(e) => setActivityType(e.target.value as Activity['activity_type'])} className={selectClass}><option value="other_income">{t.otherIncome}</option><option value="owner_contribution">{t.ownerContribution}</option><option value="owner_drawing">{t.ownerDrawing}</option></select></label>
          <label className="space-y-1 text-sm"><span>{t.amount}</span><input required value={activityAmount} onChange={(e) => setActivityAmount(e.target.value)} inputMode="decimal" className={inputClass} /></label>
          <label className="space-y-1 text-sm"><span>{t.date}</span><input required type="date" value={activityDate} onChange={(e) => setActivityDate(e.target.value)} className={inputClass} /></label>
          <label className="space-y-1 text-sm"><span>{t.liquidAccount}</span><select required value={activityAssetAccount} onChange={(e) => setActivityAssetAccount(e.target.value)} className={selectClass}>{activeLiquidAssets.map((a) => <option key={a.id} value={a.id}>{a.account_code} · {a.name}</option>)}</select></label>
          {activityType === 'other_income' && <label className="space-y-1 text-sm"><span>{t.incomeAccount}</span><select required value={activityIncomeAccount} onChange={(e) => setActivityIncomeAccount(e.target.value)} className={selectClass}>{accounts.filter((a) => a.account_type === 'revenue' && a.is_active === 1 && a.is_postable === 1 && !['acct-sales-revenue','acct-sales-returns','acct-sales-discounts'].includes(a.id)).map((a) => <option key={a.id} value={a.id}>{a.account_code} · {a.name}</option>)}</select></label>}
          <label className="space-y-1 text-sm md:col-span-2"><span>{t.description}</span><input required value={activityDescription} onChange={(e) => setActivityDescription(e.target.value)} className={inputClass} /></label>
        </div><button disabled={busy || !activeLiquidAssets.length || (activityType === 'other_income' && !accounts.some((a) => a.account_type === 'revenue' && a.is_active === 1 && a.is_postable === 1 && !['acct-sales-revenue','acct-sales-returns','acct-sales-discounts'].includes(a.id)))} className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{t.activities}</button>
      </form>
      <div className={cardClass}><h3 className="font-semibold">{t.activityHistory}</h3>{activities.length === 0 ? <p className="text-sm text-muted-foreground">{t.noRows}</p> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b"><th className="p-2 text-start">{t.date}</th><th className="p-2 text-start">{t.description}</th><th className="p-2 text-start">{t.status}</th><th className="p-2 text-start">{t.amount}</th><th className="p-2 text-start">{t.liquidAccount}</th></tr></thead><tbody>{activities.map((a) => <tr key={a.id} className="border-b border-border/60"><td className="p-2">{a.entry_date}</td><td className="p-2">{a.description}</td><td className="p-2">{t[a.activity_type === 'other_income' ? 'otherIncome' : a.activity_type === 'owner_contribution' ? 'ownerContribution' : 'ownerDrawing']}</td><td className="p-2 whitespace-nowrap">{money(a.amount_minor)}</td><td className="p-2">{a.activity_type === 'owner_drawing' ? a.credit_account_name : a.debit_account_name}</td></tr>)}</tbody></table></div>}</div>
    </div>}
    {mode === 'operations' && tab === 'openingBalances' && <div className="space-y-5">
      <form className={cardClass} onSubmit={(e) => { e.preventDefault(); void saveOpeningBalance(); }}>
        <h3 className="font-semibold">{t.openingBalanceTitle}</h3>
        <p className="text-xs text-muted-foreground">{t.amountHint} · {currency}</p>
        <p className="text-xs text-muted-foreground">{t.openingBalanceNotice}</p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <label className="space-y-1 text-sm"><span>{t.account}</span><select required value={openingAccount} onChange={(e) => { const id = e.target.value; setOpeningAccount(id); setOpeningClassification(classificationForAccount(activeOpeningAccounts.find((a) => a.id === id))); }} className={selectClass}><option value="">—</option>{activeOpeningAccounts.map((a) => <option key={a.id} value={a.id}>{a.account_code} · {a.name}</option>)}</select></label>
          <label className="space-y-1 text-sm"><span>{t.amount}</span><input required value={openingAmount} onChange={(e) => setOpeningAmount(e.target.value)} inputMode="decimal" className={inputClass} /></label>
          <label className="space-y-1 text-sm"><span>{t.date}</span><input required type="date" value={openingDate} onChange={(e) => setOpeningDate(e.target.value)} className={inputClass} /></label>
          <label className="space-y-1 text-sm"><span>{t.sourceClassification}</span><input readOnly value={t[({cash_on_hand:'cashOnHand',bank_balance:'bankBalance',accounts_receivable:'accountsReceivable',accounts_payable:'accountsPayable',owner_equity:'ownerEquity',other_asset:'otherAsset',other_liability:'otherLiability',other_equity:'otherEquity'} as const)[openingClassification]]} className={inputClass} /></label>
          <label className="space-y-1 text-sm md:col-span-2"><span>{t.description}</span><input value={openingDescription} onChange={(e) => setOpeningDescription(e.target.value)} className={inputClass} /></label>
        </div>
        <button disabled={busy || !activeOpeningAccounts.length} className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{t.openingBalanceTitle}</button>
      </form>
      <div className={cardClass}><h3 className="font-semibold">{t.openingBalanceHistory}</h3>{openingBalances.length === 0 ? <p className="text-sm text-muted-foreground">{t.noRows}</p> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b"><th className="p-2 text-start">{t.date}</th><th className="p-2 text-start">{t.account}</th><th className="p-2 text-start">{t.sourceClassification}</th><th className="p-2 text-start">{t.amount}</th><th className="p-2 text-start">{t.entryNumber}</th></tr></thead><tbody>{openingBalances.map((b) => <tr key={b.id} className="border-b border-border/60"><td className="p-2">{b.opening_date}</td><td className="p-2">{b.account_code} · {b.account_name}</td><td className="p-2">{t[({cash_on_hand:'cashOnHand',bank_balance:'bankBalance',accounts_receivable:'accountsReceivable',accounts_payable:'accountsPayable',owner_equity:'ownerEquity',other_asset:'otherAsset',other_liability:'otherLiability',other_equity:'otherEquity'} as const)[b.source_classification]]}</td><td className="p-2 whitespace-nowrap">{money(b.amount_minor)}</td><td className="p-2">{b.entry_number}</td></tr>)}</tbody></table></div>}</div>
    </div>}
    {mode === 'operations' && tab === 'accountHistory' && <div className={cardClass}>
      <h3 className="font-semibold">{t.accountHistory}</h3>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_auto]"><label className="space-y-1 text-sm"><span>{t.account}</span><select value={historyAccountId} onChange={(e) => { setHistoryAccountId(e.target.value); setAccountHistory(null); }} className={selectClass}><option value="">—</option>{accounts.filter((a) => a.is_active === 1 && a.is_postable === 1).map((a) => <option key={a.id} value={a.id}>{a.account_code} · {a.name}</option>)}</select></label><button type="button" disabled={busy || !historyAccountId} onClick={() => void loadAccountHistory()} className="self-end rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{t.loadHistory}</button></div>
      {accountHistory && <><p className="text-sm">{t.currentBalance}: <strong>{money(accountHistory.account.balance_minor)}</strong></p>{accountHistory.transactions.length === 0 ? <p className="text-sm text-muted-foreground">{t.noHistory}</p> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b"><th className="p-2 text-start">{t.date}</th><th className="p-2 text-start">{t.entryNumber}</th><th className="p-2 text-start">{t.description}</th><th className="p-2 text-start">{t.debit}</th><th className="p-2 text-start">{t.credit}</th><th className="p-2 text-start">{t.runningBalance}</th></tr></thead><tbody>{accountHistory.transactions.map((x, index) => <tr key={x.journal_entry_id + '-' + index} className="border-b border-border/60"><td className="p-2">{x.entry_date}</td><td className="p-2">{x.entry_number}</td><td className="p-2">{x.line_description || x.description}</td><td className="p-2 whitespace-nowrap">{x.debit_minor ? money(x.debit_minor) : '—'}</td><td className="p-2 whitespace-nowrap">{x.credit_minor ? money(x.credit_minor) : '—'}</td><td className="p-2 whitespace-nowrap">{money(x.balance_after_minor)}</td></tr>)}</tbody></table></div>}</>}
    </div>}

    {mode === 'operations' && tab === 'reconciliation' && <div className="space-y-5">
      <div className={cardClass}>
        <h3 className="font-semibold">{t.reconciliation}</h3>
        <p className="text-sm text-muted-foreground">{t.reconciliationNotice}</p>
        <p className="text-sm">{t.cutover}: <strong>{reconciliation?.cutover_at || '—'}</strong></p>
        {!reconciliation?.cutover_configured && <p className="text-sm text-destructive">{t.loadFailed}</p>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-lg border border-border p-3"><div className="text-xs text-muted-foreground">{t.legacyPayments}</div><div className="mt-1 text-lg font-semibold">{reconciliation?.legacy.payment_count ?? 0}</div><div className="text-sm">{money(reconciliation?.legacy.payment_total_minor ?? 0)}</div></div>
          <div className="rounded-lg border border-border p-3"><div className="text-xs text-muted-foreground">{t.legacyRefunds}</div><div className="mt-1 text-lg font-semibold">{reconciliation?.legacy.refund_count ?? 0}</div><div className="text-sm">{money(reconciliation?.legacy.refund_total_minor ?? 0)}</div></div>
          <div className="rounded-lg border border-border p-3"><div className="text-xs text-muted-foreground">{t.unclassifiedPayments}</div><div className="mt-1 text-lg font-semibold">{reconciliation?.legacy.unclassified_payment_count ?? 0}</div></div>
          <div className="rounded-lg border border-border p-3"><div className="text-xs text-muted-foreground">{t.malformedPayments}</div><div className="mt-1 text-lg font-semibold">{reconciliation?.legacy.malformed_payment_details_count ?? 0}</div></div>
        </div>
      </div>
      <div className={cardClass}>
        <h3 className="font-semibold">{t.paymentByMethod}</h3>
        {!reconciliation?.legacy.payment_by_method.length ? <p className="text-sm text-muted-foreground">{t.noRows}</p> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b"><th className="p-2 text-start">{t.method}</th><th className="p-2 text-start">{t.legacyPayments}</th><th className="p-2 text-start">{t.amount}</th></tr></thead><tbody>{reconciliation.legacy.payment_by_method.map((x) => <tr key={x.method} className="border-b border-border/60"><td className="p-2">{x.method}</td><td className="p-2">{x.count}</td><td className="p-2 whitespace-nowrap">{money(x.amount_minor)}</td></tr>)}</tbody></table></div>}
        {reconciliation?.legacy.payment_samples.length ? <><h4 className="pt-2 font-medium">{t.paymentSamples}</h4><div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b"><th className="p-2 text-start">{t.sourceKey}</th><th className="p-2 text-start">{t.bill}</th><th className="p-2 text-start">{t.method}</th><th className="p-2 text-start">{t.amount}</th></tr></thead><tbody>{reconciliation.legacy.payment_samples.map((x) => <tr key={x.source_key} className="border-b border-border/60"><td className="p-2">{x.source_key}</td><td className="p-2">{x.bill_number || '—'}</td><td className="p-2">{x.method}</td><td className="p-2 whitespace-nowrap">{money(x.amount_minor)}</td></tr>)}</tbody></table></div>{reconciliation.legacy.payment_samples_truncated && <p className="text-xs text-muted-foreground">Showing a limited sample; totals include all matching legacy payments.</p>}</> : null}
        {reconciliation?.legacy.refund_samples.length ? <><h4 className="pt-2 font-medium">{t.refundSamples}</h4><div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b"><th className="p-2 text-start">{t.date}</th><th className="p-2 text-start">{t.bill}</th><th className="p-2 text-start">{t.method}</th><th className="p-2 text-start">{t.amount}</th><th className="p-2 text-start">{t.reason}</th></tr></thead><tbody>{reconciliation.legacy.refund_samples.map((x: any) => <tr key={String(x.id)} className="border-b border-border/60"><td className="p-2">{x.created_at}</td><td className="p-2">{x.bill_number || x.bill_id}</td><td className="p-2">{x.method}</td><td className="p-2 whitespace-nowrap">{money(Number(x.amount_minor || 0))}</td><td className="p-2">{x.reason || '—'}</td></tr>)}</tbody></table></div>{reconciliation.legacy.refund_samples_truncated && <p className="text-xs text-muted-foreground">Showing a limited sample; totals include all matching legacy refunds.</p>}</> : null}
      </div>
      <div className={cardClass}>
        <h3 className="font-semibold">{t.cashCheckpoints}</h3>
        {!reconciliation?.cash_checkpoints.length ? <p className="text-sm text-muted-foreground">{t.noRows}</p> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b"><th className="p-2 text-start">{t.date}</th><th className="p-2 text-start">{t.countedAtClose}</th><th className="p-2 text-start">{t.cashBalanceAtClose}</th><th className="p-2 text-start">{t.difference}</th><th className="p-2 text-start">{t.status}</th></tr></thead><tbody>{reconciliation.cash_checkpoints.map((x) => <tr key={x.id} className="border-b border-border/60"><td className="p-2">{x.business_date}</td><td className="p-2 whitespace-nowrap">{money(Number(x.counted_cash_cents))}</td><td className="p-2 whitespace-nowrap">{x.ledger_balance_minor === null ? '—' : money(x.ledger_balance_minor)}</td><td className="p-2 whitespace-nowrap">{x.difference_minor === null ? '—' : money(x.difference_minor)}</td><td className="p-2">{x.comparison_status === 'matched' ? t.matched : x.comparison_status === 'difference' ? t.differenceFound : x.comparison_status === 'requires_review_drawer_movements' ? t.reviewRequired : x.comparison_status === 'opening_balance_missing' ? t.openingMissing : x.comparison_status === 'close_before_opening_balance' ? t.closeBeforeOpening : t.notComparable}{x.unclassified_drawer_movement_count ? <span className="block text-xs text-muted-foreground">{t.unclassifiedDrawerMovements}: {x.unclassified_drawer_movement_count}</span> : null}</td></tr>)}</tbody></table></div>}
      </div>
      <div className={cardClass}>
        <h3 className="font-semibold">{t.auditExceptions}</h3>
        {!reconciliation?.audit_exceptions.length ? <p className="text-sm text-muted-foreground">{t.noExceptions}</p> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b"><th className="p-2 text-start">{t.date}</th><th className="p-2 text-start">{t.sourceKey}</th><th className="p-2 text-start">{t.status}</th><th className="p-2 text-start">{t.description}</th></tr></thead><tbody>{reconciliation.audit_exceptions.map((x) => <tr key={x.id} className="border-b border-border/60"><td className="p-2">{x.created_at}</td><td className="p-2">{x.entity_id}</td><td className="p-2">{x.action}</td><td className="p-2">{x.details?.reason || '—'}</td></tr>)}</tbody></table></div>}
      </div>
      <form className={cardClass} onSubmit={(e) => { e.preventDefault(); void saveReconciliationAdjustment(); }}>
        <h3 className="font-semibold">{t.createAdjustment}</h3><p className="text-xs text-muted-foreground">{t.amountHint} · {currency}</p>
        {!reconciliation?.adjustment_account_available && <p className="text-sm text-destructive">{t.adjustmentAccountMissing}</p>}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <label className="space-y-1 text-sm"><span>{t.account}</span><select required value={reconciliationAccount} onChange={(e) => setReconciliationAccount(e.target.value)} className={selectClass}>{accounts.filter((a) => ['asset','liability'].includes(a.account_type) && a.is_active === 1 && a.is_postable === 1 && !['inventory','opening_balance_equity','reconciliation_adjustment_equity'].includes(a.system_key || '')).map((a) => <option key={a.id} value={a.id}>{a.account_code} · {a.name}</option>)}</select></label>
          <label className="space-y-1 text-sm"><span>{t.reconciliationDate}</span><input required type="date" value={reconciliationDate} onChange={(e) => setReconciliationDate(e.target.value)} className={inputClass} /></label>
          <label className="space-y-1 text-sm"><span>{t.verifiedBalance}</span><input required value={verifiedBalance} onChange={(e) => setVerifiedBalance(e.target.value)} inputMode="decimal" className={inputClass} /></label>
          <label className="space-y-1 text-sm"><span>{t.sourceReference}</span><input value={reconciliationReference} onChange={(e) => setReconciliationReference(e.target.value)} className={inputClass} /></label>
          <label className="space-y-1 text-sm md:col-span-2"><span>{t.reason}</span><input required value={reconciliationReason} onChange={(e) => setReconciliationReason(e.target.value)} className={inputClass} /></label>
        </div>
        <button disabled={busy || !reconciliation?.adjustment_account_available || !reconciliationReason.trim()} className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{t.createAdjustment}</button>
      </form>
      <div className={cardClass}><h3 className="font-semibold">{t.adjustmentHistory}</h3>{!reconciliation?.adjustments.length ? <p className="text-sm text-muted-foreground">{t.noRows}</p> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b"><th className="p-2 text-start">{t.date}</th><th className="p-2 text-start">{t.account}</th><th className="p-2 text-start">{t.entryNumber}</th><th className="p-2 text-start">{t.systemBalance}</th><th className="p-2 text-start">{t.verifiedBalance}</th><th className="p-2 text-start">{t.difference}</th><th className="p-2 text-start">{t.reason}</th><th className="p-2 text-start">{t.sourceReference}</th></tr></thead><tbody>{reconciliation.adjustments.map((x) => <tr key={x.id} className="border-b border-border/60"><td className="p-2">{x.adjustment_date}</td><td className="p-2">{x.account_code} · {x.account_name}</td><td className="p-2">{x.entry_number}</td><td className="p-2 whitespace-nowrap">{money(x.system_balance_minor)}</td><td className="p-2 whitespace-nowrap">{money(x.verified_balance_minor)}</td><td className="p-2 whitespace-nowrap">{money(x.difference_minor)}</td><td className="p-2">{x.reason}</td><td className="p-2">{x.source_reference || '—'}</td></tr>)}</tbody></table></div>}</div>
    </div>}
    {mode === 'operations' && tab === 'transfers' && <div className="space-y-5">
      <form className={cardClass} onSubmit={(e) => { e.preventDefault(); void saveTransfer(); }}><h3 className="font-semibold">{t.transfer}</h3><p className="text-xs text-muted-foreground">{t.amountHint} · {currency}</p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <label className="space-y-1 text-sm"><span>{t.transferFrom}</span><select value={sourceAccount} onChange={(e) => setSourceAccount(e.target.value)} className={selectClass}>{activeLiquidAssets.map((a) => <option key={a.id} value={a.id}>{a.account_code} · {a.name}</option>)}</select></label>
          <label className="space-y-1 text-sm"><span>{t.transferTo}</span><select value={destinationAccount} onChange={(e) => setDestinationAccount(e.target.value)} className={selectClass}>{activeAssets.map((a) => <option key={a.id} value={a.id}>{a.account_code} · {a.name}</option>)}</select></label>
          <label className="space-y-1 text-sm"><span>{t.amount}</span><input required value={transferAmount} onChange={(e) => setTransferAmount(e.target.value)} inputMode="decimal" className={inputClass} /></label>
          <label className="space-y-1 text-sm"><span>{t.date}</span><input required type="date" value={transferDate} onChange={(e) => setTransferDate(e.target.value)} className={inputClass} /></label>
          <label className="space-y-1 text-sm md:col-span-2"><span>{t.description}</span><input required value={transferDescription} onChange={(e) => setTransferDescription(e.target.value)} className={inputClass} /></label>
        </div><button disabled={busy || activeLiquidAssets.length < 2} className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{t.transfer}</button>
      </form>
      <div className={cardClass}><h3 className="font-semibold">{t.history}</h3>{transfers.length === 0 ? <p className="text-sm text-muted-foreground">{t.noRows}</p> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b"><th className="p-2 text-start">{t.date}</th><th className="p-2 text-start">{t.description}</th><th className="p-2 text-start">{t.transferFrom}</th><th className="p-2 text-start">{t.transferTo}</th><th className="p-2 text-start">{t.amount}</th></tr></thead><tbody>{transfers.map((x) => <tr key={x.id} className="border-b border-border/60"><td className="p-2">{x.entry_date}</td><td className="p-2">{x.description}</td><td className="p-2">{x.source_account_name}</td><td className="p-2">{x.destination_account_name}</td><td className="p-2 whitespace-nowrap">{money(x.amount_minor)}</td></tr>)}</tbody></table></div>}</div>
    </div>}
    {mode === 'settings' && tab === 'setup' && <div className="space-y-5">
      <form className={cardClass} onSubmit={(e) => { e.preventDefault(); void saveCategory(); }}><h3 className="font-semibold">{t.setup}</h3><div className="grid grid-cols-1 gap-3 md:grid-cols-2"><label className="space-y-1 text-sm"><span>{t.categoryName}</span><input value={newCategory} onChange={(e) => setNewCategory(e.target.value)} className={inputClass} required /></label><label className="space-y-1 text-sm"><span>{t.expenseAccount}</span><select value={newCategoryAccount} onChange={(e) => setNewCategoryAccount(e.target.value)} className={selectClass}>{activeExpenses.map((a) => <option key={a.id} value={a.id}>{a.account_code} · {a.name}</option>)}</select></label></div><button disabled={busy || !activeExpenses.length} className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{t.createCategory}</button><div className="space-y-2">{categories.map((c) => <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3 text-sm"><span>{c.name}</span><span className="text-muted-foreground">{c.expense_account_name} · {c.is_active ? '✓' : '—'}</span></div>)}</div></form>
      <div className={cardClass}><h3 className="font-semibold">{t.mapping}</h3>{mappings.map((m) => <label key={m.payment_method_key} className="grid grid-cols-1 gap-2 border-b border-border/60 py-2 text-sm md:grid-cols-2"><span>{m.payment_method_name}</span><select disabled={busy} value={m.account_id || ''} onChange={(e) => void saveMapping(m.payment_method_key, e.target.value)} className={selectClass}><option value="">—</option>{accounts.filter((a) => (m.payment_method_key === 'loyalty' ? a.account_type === 'liability' : a.is_liquid === true) && a.is_active === 1 && a.is_postable === 1).map((a) => <option key={a.id} value={a.id}>{a.account_code} · {a.name}</option>)}</select></label>)}</div>
    </div>}
  </section>;
}
