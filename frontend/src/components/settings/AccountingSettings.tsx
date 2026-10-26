'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocale } from 'use-intl';
import { useAuthStore } from '@/store/auth';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import { formatAccountingMoney, getCurrencyUnitAdapter, parseAccountingAmountToMinor } from '@/lib/countries';
import { accountingSystemAccountName, accountingSystemAccountNameByCode, accountingSystemAccountNameFromName, accountingSystemDescription, accountingPaymentMethodName, accountingExpenseCategoryName, accountingStatusLabel, accountingAuditActionLabel, accountingDiagnosticText, formatAccountingDate } from '@/lib/accounting-i18n';

type Account = { id: string; system_key?: string | null; account_code: string; name: string; account_type: string; is_active: number; is_postable: number; is_liquid?: boolean };
type SourceClassification = 'cash_on_hand' | 'bank_balance' | 'accounts_receivable' | 'accounts_payable' | 'owner_equity' | 'other_asset' | 'other_liability' | 'other_equity';
type OpeningBalance = { id: string; account_id: string; account_code: string; account_name: string; opening_date: string; amount_minor: number; currency_code: string; source_classification: SourceClassification; journal_entry_id: string; entry_number: string };
type AccountTransaction = { journal_entry_id: string; entry_number: string; entry_date: string; description: string; line_description: string | null; currency_code: string; source_type: string | null; source_event: string | null; debit_minor: number; credit_minor: number; balance_after_minor: number };
type AccountHistory = { account: Account & { balance_minor: number }; transactions: AccountTransaction[] };
type LegacyRefundSample = { id: string | number; created_at: string; bill_number?: string | null; bill_id?: string | number | null; method: string; amount_minor: number | string | null; reason?: string | null };
type ReconciliationOverview = { currency_code: string; cutover_at: string | null; cutover_business_date: string | null; cutover_configured: boolean; legacy: { payment_count: number; payment_total_minor: number; payment_by_method: Array<{ method: string; count: number; amount_minor: number }>; payment_samples: Array<{ source_key: string; bill_number?: string | null; method: string; amount_minor: number; status: string }>; payment_samples_truncated: boolean; unclassified_payment_count: number; malformed_payment_details_count: number; refund_count: number; refund_total_minor: number; unclassified_refund_count: number; refund_samples: LegacyRefundSample[]; refund_samples_truncated: boolean }; audit_exceptions: Array<{ id: number; entity_id: string; action: string; created_at: string; details: { reason?: string | null; [key: string]: unknown } | null }>; cash_checkpoints: Array<{ id: number; business_date: string; counted_cash_cents: number; counted_cash_minor: number | null; ledger_balance_minor: number | null; difference_minor: number | null; comparison_status: string; unclassified_drawer_movement_count: number | null }>; cash_mapping_account_id: string | null; cash_mapping_matches_drawer: boolean; adjustments: Array<{ id: string; account_code: string; account_name: string; adjustment_date: string; system_balance_minor: number; verified_balance_minor: number; difference_minor: number; reason: string; source_reference: string | null; entry_number: string; journal_status: string }>; adjustment_account_available: boolean };
type SourceEventAuditRow = { event_type: 'receipt' | 'refund' | 'expense'; source_id: string; event_date: string | null; amount: number | null; method: string | null; status: string; journal_entry_ids: string[]; reason: string | null };
type SourceEventAudit = { from: string | null; to: string | null; events: SourceEventAuditRow[]; summary: Record<string, number>; read_only: true };
function classificationForAccount(account?: Account): SourceClassification {
  const systemClassifications: Record<string, SourceClassification> = { cash_drawer: 'cash_on_hand', bank_accounts: 'bank_balance', accounts_receivable: 'accounts_receivable', accounts_payable: 'accounts_payable', owner_capital: 'owner_equity' };
  if (!account) return 'other_asset';
  if (account.system_key && systemClassifications[account.system_key]) return systemClassifications[account.system_key];
  return account.account_type === 'asset' ? 'other_asset' : account.account_type === 'liability' ? 'other_liability' : 'other_equity';
}
type Category = { id: string; name: string; expense_account_id: string; expense_account_name: string; is_active: number };
type Mapping = { payment_method_key: string; payment_method_name: string; account_id: string | null; payment_method_active?: boolean };
type DefaultPaymentAccount = { account_id: string | null; account_code?: string | null; account_name?: string | null; system_key?: string | null };
type Expense = { id: string; category_id: string; expense_date: string; due_date: string | null; amount_minor: number; currency_code: string; description: string; category_name: string; payment_status: string; payment_method_key?: string | null; payment_account_id?: string | null; payment_account_name?: string | null; payment_date?: string | null; payee?: string | null; reference_number?: string | null; is_overdue?: number; status: string };
type Transfer = { id: string; entry_number: string; entry_date: string; description: string; currency_code: string; amount_minor: number; source_account_name: string; destination_account_name: string };
type Activity = { id: string; entry_number: string; entry_date: string; description: string; currency_code: string; activity_type: 'other_income' | 'owner_contribution' | 'owner_drawing'; amount_minor: number; debit_account_name: string; credit_account_name: string };
const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const token = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random());
const labels = {
  en: { title: 'Accounting', activities: 'Income & owner equity', otherIncome: 'Other income', ownerContribution: 'Owner contribution', ownerDrawing: 'Owner drawing', incomeAccount: 'Income account', liquidAccount: 'Cash / bank account', activityHistory: 'Activity history', expenses: 'Expenses', taxPayments: 'Taxes paid', transfers: 'Cash / bank transfers', setup: 'Categories & account mapping', sourceEvents: 'Source event audit', sourceEventCount: 'Events checked', sourceFrom: 'From date (YYYY-MM-DD)', sourceTo: 'To date (YYYY-MM-DD)', filterSourceEvents: 'Apply date filter', invalidSourceEventRange: 'The start date must not be after the end date.', sourceAuditTitle: 'Source-event reconciliation', sourceAuditNotice: 'Read-only audit: this view does not post, repair, backfill, or delete financial records. Investigate unresolved rows before closing a period.', sourceId: 'Source ID', eventType: 'Event type', sourceAmount: 'Source amount (raw)', matchingJournals: 'Matching journal IDs', eventDate: 'Event date', sourceReason: 'Review note', noSourceEvents: 'No source events found.', statusPostedOnce: 'Posted once', statusMissingJournal: 'Missing journal', statusJournalNotPosted: 'Journal not posted', statusDuplicateJournals: 'Duplicate journals', statusMissingIdentity: 'Needs manual review', statusPreCutover: 'Skipped before accounting cutover', statusNonMonetary: 'Excluded non-monetary event', sourceLimitNote: 'Showing up to 2,000 source events. Narrow the date range in a later iteration if this limit is reached.', amount: 'Amount', date: 'Date', description: 'Description', category: 'Category', payee: 'Payee (optional)', reference: 'Reference (optional)', paid: 'Paid', unpaid: 'Unpaid', method: 'Payment method', paymentDate: 'Payment date', dueDate: 'Due date (optional)', paymentAccount: 'Account paid from', overdue: 'Overdue', exportExcel: 'Export Excel', editExpense: 'Edit', updateExpense: 'Save changes', cancelExpense: 'Cancel expense', cancelReason: 'Reason for cancelling this draft expense', cancelConfirm: 'Cancel this unpaid draft expense? The action will be saved in audit history.', stopEditing: 'Stop editing', createExpense: 'Record expense', post: 'Post to ledger', reverse: 'Reverse', reversalReason: 'Reason for reversal', reversalDate: 'Reversal accounting date (YYYY-MM-DD)', status: 'Status', draft: 'Draft', posted: 'Posted', reversed: 'Reversed', transferFrom: 'From account', transferTo: 'To account', transfer: 'Record transfer', history: 'Transfer history', categoryName: 'New category name', expenseAccount: 'Expense account', createCategory: 'Add category', mapping: 'Payment method → accounting account', defaultPaymentAccount: 'Default payment account', useDefaultPaymentAccount: 'Use default account', paymentAccountFallbackHint: 'A method-specific account takes priority. If none is assigned, receipts and refunds use this default account.', noRows: 'No records yet', loadFailed: 'Could not load accounting data.', saveFailed: 'Could not save the accounting record.', required: 'Complete all required fields with a valid amount and date.', amountHint: 'Enter an amount in the store currency.', reversalConfirm: 'This creates a separate reversing journal; the original entry remains unchanged.', duplicateAccounts: 'Source and destination must differ.', openingBalances: 'Opening balances', accountHistory: 'Account ledger', reconciliation: 'Cutover reconciliation', bill: 'Bill', legacyEvents: 'Legacy events requiring review', legacyPayments: 'Pre-cutover real-money payments', legacyRefunds: 'Pre-cutover monetary refunds', paymentByMethod: 'Payments by method', sourceKey: 'Source event', cashCheckpoints: 'Cash closure comparisons', countedAtClose: 'Counted cash', cashBalanceAtClose: 'Ledger balance at close', matched: 'Matched', differenceFound: 'Difference found', reviewRequired: 'Manual review required', openingMissing: 'Opening cash balance missing', closeBeforeOpening: 'Close predates opening balance', notComparable: 'Not comparable', reviewCashMapping: 'Cash payment does not post to the drawer account', auditExceptions: 'Cutover audit exceptions', unclassifiedPayments: 'Unclassified payment lines', unclassifiedRefunds: 'Refunds with unconvertible legacy amounts', malformedPayments: 'Malformed payment details', adjustmentHistory: 'Reconciliation adjustments', verifiedBalance: 'Verified balance', reconciliationDate: 'Adjustment date', reason: 'Reason for adjustment', sourceReference: 'Evidence reference (optional)', createAdjustment: 'Post reconciliation adjustment', systemBalance: 'Ledger balance before adjustment', difference: 'Difference', noExceptions: 'No recorded cutover exceptions.', reconciliationNotice: 'Legacy sales, wallet activity and refunds are not backfilled automatically. Review the source and physical evidence before posting any adjustment. Adjustments use a separate equity account, never sales income or operating expense.', adjustmentAccountMissing: 'The reconciliation offset account is not configured; adjustments are disabled.', paymentSamples: 'Legacy payment samples', refundSamples: 'Legacy refund samples', unclassifiedDrawerMovements: 'Unclassified drawer movements', cutover: 'Cutover timestamp', openingBalanceTitle: 'Record opening balance', sourceClassification: 'Source classification', openingBalanceNotice: 'Only one opening balance is allowed per account. Corrections require a reviewed adjustment.', openingBalanceHistory: 'Recorded opening balances', currentBalance: 'Current balance', loadHistory: 'Load account history', entryNumber: 'Entry', debit: 'Debit', credit: 'Credit', runningBalance: 'Running balance', account: 'Account', noHistory: 'No posted transactions for this account.', cashOnHand: 'Cash on hand', bankBalance: 'Bank balance', accountsReceivable: 'Accounts receivable', accountsPayable: 'Accounts payable', ownerEquity: 'Owner equity', otherAsset: 'Other asset', otherLiability: 'Other liability', otherEquity: 'Other equity' },
  fa: { title: 'حسابداری', activities: 'درآمد متفرقه و سرمایه مالک', otherIncome: 'درآمد متفرقه', ownerContribution: 'آورده مالک', ownerDrawing: 'برداشت مالک', incomeAccount: 'حساب درآمد', liquidAccount: 'حساب صندوق / بانک', activityHistory: 'تاریخچه عملیات', expenses: 'هزینه‌ها', taxPayments: 'مالیات پرداخت‌شده', transfers: 'انتقال صندوق و بانک', setup: 'دسته‌بندی و نگاشت حساب‌ها', sourceEvents: 'تطبیق رویدادهای مالی', sourceEventCount: 'رویدادهای بررسی‌شده', sourceFrom: 'از تاریخ (سال-ماه-روز)', sourceTo: 'تا تاریخ (سال-ماه-روز)', filterSourceEvents: 'اعمال بازه تاریخ', invalidSourceEventRange: 'تاریخ شروع نباید بعد از تاریخ پایان باشد.', sourceAuditTitle: 'بررسی رویدادهای منبع', sourceAuditNotice: 'این صفحه فقط برای بررسی است و سندی ثبت، اصلاح، وارد یا حذف نمی‌کند. قبل از بستن دوره، موارد حل‌نشده را بررسی کنید.', sourceId: 'شناسه منبع', eventType: 'نوع رویداد', sourceAmount: 'مبلغ خام منبع', matchingJournals: 'شناسه اسناد حسابداری', eventDate: 'تاریخ رویداد', sourceReason: 'توضیح بررسی', noSourceEvents: 'رویداد منبعی برای نمایش وجود ندارد.', statusPostedOnce: 'یک‌بار ثبت شده', statusMissingJournal: 'سند حسابداری ندارد', statusJournalNotPosted: 'سند نهایی نشده', statusDuplicateJournals: 'اسناد تکراری', statusMissingIdentity: 'نیازمند بررسی دستی', statusPreCutover: 'قبل از شروع حسابداری؛ ثبت نشده', statusNonMonetary: 'غیرمالی؛ خارج از حسابداری', sourceLimitNote: 'حداکثر ۲۰۰۰ رویداد نمایش داده می‌شود؛ در صورت رسیدن به این حد باید بازه محدودتر انتخاب شود.', amount: 'مبلغ', date: 'تاریخ', description: 'شرح', category: 'دسته‌بندی', payee: 'پرداخت به (اختیاری)', reference: 'شماره پیگیری (اختیاری)', paid: 'پرداخت‌شده', unpaid: 'پرداخت‌نشده', method: 'روش پرداخت', paymentDate: 'تاریخ پرداخت', dueDate: 'تاریخ سررسید (اختیاری)', paymentAccount: 'حساب پرداخت‌کننده', overdue: 'عقب‌افتاده', exportExcel: 'خروجی اکسل', editExpense: 'ویرایش', updateExpense: 'ذخیره تغییرات', cancelExpense: 'لغو هزینه', cancelReason: 'دلیل لغو این پیش‌نویس', cancelConfirm: 'این هزینه پرداخت‌نشده لغو شود؟ عملیات در تاریخچه حسابرسی ثبت می‌شود.', stopEditing: 'لغو ویرایش', createExpense: 'ثبت هزینه', post: 'ثبت در دفتر کل', reverse: 'برگشت سند', reversalReason: 'دلیل برگشت', reversalDate: 'تاریخ حسابداری برگشت (سال-ماه-روز)', status: 'وضعیت', draft: 'پیش‌نویس', posted: 'ثبت‌شده', reversed: 'برگشت‌خورده', transferFrom: 'حساب مبدأ', transferTo: 'حساب مقصد', transfer: 'ثبت انتقال', history: 'تاریخچه انتقال‌ها', categoryName: 'نام دسته‌بندی جدید', expenseAccount: 'حساب هزینه', createCategory: 'افزودن دسته‌بندی', mapping: 'روش پرداخت ← حسابداری', defaultPaymentAccount: 'حساب پیش‌فرض روش‌های پرداخت', useDefaultPaymentAccount: 'استفاده از حساب پیش‌فرض', paymentAccountFallbackHint: 'حساب اختصاصی روش پرداخت اولویت دارد؛ اگر تعیین نشده باشد، دریافت و بازپرداخت به حساب پیش‌فرض ثبت می‌شود.', noRows: 'هنوز رکوردی ثبت نشده است', loadFailed: 'بارگذاری اطلاعات حسابداری انجام نشد.', saveFailed: 'ذخیره اطلاعات حسابداری انجام نشد.', required: 'فیلدهای ضروری، مبلغ معتبر و تاریخ را کامل کنید.', amountHint: 'مبلغ را با واحد پول فروشگاه وارد کنید.', reversalConfirm: 'این عملیات سند معکوس جداگانه می‌سازد و سند اصلی را تغییر نمی‌دهد.', duplicateAccounts: 'حساب مبدأ و مقصد باید متفاوت باشند.', openingBalances: 'مانده‌های افتتاحیه', accountHistory: 'گردش حساب', reconciliation: 'تطبیق شروع حسابداری', bill: 'رسید', legacyEvents: 'رویدادهای قدیمی نیازمند بررسی', legacyPayments: 'دریافت‌های واقعی پیش از شروع حسابداری', legacyRefunds: 'بازپرداخت‌های نقدی قدیمی', paymentByMethod: 'دریافت بر اساس روش پرداخت', sourceKey: 'شناسه رویداد منبع', cashCheckpoints: 'مقایسه با بستن صندوق', countedAtClose: 'وجه شمارش‌شده', cashBalanceAtClose: 'مانده دفتر کل در زمان بستن', matched: 'تطبیق‌شده', differenceFound: 'اختلاف مشاهده شد', reviewRequired: 'نیازمند بررسی دستی', openingMissing: 'مانده افتتاحیه صندوق ثبت نشده', closeBeforeOpening: 'بستن صندوق پیش از مانده افتتاحیه است', notComparable: 'قابل مقایسه نیست', reviewCashMapping: 'روش پرداخت نقدی به حساب صندوق ثبت نمی‌شود', auditExceptions: 'استثناهای ثبت‌شده هنگام شروع حسابداری', unclassifiedPayments: 'خطوط پرداخت طبقه‌بندی‌نشده', unclassifiedRefunds: 'بازپرداخت با مبلغ قدیمی غیرقابل تبدیل', malformedPayments: 'جزئیات پرداخت نامعتبر', adjustmentHistory: 'اسناد تعدیلی تطبیق', verifiedBalance: 'مانده تأییدشده', reconciliationDate: 'تاریخ سند تعدیل', reason: 'دلیل تعدیل', sourceReference: 'مرجع مدرک (اختیاری)', createAdjustment: 'ثبت سند تعدیل تطبیق', systemBalance: 'مانده دفتر کل پیش از تعدیل', difference: 'اختلاف', noExceptions: 'استثنای ثبت‌شده‌ای وجود ندارد.', reconciliationNotice: 'فروش‌ها، گردش کیف وفاداری و بازپرداخت‌های قدیمی به‌صورت خودکار وارد دفتر کل نمی‌شوند. قبل از ثبت تعدیل، اسناد منبع و شواهد واقعی را بررسی کنید. تعدیل از حساب جداگانه حقوق مالکانه استفاده می‌کند، نه درآمد فروش یا هزینه عملیاتی.', adjustmentAccountMissing: 'حساب مقابل تعدیل تطبیق تنظیم نشده است؛ ثبت تعدیل غیرفعال است.', paymentSamples: 'نمونه دریافت‌های قدیمی', refundSamples: 'نمونه بازپرداخت‌های قدیمی', unclassifiedDrawerMovements: 'گردش‌های صندوق با طبقه‌بندی نامشخص', cutover: 'زمان شروع حسابداری', openingBalanceTitle: 'ثبت مانده افتتاحیه', sourceClassification: 'طبقه‌بندی منشأ مانده', openingBalanceNotice: 'برای هر حساب فقط یک مانده افتتاحیه ثبت می‌شود؛ اصلاح آن نیازمند سند تعدیلیِ بررسی‌شده است.', openingBalanceHistory: 'مانده‌های افتتاحیه ثبت‌شده', currentBalance: 'مانده فعلی', loadHistory: 'نمایش گردش حساب', entryNumber: 'شماره سند', debit: 'بدهکار', credit: 'بستانکار', runningBalance: 'مانده پس از سند', account: 'حساب', noHistory: 'برای این حساب گردش ثبت‌شده‌ای وجود ندارد.', cashOnHand: 'وجه نقد صندوق', bankBalance: 'مانده بانک', accountsReceivable: 'مطالبات از مشتریان', accountsPayable: 'بدهی به تأمین‌کنندگان', ownerEquity: 'حقوق مالکانه', otherAsset: 'سایر دارایی', otherLiability: 'سایر بدهی', otherEquity: 'سایر حقوق مالکانه' }
};
type AccountingMode = 'operations' | 'settings';

