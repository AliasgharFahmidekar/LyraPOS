import { Router, Request, Response } from 'express';
import { getDatabase } from '../db';
import { requireRole } from '../middleware/security';
import { ROLE_ACCESS } from '../../shared/role-permissions';
import { AccountingExpenseError, createExpense, getExpense, listExpenseCategories, listExpenses, saveExpenseCategory, setPaymentAccountMapping, listPaymentAccountMappings, updateDraftExpense } from '../accounting/expenses';

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
  if (String(error?.message || '').includes('UNIQUE constraint')) {
    res.status(409).json({ error: 'A conflicting accounting record already exists.', code: 'duplicate_record' }); return;
  }
  console.error('[API] Accounting expense request failed:', error);
  res.status(500).json({ error: 'Unable to process accounting request.' });
}
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
  try { res.status(201).json({ expense: createExpense(getDatabase(), req.body, actorId(req)) }); }
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
export { router as accountingRoutes };
