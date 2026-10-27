import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { RegionalNotConfiguredError, resolveTenantCurrency } from '../countries';
import { AccountingExpenseError, assertAccountingDate } from './expenses';
import { createDraftJournalEntry, postJournalEntry } from './ledger';

type DB = Database.Database;
type SourceClassification =
  | 'cash_on_hand'
  | 'bank_balance'
  | 'accounts_receivable'
  | 'accounts_payable'
  | 'owner_equity'
  | 'other_asset'
  | 'other_liability'
  | 'other_equity';

function fail(code: string, message: string, statusCode = 400): never {
  throw new AccountingExpenseError(code, message, statusCode);
}
function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    fail('invalid_' + field, field + ' is required and must not exceed ' + max + ' characters.');
  }
  return value.trim();
}
function configuredCurrency(db: DB): string {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key IN ('country', 'currency')").all() as { key: string; value: string | null }[];
  const settings = Object.fromEntries(rows.map((row) => [row.key, row.value ?? undefined]));
  try {
    return resolveTenantCurrency(settings.currency, settings.country ?? '');
  } catch (error) {
    if (error instanceof RegionalNotConfiguredError) {
      fail('regional_not_configured', 'Configure the store country and currency before recording opening balances.', 409);
    }
    throw error;
  }
}
function sourceClassification(value: unknown): SourceClassification {
  const allowed: SourceClassification[] = [
    'cash_on_hand', 'bank_balance', 'accounts_receivable', 'accounts_payable',
    'owner_equity', 'other_asset', 'other_liability', 'other_equity',
  ];
  if (typeof value !== 'string' || !allowed.includes(value as SourceClassification)) {
    fail('invalid_source_classification', 'Select a valid source classification for the opening balance.');
  }
  return value as SourceClassification;
}
function openingAccount(db: DB, value: unknown): any {
  const id = requiredText(value, 'account_id', 100);
  const account = db.prepare(
    'SELECT id, system_key, account_code, name, account_type, normal_balance, is_active, is_postable FROM accounting_accounts WHERE id=?',
  ).get(id) as any;
  if (!account) fail('account_not_found', 'The selected accounting account was not found.', 404);
  if (account.is_active !== 1) fail('account_inactive', 'Choose an active accounting account.', 409);
  if (account.is_postable !== 1) fail('account_not_postable', 'Opening balances require a posting account.');
  if (!['asset', 'liability', 'equity'].includes(account.account_type)) {
    fail('invalid_opening_balance_account', 'Opening balances may only be entered for asset, liability, or equity accounts.');
  }
  if (account.system_key === 'opening_balance_equity') {
    fail('invalid_opening_balance_account', 'Opening Balance Equity is a balancing account, not a source account for opening balances.');
  }
  if (account.system_key === 'inventory') {
    fail('opening_inventory_deferred', 'Inventory valuation is outside the opening-balance stage; do not infer inventory value from quantity.');
  }
  return account;
}
function expectedClassification(account: any): SourceClassification {
  const mapped: Record<string, SourceClassification> = {
    cash_drawer: 'cash_on_hand',
    bank_accounts: 'bank_balance',
    accounts_receivable: 'accounts_receivable',
    accounts_payable: 'accounts_payable',
    owner_capital: 'owner_equity',
  };
  if (typeof account.system_key === 'string' && account.system_key.startsWith('custom_liquid:cash:')) return 'cash_on_hand';
  if (typeof account.system_key === 'string' && account.system_key.startsWith('custom_liquid:bank:')) return 'bank_balance';
  return mapped[account.system_key] || (
    account.account_type === 'asset' ? 'other_asset' :
      account.account_type === 'liability' ? 'other_liability' : 'other_equity'
  );
}
function payloadHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
const OPENING_BALANCE_SELECT = `
  SELECT ob.id, ob.account_id, account.account_code, account.name AS account_name,
    account.account_type, ob.opening_date, ob.amount_minor, ob.currency_code,
    ob.source_classification, ob.journal_entry_id, entry.entry_number,
    ob.idempotency_key, ob.created_by, ob.created_at
  FROM accounting_opening_balances ob
  JOIN accounting_accounts account ON account.id=ob.account_id
  JOIN accounting_journal_entries entry ON entry.id=ob.journal_entry_id
`;

