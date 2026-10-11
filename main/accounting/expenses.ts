import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
type DB = Database.Database;

export class AccountingExpenseError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400) {
    super(message); this.name = 'AccountingExpenseError';
  }
}
function fail(code: string, message: string, statusCode = 400): never { throw new AccountingExpenseError(code, message, statusCode); }
function textValue(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') fail('invalid_' + field, field + ' is required.');
  const valueText = value.trim();
  if (!valueText || valueText.length > max) fail('invalid_' + field, field + ' must be between 1 and ' + max + ' characters.');
  return valueText;
}
function optionalText(value: unknown, field: string, max: number): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') fail('invalid_' + field, field + ' must be text.');
  const result = value.trim();
  if (result.length > max) fail('invalid_' + field, field + ' must not exceed ' + max + ' characters.');
  return result || null;
}
export function assertAccountingDate(value: unknown, field = 'date'): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('invalid_' + field, field + ' must use YYYY-MM-DD format.');
  const parsed = new Date(value + 'T00:00:00.000Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail('invalid_' + field, field + ' must be a real calendar date.');
  return value;
}
function postingAccount(db: DB, accountId: unknown, types: string[]): any {
  const id = textValue(accountId, 'account_id', 100);
  const account = db.prepare('SELECT id, account_type, is_active, is_postable FROM accounting_accounts WHERE id = ?').get(id) as any;
  if (!account) fail('account_not_found', 'Accounting account was not found.', 404);
  if (account.is_active !== 1) fail('account_inactive', 'Choose an active accounting account.');
  if (account.is_postable !== 1) fail('account_not_postable', 'Choose a posting account, not a grouping account.');
  if (!types.includes(account.account_type)) fail('invalid_account_type', 'This operation requires an account of type: ' + types.join(' or ') + '.');
  return account;
}
function auditExpenseAction(db: DB, entityType: string, entityId: string, action: string, actorId: string | null, before: unknown, after: unknown): void {
  db.prepare('INSERT INTO accounting_audit_log (entity_type, entity_id, action, actor_user_id, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?)')
    .run(entityType, entityId, action, actorId, before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after));
}
function categoryInput(db: DB, input: any) {
  return {
    name: textValue(input?.name, 'name', 80),
    accountId: postingAccount(db, input?.expense_account_id, ['expense']).id,
    active: input?.is_active === undefined ? 1 : (input.is_active === true || input.is_active === 1 ? 1 : 0),
  };
}
export function listPostingAccounts(db: DB, accountTypes?: string[]): any[] {
  const types = Array.isArray(accountTypes) ? accountTypes.filter((type) => ['asset','liability','equity','revenue','expense'].includes(type)) : [];
  const rows = db.prepare('SELECT id, account_code, name, account_type, normal_balance, parent_account_id, is_active, is_postable FROM accounting_accounts WHERE is_active = 1 AND is_postable = 1 ORDER BY account_code').all() as any[];
  return types.length ? rows.filter((account) => types.includes(account.account_type)) : rows;
}
export function listExpenseCategories(db: DB, includeInactive = false): any[] {
  return db.prepare(
    'SELECT c.id, c.name, c.expense_account_id, a.account_code, a.name AS expense_account_name, c.is_active, c.created_by, c.updated_by, c.created_at, c.updated_at, ' +
    '(SELECT COUNT(*) FROM accounting_expenses e WHERE e.category_id = c.id) AS expense_count ' +
    'FROM accounting_expense_categories c JOIN accounting_accounts a ON a.id = c.expense_account_id ' +
    (includeInactive ? '' : 'WHERE c.is_active = 1 ') + 'ORDER BY c.is_active DESC, c.name COLLATE NOCASE'
  ).all();
}
export function saveExpenseCategory(db: DB, input: any, actorId: string | null, categoryId?: string): any {
  const n = categoryInput(db, input); const id = categoryId || randomUUID();
  try {
    db.transaction(() => {
      const before = categoryId ? db.prepare('SELECT id,name,expense_account_id,is_active FROM accounting_expense_categories WHERE id=?').get(categoryId) as any : null;
      if (categoryId && !before) fail('category_not_found', 'Expense category was not found.', 404);
      if (categoryId) {
        db.prepare('UPDATE accounting_expense_categories SET name=?, expense_account_id=?, is_active=?, updated_by=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
          .run(n.name, n.accountId, n.active, actorId, categoryId);
      } else {
        db.prepare('INSERT INTO accounting_expense_categories (id,name,expense_account_id,is_active,created_by,updated_by) VALUES (?,?,?,?,?,?)')
          .run(id, n.name, n.accountId, n.active, actorId, actorId);
      }
      auditExpenseAction(db, 'expense_category', id, categoryId ? 'updated' : 'created', actorId, before, {
        id, name: n.name, expense_account_id: n.accountId, is_active: n.active,
      });
    })();
  } catch (e: any) {
    if (String(e?.message || '').includes('UNIQUE constraint failed: accounting_expense_categories.name')) fail('duplicate_category', 'An expense category with this name already exists.', 409);
    throw e;
  }
  return listExpenseCategories(db, true).find((row: any) => row.id === id);
}
function paymentKey(db: DB, value: unknown): string {
  const key = textValue(value, 'payment_method_key', 80);
  if (key === 'cash' || key === 'card' || key === 'loyalty') return key;
  const match = /^custom:([1-9]\d*)$/.exec(key);
  if (!match) fail('invalid_payment_method_key', 'Choose a supported existing payment method.');
  if (!db.prepare('SELECT id FROM payment_methods WHERE id = ?').get(Number(match[1]))) fail('payment_method_not_found', 'The selected custom payment method does not exist.', 404);
  return key;
}
function mappedAccount(db: DB, key: string, accountId: unknown): string {
  const types = key === 'cash' || key === 'card' ? ['asset'] : key === 'loyalty' ? ['liability'] : ['asset', 'liability'];
  return postingAccount(db, accountId, types).id;
}
export function listPaymentAccountMappings(db: DB): any[] {
  const methods = [
    { payment_method_key: 'cash', payment_method_name: 'Cash' },
    { payment_method_key: 'card', payment_method_name: 'Card' },
    { payment_method_key: 'loyalty', payment_method_name: 'Loyalty wallet' },
    ...(db.prepare('SELECT id, name, is_active FROM payment_methods ORDER BY sort_order, id').all() as any[])
      .map((m) => ({ payment_method_key: 'custom:' + m.id, payment_method_name: m.name, payment_method_id: m.id, payment_method_active: Boolean(m.is_active) })),
  ];
  const rows = db.prepare('SELECT m.payment_method_key, m.account_id, a.account_code, a.name AS account_name, a.account_type, m.updated_by, m.updated_at FROM accounting_payment_method_mappings m JOIN accounting_accounts a ON a.id=m.account_id').all() as any[];
  const byKey = new Map(rows.map((row) => [row.payment_method_key, row]));
  return methods.map((method) => ({ ...method, ...(byKey.get(method.payment_method_key) || { account_id: null, account_code: null, account_name: null }) }));
}
export function setPaymentAccountMapping(db: DB, methodKey: unknown, accountId: unknown, actorId: string | null): any {
  const key = paymentKey(db, methodKey); const account = mappedAccount(db, key, accountId);
  const before = db.prepare('SELECT payment_method_key,account_id FROM accounting_payment_method_mappings WHERE payment_method_key=?').get(key) as any;
  db.transaction(() => {
    db.prepare('INSERT INTO accounting_payment_method_mappings (payment_method_key,account_id,updated_by) VALUES (?,?,?) ON CONFLICT(payment_method_key) DO UPDATE SET account_id=excluded.account_id, updated_by=excluded.updated_by, updated_at=CURRENT_TIMESTAMP')
      .run(key, account, actorId);
    auditExpenseAction(db, 'payment_method_mapping', key, before ? 'updated' : 'created', actorId, before, { payment_method_key: key, account_id: account });
  })();
  return listPaymentAccountMappings(db).find((m) => m.payment_method_key === key);
}
function paymentInput(db: DB, input: any) {
  const status = input?.payment_status === undefined ? 'unpaid' : input.payment_status;
  if (status !== 'paid' && status !== 'unpaid') fail('invalid_payment_status', 'Payment status must be paid or unpaid.');
  if (status === 'unpaid') return { paymentStatus: status, paymentMethodKey: null, paymentAccountId: null, paymentDate: null };
  const key = paymentKey(db, input?.payment_method_key);
  if (key === 'loyalty') fail('invalid_expense_payment_method', 'A loyalty wallet is not a valid expense payment source.');
  const mapping = db.prepare('SELECT account_id FROM accounting_payment_method_mappings WHERE payment_method_key=?').get(key) as { account_id: string } | undefined;
  if (!mapping) fail('payment_mapping_required', 'Map this payment method to an accounting account before using it for a paid expense.', 409);
  return { paymentStatus: status, paymentMethodKey: key, paymentAccountId: mapping.account_id, paymentDate: assertAccountingDate(input?.payment_date, 'payment_date') };
}
function expenseInput(db: DB, input: any) {
  const categoryId = textValue(input?.category_id, 'category_id', 100);
  const category = db.prepare('SELECT c.id,c.is_active,c.expense_account_id,a.account_type,a.is_active AS account_active,a.is_postable FROM accounting_expense_categories c JOIN accounting_accounts a ON a.id=c.expense_account_id WHERE c.id=?').get(categoryId) as any;
  if (!category) fail('category_not_found', 'Expense category was not found.', 404);
  if (category.is_active !== 1 || category.account_active !== 1 || category.is_postable !== 1 || category.account_type !== 'expense') fail('category_unavailable', 'Choose an active category mapped to an active expense account.', 409);
  const amount = input?.amount_minor;
  if (!Number.isSafeInteger(amount) || amount <= 0) fail('invalid_amount', 'Amount must be a positive safe integer in currency minor units.');
  const currency = typeof input?.currency_code === 'string' ? input.currency_code.trim().toUpperCase() : '';
  if (!/^[A-Z]{3}$/.test(currency)) fail('invalid_currency', 'Currency code must be a three-letter code.');
  return {
    categoryId, expenseAccountId: category.expense_account_id, amount, currency, description: textValue(input?.description, 'description', 500),
    expenseDate: assertAccountingDate(input?.expense_date, 'expense_date'),
    ...paymentInput(db, input), payee: optionalText(input?.payee, 'payee', 160),
    referenceNumber: optionalText(input?.reference_number, 'reference_number', 120),
  };
}
function detail(db: DB, id: string): any {
  return db.prepare('SELECT e.*, c.name AS category_name, e.expense_account_id, a.account_code AS expense_account_code, a.name AS expense_account_name, e.payment_account_id AS payment_account_id, pa.name AS payment_account_name FROM accounting_expenses e JOIN accounting_expense_categories c ON c.id=e.category_id JOIN accounting_accounts a ON a.id=e.expense_account_id LEFT JOIN accounting_accounts pa ON pa.id=e.payment_account_id WHERE e.id=?').get(id);
}
export function listExpenses(db: DB, filters: any = {}): any[] {
  const clauses: string[] = []; const values: any[] = [];
  if (filters.from) { clauses.push('e.expense_date >= ?'); values.push(assertAccountingDate(filters.from, 'from')); }
  if (filters.to) { clauses.push('e.expense_date <= ?'); values.push(assertAccountingDate(filters.to, 'to')); }
  if (filters.category_id) { clauses.push('e.category_id = ?'); values.push(textValue(filters.category_id, 'category_id', 100)); }
  if (filters.status && ['draft','posted','reversed'].includes(String(filters.status))) { clauses.push('e.status = ?'); values.push(filters.status); }
  if (filters.payment_status && ['paid','unpaid'].includes(String(filters.payment_status))) { clauses.push('e.payment_status = ?'); values.push(filters.payment_status); }
  const limit = filters.limit === undefined ? 100 : Number(filters.limit), offset = filters.offset === undefined ? 0 : Number(filters.offset);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) fail('invalid_limit', 'Limit must be between 1 and 500.');
  if (!Number.isSafeInteger(offset) || offset < 0) fail('invalid_offset', 'Offset must be a non-negative integer.');
  return db.prepare('SELECT e.*, c.name AS category_name, a.account_code AS expense_account_code, a.name AS expense_account_name FROM accounting_expenses e JOIN accounting_expense_categories c ON c.id=e.category_id JOIN accounting_accounts a ON a.id=e.expense_account_id ' + (clauses.length ? 'WHERE ' + clauses.join(' AND ') + ' ' : '') + 'ORDER BY e.expense_date DESC,e.created_at DESC,e.id DESC LIMIT ? OFFSET ?')
    .all(...values, limit, offset);
}
export function getExpense(db: DB, id: string): any {
  const row = detail(db, textValue(id, 'expense_id', 100));
  if (!row) fail('expense_not_found', 'Expense was not found.', 404);
  return row;
}
export function createExpense(db: DB, input: any, actorId: string | null): any {
  const n = expenseInput(db, input), id = randomUUID();
  db.transaction(() => {
    db.prepare('INSERT INTO accounting_expenses (id,category_id,expense_account_id,expense_date,amount_minor,currency_code,description,payee,reference_number,payment_status,payment_method_key,payment_account_id,payment_date,created_by,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id,n.categoryId,n.expenseAccountId,n.expenseDate,n.amount,n.currency,n.description,n.payee,n.referenceNumber,n.paymentStatus,n.paymentMethodKey,n.paymentAccountId,n.paymentDate,actorId,actorId);
    auditExpenseAction(db, 'expense', id, 'created', actorId, null, {
      id, category_id: n.categoryId, expense_account_id: n.expenseAccountId, expense_date: n.expenseDate, amount_minor: n.amount,
      currency_code: n.currency, description: n.description, payment_status: n.paymentStatus,
      payment_method_key: n.paymentMethodKey, payment_account_id: n.paymentAccountId, payment_date: n.paymentDate,
    });
  })();
  return getExpense(db, id);
}
export function updateDraftExpense(db: DB, id: string, input: any, actorId: string | null): any {
  const current = getExpense(db, id);
  if (current.status !== 'draft') fail('expense_not_editable', 'Posted or reversed expenses cannot be edited; use a correction entry.', 409);
  const n = expenseInput(db, { ...current, ...input });
  if (current.category_id === n.categoryId) n.expenseAccountId = current.expense_account_id;
  if (current.payment_status === 'paid' && n.paymentStatus === 'paid' && n.paymentMethodKey === current.payment_method_key) n.paymentAccountId = current.payment_account_id;
  db.transaction(() => {
    db.prepare('UPDATE accounting_expenses SET category_id=?,expense_account_id=?,expense_date=?,amount_minor=?,currency_code=?,description=?,payee=?,reference_number=?,payment_status=?,payment_method_key=?,payment_account_id=?,payment_date=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status=?')
      .run(n.categoryId,n.expenseAccountId,n.expenseDate,n.amount,n.currency,n.description,n.payee,n.referenceNumber,n.paymentStatus,n.paymentMethodKey,n.paymentAccountId,n.paymentDate,actorId,id,'draft');
    auditExpenseAction(db, 'expense', id, 'updated', actorId, current, {
      id, category_id: n.categoryId, expense_account_id: n.expenseAccountId, expense_date: n.expenseDate, amount_minor: n.amount,
      currency_code: n.currency, description: n.description, payment_status: n.paymentStatus,
      payment_method_key: n.paymentMethodKey, payment_date: n.paymentDate,
    });
  })();
  return getExpense(db, id);
}
