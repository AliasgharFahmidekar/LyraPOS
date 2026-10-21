import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { RegionalNotConfiguredError, resolveTenantCurrency } from '../countries';
import { createDraftJournalEntry, postJournalEntry } from './ledger';
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

const EXPENSE_AUDIT_FIELDS = [
  'id', 'category_id', 'expense_account_id', 'expense_date', 'amount_minor', 'currency_code',
  'description', 'payee', 'reference_number', 'payment_status', 'payment_method_key',
  'payment_account_id', 'payment_date', 'status', 'posted_journal_entry_id',
  'reversal_journal_entry_id', 'reversal_reason',
  'created_by', 'updated_by', 'created_at', 'updated_at',
] as const;

function expenseAuditSnapshot(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(EXPENSE_AUDIT_FIELDS.map((field) => [
    field,
    row[field] === undefined ? null : row[field],
  ]));
}
function categoryInput(db: DB, input: any) {
  let active: number | null = null;
  if (input?.is_active !== undefined) {
    if (input.is_active === true || input.is_active === 1) active = 1;
    else if (input.is_active === false || input.is_active === 0) active = 0;
    else fail('invalid_is_active', 'Category active state must be a boolean.');
  }
  return {
    name: textValue(input?.name, 'name', 80),
    accountId: postingAccount(db, input?.expense_account_id, ['expense']).id,
    active,
  };
}
export function listPostingAccounts(db: DB, accountTypes?: string[]): any[] {
  const rows = db.prepare('SELECT id, system_key, account_code, name, account_type, normal_balance, parent_account_id, is_active, is_postable FROM accounting_accounts WHERE is_active = 1 AND is_postable = 1 ORDER BY account_code').all() as any[];
  const allowedTypes = new Set(['asset', 'liability', 'equity', 'revenue', 'expense']);
  const types = accountTypes === undefined ? null : accountTypes.filter((type) => allowedTypes.has(type));
  if (types !== null && types.length === 0) return [];
  return rows
    .filter((account) => types === null || types.includes(account.account_type))
    .map((account) => ({
      ...account,
      is_liquid: ['cash_drawer', 'bank_accounts', 'payment_clearing'].includes(account.system_key ?? ''),
    }));
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
      const active = n.active ?? (before ? before.is_active : 1);
      if (categoryId) {
        db.prepare('UPDATE accounting_expense_categories SET name=?, expense_account_id=?, is_active=?, updated_by=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
          .run(n.name, n.accountId, active, actorId, categoryId);
      } else {
        db.prepare('INSERT INTO accounting_expense_categories (id,name,expense_account_id,is_active,created_by,updated_by) VALUES (?,?,?,?,?,?)')
          .run(id, n.name, n.accountId, active, actorId, actorId);
      }
      auditExpenseAction(db, 'expense_category', id, categoryId ? 'updated' : 'created', actorId, before, {
        id, name: n.name, expense_account_id: n.accountId, is_active: active,
      });
    })();
  } catch (e: any) {
    if (String(e?.message || '').includes('UNIQUE constraint failed: accounting_expense_categories.name')) fail('duplicate_category', 'An expense category with this name already exists.', 409);
    throw e;
  }
  return listExpenseCategories(db, true).find((row: any) => row.id === id);
}
function paymentKey(db: DB, value: unknown, requireActive = false): string {
  const key = textValue(value, 'payment_method_key', 80);
  if (key === 'cash' || key === 'card') return key;
  const match = /^custom:([1-9]\d*)$/.exec(key);
  if (!match) fail('invalid_payment_method_key', 'Choose a supported existing payment method.');
  const method = db.prepare('SELECT id, is_active FROM payment_methods WHERE id = ?').get(Number(match[1])) as { id: number; is_active: number } | undefined;
  if (!method) fail('payment_method_not_found', 'The selected custom payment method does not exist.', 404);
  if (requireActive && method.is_active !== 1) fail('payment_method_inactive', 'Choose an active payment method for a new expense payment.', 409);
  return key;
}
function mappedAccount(db: DB, key: string, accountId: unknown): string {
  const account = postingAccount(db, accountId, ['asset']);
  const details = db.prepare('SELECT system_key FROM accounting_accounts WHERE id = ?').get(account.id) as { system_key: string | null };
  if (!['cash_drawer', 'bank_accounts', 'payment_clearing'].includes(details.system_key ?? '')) {
    fail('invalid_payment_account', 'Payment-account mappings must target configured cash, bank, or payment-clearing accounts; unclassified custom assets are not eligible.');
  }
  return account.id;
}
export function listPaymentAccountMappings(db: DB): any[] {
  const methods = [
    { payment_method_key: 'cash', payment_method_name: 'Cash' },
    { payment_method_key: 'card', payment_method_name: 'Card' },
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
  const key = paymentKey(db, input?.payment_method_key, true);
  const mapping = db.prepare('SELECT account_id FROM accounting_payment_method_mappings WHERE payment_method_key=?').get(key) as { account_id: string } | undefined;
  if (!mapping) fail('payment_mapping_required', 'Map this payment method to an accounting account before using it for a paid expense.', 409);
  const paymentAccountId = mappedAccount(db, key, mapping.account_id);
  return { paymentStatus: status, paymentMethodKey: key, paymentAccountId: paymentAccountId, paymentDate: assertAccountingDate(input?.payment_date, 'payment_date') };
}
function configuredStoreCurrency(db: DB): string {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key IN ('country', 'currency')").all() as { key: string; value: string | null }[];
  const settings = Object.fromEntries(rows.map((row) => [row.key, row.value ?? undefined]));
  try {
    return resolveTenantCurrency(settings.currency, settings.country ?? '');
  } catch (error) {
    if (error instanceof RegionalNotConfiguredError) {
      fail('regional_not_configured', 'Configure the store country and currency before recording expenses.', 409);
    }
    throw error;
  }
}

function idempotencyKeyValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return textValue(value, 'idempotency_key', 128);
}

