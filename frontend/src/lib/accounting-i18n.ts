export function isPersianAccountingLocale(locale: string): boolean {
  return locale.toLowerCase().startsWith('fa');
}

const SYSTEM_ACCOUNT_NAMES: Record<string, string> = {
  assets: 'دارایی‌ها',
  cash_drawer: 'صندوق نقدی',
  bank_accounts: 'حساب‌های بانکی',
  payment_clearing: 'حساب واسط پرداخت',
  accounts_receivable: 'مطالبات از مشتریان',
  inventory: 'موجودی کالا',
  liabilities: 'بدهی‌ها',
  accounts_payable: 'بدهی به تأمین‌کنندگان',
  customer_advances: 'پیش‌دریافت از مشتریان',
  equity: 'حقوق مالکانه',
  owner_capital: 'آورده مالک',
  owner_drawings: 'برداشت مالک',
  income: 'درآمدها',
  sales_revenue: 'درآمد فروش',
  sales_discounts: 'تخفیف فروش',
  sales_returns: 'برگشت از فروش',
  other_income: 'سایر درآمدها',
  expenses: 'هزینه‌ها',
  cost_of_goods_sold: 'بهای تمام‌شده کالای فروش‌رفته',
  operating_expenses: 'هزینه‌های عملیاتی',
  payment_processing_fees: 'کارمزدهای پرداخت',
  tax_payable: 'مالیات پرداختنی',
  opening_balance_equity: 'حقوق مالکانه مانده افتتاحیه',
  reconciliation_adjustment_equity: 'حقوق مالکانه تعدیل تطبیق',
  future_receipt_clearing: 'حساب واسط دریافت‌های آتی',
  future_payment_clearing: 'حساب واسط پرداخت‌های آتی',
};

export function accountingSystemAccountName(
  systemKey: string | null | undefined,
  originalName: string,
  locale: string,
): string {
  if (!isPersianAccountingLocale(locale) || !systemKey) return originalName;
  if (systemKey.startsWith('custom_liquid:cash:')) return 'صندوق نقدی';
  if (systemKey.startsWith('custom_liquid:bank:')) return 'حساب بانکی';
  return SYSTEM_ACCOUNT_NAMES[systemKey] || originalName;
}

const SYSTEM_ACCOUNT_CODES: Record<string, string> = {
  '1000': 'دارایی‌ها', '1010': 'صندوق نقدی', '1020': 'حساب‌های بانکی',
  '1030': 'حساب واسط پرداخت', '1100': 'مطالبات از مشتریان', '1200': 'موجودی کالا',
  '2000': 'بدهی‌ها', '2010': 'بدهی به تأمین‌کنندگان', '2020': 'پیش‌دریافت از مشتریان',
  '3000': 'حقوق مالکانه', '3010': 'آورده مالک', '3020': 'برداشت مالک',
  '4000': 'درآمدها', '4010': 'درآمد فروش', '4020': 'تخفیف فروش',
  '4030': 'سایر درآمدها', '5000': 'هزینه‌ها', '5010': 'بهای تمام‌شده کالای فروش‌رفته',
  '5020': 'هزینه‌های عملیاتی', '5030': 'کارمزدهای پرداخت',
};

export function accountingSystemAccountNameByCode(
  accountCode: string | null | undefined,
  originalName: string,
  locale: string,
): string {
  if (!isPersianAccountingLocale(locale) || !accountCode) return originalName;
  return SYSTEM_ACCOUNT_CODES[accountCode] || originalName;
}

export function accountingAuditActionLabel(action: string, locale: string): string {
  if (!isPersianAccountingLocale(locale)) return action;
  const labels: Record<string, string> = {
    skipped_pre_cutover_payment: 'دریافت پیش از شروع حسابداری؛ ثبت نشده',
    skipped_pre_cutover_refund: 'بازپرداخت پیش از شروع حسابداری؛ ثبت نشده',
    excluded_non_monetary: 'رویداد غیرمالی؛ خارج از حسابداری',
    created: 'ایجاد شد', updated: 'ویرایش شد', reversed: 'برگشت خورد',
  };
  return labels[action] || accountingStatusLabel(action, locale, 'رویداد فنی حسابداری');
}