export function AccountingSettings({ isAdmin, mode = 'operations' }: { isAdmin: boolean; mode?: AccountingMode }) {
  const locale = useLocale();
  const tenant = useAuthStore((state) => state.currentTenant);
  const t = locale.toLowerCase().startsWith('fa') ? labels.fa : labels.en;
  const [tab, setTab] = useState<'expenses' | 'transfers' | 'activities' | 'openingBalances' | 'accountHistory' | 'reconciliation' | 'sourceEvents' | 'setup'>(mode === 'settings' ? 'setup' : 'expenses');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [currency, setCurrency] = useState('IRR');
  const [fractionDigits, setFractionDigits] = useState(0);
  const [categories, setCategories] = useState<Category[]>([]);
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [defaultPaymentAccountId, setDefaultPaymentAccountId] = useState('acct-payment-clearing');
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
  const [sourceEventAudit, setSourceEventAudit] = useState<SourceEventAudit | null>(null);
  const [sourceEventFrom, setSourceEventFrom] = useState('');
  const [sourceEventTo, setSourceEventTo] = useState('');
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
  const [dueDate, setDueDate] = useState('');
  const [paymentDate, setPaymentDate] = useState(today());
  const [payee, setPayee] = useState('');
  const [reference, setReference] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [paymentStatus, setPaymentStatus] = useState<'paid' | 'unpaid'>('paid');
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [expensePaymentAccountId, setExpensePaymentAccountId] = useState('acct-cash-drawer');
  const [editingExpenseId, setEditingExpenseId] = useState<string | null>(null);
  const [expenseFilter, setExpenseFilter] = useState<'all' | 'paid' | 'unpaid' | 'overdue'>('all');
  const [newCategory, setNewCategory] = useState('');
  const [newCategoryAccount, setNewCategoryAccount] = useState('');
  const [sourceAccount, setSourceAccount] = useState('');
  const [destinationAccount, setDestinationAccount] = useState('');
  const [transferAmount, setTransferAmount] = useState('');
  const [transferDate, setTransferDate] = useState(today());
  const [transferDescription, setTransferDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [reversalExpense, setReversalExpense] = useState<Expense | null>(null);
  const [reversalReasonValue, setReversalReasonValue] = useState('');
  const [reversalDateValue, setReversalDateValue] = useState(today());
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
  const reconciliationDateInitialized = useRef(false);
  const load = useCallback(async () => {
    const [accountsResponse, categoriesResponse, mappingsResponse, expensesResponse, transfersResponse, activitiesResponse, openingBalancesResponse, reconciliationResponse, sourceEventResponse] = await Promise.all([
      api.get('/accounting/accounts'),
      api.get('/accounting/expense-categories?include_inactive=true'),
      api.get('/accounting/payment-account-mappings'),
      mode === 'operations' ? api.get('/accounting/expenses?limit=100' + (expenseFilter === 'all' ? '' : expenseFilter === 'overdue' ? '&overdue=true' : '&payment_status=' + expenseFilter)) : Promise.resolve({ data: { expenses: [] as Expense[] } }),
      mode === 'operations' ? api.get('/accounting/transfers?limit=100') : Promise.resolve({ data: { transfers: [] as Transfer[] } }),
      mode === 'operations' ? api.get('/accounting/activities?limit=100') : Promise.resolve({ data: { activities: [] as Activity[] } }),
      mode === 'operations' ? api.get('/accounting/opening-balances?limit=100') : Promise.resolve({ data: { opening_balances: [] as OpeningBalance[] } }),
      mode === 'operations' ? api.get('/accounting/reconciliation?limit=50').catch(() => ({ data: null as ReconciliationOverview | null })) : Promise.resolve({ data: null as ReconciliationOverview | null }),
      mode === 'operations' ? api.get('/accounting/source-events?limit=2000').catch(() => ({ data: null as SourceEventAudit | null })) : Promise.resolve({ data: null as SourceEventAudit | null }),
    ]);
    const accountRows: Account[] = accountsResponse.data.accounts || [];
    const categoryRows: Category[] = categoriesResponse.data.categories || [];
    setAccounts(accountRows); if (accountsResponse.data.currency_code) setCurrency(accountsResponse.data.currency_code);
    setFractionDigits(Number(accountsResponse.data.accounting_fraction_digits ?? 0));
    setCategories(categoryRows); setMappings(mappingsResponse.data.mappings || []);
    setDefaultPaymentAccountId((mappingsResponse.data.default_account as DefaultPaymentAccount | undefined)?.account_id || '');
    setExpenses(expensesResponse.data.expenses || []); setTransfers(transfersResponse.data.transfers || []); setActivities(activitiesResponse.data.activities || []); setOpeningBalances(openingBalancesResponse.data.opening_balances || []); const reconciliationData = reconciliationResponse.data as ReconciliationOverview | null; setReconciliation(reconciliationData); setSourceEventAudit(sourceEventResponse.data as SourceEventAudit | null); if (reconciliationData?.cutover_business_date && !reconciliationDateInitialized.current) { setReconciliationDate(reconciliationData.cutover_business_date); reconciliationDateInitialized.current = true; }
    const assets = accountRows.filter((a) => a.is_liquid === true && a.account_type === 'asset' && a.is_active === 1 && a.is_postable === 1);
    const openingAccounts = accountRows.filter((a) => ['asset', 'liability', 'equity'].includes(a.account_type) && a.is_active === 1 && a.is_postable === 1 && !['inventory', 'opening_balance_equity'].includes(a.system_key || ''));
    setExpensePaymentAccountId((v) => assets.some((a) => a.id === v) ? v : (assets.find((a) => a.id === 'acct-cash-drawer')?.id || assets[0]?.id || ''));
    setSourceAccount((v) => assets.some((a) => a.id === v) ? v : (assets[0]?.id || ''));
    setDestinationAccount((v) => assets.some((a) => a.id === v) ? v : (assets[1]?.id || assets[0]?.id || ''));
    setActivityAssetAccount((v) => assets.some((a) => a.id === v) ? v : (assets[0]?.id || ''));
    setOpeningAccount((v) => openingAccounts.some((a) => a.id === v) ? v : (openingAccounts.find((a) => a.id === 'acct-cash-drawer')?.id || openingAccounts[0]?.id || ''));
    setHistoryAccountId((v) => accountRows.some((a) => a.id === v && a.is_active === 1 && a.is_postable === 1) ? v : (accountRows.find((a) => a.id === 'acct-cash-drawer')?.id || accountRows.find((a) => a.is_active === 1 && a.is_postable === 1)?.id || ''));
    setActivityIncomeAccount((v) => accountRows.some((a) => a.id === v && a.account_type === 'revenue' && a.is_active === 1 && a.is_postable === 1 && !['acct-sales-revenue','acct-sales-returns','acct-sales-discounts'].includes(a.id)) ? v : (accountRows.find((a) => a.account_type === 'revenue' && a.is_active === 1 && a.is_postable === 1 && !['acct-sales-revenue','acct-sales-returns','acct-sales-discounts'].includes(a.id))?.id || ''));
    setCategoryId((v) => categoryRows.some((c) => c.id === v && c.is_active === 1) ? v : (categoryRows.find((c) => c.is_active === 1)?.id || ''));
    setNewCategoryAccount((v) => accountRows.some((a) => a.id === v && a.account_type === 'expense' && a.is_active === 1 && a.is_postable === 1) ? v : (accountRows.find((a) => a.account_type === 'expense' && a.is_active === 1 && a.is_postable === 1)?.id || ''));
  }, [mode, expenseFilter]);
  useEffect(() => {
    // Loading server state here is intentional; the state updates occur after the asynchronous request resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load().catch(() => toast.error(t.loadFailed));
  }, [load, t.loadFailed]);
  const preferences = useMemo(() => ({ currencyDisplay: tenant?.currency_display, digits: tenant?.number_digits, calendar: tenant?.calendar }), [tenant?.currency_display, tenant?.number_digits, tenant?.calendar]);
  const unitAdapter = useMemo(() => getCurrencyUnitAdapter(currency, tenant?.country, preferences), [currency, tenant?.country, preferences]);
  const money = (minor: number) => formatAccountingMoney(minor, {
    currency, fractionDigits, locale, countryCode: tenant?.country, preferences,
  });
  const parseAmount = (value: string, allowZero = false) => parseAccountingAmountToMinor(value, {
    currency, fractionDigits, locale, countryCode: tenant?.country, preferences,
  }, allowZero);
  const selectClass = 'w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground';
  const inputClass = selectClass;
  const cardClass = 'rounded-xl border border-border bg-card p-4 space-y-3';

  async function saveExpense() {
    const minor = parseAmount(amount);
    if (!categoryId || !description.trim() || minor === null || !expenseDate || (paymentStatus === 'paid' && (!paymentDate || !expensePaymentAccountId || !paymentMethod))) { toast.error(t.required); return; }
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { category_id: categoryId, amount_minor: minor, currency_code: currency, description: description.trim(), expense_date: expenseDate, due_date: dueDate || null, payment_status: paymentStatus, payee: payee.trim() || null, reference_number: reference.trim() || null };
      if (paymentStatus === 'paid') Object.assign(payload, { payment_method_key: paymentMethod, payment_account_id: expensePaymentAccountId, payment_date: paymentDate });
      let savedExpense: Expense;
      if (editingExpenseId) {
        const response = await api.put('/accounting/expenses/' + editingExpenseId, payload);
        savedExpense = response.data.expense as Expense;
      } else {
        const payloadSignature = JSON.stringify(payload);
        if (expenseRequestPayload.current !== payloadSignature) {
          expenseRequestPayload.current = payloadSignature;
          expenseRequestKey.current = token();
        }
        const response = await api.post('/accounting/expenses', payload, { headers: { 'Idempotency-Key': expenseRequestKey.current } });
        savedExpense = response.data.expense as Expense;
        // Compatibility only for drafts created by an older build. New paid expenses
        // are posted atomically by the backend as part of the create transaction.
        if (paymentStatus === 'paid' && savedExpense.status === 'draft') {
          const posted = await api.post('/accounting/expenses/' + savedExpense.id + '/post', {});
          savedExpense = posted.data.expense as Expense;
        }
        expenseRequestKey.current = ''; expenseRequestPayload.current = '';
      }
      setEditingExpenseId(null); setAmount(''); setDescription(''); setPayee(''); setReference(''); setDueDate('');
      setExpenseDate(today()); setPaymentDate(today()); setPaymentStatus('paid'); setPaymentMethod('cash');
      setExpensePaymentAccountId(accounts.find((a) => a.id === 'acct-cash-drawer' && a.is_active === 1 && a.is_postable === 1)?.id || activeLiquidAssets[0]?.id || '');
      await load();
    } catch { toast.error(t.saveFailed); } finally { setBusy(false); }
  }
  function beginEditExpense(expense: Expense) {
    if (expense.status !== 'draft' || expense.payment_status !== 'unpaid') return;
    setEditingExpenseId(expense.id);
    setAmount(String(expense.amount_minor / Math.pow(10, fractionDigits)));
    setDescription(expense.description); setExpenseDate(expense.expense_date); setDueDate(expense.due_date || '');
    setPaymentDate(expense.payment_date || today()); setPayee(expense.payee || ''); setReference(expense.reference_number || '');
    setCategoryId(expense.category_id); setPaymentStatus('unpaid');
    setPaymentMethod('cash'); setExpensePaymentAccountId(expense.payment_account_id || 'acct-cash-drawer');
  }
  function stopEditingExpense() {
    setEditingExpenseId(null); setAmount(''); setDescription(''); setPayee(''); setReference(''); setDueDate('');
    setExpenseDate(today()); setPaymentDate(today()); setPaymentStatus('paid'); setPaymentMethod('cash');
  }
  async function cancelDraftExpense(expense: Expense) {
    const reason = window.prompt(t.cancelReason);
    if (!reason || !reason.trim()) return;
    if (!window.confirm(t.cancelConfirm)) return;
    setBusy(true);
    try {
      await api.post('/accounting/expenses/' + expense.id + '/cancel', { reason: reason.trim() });
      if (editingExpenseId === expense.id) stopEditingExpense();
      await load();
    } catch { toast.error(t.saveFailed); } finally { setBusy(false); }
  }
  async function exportExpensesExcel() {
    setBusy(true);
    try {
      const localeParam = locale.toLowerCase().startsWith('fa') ? 'fa' : 'en';
      const filterParam = expenseFilter === 'all' ? '' : expenseFilter === 'overdue' ? '&overdue=true' : '&payment_status=' + expenseFilter;
      const response = await api.get('/accounting/expenses/export.xlsx?locale=' + localeParam + filterParam, { responseType: 'blob' });
      const downloadUrl = URL.createObjectURL(response.data);
      const anchor = document.createElement('a'); anchor.href = downloadUrl; anchor.download = 'lyrapos-expenses.xlsx';
      document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(downloadUrl);
    } catch { toast.error(t.saveFailed); } finally { setBusy(false); }
  }
  function openReverseExpense(expense: Expense) {
    if (busy || expense.status !== 'posted') return;
    setReversalExpense(expense);
    setReversalReasonValue('');
    setReversalDateValue(today());
  }
  async function submitExpenseReversal(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const expense = reversalExpense;
    const reason = reversalReasonValue.trim();
    if (!expense || busy || expense.status !== 'posted' || !reason || !/^\d{4}-\d{2}-\d{2}$/.test(reversalDateValue)) return;
    setBusy(true);
    try {
      await api.post('/accounting/expenses/' + expense.id + '/reverse', { reason, reversal_date: reversalDateValue });
      setReversalExpense(null);
      setReversalReasonValue('');
      await load();
      toast.success(locale.toLowerCase().startsWith('fa') ? 'سند معکوس با موفقیت ثبت شد.' : 'Reversing journal posted successfully.');
    } catch {
      toast.error(t.saveFailed);
    } finally {
      setBusy(false);
    }
  }
  async function saveTransfer() {
    const minor = parseAmount(transferAmount);
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
    const minor = parseAmount(activityAmount);
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
    const minor = parseAmount(openingAmount);
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
    const minor = parseAmount(verifiedBalance, true);
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
  async function loadSourceEvents() {
    if (sourceEventFrom && sourceEventTo && sourceEventFrom > sourceEventTo) { toast.error(t.invalidSourceEventRange); return; }
    setBusy(true);
    try {
      const params = new URLSearchParams({ limit: '2000' });
      if (sourceEventFrom) params.set('from', sourceEventFrom);
      if (sourceEventTo) params.set('to', sourceEventTo);
      const response = await api.get('/accounting/source-events?' + params.toString());
      setSourceEventAudit(response.data as SourceEventAudit);
    } catch { toast.error(t.loadFailed); } finally { setBusy(false); }
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
    try { await api.put('/accounting/payment-account-mappings/' + encodeURIComponent(key), { account_id: accountId || null }); await load(); }
    catch { toast.error(t.saveFailed); } finally { setBusy(false); }
  }
  async function saveDefaultMapping(accountId: string) {
    if (!accountId) { toast.error(t.required); return; }
    setBusy(true);
    try { await api.put('/accounting/payment-account-mappings/default', { account_id: accountId }); await load(); }
    catch { toast.error(t.saveFailed); } finally { setBusy(false); }
  }
  const sourceStatusLabel = (status: string): string => {
    const statusMap: Record<string, string> = locale.toLowerCase().startsWith('fa') ? {
      posted_once: t.statusPostedOnce, missing_journal: t.statusMissingJournal, journal_not_posted: t.statusJournalNotPosted,
      duplicate_journals: t.statusDuplicateJournals, missing_source_identity: t.statusMissingIdentity,
      skipped_pre_cutover: t.statusPreCutover, excluded_non_monetary: t.statusNonMonetary,
    } : {
      posted_once: t.statusPostedOnce, missing_journal: t.statusMissingJournal, journal_not_posted: t.statusJournalNotPosted,
      duplicate_journals: t.statusDuplicateJournals, missing_source_identity: t.statusMissingIdentity,
      skipped_pre_cutover: t.statusPreCutover, excluded_non_monetary: t.statusNonMonetary,
    };
    return statusMap[status] || accountingStatusLabel(status, locale, locale.toLowerCase().startsWith('fa') ? 'وضعیت نامشخص' : 'Unknown status');
  };
  const sourceEventTypeLabel = (type: SourceEventAuditRow['event_type']): string => {
    if (locale.toLowerCase().startsWith('fa')) return type === 'receipt' ? 'دریافت' : type === 'refund' ? 'بازپرداخت' : 'هزینه';
    return type === 'receipt' ? 'Receipt' : type === 'refund' ? 'Refund' : 'Expense';
  };
  const activeAssets = accounts.filter((a) => a.account_type === 'asset' && a.is_active === 1 && a.is_postable === 1);
  const activeLiquidAssets = activeAssets.filter((a) => a.is_liquid === true);
  const defaultPaymentAccount = accounts.find((a) => a.id === defaultPaymentAccountId);
  const defaultPaymentAccountLabel = defaultPaymentAccount
    ? defaultPaymentAccount.account_code + ' · ' + accountingSystemAccountName(defaultPaymentAccount.system_key, defaultPaymentAccount.name, locale)
    : t.defaultPaymentAccount;
  const activeOpeningAccounts = accounts.filter((a) => ['asset', 'liability', 'equity'].includes(a.account_type) && a.is_active === 1 && a.is_postable === 1 && !['inventory', 'opening_balance_equity'].includes(a.system_key || ''));
  const activeExpenses = accounts.filter((a) => a.account_type === 'expense' && a.is_active === 1 && a.is_postable === 1);
  const activeCategories = categories.filter((c) => c.is_active === 1);
  if (!isAdmin) return null;
  return <section className="w-full max-w-5xl space-y-5" dir={locale.toLowerCase().startsWith('fa') ? 'rtl' : 'ltr'}>
    <h2 className="text-xl font-semibold">{t.title}</h2>
    <div className="flex flex-wrap gap-2" role="tablist">
      {(mode === 'settings' ? (['setup'] as const) : (['expenses', 'transfers', 'activities', 'openingBalances', 'accountHistory', 'reconciliation', 'sourceEvents'] as const)).map((key) => <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)} className={tab === key ? 'rounded-lg border border-brand bg-brand/10 px-4 py-2 text-sm text-brand' : 'rounded-lg border border-border px-4 py-2 text-sm'}>{t[key]}</button>)}
    </div>
    {mode === 'operations' && tab === 'expenses' && <div className="space-y-5">
      <form className={cardClass} onSubmit={(e) => { e.preventDefault(); void saveExpense(); }}>
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{editingExpenseId ? t.editExpense : t.createExpense}</h3>{editingExpenseId && <button type="button" onClick={stopEditingExpense} className="rounded-lg border border-border px-3 py-2 text-sm">{t.stopEditing}</button>}</div>
        <p className="text-xs text-muted-foreground">{t.amountHint} · {unitAdapter.label}</p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <label className="space-y-1 text-sm"><span>{t.amount}</span><input required value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" className={inputClass} /></label>
          <label className="space-y-1 text-sm"><span>{t.date}</span><input required type="date" value={expenseDate} onChange={(e) => setExpenseDate(e.target.value)} className={inputClass} /></label>
          <label className="space-y-1 text-sm"><span>{t.dueDate}</span><input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={inputClass} /></label>
          <label className="space-y-1 text-sm"><span>{t.category}</span><select required value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className={selectClass}><option value="">—</option>{activeCategories.map((c) => <option key={c.id} value={c.id}>{accountingExpenseCategoryName(c.id, c.name, locale, t.taxPayments)}</option>)}</select></label>
          <label className="space-y-1 text-sm"><span>{t.description}</span><input required value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} /></label>
          <label className="space-y-1 text-sm"><span>{t.payee}</span><input value={payee} onChange={(e) => setPayee(e.target.value)} className={inputClass} /></label>
          <label className="space-y-1 text-sm"><span>{t.reference}</span><input value={reference} onChange={(e) => setReference(e.target.value)} className={inputClass} /></label>
          <label className="space-y-1 text-sm"><span>{t.status}</span><select value={paymentStatus} onChange={(e) => setPaymentStatus(e.target.value as 'paid' | 'unpaid')} className={selectClass}><option value="paid">{t.paid}</option><option value="unpaid">{t.unpaid}</option></select></label>
          {paymentStatus === 'paid' && <>
            <label className="space-y-1 text-sm"><span>{t.method}</span><select required value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)} className={selectClass}>{mappings.filter((m) => m.payment_method_active !== false).map((m) => <option key={m.payment_method_key} value={m.payment_method_key}>{accountingPaymentMethodName(m.payment_method_name, locale)}</option>)}</select></label>
            <label className="space-y-1 text-sm"><span>{t.paymentAccount}</span><select required value={expensePaymentAccountId} onChange={(e) => setExpensePaymentAccountId(e.target.value)} className={selectClass}><option value="">—</option>{activeLiquidAssets.map((a) => <option key={a.id} value={a.id}>{a.account_code} · {accountingSystemAccountName(a.system_key, a.name, locale)}</option>)}</select></label>
            <label className="space-y-1 text-sm"><span>{t.paymentDate}</span><input required type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} className={inputClass} /></label>
          </>}
        </div>
        <div className="flex flex-wrap gap-2"><button disabled={busy || !activeCategories.length || (paymentStatus === 'paid' && !activeLiquidAssets.length)} className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{editingExpenseId ? t.updateExpense : t.createExpense}</button></div>
      </form>
      <div className={cardClass}>
        <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-semibold">{t.expenses}</h3><div className="flex flex-wrap gap-2">
          <select aria-label={t.status} value={expenseFilter} onChange={(e) => setExpenseFilter(e.target.value as typeof expenseFilter)} className={selectClass}><option value="all">{t.status}: {locale.toLowerCase().startsWith('fa') ? 'همه' : 'All'}</option><option value="paid">{t.paid}</option><option value="unpaid">{t.unpaid}</option><option value="overdue">{t.overdue}</option></select>
          <button type="button" disabled={busy} onClick={() => void exportExpensesExcel()} className="rounded-lg border border-border px-3 py-2 text-sm">{t.exportExcel}</button>
        </div></div>
        {expenses.length === 0 ? <p className="text-sm text-muted-foreground">{t.noRows}</p> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b"><th className="p-2 text-start">{t.date}</th><th className="p-2 text-start">{t.dueDate}</th><th className="p-2 text-start">{t.description}</th><th className="p-2 text-start">{t.category}</th><th className="p-2 text-start">{t.amount}</th><th className="p-2 text-start">{t.paymentAccount}</th><th className="p-2 text-start">{t.status}</th><th /></tr></thead><tbody>{expenses.map((e) => <tr key={e.id} className="border-b border-border/60"><td className="p-2 whitespace-nowrap">{formatAccountingDate(e.expense_date, locale, tenant?.calendar)}</td><td className="p-2 whitespace-nowrap">{e.due_date ? formatAccountingDate(e.due_date, locale, tenant?.calendar) : '—'}</td><td className="p-2">{e.description}</td><td className="p-2">{accountingExpenseCategoryName(e.category_id, e.category_name, locale, t.taxPayments)}</td><td className="p-2 whitespace-nowrap">{money(e.amount_minor)}</td><td className="p-2 whitespace-nowrap">{e.payment_account_name ? accountingSystemAccountNameFromName(e.payment_account_name, locale) : '—'}</td><td className="p-2">{e.is_overdue ? t.overdue : (t[e.status as 'draft' | 'posted' | 'reversed'] || e.status)} · {e.payment_status === 'paid' ? t.paid : t.unpaid}</td><td className="p-2 whitespace-nowrap">
          {e.status === 'draft' && e.payment_status === 'unpaid' && <><button type="button" disabled={busy} onClick={() => beginEditExpense(e)} className="inline-flex min-h-9 items-center rounded-md border border-border px-3 py-1.5 text-sm font-medium text-brand hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50">{t.editExpense}</button><button type="button" disabled={busy} onClick={() => void cancelDraftExpense(e)} className="ms-3 inline-flex min-h-9 items-center rounded-md border border-destructive/30 px-3 py-1.5 text-sm font-medium text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50">{t.cancelExpense}</button></>}
          {e.status === 'draft' && e.payment_status === 'paid' && <button type="button" disabled={busy} onClick={() => { void api.post('/accounting/expenses/' + e.id + '/post').then(() => load()).catch(() => toast.error(t.saveFailed)); }} className="inline-flex min-h-9 items-center rounded-md border border-border px-3 py-1.5 text-sm font-medium text-brand hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50">{t.post}</button>}
          {e.status === 'posted' && <button type="button" disabled={busy} onClick={() => openReverseExpense(e)} className="inline-flex min-h-9 items-center rounded-md border border-border px-3 py-1.5 text-sm font-medium text-brand hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50">{t.reverse}</button>}
        </td></tr>)}</tbody></table></div>}
      </div>
    </div>}
    {mode === 'operations' && tab === 'activities' && <div className="space-y-5">
      <form className={cardClass} onSubmit={(e) => { e.preventDefault(); void saveActivity(); }}>
        <h3 className="font-semibold">{t.activities}</h3><p className="text-xs text-muted-foreground">{t.amountHint} · {unitAdapter.label}</p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <label className="space-y-1 text-sm"><span>{t.status}</span><select value={activityType} onChange={(e) => setActivityType(e.target.value as Activity['activity_type'])} className={selectClass}><option value="other_income">{t.otherIncome}</option><option value="owner_contribution">{t.ownerContribution}</option><option value="owner_drawing">{t.ownerDrawing}</option></select></label>
          <label className="space-y-1 text-sm"><span>{t.amount}</span><input required value={activityAmount} onChange={(e) => setActivityAmount(e.target.value)} inputMode="decimal" className={inputClass} /></label>
          <label className="space-y-1 text-sm"><span>{t.date}</span><input required type="date" value={activityDate} onChange={(e) => setActivityDate(e.target.value)} className={inputClass} /></label>
          <label className="space-y-1 text-sm"><span>{t.liquidAccount}</span><select required value={activityAssetAccount} onChange={(e) => setActivityAssetAccount(e.target.value)} className={selectClass}>{activeLiquidAssets.map((a) => <option key={a.id} value={a.id}>{a.account_code} · {accountingSystemAccountName(a.system_key, a.name, locale)}</option>)}</select></label>
          {activityType === 'other_income' && <label className="space-y-1 text-sm"><span>{t.incomeAccount}</span><select required value={activityIncomeAccount} onChange={(e) => setActivityIncomeAccount(e.target.value)} className={selectClass}>{accounts.filter((a) => a.account_type === 'revenue' && a.is_active === 1 && a.is_postable === 1 && !['acct-sales-revenue','acct-sales-returns','acct-sales-discounts'].includes(a.id)).map((a) => <option key={a.id} value={a.id}>{a.account_code} · {accountingSystemAccountName(a.system_key, a.name, locale)}</option>)}</select></label>}
          <label className="space-y-1 text-sm md:col-span-2"><span>{t.description}</span><input required value={activityDescription} onChange={(e) => setActivityDescription(e.target.value)} className={inputClass} /></label>
        </div><button disabled={busy || !activeLiquidAssets.length || (activityType === 'other_income' && !accounts.some((a) => a.account_type === 'revenue' && a.is_active === 1 && a.is_postable === 1 && !['acct-sales-revenue','acct-sales-returns','acct-sales-discounts'].includes(a.id)))} className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{t.activities}</button>
      </form>
      <div className={cardClass}><h3 className="font-semibold">{t.activityHistory}</h3>{activities.length === 0 ? <p className="text-sm text-muted-foreground">{t.noRows}</p> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b"><th className="p-2 text-start">{t.date}</th><th className="p-2 text-start">{t.description}</th><th className="p-2 text-start">{t.status}</th><th className="p-2 text-start">{t.amount}</th><th className="p-2 text-start">{t.liquidAccount}</th></tr></thead><tbody>{activities.map((a) => <tr key={a.id} className="border-b border-border/60"><td className="p-2">{formatAccountingDate(a.entry_date, locale, tenant?.calendar)}</td><td className="p-2">{a.description}</td><td className="p-2">{t[a.activity_type === 'other_income' ? 'otherIncome' : a.activity_type === 'owner_contribution' ? 'ownerContribution' : 'ownerDrawing']}</td><td className="p-2 whitespace-nowrap">{money(a.amount_minor)}</td><td className="p-2">{accountingSystemAccountNameFromName(a.activity_type === 'owner_drawing' ? a.credit_account_name : a.debit_account_name, locale)}</td></tr>)}</tbody></table></div>}</div>
    </div>}
    {mode === 'operations' && tab === 'openingBalances' && <div className="space-y-5">
      <form className={cardClass} onSubmit={(e) => { e.preventDefault(); void saveOpeningBalance(); }}>
        <h3 className="font-semibold">{t.openingBalanceTitle}</h3>
        <p className="text-xs text-muted-foreground">{t.amountHint} · {unitAdapter.label}</p>
        <p className="text-xs text-muted-foreground">{t.openingBalanceNotice}</p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <label className="space-y-1 text-sm"><span>{t.account}</span><select required value={openingAccount} onChange={(e) => { const id = e.target.value; setOpeningAccount(id); setOpeningClassification(classificationForAccount(activeOpeningAccounts.find((a) => a.id === id))); }} className={selectClass}><option value="">—</option>{activeOpeningAccounts.map((a) => <option key={a.id} value={a.id}>{a.account_code} · {accountingSystemAccountName(a.system_key, a.name, locale)}</option>)}</select></label>
          <label className="space-y-1 text-sm"><span>{t.amount}</span><input required value={openingAmount} onChange={(e) => setOpeningAmount(e.target.value)} inputMode="decimal" className={inputClass} /></label>
          <label className="space-y-1 text-sm"><span>{t.date}</span><input required type="date" value={openingDate} onChange={(e) => setOpeningDate(e.target.value)} className={inputClass} /></label>
          <label className="space-y-1 text-sm"><span>{t.sourceClassification}</span><input readOnly value={t[({cash_on_hand:'cashOnHand',bank_balance:'bankBalance',accounts_receivable:'accountsReceivable',accounts_payable:'accountsPayable',owner_equity:'ownerEquity',other_asset:'otherAsset',other_liability:'otherLiability',other_equity:'otherEquity'} as const)[openingClassification]]} className={inputClass} /></label>
          <label className="space-y-1 text-sm md:col-span-2"><span>{t.description}</span><input value={openingDescription} onChange={(e) => setOpeningDescription(e.target.value)} className={inputClass} /></label>
        </div>
        <button disabled={busy || !activeOpeningAccounts.length} className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{t.openingBalanceTitle}</button>
      </form>
      <div className={cardClass}><h3 className="font-semibold">{t.openingBalanceHistory}</h3>{openingBalances.length === 0 ? <p className="text-sm text-muted-foreground">{t.noRows}</p> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b"><th className="p-2 text-start">{t.date}</th><th className="p-2 text-start">{t.account}</th><th className="p-2 text-start">{t.sourceClassification}</th><th className="p-2 text-start">{t.amount}</th><th className="p-2 text-start">{t.entryNumber}</th></tr></thead><tbody>{openingBalances.map((b) => <tr key={b.id} className="border-b border-border/60"><td className="p-2">{formatAccountingDate(b.opening_date, locale, tenant?.calendar)}</td><td className="p-2">{b.account_code} · {accountingSystemAccountNameByCode(b.account_code, b.account_name, locale)}</td><td className="p-2">{t[({cash_on_hand:'cashOnHand',bank_balance:'bankBalance',accounts_receivable:'accountsReceivable',accounts_payable:'accountsPayable',owner_equity:'ownerEquity',other_asset:'otherAsset',other_liability:'otherLiability',other_equity:'otherEquity'} as const)[b.source_classification]]}</td><td className="p-2 whitespace-nowrap">{money(b.amount_minor)}</td><td className="p-2">{b.entry_number}</td></tr>)}</tbody></table></div>}</div>
    </div>}
    {mode === 'operations' && tab === 'accountHistory' && <div className={cardClass}>
      <h3 className="font-semibold">{t.accountHistory}</h3>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_auto]"><label className="space-y-1 text-sm"><span>{t.account}</span><select value={historyAccountId} onChange={(e) => { setHistoryAccountId(e.target.value); setAccountHistory(null); }} className={selectClass}><option value="">—</option>{accounts.filter((a) => a.is_active === 1 && a.is_postable === 1).map((a) => <option key={a.id} value={a.id}>{a.account_code} · {accountingSystemAccountName(a.system_key, a.name, locale)}</option>)}</select></label><button type="button" disabled={busy || !historyAccountId} onClick={() => void loadAccountHistory()} className="self-end rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{t.loadHistory}</button></div>
      {accountHistory && <><p className="text-sm">{t.currentBalance}: <strong>{money(accountHistory.account.balance_minor)}</strong></p>{accountHistory.transactions.length === 0 ? <p className="text-sm text-muted-foreground">{t.noHistory}</p> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b"><th className="p-2 text-start">{t.date}</th><th className="p-2 text-start">{t.entryNumber}</th><th className="p-2 text-start">{t.description}</th><th className="p-2 text-start">{t.debit}</th><th className="p-2 text-start">{t.credit}</th><th className="p-2 text-start">{t.runningBalance}</th></tr></thead><tbody>{accountHistory.transactions.map((x, index) => <tr key={x.journal_entry_id + '-' + index} className="border-b border-border/60"><td className="p-2">{formatAccountingDate(x.entry_date, locale, tenant?.calendar)}</td><td className="p-2">{x.entry_number}</td><td className="p-2">{accountingSystemDescription(x.line_description || x.description, locale)}</td><td className="p-2 whitespace-nowrap">{x.debit_minor ? money(x.debit_minor) : '—'}</td><td className="p-2 whitespace-nowrap">{x.credit_minor ? money(x.credit_minor) : '—'}</td><td className="p-2 whitespace-nowrap">{money(x.balance_after_minor)}</td></tr>)}</tbody></table></div>}</>}
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
          <div className="rounded-lg border border-border p-3"><div className="text-xs text-muted-foreground">{t.unclassifiedRefunds}</div><div className="mt-1 text-lg font-semibold">{reconciliation?.legacy.unclassified_refund_count ?? 0}</div></div>
          <div className="rounded-lg border border-border p-3"><div className="text-xs text-muted-foreground">{t.malformedPayments}</div><div className="mt-1 text-lg font-semibold">{reconciliation?.legacy.malformed_payment_details_count ?? 0}</div></div>
        </div>
      </div>
      <div className={cardClass}>
        <h3 className="font-semibold">{t.paymentByMethod}</h3>
        {!reconciliation?.legacy.payment_by_method.length ? <p className="text-sm text-muted-foreground">{t.noRows}</p> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b"><th className="p-2 text-start">{t.method}</th><th className="p-2 text-start">{t.legacyPayments}</th><th className="p-2 text-start">{t.amount}</th></tr></thead><tbody>{reconciliation.legacy.payment_by_method.map((x) => <tr key={x.method} className="border-b border-border/60"><td className="p-2">{accountingPaymentMethodName(x.method, locale)}</td><td className="p-2">{x.count}</td><td className="p-2 whitespace-nowrap">{money(x.amount_minor)}</td></tr>)}</tbody></table></div>}
        {reconciliation?.legacy.payment_samples.length ? <><h4 className="pt-2 font-medium">{t.paymentSamples}</h4><div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b"><th className="p-2 text-start">{t.sourceKey}</th><th className="p-2 text-start">{t.bill}</th><th className="p-2 text-start">{t.method}</th><th className="p-2 text-start">{t.amount}</th></tr></thead><tbody>{reconciliation.legacy.payment_samples.map((x) => <tr key={x.source_key} className="border-b border-border/60"><td className="p-2">{x.source_key}</td><td className="p-2">{x.bill_number || '—'}</td><td className="p-2">{accountingPaymentMethodName(x.method, locale)}</td><td className="p-2 whitespace-nowrap">{money(x.amount_minor)}</td></tr>)}</tbody></table></div>{reconciliation.legacy.payment_samples_truncated && <p className="text-xs text-muted-foreground">{locale.toLowerCase().startsWith('fa') ? 'فقط بخشی از سوابق نمایش داده شده؛ جمع شامل همه دریافت‌های قدیمی منطبق است.' : 'Showing a limited sample; totals include all matching legacy payments.'}</p>}</> : null}
        {reconciliation?.legacy.refund_samples.length ? <><h4 className="pt-2 font-medium">{t.refundSamples}</h4><div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b"><th className="p-2 text-start">{t.date}</th><th className="p-2 text-start">{t.bill}</th><th className="p-2 text-start">{t.method}</th><th className="p-2 text-start">{t.amount}</th><th className="p-2 text-start">{t.reason}</th></tr></thead><tbody>{reconciliation.legacy.refund_samples.map((x) => <tr key={String(x.id)} className="border-b border-border/60"><td className="p-2">{formatAccountingDate(x.created_at, locale, tenant?.calendar)}</td><td className="p-2">{x.bill_number || x.bill_id}</td><td className="p-2">{accountingPaymentMethodName(x.method, locale)}</td><td className="p-2 whitespace-nowrap">{money(Number(x.amount_minor || 0))}</td><td className="p-2">{x.reason || '—'}</td></tr>)}</tbody></table></div>{reconciliation.legacy.refund_samples_truncated && <p className="text-xs text-muted-foreground">{locale.toLowerCase().startsWith('fa') ? 'فقط بخشی از سوابق نمایش داده شده؛ جمع شامل همه بازپرداخت‌های قدیمی منطبق است.' : 'Showing a limited sample; totals include all matching legacy refunds.'}</p>}</> : null}
      </div>
      <div className={cardClass}>
        <h3 className="font-semibold">{t.cashCheckpoints}</h3>
        {!reconciliation?.cash_checkpoints.length ? <p className="text-sm text-muted-foreground">{t.noRows}</p> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b"><th className="p-2 text-start">{t.date}</th><th className="p-2 text-start">{t.countedAtClose}</th><th className="p-2 text-start">{t.cashBalanceAtClose}</th><th className="p-2 text-start">{t.difference}</th><th className="p-2 text-start">{t.status}</th></tr></thead><tbody>{reconciliation.cash_checkpoints.map((x) => <tr key={x.id} className="border-b border-border/60"><td className="p-2">{formatAccountingDate(x.business_date, locale, tenant?.calendar)}</td><td className="p-2 whitespace-nowrap">{x.counted_cash_minor === null ? '—' : money(x.counted_cash_minor)}</td><td className="p-2 whitespace-nowrap">{x.ledger_balance_minor === null ? '—' : money(x.ledger_balance_minor)}</td><td className="p-2 whitespace-nowrap">{x.difference_minor === null ? '—' : money(x.difference_minor)}</td><td className="p-2">{x.comparison_status === 'matched' ? t.matched : x.comparison_status === 'difference' ? t.differenceFound : x.comparison_status === 'requires_review_drawer_movements' ? t.reviewRequired : x.comparison_status === 'requires_review_cash_mapping' ? t.reviewCashMapping : x.comparison_status === 'opening_balance_missing' ? t.openingMissing : x.comparison_status === 'close_before_opening_balance' ? t.closeBeforeOpening : t.notComparable}{x.unclassified_drawer_movement_count ? <span className="block text-xs text-muted-foreground">{t.unclassifiedDrawerMovements}: {x.unclassified_drawer_movement_count}</span> : null}</td></tr>)}</tbody></table></div>}
      </div>
      <div className={cardClass}>
        <h3 className="font-semibold">{t.auditExceptions}</h3>
        {!reconciliation?.audit_exceptions.length ? <p className="text-sm text-muted-foreground">{t.noExceptions}</p> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b"><th className="p-2 text-start">{t.date}</th><th className="p-2 text-start">{t.sourceKey}</th><th className="p-2 text-start">{t.status}</th><th className="p-2 text-start">{t.description}</th></tr></thead><tbody>{reconciliation.audit_exceptions.map((x) => <tr key={x.id} className="border-b border-border/60"><td className="p-2">{formatAccountingDate(x.created_at, locale, tenant?.calendar)}</td><td className="p-2">{x.entity_id}</td><td className="p-2">{accountingAuditActionLabel(x.action, locale)}</td><td className="p-2">{accountingDiagnosticText(x.details?.reason, locale)}</td></tr>)}</tbody></table></div>}
      </div>
      <form className={cardClass} onSubmit={(e) => { e.preventDefault(); void saveReconciliationAdjustment(); }}>
        <h3 className="font-semibold">{t.createAdjustment}</h3><p className="text-xs text-muted-foreground">{t.amountHint} · {unitAdapter.label}</p>
        {!reconciliation?.adjustment_account_available && <p className="text-sm text-destructive">{t.adjustmentAccountMissing}</p>}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <label className="space-y-1 text-sm"><span>{t.account}</span><select required value={reconciliationAccount} onChange={(e) => setReconciliationAccount(e.target.value)} className={selectClass}>{accounts.filter((a) => ['asset','liability'].includes(a.account_type) && a.is_active === 1 && a.is_postable === 1 && !['inventory','opening_balance_equity','reconciliation_adjustment_equity'].includes(a.system_key || '')).map((a) => <option key={a.id} value={a.id}>{a.account_code} · {accountingSystemAccountName(a.system_key, a.name, locale)}</option>)}</select></label>
          <label className="space-y-1 text-sm"><span>{t.reconciliationDate}</span><input required type="date" value={reconciliationDate} onChange={(e) => setReconciliationDate(e.target.value)} className={inputClass} /></label>
          <label className="space-y-1 text-sm"><span>{t.verifiedBalance}</span><input required value={verifiedBalance} onChange={(e) => setVerifiedBalance(e.target.value)} inputMode="decimal" className={inputClass} /></label>
          <label className="space-y-1 text-sm"><span>{t.sourceReference}</span><input value={reconciliationReference} onChange={(e) => setReconciliationReference(e.target.value)} className={inputClass} /></label>
          <label className="space-y-1 text-sm md:col-span-2"><span>{t.reason}</span><input required value={reconciliationReason} onChange={(e) => setReconciliationReason(e.target.value)} className={inputClass} /></label>
        </div>
        <button disabled={busy || !reconciliation?.cutover_configured || !reconciliation?.adjustment_account_available || !reconciliationReason.trim()} className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{t.createAdjustment}</button>
      </form>
      <div className={cardClass}><h3 className="font-semibold">{t.adjustmentHistory}</h3>{!reconciliation?.adjustments.length ? <p className="text-sm text-muted-foreground">{t.noRows}</p> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b"><th className="p-2 text-start">{t.date}</th><th className="p-2 text-start">{t.account}</th><th className="p-2 text-start">{t.entryNumber}</th><th className="p-2 text-start">{t.systemBalance}</th><th className="p-2 text-start">{t.verifiedBalance}</th><th className="p-2 text-start">{t.difference}</th><th className="p-2 text-start">{t.reason}</th><th className="p-2 text-start">{t.sourceReference}</th></tr></thead><tbody>{reconciliation.adjustments.map((x) => <tr key={x.id} className="border-b border-border/60"><td className="p-2">{formatAccountingDate(x.adjustment_date, locale, tenant?.calendar)}</td><td className="p-2">{x.account_code} · {accountingSystemAccountNameByCode(x.account_code, x.account_name, locale)}</td><td className="p-2">{x.entry_number}</td><td className="p-2 whitespace-nowrap">{money(x.system_balance_minor)}</td><td className="p-2 whitespace-nowrap">{money(x.verified_balance_minor)}</td><td className="p-2 whitespace-nowrap">{money(x.difference_minor)}</td><td className="p-2">{x.reason}</td><td className="p-2">{x.source_reference || '—'}</td></tr>)}</tbody></table></div>}</div>
    </div>}
    {mode === 'operations' && tab === 'sourceEvents' && <div className="space-y-5">
      <div className={cardClass}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-semibold">{t.sourceAuditTitle}</h3>
          <button type="button" disabled={busy} onClick={() => void loadSourceEvents()} className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50">{locale.toLowerCase().startsWith('fa') ? 'به‌روزرسانی' : 'Refresh'}</button>
        </div>
        <p className="text-sm text-muted-foreground">{t.sourceAuditNotice}</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_auto]">
          <label className="space-y-1 text-sm"><span>{t.sourceFrom}</span><input type="date" value={sourceEventFrom} onChange={(e) => setSourceEventFrom(e.target.value)} className={inputClass} /></label>
          <label className="space-y-1 text-sm"><span>{t.sourceTo}</span><input type="date" value={sourceEventTo} onChange={(e) => setSourceEventTo(e.target.value)} className={inputClass} /></label>
          <button type="button" disabled={busy} onClick={() => void loadSourceEvents()} className="self-end rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{t.filterSourceEvents}</button>
        </div>
        {!sourceEventAudit ? <p className="text-sm text-destructive">{t.loadFailed}</p> : <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border border-border p-3"><div className="text-xs text-muted-foreground">{t.sourceEventCount}</div><div className="mt-1 text-lg font-semibold">{sourceEventAudit.events.length}</div></div>
            {Object.entries(sourceEventAudit.summary).map(([status, count]) => <div key={status} className="rounded-lg border border-border p-3"><div className="text-xs text-muted-foreground">{sourceStatusLabel(status)}</div><div className="mt-1 text-lg font-semibold">{count}</div></div>)}
          </div>
          {!sourceEventAudit.events.length ? <p className="text-sm text-muted-foreground">{t.noSourceEvents}</p> : <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b"><th className="p-2 text-start">{t.eventDate}</th><th className="p-2 text-start">{t.eventType}</th><th className="p-2 text-start">{t.sourceId}</th><th className="p-2 text-start">{t.method}</th><th className="p-2 text-start">{t.sourceAmount}</th><th className="p-2 text-start">{t.status}</th><th className="p-2 text-start">{t.matchingJournals}</th><th className="p-2 text-start">{t.sourceReason}</th></tr></thead>
              <tbody>{sourceEventAudit.events.map((event, index) => <tr key={event.event_type + ':' + event.source_id + ':' + index} className="border-b border-border/60 align-top">
                <td className="p-2 whitespace-nowrap">{formatAccountingDate(event.event_date, locale, tenant?.calendar)}</td>
                <td className="p-2">{sourceEventTypeLabel(event.event_type)}</td>
                <td className="p-2 font-mono text-xs">{event.source_id}</td>
                <td className="p-2">{accountingPaymentMethodName(event.method || '—', locale)}</td>
                <td className="p-2 whitespace-nowrap">{event.amount === null ? '—' : String(event.amount)}</td>
                <td className="p-2">{sourceStatusLabel(event.status)}</td>
                <td className="p-2 font-mono text-xs">{event.journal_entry_ids.length ? event.journal_entry_ids.join(', ') : '—'}</td>
                <td className="p-2 min-w-56">{accountingDiagnosticText(event.reason, locale)}</td>
              </tr>)}</tbody>
            </table>
          </div>}
          {sourceEventAudit.events.length >= 2000 && <p className="text-xs text-muted-foreground">{t.sourceLimitNote}</p>}
        </>}
      </div>
    </div>}
    {mode === 'operations' && tab === 'transfers' && <div className="space-y-5">
      <form className={cardClass} onSubmit={(e) => { e.preventDefault(); void saveTransfer(); }}><h3 className="font-semibold">{t.transfer}</h3><p className="text-xs text-muted-foreground">{t.amountHint} · {unitAdapter.label}</p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <label className="space-y-1 text-sm"><span>{t.transferFrom}</span><select value={sourceAccount} onChange={(e) => setSourceAccount(e.target.value)} className={selectClass}>{activeLiquidAssets.map((a) => <option key={a.id} value={a.id}>{a.account_code} · {accountingSystemAccountName(a.system_key, a.name, locale)}</option>)}</select></label>
          <label className="space-y-1 text-sm"><span>{t.transferTo}</span><select value={destinationAccount} onChange={(e) => setDestinationAccount(e.target.value)} className={selectClass}>{activeAssets.map((a) => <option key={a.id} value={a.id}>{a.account_code} · {accountingSystemAccountName(a.system_key, a.name, locale)}</option>)}</select></label>
          <label className="space-y-1 text-sm"><span>{t.amount}</span><input required value={transferAmount} onChange={(e) => setTransferAmount(e.target.value)} inputMode="decimal" className={inputClass} /></label>
          <label className="space-y-1 text-sm"><span>{t.date}</span><input required type="date" value={transferDate} onChange={(e) => setTransferDate(e.target.value)} className={inputClass} /></label>
          <label className="space-y-1 text-sm md:col-span-2"><span>{t.description}</span><input required value={transferDescription} onChange={(e) => setTransferDescription(e.target.value)} className={inputClass} /></label>
        </div><button disabled={busy || activeLiquidAssets.length < 2} className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{t.transfer}</button>
      </form>
      <div className={cardClass}><h3 className="font-semibold">{t.history}</h3>{transfers.length === 0 ? <p className="text-sm text-muted-foreground">{t.noRows}</p> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b"><th className="p-2 text-start">{t.date}</th><th className="p-2 text-start">{t.description}</th><th className="p-2 text-start">{t.transferFrom}</th><th className="p-2 text-start">{t.transferTo}</th><th className="p-2 text-start">{t.amount}</th></tr></thead><tbody>{transfers.map((x) => <tr key={x.id} className="border-b border-border/60"><td className="p-2">{formatAccountingDate(x.entry_date, locale, tenant?.calendar)}</td><td className="p-2">{accountingSystemDescription(x.description, locale)}</td><td className="p-2">{accountingSystemAccountNameFromName(x.source_account_name, locale)}</td><td className="p-2">{accountingSystemAccountNameFromName(x.destination_account_name, locale)}</td><td className="p-2 whitespace-nowrap">{money(x.amount_minor)}</td></tr>)}</tbody></table></div>}</div>
    </div>}
    {mode === 'settings' && tab === 'setup' && <div className="space-y-5">
      <form className={cardClass} onSubmit={(e) => { e.preventDefault(); void saveCategory(); }}><h3 className="font-semibold">{t.setup}</h3><div className="grid grid-cols-1 gap-3 md:grid-cols-2"><label className="space-y-1 text-sm"><span>{t.categoryName}</span><input value={newCategory} onChange={(e) => setNewCategory(e.target.value)} className={inputClass} required /></label><label className="space-y-1 text-sm"><span>{t.expenseAccount}</span><select value={newCategoryAccount} onChange={(e) => setNewCategoryAccount(e.target.value)} className={selectClass}>{activeExpenses.map((a) => <option key={a.id} value={a.id}>{a.account_code} · {accountingSystemAccountName(a.system_key, a.name, locale)}</option>)}</select></label></div><button disabled={busy || !activeExpenses.length} className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{t.createCategory}</button><div className="space-y-2">{categories.map((c) => <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3 text-sm"><span>{accountingExpenseCategoryName(c.id, c.name, locale, t.taxPayments)}</span><span className="text-muted-foreground">{accountingSystemAccountNameFromName(c.expense_account_name, locale)} · {c.is_active ? '✓' : '—'}</span></div>)}</div></form>
      <div className={cardClass}>
        <h3 className="font-semibold">{t.mapping}</h3>
        <div className="grid grid-cols-1 gap-2 border-b border-border/60 py-3 text-sm md:grid-cols-2">
          <label className="space-y-1"><span>{t.defaultPaymentAccount}</span><select disabled={busy} required value={defaultPaymentAccountId} onChange={(e) => void saveDefaultMapping(e.target.value)} className={selectClass}><option value="" disabled>{t.required}</option>{activeLiquidAssets.map((a) => <option key={a.id} value={a.id}>{a.account_code} · {accountingSystemAccountName(a.system_key, a.name, locale)}</option>)}</select></label>
          <p className="self-end text-xs text-muted-foreground">{t.paymentAccountFallbackHint}</p>
        </div>
        {mappings.map((m) => <label key={m.payment_method_key} className="grid grid-cols-1 gap-2 border-b border-border/60 py-2 text-sm md:grid-cols-2"><span>{accountingPaymentMethodName(m.payment_method_name, locale)}</span><select disabled={busy} value={m.account_id || ''} onChange={(e) => void saveMapping(m.payment_method_key, e.target.value)} className={selectClass}><option value="">{t.useDefaultPaymentAccount} ({defaultPaymentAccountLabel})</option>{activeLiquidAssets.map((a) => <option key={a.id} value={a.id}>{a.account_code} · {accountingSystemAccountName(a.system_key, a.name, locale)}</option>)}</select></label>)}
      </div>
    </div>}
    {reversalExpense && <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setReversalExpense(null); }}>
      <form role="dialog" aria-modal="true" aria-labelledby="accounting-reversal-title" onSubmit={(event) => void submitExpenseReversal(event)} className="w-full max-w-lg space-y-4 rounded-xl border border-border bg-background p-5 shadow-xl">
        <div className="space-y-1">
          <h2 id="accounting-reversal-title" className="text-lg font-semibold">{t.reverse} · {reversalExpense.description}</h2>
          <p className="text-sm text-muted-foreground">{t.reversalConfirm}</p>
        </div>
        <label className="block space-y-1 text-sm">
          <span>{t.reversalReason}</span>
          <textarea autoFocus required maxLength={500} value={reversalReasonValue} onChange={(event) => setReversalReasonValue(event.target.value)} disabled={busy} className={inputClass + ' min-h-24 w-full'} />
        </label>
        <label className="block space-y-1 text-sm">
          <span>{t.reversalDate}</span>
          <input type="date" required value={reversalDateValue} onChange={(event) => setReversalDateValue(event.target.value)} disabled={busy} className={inputClass + ' w-full'} />
        </label>
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" disabled={busy} onClick={() => setReversalExpense(null)} className="min-h-10 rounded-lg border border-border px-4 py-2 text-sm disabled:opacity-50">{locale.toLowerCase().startsWith('fa') ? 'انصراف' : 'Cancel'}</button>
          <button type="submit" disabled={busy || !reversalReasonValue.trim() || !reversalDateValue} className="min-h-10 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50">{busy ? (locale.toLowerCase().startsWith('fa') ? 'در حال ثبت…' : 'Posting…') : (locale.toLowerCase().startsWith('fa') ? 'تأیید و ثبت برگشت' : 'Confirm reversal')}</button>
        </div>
      </form>
    </div>}
  </section>;
}