function normalizedHashText(value: unknown): unknown {
  if (value === undefined || value === null || value === '') return null;
  return typeof value === 'string' ? (value.trim() || null) : value;
}

function expenseRequestHash(value: unknown): string {
  const input: Record<string, unknown> = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const paymentStatus = input.payment_status === undefined ? 'unpaid' : input.payment_status;
  const canonicalRequest = {
    category_id: normalizedHashText(input.category_id),
    expense_date: normalizedHashText(input.expense_date),
    amount_minor: input.amount_minor ?? null,
    currency_code: typeof input.currency_code === 'string' ? input.currency_code.trim().toUpperCase() : (input.currency_code ?? null),
    description: normalizedHashText(input.description),
    payee: normalizedHashText(input.payee),
    reference_number: normalizedHashText(input.reference_number),
    payment_status: paymentStatus,
    payment_method_key: paymentStatus === 'paid' ? normalizedHashText(input.payment_method_key) : null,
    payment_date: paymentStatus === 'paid' ? normalizedHashText(input.payment_date) : null,
  };
  const serialized = JSON.stringify(canonicalRequest);
  if (serialized === undefined) fail('invalid_expense_payload', 'Expense payload could not be normalized.');
  return createHash('sha256').update(serialized).digest('hex');
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
  const storeCurrency = configuredStoreCurrency(db);
  if (currency !== storeCurrency) {
    fail('expense_currency_mismatch', 'Expense currency must match the configured store currency (' + storeCurrency + ').', 409);
  }
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
  if (filters.status !== undefined && filters.status !== '') {
    if (typeof filters.status !== 'string' || !['draft', 'posted', 'reversed'].includes(filters.status)) fail('invalid_status', 'Status filter must be draft, posted, or reversed.');
    clauses.push('e.status = ?'); values.push(filters.status);
  }
  if (filters.payment_status !== undefined && filters.payment_status !== '') {
    if (typeof filters.payment_status !== 'string' || !['paid', 'unpaid'].includes(filters.payment_status)) fail('invalid_payment_status', 'Payment status filter must be paid or unpaid.');
    clauses.push('e.payment_status = ?'); values.push(filters.payment_status);
  }
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
export function createExpense(db: DB, input: any, actorId: string | null, idempotencyKeyInput?: unknown): any {
  const idempotencyKey = idempotencyKeyValue(idempotencyKeyInput);
  const requestHash = idempotencyKey ? expenseRequestHash(input) : null;

  // Resolve retries before revalidating mutable category/account mappings. A
  // retry must return the original record even if settings changed after commit.
  if (idempotencyKey) {
    const existing = db.prepare('SELECT id, idempotency_payload_hash FROM accounting_expenses WHERE idempotency_key = ?').get(idempotencyKey) as
      { id: string; idempotency_payload_hash: string | null } | undefined;
    if (existing) {
      if (existing.idempotency_payload_hash !== requestHash) {
        fail('idempotency_key_conflict', 'This Idempotency-Key was already used with a different expense payload.', 409);
      }
      return getExpense(db, existing.id);
    }
  }

  const n = expenseInput(db, input), id = randomUUID();
  try {
    db.transaction(() => {
      db.prepare('INSERT INTO accounting_expenses (id,category_id,expense_account_id,expense_date,amount_minor,currency_code,description,payee,reference_number,payment_status,payment_method_key,payment_account_id,payment_date,created_by,updated_by,idempotency_key,idempotency_payload_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id,n.categoryId,n.expenseAccountId,n.expenseDate,n.amount,n.currency,n.description,n.payee,n.referenceNumber,n.paymentStatus,n.paymentMethodKey,n.paymentAccountId,n.paymentDate,actorId,actorId,idempotencyKey,requestHash);
      const created = getExpense(db, id);
      auditExpenseAction(db, 'expense', id, 'created', actorId, null, expenseAuditSnapshot(created));
    })();
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error ?? '');
    if (idempotencyKey && errorMessage.includes('accounting_expenses.idempotency_key')) {
      const existing = db.prepare('SELECT id, idempotency_payload_hash FROM accounting_expenses WHERE idempotency_key = ?').get(idempotencyKey) as
        { id: string; idempotency_payload_hash: string | null } | undefined;
      if (existing) {
        if (existing.idempotency_payload_hash !== requestHash) {
          fail('idempotency_key_conflict', 'This Idempotency-Key was already used with a different expense payload.', 409);
        }
        return getExpense(db, existing.id);
      }
    }
    throw error;
  }
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
    auditExpenseAction(db, 'expense', id, 'updated', actorId, expenseAuditSnapshot(current), expenseAuditSnapshot(getExpense(db, id)));
  })();
  return getExpense(db, id);
}


