import { Router, Request, Response } from 'express';
import ExcelJS from 'exceljs';
import { getDatabase } from '../db';
import { requireRole } from '../middleware/security';
import { ROLE_ACCESS } from '../../shared/role-permissions';
import { AccountingExpenseError, createExpense, getExpense, listExpenseCategories, listExpenses, listPostingAccounts, saveExpenseCategory, setPaymentAccountMapping, listPaymentAccountMappings, getDefaultPaymentAccountMapping, setDefaultPaymentAccountMapping, updateDraftExpense, postExpense, reverseExpense, cancelDraftExpense } from '../accounting/expenses';
import { AccountingAccountError, createManagedAccountingAccount, listManagedAccountingAccounts, updateManagedAccountingAccount } from '../accounting/chart-of-accounts';
import { AccountingLedgerError } from '../accounting/ledger';
import { createCashBankTransfer, listCashBankTransfers } from '../accounting/transfers';
import { getAccountingMinorUnitFactor, resolveTenantCurrency } from '../countries';
import { createManualAccountingActivity, listManualAccountingActivities } from '../accounting/manual-activities';
import { createOpeningBalance, listAccountTransactionHistory, listOpeningBalances } from '../accounting/opening-balances';
import { createReconciliationAdjustment, getAccountingReconciliationOverview } from '../accounting/reconciliation';
import { getAccountingManagementReport } from '../accounting/reports';
import { getAccountingForecast } from '../accounting/forecast';
import { getAccountingSourceEventReconciliation } from '../accounting/source-reconciliation';
import { getAccountingTrialBalance } from '../accounting/trial-balance';
import { closeAccountingPeriod, listAccountingPeriods, reopenAccountingPeriod } from '../accounting/period-close';
import { isAutomaticSalesPostingEnabled } from '../accounting/sales';
import { cancelFutureItem, createFutureItem, listFutureItems, registerFutureItem, settleFutureItem, FutureItemError } from '../accounting/future-items';
import { cancelRecurringObligation, createRecurringObligation, listRecurringObligations, RecurringObligationError } from '../accounting/recurring-obligations';
import { AccountingLoanError, cancelLoanInstallment, createLoan, createLoanInstallments, listLoans, registerLoanInstallment, settleLoanInstallment, updateLoanOriginationDate, updateLoanInstallment, cancelLoan, correctLoan } from '../accounting/loans';

