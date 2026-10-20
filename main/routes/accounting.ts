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
import { getAccountingSourceEventReconciliation } from '../accounting/source-reconciliation';
import { getAccountingTrialBalance } from '../accounting/trial-balance';

const router = Router();
const managerOnly = requireRole(...ROLE_ACCESS.ownerManager);
function actorId(req: Request): string | null {
  const user = (req as any).user;
  return user?.userId == null ? null : String(user.userId);
}
function respondError(res: Response, error: any): void {
  if (error instanceof AccountingExpenseError) {
    res.status(error.statusCode).json({ error: error.message, code: error.code }); return;
  }
  if (error instanceof AccountingLedgerError) {
    const status = error.code === 'entry_not_found' ? 404 : error.code === 'idempotency_conflict' ? 409 : 400;
    res.status(status).json({ error: error.message, code: error.code }); return;
  }
  if (String(error?.message || '').includes('UNIQUE constraint')) {
    res.status(409).json({ error: 'A conflicting accounting record already exists.', code: 'duplicate_record' }); return;
  }
  console.error('[API] Accounting expense request failed:', error);
  res.status(500).json({ error: 'Unable to process accounting request.' });
}
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
router.get('/trial-balance', managerOnly, (req, res) => {
  try { res.json(getAccountingTrialBalance(getDatabase(), req.query)); }
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