export function postExpense(db: DB, id: string, actorId: string | null): any {
  const expenseId = textValue(id, 'expense_id', 100);
  const current = getExpense(db, expenseId);
  if (current.status === 'posted') {
    if (!current.posted_journal_entry_id) fail('expense_journal_missing', 'Posted expense has no linked journal entry.', 409);
    const journal = db.prepare('SELECT status FROM accounting_journal_entries WHERE id = ?')
      .get(current.posted_journal_entry_id) as { status: string } | undefined;
    if (journal?.status !== 'posted') fail('expense_journal_invalid', 'Posted expense journal is missing or not posted.', 409);
    return { ...current, duplicate: true };
  }
  if (current.status === 'reversed') fail('expense_reversed', 'A reversed expense cannot be posted again.', 409);
  if (current.payment_status !== 'paid' || !current.payment_account_id || !current.payment_date) {
    fail('expense_unpaid', 'Only expenses already marked as paid can be posted in this stage.', 409);
  }

  return db.transaction(() => {
    const fresh = getExpense(db, expenseId);
    if (fresh.status !== 'draft') fail('expense_not_postable', 'Only draft expenses can be posted.', 409);
    if (fresh.payment_status !== 'paid' || !fresh.payment_account_id || !fresh.payment_date) {
      fail('expense_unpaid', 'Only expenses already marked as paid can be posted in this stage.', 409);
    }

    const journal = createDraftJournalEntry(db, {
      entryDate: fresh.payment_date,
      description: 'Expense: ' + fresh.description,
      currencyCode: fresh.currency_code,
      lines: [
        { accountId: fresh.expense_account_id, debitMinor: fresh.amount_minor, creditMinor: 0, description: fresh.description },
        { accountId: fresh.payment_account_id, debitMinor: 0, creditMinor: fresh.amount_minor, description: fresh.description },
      ],
      createdBy: actorId,
      sourceType: 'expense',
      sourceId: fresh.id,
      sourceEvent: 'expense_paid',
      idempotencyKey: 'expense:' + fresh.id + ':paid',
    });
    const postedJournal = postJournalEntry(db, journal.id, actorId);
    db.prepare("UPDATE accounting_expenses SET status='posted', posted_journal_entry_id=?, updated_by=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='draft'")
      .run(postedJournal.id, actorId, fresh.id);
    const saved = getExpense(db, fresh.id);
    auditExpenseAction(db, 'expense', fresh.id, 'posted', actorId, expenseAuditSnapshot(fresh), expenseAuditSnapshot(saved));
    return { ...saved, duplicate: false };
  })();
}

