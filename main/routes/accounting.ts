import { Router, Request, Response } from 'express';
import { getDatabase } from '../db';
import { requireRole } from '../middleware/security';
import { ROLE_ACCESS } from '../../shared/role-permissions';
import { AccountingExpenseError, createExpense, getExpense, listExpenseCategories, listExpenses, listPostingAccounts, saveExpenseCategory, setPaymentAccountMapping, listPaymentAccountMappings, updateDraftExpense, postExpense, reverseExpense } from '../accounting/expenses';
import { AccountingLedgerError } from '../accounting/ledger';
import { createCashBankTransfer, listCashBankTransfers } from '../accounting/transfers';
import { resolveTenantCurrency } from '../countries';
import { createManualAccountingActivity, listManualAccountingActivities } from '../accounting/manual-activities';
import { createOpeningBalance, listAccountTransactionHistory, listOpeningBalances } from '../accounting/opening-balances';
import { createReconciliationAdjustment, getAccountingReconciliationOverview } from '../accounting/reconciliation';
import { getAccountingManagementReport } from '../accounting/reports';
import { getAccountingForecast } from '../accounting/forecast';
import { getAccountingSourceEventReconciliation } from '../accounting/source-reconciliation';
import { getAccountingTrialBalance } from '../accounting/trial-balance';
import { closeAccountingPeriod, listAccountingPeriods, reopenAccountingPeriod } from '../accounting/period-close';
import { cancelFutureItem, createFutureItem, listFutureItems, registerFutureItem, settleFutureItem, FutureItemError } from '../accounting/future-items';
import { cancelRecurringObligation, createRecurringObligation, listRecurringObligations, RecurringObligationError } from '../accounting/recurring-obligations';
import { AccountingLoanError, cancelLoanInstallment, createLoan, createLoanInstallments, listLoans, registerLoanInstallment, settleLoanInstallment } from '../accounting/loans';
import { isAutomaticSalesPostingEnabled } from '../accounting/sales';

const router = Router();
const managerOnly = requireRole(...ROLE_ACCESS.ownerManager);
function actorId(req: Request): string | null {
  const user = (req as any).user;
  return user?.userId == null ? null : String(user.userId);
}
function respondError(res: Response, error: any): void {
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
router.post('/loans/:id/installments', managerOnly, (req, res) => {
  try { res.status(201).json(createLoanInstallments(getDatabase(), String(req.params.id), req.body, actorId(req), req.get('Idempotency-Key'))); }
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
router.get('/sales-auto-posting', managerOnly, (_req, res) => {
  try {
    res.json({ enabled: isAutomaticSalesPostingEnabled(getDatabase()) });
  } catch (error) { respondError(res, error); }
});
router.put('/sales-auto-posting', managerOnly, (req, res) => {
  try {
    if (typeof req.body?.enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be a boolean.', code: 'invalid_accounting_setting' });
      return;
    }
    const db = getDatabase();
    const enabled = req.body.enabled;
    db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES ('accounting_auto_post_sales', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP
    `).run(enabled ? 'true' : 'false');
    res.json({ enabled: isAutomaticSalesPostingEnabled(db) });
  } catch (error) { respondError(res, error); }
});
router.get('/accounts', managerOnly, (req, res) => {
  try {
    const types = typeof req.query.types === 'string' ? req.query.types.split(',') : undefined;
    const db = getDatabase();
    const regionalRows = db.prepare("SELECT key, value FROM settings WHERE key IN ('country', 'currency')").all() as { key: string; value: string | null }[];
    const regional = Object.fromEntries(regionalRows.map((row) => [row.key, row.value ?? undefined]));
    res.json({ accounts: listPostingAccounts(db, types), currency_code: resolveTenantCurrency(regional.currency, regional.country ?? '') });
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
  try { res.json({ mappings: listPaymentAccountMappings(getDatabase()) }); }
  catch (error) { respondError(res, error); }
});
router.put('/payment-account-mappings/:key', managerOnly, (req, res) => {
  try { res.json({ mapping: setPaymentAccountMapping(getDatabase(), decodeURIComponent(String(req.params.key)), req.body?.account_id, actorId(req)) }); }
  catch (error) { respondError(res, error); }
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
router.post('/expenses/:id/reverse', managerOnly, (req, res) => {
  try {
    res.json({ expense: reverseExpense(getDatabase(), String(req.params.id), req.body?.reason, req.body?.reversal_date, actorId(req)) });
  } catch (error) { respondError(res, error); }
});
export { router as accountingRoutes };