export function accountingDiagnosticText(value: string | null | undefined, locale: string, fallback = 'جزئیات فنی برای بررسی در گزارش ثبت شده است.'): string {
  if (!value) return '—';
  if (!isPersianAccountingLocale(locale)) return value;
  if (/[\u0600-\u06ff]/.test(value)) return value;
  const known: Record<string, string> = {
    'The refund event timestamp predates accounting cutover; historical monetary refunds are intentionally not backfilled.': 'زمان بازپرداخت پیش از شروع حسابداری است؛ سوابق مالی قدیمی به‌صورت خودکار وارد دفتر کل نمی‌شوند.',
    'The payment event timestamp predates accounting cutover; historical payments are intentionally not backfilled.': 'زمان دریافت پیش از شروع حسابداری است؛ سوابق مالی قدیمی به‌صورت خودکار وارد دفتر کل نمی‌شوند.',
    'The payment timestamp predates accounting cutover; historical payments are intentionally not backfilled.': 'زمان دریافت پیش از شروع حسابداری است؛ سوابق مالی قدیمی به‌صورت خودکار وارد دفتر کل نمی‌شوند.',
  };
  return known[value] || fallback;
}

export function accountingPaymentMethodName(name: string, locale: string): string {
  if (!isPersianAccountingLocale(locale)) return name;
  if (name === 'Cash') return 'نقدی';
  if (name === 'Card') return 'کارت‌خوان';
  return name;
}

const SYSTEM_DESCRIPTION_EXACT: Record<string, string> = {
  'Actual money received through payment method': 'دریافت واقعی وجه از طریق روش پرداخت',
  'Revenue recognized from actual money received': 'شناسایی درآمد بر اساس وجه واقعاً دریافت‌شده',
  'Reverse revenue for money refunded': 'برگشت درآمد بابت وجه بازپرداخت‌شده',
  'Actual money paid out through refund method': 'پرداخت واقعی وجه بابت بازپرداخت',
  'Opening balance offset': 'حساب مقابل مانده افتتاحیه',
  'Actual loan instalment payment': 'پرداخت واقعی قسط وام',
  'Actual loan installment payment': 'پرداخت واقعی قسط وام',
  'Existing outstanding loan principal': 'مانده اصل وام قبلی',
  'Opening balance offset; no new cash received': 'حساب مقابل مانده افتتاحیه؛ بدون دریافت وجه جدید',
  'Actual future receipt/cheque settlement': 'وصول واقعی دریافت یا چک',
  'Clear registered future receipt receivable': 'تسویه مطالبات دریافت آتی ثبت‌شده',
  'Recognize expense only after actual payment': 'شناسایی هزینه فقط پس از پرداخت واقعی',
  'Settle registered payable': 'تسویه بدهی ثبت‌شده',
  'Actual future payment/cheque settlement': 'پرداخت واقعی پرداخت آتی یا چک',
  'Receipt pending actual settlement; not recognized as income yet': 'دریافت در انتظار وصول واقعی؛ هنوز درآمد محسوب نمی‌شود',
  'Payment pending actual settlement; not recognized as paid expense yet': 'پرداخت در انتظار تسویه واقعی؛ هنوز هزینه پرداخت‌شده محسوب نمی‌شود',
};