export function reverseExpense(
  db: DB,
  id: string,
  reasonInput: unknown,
  reversalDateInput: unknown,
  actorId: string | null,
): any {
  const expenseId = textValue(id, 'expense_id', 100);
  const reason = textValue(reasonInput, 'reversal_reason', 500);
  const reversalDate = assertAccountingDate(reversalDateInput, 'reversal_date');
  const current = getExpense(db, expenseId);

  if (current.status === 'reversed') {
    const reversal = current.reversal_journal_entry_id
      ? db.prepare('SELECT entry_date, status FROM accounting_journal_entries WHERE id = ?')
        .get(current.reversal_journal_entry_id) as { entry_date: string; status: string } | undefined
      : undefined;
    if (current.reversal_reason !== reason || reversal?.entry_date !== reversalDate || reversal?.status !== 'posted') {
      fail('expense_reversal_conflict', 'This expense has already been reversed with a different reason or date.', 409);
    }
    return { ...current, duplicate: true };
  }
  if (current.status !== 'posted' || !current.posted_journal_entry_id) {
    fail('expense_not_reversible', 'Only a posted expense can be reversed.', 409);
  }

  return db.transaction(() => {
    const fresh = getExpense(db, expenseId);
    if (fresh.status !== 'posted' || !fresh.posted_journal_entry_id) {
      fail('expense_not_reversible', 'Only a posted expense can be reversed.', 409);
    }
    const original = db.prepare(
      'SELECT entry.entry_number, entry.entry_date, entry.currency_code, entry.status, line.account_id, line.debit_minor, line.credit_minor, line.description ' +
      'FROM accounting_journal_entries AS entry JOIN accounting_journal_lines AS line ON line.journal_entry_id = entry.id ' +
      'WHERE entry.id = ? ORDER BY line.line_no',
    ).all(fresh.posted_journal_entry_id) as Array<{
      entry_number: string; entry_date: string; currency_code: string; status: string;
      account_id: string; debit_minor: number; credit_minor: number; description: string | null;
    }>;
    if (original.length < 2 || original.some((line) => line.status !== 'posted')) {
      fail('expense_journal_invalid', 'The original expense journal is missing, unposted, or incomplete.', 409);
    }
    if (reversalDate < original[0].entry_date) {
      fail('invalid_reversal_date', 'A reversal must be dated on or after the original posted expense. Use an open accounting period and provide a reason to correct a closed-period entry.');
    }

    const journal = createDraftJournalEntry(db, {
      entryDate: reversalDate,
      description: 'Reversal of ' + original[0].entry_number + ': ' + reason,
      currencyCode: fresh.currency_code,
      lines: original.map((line) => ({
        accountId: line.account_id,
        debitMinor: line.credit_minor,
        creditMinor: line.debit_minor,
        description: 'Reversal: ' + (line.description || fresh.description),
      })),
      createdBy: actorId,
      sourceType: 'expense',
      sourceId: fresh.id,
      sourceEvent: 'expense_reversal',
      idempotencyKey: 'expense:' + fresh.id + ':reversal',
    });
    const postedJournal = postJournalEntry(db, journal.id, actorId);
    db.prepare("UPDATE accounting_expenses SET status='reversed', reversal_journal_entry_id=?, reversal_reason=?, updated_by=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='posted'")
      .run(postedJournal.id, reason, actorId, fresh.id);
    const saved = getExpense(db, fresh.id);
    auditExpenseAction(db, 'expense', fresh.id, 'reversed', actorId, expenseAuditSnapshot(fresh), expenseAuditSnapshot(saved));
    return { ...saved, duplicate: false };
  })();
}