export function listOpeningBalances(db: DB, filters: { from?: unknown; to?: unknown; limit?: unknown } = {}): any[] {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (filters.from) { clauses.push('ob.opening_date >= ?'); values.push(assertAccountingDate(filters.from, 'from')); }
  if (filters.to) { clauses.push('ob.opening_date <= ?'); values.push(assertAccountingDate(filters.to, 'to')); }
  if (filters.from && filters.to && String(filters.from) > String(filters.to)) {
    fail('invalid_date_range', 'The start date must not be later than the end date.');
  }
  const limit = filters.limit === undefined ? 100 : Number(filters.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) fail('invalid_limit', 'Limit must be an integer from 1 to 500.');
  return db.prepare(OPENING_BALANCE_SELECT + (clauses.length ? ' WHERE ' + clauses.join(' AND ') : '') +
    ' ORDER BY ob.opening_date DESC, entry.entry_number DESC LIMIT ?').all(...values, limit);
}

export function createOpeningBalance(db: DB, input: any, actorId: string | null, requestKeyValue: unknown): any {
  const account = openingAccount(db, input?.account_id);
  const entryDate = assertAccountingDate(input?.entry_date, 'entry_date');
  if (!Number.isSafeInteger(input?.amount_minor) || input.amount_minor <= 0) {
    fail('invalid_amount_minor', 'Opening balance must be a positive safe integer in the configured currency minor units.');
  }
  const classification = sourceClassification(input?.source_classification);
  const expected = expectedClassification(account);
  if (classification !== expected) {
    fail('opening_balance_classification_mismatch', 'The source classification does not match the selected account. Expected: ' + expected + '.');
  }
  const currencyCode = configuredCurrency(db);
  if (input?.currency_code !== undefined && input.currency_code !== currencyCode) {
    fail('opening_balance_currency_mismatch', 'Opening balance currency must match the store currency.', 409);
  }
  const requestKey = requiredText(requestKeyValue, 'idempotency_key', 200);
  const descriptionInput = input?.description == null || input.description === '' ? '' : requiredText(input.description, 'description', 500);
  const description = descriptionInput || ('Opening balance: ' + account.name + ' (' + classification + ')');
  const payload = {
    account_id: account.id,
    entry_date: entryDate,
    amount_minor: input.amount_minor as number,
    currency_code: currencyCode,
    source_classification: classification,
    description,
  };
  const hash = payloadHash(payload);

  const result = db.transaction(() => {
    const byKey = db.prepare('SELECT id, payload_hash FROM accounting_opening_balances WHERE idempotency_key=?').get(requestKey) as
      { id: string; payload_hash: string } | undefined;
    if (byKey) {
      if (byKey.payload_hash !== hash) fail('idempotency_key_conflict', 'This idempotency key was already used for a different opening-balance payload.', 409);
      const existing = db.prepare(OPENING_BALANCE_SELECT + ' WHERE ob.id=?').get(byKey.id) as any;
      return { ...existing, duplicate: true };
    }
    const byAccount = db.prepare('SELECT id FROM accounting_opening_balances WHERE account_id=?').get(account.id) as { id: string } | undefined;
    if (byAccount) fail('opening_balance_exists', 'An opening balance is already recorded for this account. Correct it through a reviewed adjustment rather than replacing it.', 409);

    const openingEquity = db.prepare(
      "SELECT id, is_active, is_postable FROM accounting_accounts WHERE id='acct-opening-balance-equity' AND system_key='opening_balance_equity'",
    ).get() as { id: string; is_active: number; is_postable: number } | undefined;
    if (!openingEquity || openingEquity.is_active !== 1 || openingEquity.is_postable !== 1) {
      fail('opening_balance_equity_unavailable', 'The Opening Balance Equity system account is unavailable.', 409);
    }
    const amount = input.amount_minor as number;
    const accountLine = account.normal_balance === 'debit'
      ? { accountId: account.id, debitMinor: amount, creditMinor: 0, description }
      : { accountId: account.id, debitMinor: 0, creditMinor: amount, description };
    const balancingLine = account.normal_balance === 'debit'
      ? { accountId: openingEquity.id, debitMinor: 0, creditMinor: amount, description: 'Opening balance offset' }
      : { accountId: openingEquity.id, debitMinor: amount, creditMinor: 0, description: 'Opening balance offset' };
    const journal = createDraftJournalEntry(db, {
      entryDate, description, currencyCode,
      lines: [accountLine, balancingLine],
      createdBy: actorId,
      sourceType: 'accounting_opening_balance',
      sourceId: account.id,
      sourceEvent: 'opening_balance',
      idempotencyKey: 'accounting-opening-balance:' + account.id,
    });
    if (journal.duplicate) fail('opening_balance_journal_conflict', 'A journal already exists for this opening-balance source but its setup record is missing.', 409);
    const posted = postJournalEntry(db, journal.id, actorId);
    if (posted.status !== 'posted') fail('opening_balance_post_failed', 'Opening balance journal could not be posted.', 409);
    const id = randomUUID();
    db.prepare(`
      INSERT INTO accounting_opening_balances
        (id, account_id, opening_date, amount_minor, currency_code, source_classification,
         journal_entry_id, idempotency_key, payload_hash, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, account.id, entryDate, amount, currencyCode, classification, posted.id, requestKey, hash, actorId);
    const after = db.prepare(OPENING_BALANCE_SELECT + ' WHERE ob.id=?').get(id) as any;
    db.prepare(`INSERT INTO accounting_audit_log
      (entity_type, entity_id, action, actor_user_id, before_json, after_json)
      VALUES ('opening_balance', ?, 'created', ?, NULL, ?)`)
      .run(id, actorId, JSON.stringify(after));
    return { ...after, duplicate: false };
  })();
  return result;
}

export function listAccountTransactionHistory(
  db: DB,
  accountIdValue: unknown,
  filters: { from?: unknown; to?: unknown; limit?: unknown } = {},
): any {
  const accountId = requiredText(accountIdValue, 'account_id', 100);
  const account = db.prepare(
    'SELECT id, account_code, name, account_type, normal_balance, is_active, is_postable FROM accounting_accounts WHERE id=?',
  ).get(accountId) as any;
  if (!account) fail('account_not_found', 'The accounting account was not found.', 404);
  const from = filters.from ? assertAccountingDate(filters.from, 'from') : null;
  const to = filters.to ? assertAccountingDate(filters.to, 'to') : null;
  if (from && to && from > to) fail('invalid_date_range', 'The start date must not be later than the end date.');
  const limit = filters.limit === undefined ? 100 : Number(filters.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) fail('invalid_limit', 'Limit must be an integer from 1 to 500.');
  const normalSign = account.normal_balance === 'debit' ? 1 : -1;
  const balance = db.prepare(`
    SELECT COALESCE(SUM((line.debit_minor - line.credit_minor) * ?), 0) AS balance_minor
    FROM accounting_journal_lines line
    JOIN accounting_journal_entries entry ON entry.id=line.journal_entry_id
    WHERE line.account_id=? AND entry.status='posted'
  `).get(normalSign, accountId) as { balance_minor: number };
  const transactions = db.prepare(`
    WITH account_ledger AS (
      SELECT entry.id AS journal_entry_id, entry.entry_number, entry.entry_date,
        entry.description, entry.currency_code, entry.source_type, entry.source_id, entry.source_event,
        line.line_no, line.description AS line_description, line.debit_minor, line.credit_minor,
        (line.debit_minor - line.credit_minor) * ? AS balance_change_minor,
        SUM((line.debit_minor - line.credit_minor) * ?) OVER (
          ORDER BY entry.entry_date, entry.entry_number, line.line_no
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS balance_after_minor
      FROM accounting_journal_lines line
      JOIN accounting_journal_entries entry ON entry.id=line.journal_entry_id
      WHERE line.account_id=? AND entry.status='posted'
    )
    SELECT * FROM account_ledger
    WHERE (? IS NULL OR entry_date >= ?) AND (? IS NULL OR entry_date <= ?)
    ORDER BY entry_date DESC, entry_number DESC, line_no DESC
    LIMIT ?
  `).all(normalSign, normalSign, accountId, from, from, to, to, limit);
  return {
    account: { ...account, balance_minor: balance.balance_minor },
    transactions,
  };
}
