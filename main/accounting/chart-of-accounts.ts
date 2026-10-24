import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

type DB = Database.Database;

export class AccountingAccountError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400) {
    super(message);
    this.name = 'AccountingAccountError';
  }
}
function fail(code: string, message: string, statusCode = 400): never {
  throw new AccountingAccountError(code, message, statusCode);
}

const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;
type AccountType = typeof ACCOUNT_TYPES[number];
type AccountKind = AccountType | 'cash' | 'bank';
const PARENT_BY_TYPE: Record<AccountType, string> = {
  asset: 'acct-assets', liability: 'acct-liabilities', equity: 'acct-equity',
  revenue: 'acct-income', expense: 'acct-expenses',
};
const CODE_START_BY_TYPE: Record<AccountType, number> = {
  asset: 1300, liability: 2100, equity: 3100, revenue: 4100, expense: 5100,
};

export function isLiquidAccountSystemKey(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return ['cash_drawer', 'bank_accounts', 'payment_clearing'].includes(value)
    || value.startsWith('custom_liquid:cash:')
    || value.startsWith('custom_liquid:bank:');
}
function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') fail('invalid_' + field, field + ' is required.');
  const result = value.trim();
  if (!result || result.length > maxLength) fail('invalid_' + field, field + ' must be between 1 and ' + maxLength + ' characters.');
  return result;
}
function optionalText(value: unknown, field: string, maxLength: number): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') fail('invalid_' + field, field + ' must be text.');
  const result = value.trim();
  if (result.length > maxLength) fail('invalid_' + field, field + ' must not exceed ' + maxLength + ' characters.');
  return result || null;
}
function resolveAccountKind(value: unknown): { kind: AccountKind; type: AccountType; normalBalance: 'debit' | 'credit' } {
  if (typeof value !== 'string') fail('invalid_account_kind', 'Choose a supported account type.');
  const kind = value as AccountKind;
  if (kind === 'cash' || kind === 'bank') return { kind, type: 'asset', normalBalance: 'debit' };
  if (!(ACCOUNT_TYPES as readonly string[]).includes(kind)) fail('invalid_account_kind', 'Choose a supported account type.');
  const type = kind as AccountType;
  return { kind, type, normalBalance: type === 'asset' || type === 'expense' ? 'debit' : 'credit' };
}
function tableHasColumn(db: DB, table: string, column: string): boolean {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) return false;
  return (db.pragma('table_info("' + table + '")') as Array<{ name: string }>).some((item) => item.name === column);
}
function hasActiveDependencies(db: DB, accountId: string): boolean {
  const checks: Array<{ table: string; column: string; condition?: string }> = [
    { table: 'accounting_payment_method_mappings', column: 'account_id' },
    { table: 'accounting_expense_categories', column: 'expense_account_id', condition: 'is_active=1' },
    { table: 'accounting_expenses', column: 'expense_account_id', condition: "status='draft'" },
    { table: 'accounting_expenses', column: 'payment_account_id', condition: "status='draft'" },
    { table: 'accounting_loans', column: 'liability_account_id', condition: "status='active'" },
    { table: 'accounting_loans', column: 'cash_account_id', condition: "status='active'" },
    { table: 'accounting_loan_installments', column: 'interest_account_id', condition: "status NOT IN ('settled','cancelled')" },
    { table: 'accounting_loan_installments', column: 'fees_account_id', condition: "status NOT IN ('settled','cancelled')" },
    { table: 'accounting_future_items', column: 'classification_account_id', condition: "status NOT IN ('settled','cancelled')" },
    { table: 'accounting_future_items', column: 'settlement_account_id', condition: "status NOT IN ('settled','cancelled')" },
    { table: 'accounting_recurring_schedules', column: 'classification_account_id', condition: "status='active'" },
  ];
  for (const check of checks) {
    if (!tableHasColumn(db, check.table, check.column)) continue;
    const sql = 'SELECT 1 FROM "' + check.table + '" WHERE "' + check.column + '"=?'
      + (check.condition ? ' AND (' + check.condition + ')' : '') + ' LIMIT 1';
    if (db.prepare(sql).get(accountId)) return true;
  }
  return false;
}
function snapshot(row: Record<string, unknown>): Record<string, unknown> {
  return { id: row.id, account_code: row.account_code, name: row.name, account_type: row.account_type,
    system_key: row.system_key, is_system: row.is_system, is_active: row.is_active,
    is_postable: row.is_postable, description: row.description ?? null };
}
function audit(
  db: DB, id: string, action: string, actorId: string | null,
  before: Record<string, unknown> | null, after: Record<string, unknown> | null,
): void {
  db.prepare('INSERT INTO accounting_audit_log (entity_type, entity_id, action, actor_user_id, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?)')
    .run('accounting_account', id, action, actorId, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null);
}
function uiKind(row: Record<string, any>): string {
  if (typeof row.system_key === 'string' && row.system_key.startsWith('custom_liquid:cash:')) return 'cash';
  if (typeof row.system_key === 'string' && (row.system_key === 'bank_accounts' || row.system_key.startsWith('custom_liquid:bank:'))) return 'bank';
  if (row.system_key === 'cash_drawer') return 'cash';
  return String(row.account_type);
}