export function accountingSystemDescription(value: string | null | undefined, locale: string): string {
  if (!value || !isPersianAccountingLocale(locale)) return value || '';
  const exact = SYSTEM_DESCRIPTION_EXACT[value];
  if (exact) return exact;

  let match = value.match(/^Money received for bill (.+) \((cash|card|custom:\d+)\)$/);
  if (match) {
    const method = match[2] === 'cash' ? 'نقدی' : match[2] === 'card' ? 'کارت‌خوان' : 'روش پرداخت سفارشی';
    return `دریافت وجه بابت فاکتور ${match[1]} (${method})`;
  }
  match = value.match(/^Monetary refund for bill (.+) \(#(.+)\)$/);
  if (match) return `بازپرداخت نقدی بابت فاکتور ${match[1]} (شناسه ${match[2]})`;
  match = value.match(/^Expense: (.*)$/);
  if (match) return `هزینه: ${match[1]}`;
  match = value.match(/^Reversal of (.+): (.*)$/);
  if (match) return `برگشت سند ${match[1]}: ${match[2]}`;
  match = value.match(/^Reversal: (.*)$/);
  if (match) return `برگشت: ${match[1]}`;
  match = value.match(/^Opening balance: (.*)$/);
  if (match) return `مانده افتتاحیه: ${match[1]}`;
  match = value.match(/^Loan instalment payment: (.*)$/);
  if (match) return `پرداخت قسط وام: ${match[1]}`;
  match = value.match(/^Loan installment payment: (.*)$/);
  if (match) return `پرداخت قسط وام: ${match[1]}`;
  match = value.match(/^Future receipt: (.*)$/);
  if (match) return `دریافت آتی: ${match[1]}`;
  match = value.match(/^Future payment: (.*)$/);
  if (match) return `پرداخت آتی: ${match[1]}`;
  match = value.match(/^Settlement: (.*)$/);
  if (match) return `تسویه: ${match[1]}`;
  match = value.match(/^Transfer: (.*)$/);
  if (match) return `انتقال وجه: ${match[1]}`;
  match = value.match(/^Owner contribution(?:: (.*))?$/);
  if (match) return `آورده مالک${match[1] ? ': ' + match[1] : ''}`;
  match = value.match(/^Owner drawing(?:: (.*))?$/);
  if (match) return `برداشت مالک${match[1] ? ': ' + match[1] : ''}`;
  return value;
}

const ACCOUNTING_STATUS_FA: Record<string, string> = {
  scheduled: 'برنامه‌ریزی‌شده',
  awaiting_confirmation: 'در انتظار تأیید',
  registered: 'سررسید ثبت‌شده؛ پرداخت‌نشده',
  failed: 'ناموفق؛ نیازمند بررسی یا تلاش مجدد',
  settled: 'تسویه‌شده',
  cancelled: 'لغوشده',
  cancelled_item: 'لغوشده',
  active: 'فعال',
  closed: 'بسته‌شده',
  posted: 'ثبت نهایی‌شده',
  draft: 'پیش‌نویس',
  reversed: 'برگشت‌خورده',
  paid: 'پرداخت‌شده',
  unpaid: 'پرداخت‌نشده',
  incoming: 'دریافتی',
  outgoing: 'پرداختی',
  posted_once: 'یک‌بار ثبت شده',
  missing_journal: 'سند حسابداری ندارد',
  journal_not_posted: 'سند نهایی نشده',
  duplicate_journals: 'اسناد تکراری',
  missing_source_identity: 'نیازمند بررسی دستی',
  skipped_pre_cutover_payment: 'دریافت پیش از شروع حسابداری؛ ثبت نشده',
  skipped_pre_cutover_refund: 'بازپرداخت پیش از شروع حسابداری؛ ثبت نشده',
  skipped_pre_cutover: 'پیش از شروع حسابداری؛ ثبت نشده',
  excluded_non_monetary: 'رویداد غیرمالی؛ خارج از حسابداری',
  requires_review_drawer_movements: 'نیازمند بررسی گردش صندوق',
  requires_review_cash_mapping: 'نیازمند بررسی نگاشت حساب نقدی',
  opening_balance_missing: 'مانده افتتاحیه ثبت نشده',
  close_before_opening_balance: 'بستن صندوق پیش از مانده افتتاحیه',
  matched: 'تطبیق‌شده',
  difference: 'دارای اختلاف',
  not_comparable: 'قابل مقایسه نیست',
};

export function accountingStatusLabel(status: string, locale: string, fallback?: string): string {
  if (!isPersianAccountingLocale(locale)) return status;
  return ACCOUNTING_STATUS_FA[status] || fallback || status;
}

const ACCOUNTING_ERROR_FA: Record<string, string> = {
  accounting_region_unconfigured: 'پیش از استفاده از حسابداری، کشور و واحد پول فروشگاه را در تنظیمات مشخص کنید.',
  regional_not_configured: 'پیش از ثبت این عملیات، کشور و واحد پول فروشگاه را در تنظیمات مشخص کنید.',
  payment_mapping_required: 'روش پرداخت به حسابداری نگاشت نشده است. ابتدا حساب مقصد آن را در تنظیمات حسابداری مشخص کنید.',
  payment_mapping_invalid: 'حساب مقصد این روش پرداخت معتبر نیست. یک حساب فعال صندوق، بانک یا واسط پرداخت انتخاب کنید.',
  account_not_found: 'حساب موردنظر پیدا نشد.',
  account_not_active: 'حساب موردنظر فعال نیست.',
  account_inactive: 'حساب غیرفعال است.',
  account_not_postable: 'برای این عملیات یک حساب قابل ثبت انتخاب کنید، نه سرفصل گروهی.',
  invalid_amount: 'مبلغ واردشده معتبر نیست.',
  invalid_date: 'تاریخ واردشده معتبر نیست.',
  invalid_account_id: 'حساب انتخاب‌شده معتبر نیست.',
  period_closed: 'این تاریخ در دوره حسابداری بسته‌شده قرار دارد.',
  journal_period_closed: 'این تاریخ در دوره حسابداری بسته‌شده قرار دارد.',
  installment_not_due: 'سررسید این قسط هنوز نرسیده است.',
  installment_not_registered: 'ابتدا سررسید قسط را ثبت کنید؛ سپس پرداخت واقعی را تأیید کنید.',
  future_item_not_registered: 'ابتدا رویداد سررسید را ثبت کنید؛ سپس تسویه واقعی را تأیید کنید.',
  invalid_settlement_account: 'برای تسویه، یک حساب فعال صندوق، بانک یا واسط پرداخت انتخاب کنید.',
  principal_schedule_exceeds_balance: 'اصل اقساط از مانده فعلی بدهی وام بیشتر است.',
  invalid_account_type: 'نوع حساب انتخاب‌شده برای این عملیات مناسب نیست.',
  duplicate_accounts: 'حساب مبدأ و مقصد باید متفاوت باشند.',
};

export function accountingErrorMessage(value: unknown, locale: string, fallback: string): string {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const message = value.trim();
  if (!isPersianAccountingLocale(locale)) return message;
  if (/^[\u0600-\u06ff\s\d.,:()_-]+$/.test(message)) return message;
  const normalized = message.toLowerCase();
  const known = ACCOUNTING_ERROR_FA[normalized];
  if (known) return known;

  if (/configure (a valid )?store country and currency|configure the store country and currency/i.test(message)) {
    return ACCOUNTING_ERROR_FA.accounting_region_unconfigured;
  }
  if (/map (this |payment method |payment method ").*account|payment method.*not (mapped|configured)/i.test(message)) {
    return ACCOUNTING_ERROR_FA.payment_mapping_required;
  }
  if (/account.*not found/i.test(message)) return ACCOUNTING_ERROR_FA.account_not_found;
  if (/account.*inactive|choose an active accounting account/i.test(message)) return ACCOUNTING_ERROR_FA.account_inactive;
  if (/posting account|not a grouping account/i.test(message)) return ACCOUNTING_ERROR_FA.account_not_postable;
  if (/period.*closed|closed period/i.test(message)) return ACCOUNTING_ERROR_FA.period_closed;
  if (/invalid.*amount|amount.*invalid/i.test(message)) return ACCOUNTING_ERROR_FA.invalid_amount;
  if (/date.*invalid|invalid.*date/i.test(message)) return ACCOUNTING_ERROR_FA.invalid_date;
  return fallback;
}

export function formatAccountingDate(value: string | null | undefined, locale: string, calendar?: string | null): string {
  if (!value) return '—';
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const date = match ? new Date(`${match[1]}-${match[2]}-${match[3]}T12:00:00`) : new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  try {
    const calendarId = calendar === 'jalali' || calendar === 'persian' ? 'persian'
      : calendar === 'gregorian' || calendar === 'gregory' ? 'gregory'
      : isPersianAccountingLocale(locale) ? 'persian' : 'gregory';
    const formatLocale = isPersianAccountingLocale(locale) ? 'fa-IR' : locale;
    return new Intl.DateTimeFormat(formatLocale, { dateStyle: 'medium', calendar: calendarId }).format(date);
  } catch {
    return value;
  }
}