const router = Router();
const managerOnly = requireRole(...ROLE_ACCESS.ownerManager);
function actorId(req: Request): string | null {
  const user = (req as any).user;
  return user?.userId == null ? null : String(user.userId);
}
function respondError(res: Response, error: any): void {
  if (error instanceof AccountingAccountError) {
    res.status(error.statusCode).json({ error: error.message, code: error.code }); return;
  }
  if (error instanceof AccountingLoanError) {
    res.status(error.statusCode).json({ error: error.message, code: error.code }); return;
  }
  if (error instanceof RecurringObligationError) {
    res.status(error.statusCode).json({ error: error.message, code: error.code }); return;
  }
  if (error instanceof FutureItemError) {
    res.status(error.statusCode).json({ error: error.message, code: error.code }); return;
  }
  if (error instanceof AccountingExpenseError) {
    res.status(error.statusCode).json({ error: error.message, code: error.code }); return;
  }
  if (error instanceof AccountingLedgerError) {
    const status = error.code === 'entry_not_found' || error.code === 'period_not_found' ? 404 : ['idempotency_conflict', 'period_closed', 'period_has_draft_journals', 'period_has_unposted_expenses', 'period_has_source_exceptions', 'period_overlap', 'period_reopen_conflict', 'period_close_conflict', 'period_reclose_requires_new_record'].includes(error.code) ? 409 : 400;
    res.status(status).json({ error: error.message, code: error.code }); return;
  }
  if (String(error?.message || '').includes('UNIQUE constraint')) {
    res.status(409).json({ error: 'A conflicting accounting record already exists.', code: 'duplicate_record' }); return;
  }
  console.error('[API] Accounting expense request failed:', error);
  res.status(500).json({ error: 'Unable to process accounting request.' });
}
router.get('/loans', managerOnly, (req, res) => {
  try { res.json({ loans: listLoans(getDatabase(), req.query) }); }
  catch (error) { respondError(res, error); }
});
router.post('/loans', managerOnly, (req, res) => {
  try { res.status(201).json({ loan: createLoan(getDatabase(), req.body, actorId(req), req.get('Idempotency-Key')) }); }
  catch (error) { respondError(res, error); }
});
router.put('/loans/:id/origination-date', managerOnly, (req, res) => {
  try { res.json({ loan: updateLoanOriginationDate(getDatabase(), String(req.params.id), req.body?.origination_date, actorId(req)) }); }
  catch (error) { respondError(res, error); }
});
router.post('/loans/:id/cancel', managerOnly, (req, res) => {
  try { res.json({ loan: cancelLoan(getDatabase(), String(req.params.id), req.body?.reason, actorId(req)) }); }
  catch (error) { respondError(res, error); }
});
router.post('/loans/:id/correct', managerOnly, (req, res) => {
  try { res.json({ loan: correctLoan(getDatabase(), String(req.params.id), req.body, actorId(req), req.get('Idempotency-Key')) }); }
  catch (error) { respondError(res, error); }
});
router.post('/loans/:id/installments', managerOnly, (req, res) => {
  try { res.status(201).json(createLoanInstallments(getDatabase(), String(req.params.id), req.body, actorId(req), req.get('Idempotency-Key'))); }
  catch (error) { respondError(res, error); }
});
router.put('/loan-installments/:id', managerOnly, (req, res) => {
  try { res.json({ installment: updateLoanInstallment(getDatabase(), String(req.params.id), req.body, actorId(req)) }); }
  catch (error) { respondError(res, error); }
});
router.post('/loan-installments/:id/register', managerOnly, (req, res) => {
  try { res.json({ installment: registerLoanInstallment(getDatabase(), String(req.params.id), actorId(req)) }); }
  catch (error) { respondError(res, error); }
});
router.post('/loan-installments/:id/settle', managerOnly, (req, res) => {
  try { res.json({ installment: settleLoanInstallment(getDatabase(), String(req.params.id), req.body, actorId(req), req.get('Idempotency-Key')) }); }
  catch (error) { respondError(res, error); }
});
router.post('/loan-installments/:id/cancel', managerOnly, (req, res) => {
  try { res.json({ installment: cancelLoanInstallment(getDatabase(), String(req.params.id), req.body?.reason, actorId(req)) }); }
  catch (error) { respondError(res, error); }
});
router.get('/recurring-obligations', managerOnly, (req, res) => {
  try { res.json({ schedules: listRecurringObligations(getDatabase(), req.query) }); }
  catch (error) { respondError(res, error); }
});
router.post('/recurring-obligations', managerOnly, (req, res) => {
  try { res.status(201).json({ schedule: createRecurringObligation(getDatabase(), req.body, actorId(req), req.get('Idempotency-Key')) }); }
  catch (error) { respondError(res, error); }
});
router.post('/recurring-obligations/:id/cancel', managerOnly, (req, res) => {
  try { res.json({ schedule: cancelRecurringObligation(getDatabase(), String(req.params.id), req.body?.reason, actorId(req)) }); }
  catch (error) { respondError(res, error); }
});
router.get('/future-items', managerOnly, (req, res) => {
  try { res.json(listFutureItems(getDatabase(), req.query)); }
  catch (error) { respondError(res, error); }
});
router.post('/future-items', managerOnly, (req, res) => {
  try {
    res.status(201).json({
      item: createFutureItem(getDatabase(), req.body, actorId(req), req.get('Idempotency-Key')),
    });
  } catch (error) { respondError(res, error); }
});
router.post('/future-items/:id/register', managerOnly, (req, res) => {
  try {
    res.json({ item: registerFutureItem(getDatabase(), String(req.params.id), actorId(req)) });
  } catch (error) { respondError(res, error); }
});
router.post('/future-items/:id/settle', managerOnly, (req, res) => {
  try {
    res.json({
      item: settleFutureItem(getDatabase(), String(req.params.id), req.body, actorId(req), req.get('Idempotency-Key')),
    });
  } catch (error) { respondError(res, error); }
});
router.post('/future-items/:id/cancel', managerOnly, (req, res) => {
  try {
    res.json({ item: cancelFutureItem(getDatabase(), String(req.params.id), req.body?.reason, actorId(req)) });
  } catch (error) { respondError(res, error); }
});
router.get('/activities', managerOnly, (req, res) => {
  try { res.json({ activities: listManualAccountingActivities(getDatabase(), req.query) }); }
  catch (error) { respondError(res, error); }
});
router.post('/activities', managerOnly, (req, res) => {
  try { res.status(201).json({ activity: createManualAccountingActivity(getDatabase(), req.body, actorId(req), req.get('Idempotency-Key')) }); }
  catch (error) { respondError(res, error); }
});
router.get('/transfers', managerOnly, (req, res) => {
  try { res.json({ transfers: listCashBankTransfers(getDatabase(), req.query) }); }
  catch (error) { respondError(res, error); }
});
router.post('/transfers', managerOnly, (req, res) => {
  try {
    res.status(201).json({ transfer: createCashBankTransfer(getDatabase(), req.body, actorId(req), req.get('Idempotency-Key')) });
  } catch (error) { respondError(res, error); }
});
router.get('/opening-balances', managerOnly, (req, res) => {
  try { res.json({ opening_balances: listOpeningBalances(getDatabase(), req.query) }); }
  catch (error) { respondError(res, error); }
});
router.post('/opening-balances', managerOnly, (req, res) => {
  try {
    res.status(201).json({ opening_balance: createOpeningBalance(getDatabase(), req.body, actorId(req), req.get('Idempotency-Key')) });
  } catch (error) { respondError(res, error); }
});
router.get('/accounts/managed', managerOnly, (req, res) => {
  try { res.json({ accounts: listManagedAccountingAccounts(getDatabase()) }); }
  catch (error) { respondError(res, error); }
});
router.post('/accounts', managerOnly, (req, res) => {
  try { res.status(201).json({ account: createManagedAccountingAccount(getDatabase(), req.body, actorId(req)) }); }
  catch (error) { respondError(res, error); }
});
router.put('/accounts/:id', managerOnly, (req, res) => {
  try { res.json({ account: updateManagedAccountingAccount(getDatabase(), String(req.params.id), req.body, actorId(req)) }); }
  catch (error) { respondError(res, error); }
});
router.get('/accounts/:accountId/transactions', managerOnly, (req, res) => {
  try { res.json(listAccountTransactionHistory(getDatabase(), String(req.params.accountId), req.query)); }
  catch (error) { respondError(res, error); }
});
router.get('/reports', managerOnly, (req, res) => {
  try { res.json(getAccountingManagementReport(getDatabase(), req.query)); }
  catch (error) { respondError(res, error); }
});
router.get('/forecast', managerOnly, (req, res) => {
  try { res.json(getAccountingForecast(getDatabase(), req.query)); }
  catch (error) { respondError(res, error); }
});
router.get('/trial-balance', managerOnly, (req, res) => {
  try { res.json(getAccountingTrialBalance(getDatabase(), req.query)); }
  catch (error) { respondError(res, error); }
});
router.get('/periods', managerOnly, (_req, res) => {
  try { res.json({ periods: listAccountingPeriods(getDatabase()) }); }
  catch (error) { respondError(res, error); }
});
router.post('/periods/close', managerOnly, (req, res) => {
  try { res.status(201).json({ period: closeAccountingPeriod(getDatabase(), req.body, actorId(req)) }); }
  catch (error) { respondError(res, error); }
});
router.post('/periods/:id/reopen', managerOnly, (req, res) => {
  try { res.json({ period: reopenAccountingPeriod(getDatabase(), String(req.params.id), req.body?.reason, actorId(req)) }); }
  catch (error) { respondError(res, error); }
});
router.get('/sales-auto-posting', managerOnly, (_req, res) => {
  try {
    res.json({ enabled: isAutomaticSalesPostingEnabled(getDatabase()) });
  } catch (error) { respondError(res, error); }
});
router.put('/sales-auto-posting', managerOnly, (req, res) => {
  if (typeof req.body?.enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled must be a boolean.', code: 'invalid_setting' });
    return;
  }
  try {
    const db = getDatabase();
    const before = isAutomaticSalesPostingEnabled(db);
    const after = req.body.enabled;
    db.transaction(() => {
      if (before !== after) {
        db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('accounting_auto_post_sales', ?, CURRENT_TIMESTAMP)")
          .run(after ? 'true' : 'false');
        db.prepare(`
          INSERT INTO accounting_audit_log
            (entity_type, entity_id, action, actor_user_id, before_json, after_json)
          VALUES ('accounting_setting', 'accounting_auto_post_sales', 'updated', ?, ?, ?)
        `).run(actorId(req), JSON.stringify({ enabled: before }), JSON.stringify({ enabled: after }));
      }
    })();
    res.json({ enabled: isAutomaticSalesPostingEnabled(db) });
  } catch (error) { respondError(res, error); }
});
router.get('/source-events', managerOnly, (req, res) => {
  try {
    res.json(getAccountingSourceEventReconciliation(getDatabase(), req.query));
  } catch (error: any) {
    if (error?.statusCode && error?.code) {
      res.status(Number(error.statusCode)).json({ error: String(error.message || 'Invalid reconciliation request.'), code: String(error.code) });
      return;
    }
    respondError(res, error);
  }
});
router.get('/reconciliation', managerOnly, (req, res) => {
  try { res.json(getAccountingReconciliationOverview(getDatabase(), req.query)); }
  catch (error) { respondError(res, error); }
});
router.post('/reconciliation/adjustments', managerOnly, (req, res) => {
  try {
    res.status(201).json({
      adjustment: createReconciliationAdjustment(getDatabase(), req.body, actorId(req), req.get('Idempotency-Key')),
    });
  } catch (error) { respondError(res, error); }
});
router.get('/export', managerOnly, (_req, res) => {
  try {
    const db = getDatabase();
    const accountingTables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'accounting_%' ORDER BY name",
    ).all() as { name: string }[])
      .map((row) => row.name)
      .filter((name) => /^accounting_[a-zA-Z0-9_]+$/.test(name));
    const tables: Record<string, unknown[]> = {};
    for (const tableName of accountingTables) {
      tables[tableName] = db.prepare('SELECT * FROM "' + tableName + '"').all() as unknown[];
    }
    const triggers = db.prepare(
      "SELECT name, tbl_name, sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'accounting_%' ORDER BY name",
    ).all();
    const foreignKeyViolations = db.pragma('foreign_key_check') as unknown[];
    const integrity = db.pragma('integrity_check') as { integrity_check: string }[];
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="lyrapos-accounting-export.json"');
    res.json({
      format: 'lyrapos-accounting-export',
      format_version: 1,
      exported_at: new Date().toISOString(),
      database_schema_version: db.pragma('user_version', { simple: true }),
      integrity_check: integrity.map((row) => row.integrity_check),
      foreign_key_violations: foreignKeyViolations,
      accounting_tables: tables,
      accounting_triggers: triggers,
    });
  } catch (error) {
    respondError(res, error);
  }
});
router.get('/accounts', managerOnly, (req, res) => {
  try {
    const types = typeof req.query.types === 'string' ? req.query.types.split(',') : undefined;
    const db = getDatabase();
    const regionalRows = db.prepare("SELECT key, value FROM settings WHERE key IN ('country', 'currency')").all() as { key: string; value: string | null }[];
    const regional = Object.fromEntries(regionalRows.map((row) => [row.key, row.value ?? undefined]));
    const currencyCode = resolveTenantCurrency(regional.currency, regional.country ?? '');
    const accountingFactor = getAccountingMinorUnitFactor(currencyCode);
    const accountingFractionDigits = Math.round(Math.log10(accountingFactor));
    res.json({ accounts: listPostingAccounts(db, types), currency_code: currencyCode, accounting_fraction_digits: accountingFractionDigits });
  } catch (error) { respondError(res, error); }
});
router.get('/expense-categories', managerOnly, (req, res) => {
  try { res.json({ categories: listExpenseCategories(getDatabase(), req.query.include_inactive === 'true') }); }
  catch (error) { respondError(res, error); }
});
router.post('/expense-categories', managerOnly, (req, res) => {
  try { res.status(201).json({ category: saveExpenseCategory(getDatabase(), req.body, actorId(req)) }); }
  catch (error) { respondError(res, error); }
});
router.put('/expense-categories/:id', managerOnly, (req, res) => {
  try { res.json({ category: saveExpenseCategory(getDatabase(), req.body, actorId(req), String(req.params.id)) }); }
  catch (error) { respondError(res, error); }
});
router.get('/payment-account-mappings', managerOnly, (_req, res) => {
  try {
    const db = getDatabase();
    res.json({ mappings: listPaymentAccountMappings(db), default_account: getDefaultPaymentAccountMapping(db) });
  } catch (error) { respondError(res, error); }
});
router.put('/payment-account-mappings/default', managerOnly, (req, res) => {
  try { res.json({ default_account: setDefaultPaymentAccountMapping(getDatabase(), req.body?.account_id, actorId(req)) }); }
  catch (error) { respondError(res, error); }
});
router.put('/payment-account-mappings/:key', managerOnly, (req, res) => {
  try { res.json({ mapping: setPaymentAccountMapping(getDatabase(), decodeURIComponent(String(req.params.key)), req.body?.account_id, actorId(req)) }); }
  catch (error) { respondError(res, error); }
});
router.get('/expenses/export.xlsx', managerOnly, async (req, res) => {
  try {
    const db = getDatabase();
    const rows: any[] = [];
    let offset = 0;
    const pageSize = 500;
    while (true) {
      const page = listExpenses(db, { ...req.query, limit: pageSize, offset });
      rows.push(...page);
      if (page.length < pageSize) break;
      offset += pageSize;
    }

    const isPersian = String(req.query.locale || 'fa').toLowerCase().startsWith('fa');
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'LyraPOS';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet(isPersian ? 'هزینه‌ها' : 'Expenses', {
      views: [{ state: 'frozen', ySplit: 1, rightToLeft: isPersian }],
    });
    sheet.columns = isPersian ? [
      { header: 'تاریخ هزینه', key: 'expense_date', width: 16 },
      { header: 'سررسید', key: 'due_date', width: 16 },
      { header: 'شرح', key: 'description', width: 32 },
      { header: 'دسته‌بندی', key: 'category', width: 22 },
      { header: 'پرداخت به', key: 'payee', width: 22 },
      { header: 'شماره پیگیری', key: 'reference', width: 20 },
      { header: 'مبلغ', key: 'amount', width: 18 },
      { header: 'واحد پول', key: 'currency', width: 12 },
      { header: 'وضعیت پرداخت', key: 'payment_status', width: 18 },
      { header: 'وضعیت دفتر کل', key: 'ledger_status', width: 18 },
      { header: 'حساب پرداخت‌کننده', key: 'payment_account', width: 26 },
      { header: 'تاریخ پرداخت', key: 'payment_date', width: 16 },
    ] : [
      { header: 'Expense date', key: 'expense_date', width: 16 },
      { header: 'Due date', key: 'due_date', width: 16 },
      { header: 'Description', key: 'description', width: 32 },
      { header: 'Category', key: 'category', width: 22 },
      { header: 'Payee', key: 'payee', width: 22 },
      { header: 'Reference', key: 'reference', width: 20 },
      { header: 'Amount', key: 'amount', width: 18 },
      { header: 'Currency', key: 'currency', width: 12 },
      { header: 'Payment status', key: 'payment_status', width: 18 },
      { header: 'Ledger status', key: 'ledger_status', width: 18 },
      { header: 'Payment account', key: 'payment_account', width: 26 },
      { header: 'Payment date', key: 'payment_date', width: 16 },
    ];
    const factor = getAccountingMinorUnitFactor(String(rows[0]?.currency_code || 'IRR'));
    const decimalPlaces = factor === 1 ? 0 : Math.round(Math.log10(factor));
    const amountFormat = decimalPlaces === 0
      ? '#,##0;[Red]-#,##0'
      : '#,##0.' + '0'.repeat(decimalPlaces) + ';[Red]-#,##0.' + '0'.repeat(decimalPlaces);
    for (const expense of rows) {
      sheet.addRow({
        expense_date: expense.expense_date || '',
        due_date: expense.due_date || '',
        description: expense.description || '',
        category: expense.category_name || '',
        payee: expense.payee || '',
        reference: expense.reference_number || '',
        amount: Number(expense.amount_minor || 0) / factor,
        currency: expense.currency_code || '',
        payment_status: isPersian
          ? (expense.payment_status === 'paid' ? 'پرداخت‌شده' : expense.is_overdue ? 'عقب‌افتاده' : 'پرداخت‌نشده')
          : (expense.payment_status === 'paid' ? 'Paid' : expense.is_overdue ? 'Overdue' : 'Unpaid'),
        ledger_status: isPersian
          ? ({ draft: 'پیش‌نویس', posted: 'ثبت‌شده', reversed: 'برگشت‌خورده' } as Record<string, string>)[expense.status] || expense.status
          : ({ draft: 'Draft', posted: 'Posted', reversed: 'Reversed' } as Record<string, string>)[expense.status] || expense.status,
        payment_account: expense.payment_account_name || '',
        payment_date: expense.payment_date || '',
      });
    }
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
    sheet.autoFilter = { from: 'A1', to: 'L1' };
    sheet.getColumn('amount').numFmt = amountFormat;
    sheet.eachRow((row, rowNumber) => {
      row.alignment = { vertical: 'middle', horizontal: isPersian ? 'right' : 'left', wrapText: rowNumber === 1 };
      if (rowNumber > 1) row.height = 20;
    });
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="lyrapos-expenses.xlsx"');
    res.status(200).send(buffer);
  } catch (error) { respondError(res, error); }
});
router.get('/expenses', managerOnly, (req, res) => {
  try { res.json({ expenses: listExpenses(getDatabase(), req.query) }); }
  catch (error) { respondError(res, error); }
});
router.post('/expenses', managerOnly, (req, res) => {
  try { res.status(201).json({ expense: createExpense(getDatabase(), req.body, actorId(req), req.get('Idempotency-Key')) }); }
  catch (error) { respondError(res, error); }
});
router.get('/expenses/:id', managerOnly, (req, res) => {
  try { res.json({ expense: getExpense(getDatabase(), String(req.params.id)) }); }
  catch (error) { respondError(res, error); }
});
router.put('/expenses/:id', managerOnly, (req, res) => {
  try { res.json({ expense: updateDraftExpense(getDatabase(), String(req.params.id), req.body, actorId(req)) }); }
  catch (error) { respondError(res, error); }
});
router.post('/expenses/:id/post', managerOnly, (req, res) => {
  try { res.json({ expense: postExpense(getDatabase(), String(req.params.id), actorId(req)) }); }
  catch (error) { respondError(res, error); }
});
router.post('/expenses/:id/cancel', managerOnly, (req, res) => {
  try { res.json({ expense: cancelDraftExpense(getDatabase(), String(req.params.id), req.body?.reason, actorId(req)) }); }
  catch (error) { respondError(res, error); }
});
router.post('/expenses/:id/reverse', managerOnly, (req, res) => {
  try {
    res.json({ expense: reverseExpense(getDatabase(), String(req.params.id), req.body?.reason, req.body?.reversal_date, actorId(req)) });
  } catch (error) { respondError(res, error); }
});
export { router as accountingRoutes };