/** Includes active and inactive posting accounts with balances from posted ledger entries only. */
export function listManagedAccountingAccounts(db: DB): any[] {
  const rows = db.prepare(`
    SELECT a.id, a.system_key, a.account_code, a.name, a.account_type, a.normal_balance,
      a.parent_account_id, a.is_system, a.is_active, a.is_postable, a.description,
      COALESCE(SUM(CASE WHEN entry.status='posted' THEN
        CASE WHEN a.normal_balance='debit' THEN line.debit_minor-line.credit_minor
          ELSE line.credit_minor-line.debit_minor END ELSE 0 END), 0) AS balance_minor,
      COUNT(DISTINCT CASE WHEN entry.status='posted' THEN entry.id END) AS transaction_count
    FROM accounting_accounts a
    LEFT JOIN accounting_journal_lines line ON line.account_id=a.id
    LEFT JOIN accounting_journal_entries entry ON entry.id=line.journal_entry_id
    WHERE a.is_postable=1
    GROUP BY a.id
    ORDER BY a.account_code, a.name COLLATE NOCASE
  `).all() as Array<Record<string, any>>;
  return rows.map((row) => ({ ...row, is_liquid: isLiquidAccountSystemKey(row.system_key), account_kind: uiKind(row) }));
}

export function createManagedAccountingAccount(db: DB, input: any, actorId: string | null): any {
  const name = requiredText(input?.name, 'name', 120);
  const description = optionalText(input?.description, 'description', 500);
  const resolved = resolveAccountKind(input?.account_kind ?? input?.account_type);
  const parentId = PARENT_BY_TYPE[resolved.type];
  const parent = db.prepare('SELECT id,account_type,is_postable,is_active FROM accounting_accounts WHERE id=?').get(parentId) as
    { id: string; account_type: string; is_postable: number; is_active: number } | undefined;
  if (!parent || parent.account_type !== resolved.type || parent.is_postable !== 0 || parent.is_active !== 1) {
    fail('account_parent_unavailable', 'The account group for this type is not available.', 409);
  }
  let isActive = 1;
  if (input?.is_active !== undefined) {
    if (input.is_active === true || input.is_active === 1) isActive = 1;
    else if (input.is_active === false || input.is_active === 0) isActive = 0;
    else fail('invalid_is_active', 'Account active state must be a boolean.');
  }
  const id = randomUUID();
  const systemKey = resolved.kind === 'cash' || resolved.kind === 'bank' ? 'custom_liquid:' + resolved.kind + ':' + id : null;
  const saved = db.transaction(() => {
    let code = CODE_START_BY_TYPE[resolved.type];
    while (db.prepare('SELECT 1 FROM accounting_accounts WHERE account_code=?').get(String(code))) code++;
    db.prepare(`
      INSERT INTO accounting_accounts
        (id,system_key,account_code,name,account_type,normal_balance,parent_account_id,is_system,is_active,is_postable,description)
      VALUES (?,?,?,?,?,?,?,0,?,1,?)
    `).run(id, systemKey, String(code), name, resolved.type, resolved.normalBalance, parentId, isActive, description);
    const after = db.prepare('SELECT * FROM accounting_accounts WHERE id=?').get(id) as Record<string, unknown>;
    audit(db, id, 'created', actorId, null, snapshot(after));
    return after;
  })();
  return { ...saved, balance_minor: 0, transaction_count: 0, is_liquid: isLiquidAccountSystemKey(systemKey), account_kind: resolved.kind };
}

export function updateManagedAccountingAccount(db: DB, accountIdValue: unknown, input: any, actorId: string | null): any {
  const accountId = requiredText(accountIdValue, 'account_id', 100);
  const current = db.prepare('SELECT * FROM accounting_accounts WHERE id=? AND is_postable=1').get(accountId) as
    Record<string, any> | undefined;
  if (!current) fail('account_not_found', 'The posting account was not found.', 404);
  const name = requiredText(input?.name, 'name', 120);
  const description = optionalText(input?.description, 'description', 500);
  let isActive = current.is_active as number;
  if (input?.is_active !== undefined) {
    if (input.is_active === true || input.is_active === 1) isActive = 1;
    else if (input.is_active === false || input.is_active === 0) isActive = 0;
    else fail('invalid_is_active', 'Account active state must be a boolean.');
  }
  if (current.is_system === 1 && isActive !== current.is_active) {
    fail('system_account_status_locked', 'System accounts can be renamed, but their active state cannot be changed.', 409);
  }
  if (current.is_active === 1 && isActive === 0 && hasActiveDependencies(db, accountId)) {
    fail('account_has_active_dependencies', 'Reassign active accounting settings and pending obligations before deactivating this account.', 409);
  }
  const before = snapshot(current);
  const saved = db.transaction(() => {
    db.prepare('UPDATE accounting_accounts SET name=?, description=?, is_active=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(name, description, isActive, accountId);
    const after = db.prepare('SELECT * FROM accounting_accounts WHERE id=?').get(accountId) as Record<string, any>;
    audit(db, accountId, isActive === 0 && current.is_active === 1 ? 'deactivated' : 'updated', actorId, before, snapshot(after));
    return after;
  })();
  const totals = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN entry.status='posted' THEN
      CASE WHEN ?='debit' THEN line.debit_minor-line.credit_minor ELSE line.credit_minor-line.debit_minor END
      ELSE 0 END),0) AS balance_minor,
      COUNT(DISTINCT CASE WHEN entry.status='posted' THEN entry.id END) AS transaction_count
    FROM accounting_journal_lines line JOIN accounting_journal_entries entry ON entry.id=line.journal_entry_id
    WHERE line.account_id=?
  `).get(saved.normal_balance, accountId) as { balance_minor: number; transaction_count: number };
  return { ...saved, balance_minor: totals.balance_minor, transaction_count: totals.transaction_count,
    is_liquid: isLiquidAccountSystemKey(saved.system_key), account_kind: uiKind(saved) };
}
