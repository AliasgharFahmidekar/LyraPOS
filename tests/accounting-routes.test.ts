/**
 * Phase 2 Stage 1 API authorization and request-idempotency regression tests.
 * Run: npm run test:accounting-routes
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-accounting-routes-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-accounting-routes';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { initTestDb, createApp, closeDatabase, now } = require('./helpers/test-setup');
const { accountingRoutes } = require('../main/routes/accounting');
const { createDraftJournalEntry, postJournalEntry } = require('../main/accounting/ledger');
const { getAccountingSourceEventReconciliation } = require('../main/accounting/source-reconciliation');
const { processDueFutureItems } = require('../main/accounting/future-items');
const { accountingDate } = require('../main/accounting/sales');
const { getJWTSecret } = require('../main/routes/auth');

let assertions = 0;
function equal(actual: unknown, expected: unknown, message: string): void {
  require('node:assert/strict').equal(actual, expected, message);
  assertions++;
}
function ok(value: unknown, message: string): void {
  require('node:assert/strict').ok(value, message);
  assertions++;
}

function seedUser(db: any, id: string, role: string) {
  const email = id + '@test.local';
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?)
  `).run(id, id, email, bcrypt.hashSync('Testpass123', 4), role, now(), now());
  const token = jwt.sign({ userId: id, email, role }, getJWTSecret(), { expiresIn: '1h' });
  return { Authorization: 'Bearer ' + token };
}

async function main(): Promise<void> {
  const db = initTestDb();
  try {
    const owner = seedUser(db, 'accounting-api-owner', 'owner');
    const manager = seedUser(db, 'accounting-api-manager', 'manager');
    const cashier = seedUser(db, 'accounting-api-cashier', 'cashier');
    const server = seedUser(db, 'accounting-api-server', 'server');
    const chef = seedUser(db, 'accounting-api-chef', 'chef');
    const app = createApp({ '/api/accounting': accountingRoutes });

    equal((await request(app).get('/api/accounting/expenses')).status, 401, 'unauthenticated expense list is denied');
    equal((await request(app).get('/api/accounting/future-items')).status, 401, 'unauthenticated future-item list is denied');
    equal((await request(app).post('/api/accounting/future-items').set(cashier).send({})).status, 403, 'cashier cannot create future items');
    equal((await request(app).get('/api/accounting/future-items').set(cashier)).status, 403, 'cashier cannot read future items');
    equal((await request(app).get('/api/accounting/export')).status, 401, 'unauthenticated accounting export is denied');
    for (const [role, headers] of [['cashier', cashier], ['server', server], ['chef', chef]] as const) {
      equal((await request(app).get('/api/accounting/accounts').set(headers)).status, 403, role + ' cannot read accounting accounts');
      equal((await request(app).get('/api/accounting/transfers').set(headers)).status, 403, role + ' cannot read accounting transfers');
      equal((await request(app).post('/api/accounting/transfers').set(headers).send({})).status, 403, role + ' cannot create accounting transfers');
      equal((await request(app).post('/api/accounting/expenses').set(headers).send({})).status, 403, role + ' cannot create accounting expenses');
      equal((await request(app).post('/api/accounting/expenses/not-an-id/post').set(headers).send({})).status, 403, role + ' cannot post accounting expenses');
      equal((await request(app).post('/api/accounting/expenses/not-an-id/reverse').set(headers).send({ reason: 'x', reversal_date: '2026-10-11' })).status, 403, role + ' cannot reverse accounting expenses');
    }
    equal((await request(app).get('/api/accounting/activities').set(cashier)).status, 403, 'cashier cannot read manual accounting activities');
    equal((await request(app).get('/api/accounting/reconciliation').set(cashier)).status, 403, 'cashier cannot read accounting reconciliation');
    equal((await request(app).post('/api/accounting/reconciliation/adjustments').set(cashier).send({})).status, 403, 'cashier cannot post reconciliation adjustments');
    equal((await request(app).post('/api/accounting/activities').set(cashier).send({})).status, 403, 'cashier cannot create manual accounting activities');
    equal((await request(app).get('/api/accounting/opening-balances').set(cashier)).status, 403, 'cashier cannot read opening balances');
    equal((await request(app).post('/api/accounting/opening-balances').set(cashier).send({})).status, 403, 'cashier cannot create opening balances');
    equal((await request(app).get('/api/accounting/accounts/acct-bank/transactions').set(cashier)).status, 403, 'cashier cannot read account history');
    equal((await request(app).get('/api/accounting/accounts').set(owner)).status, 200, 'owner can read posting accounts');
    equal((await request(app).get('/api/accounting/accounts').set(manager)).status, 200, 'manager can read posting accounts');
    for (const headers of [owner, manager]) {
      const exportResponse = await request(app).get('/api/accounting/export').set(headers);
      equal(exportResponse.status, 200, 'owner/manager can export accounting audit data');
      equal(exportResponse.body.format, 'lyrapos-accounting-export', 'accounting export has an explicit format marker');
      ok(Array.isArray(exportResponse.body.accounting_tables?.accounting_journal_entries), 'accounting export includes journal headers');
      ok(Array.isArray(exportResponse.body.accounting_tables?.accounting_journal_lines), 'accounting export includes journal lines');
      ok(Array.isArray(exportResponse.body.accounting_tables?.accounting_audit_log), 'accounting export includes the audit log');
      ok(Array.isArray(exportResponse.body.accounting_triggers), 'accounting export includes installed accounting guards');
      ok(Array.isArray(exportResponse.body.integrity_check), 'accounting export reports SQLite integrity check results');
      ok(Array.isArray(exportResponse.body.foreign_key_violations), 'accounting export reports foreign-key check results');
    }
    const accountList = await request(app).get('/api/accounting/accounts').set(manager);
    equal(accountList.body.accounts.find((a: any) => a.id === 'acct-bank')?.is_liquid, true, 'bank is explicitly marked as a liquid asset');
    equal(accountList.body.accounts.find((a: any) => a.id === 'acct-inventory')?.is_liquid, false, 'inventory is explicitly marked as non-liquid');

    db.prepare(`
      INSERT INTO accounting_accounts
        (id, system_key, account_code, name, account_type, normal_balance, parent_account_id, is_system, is_active, is_postable)
      VALUES ('acct-custom-nonliquid', NULL, '1199', 'Custom non-liquid asset', 'asset', 'debit', 'acct-assets', 0, 1, 1)
    `).run();
    const customAccountList = await request(app).get('/api/accounting/accounts').set(manager);
    equal(customAccountList.body.accounts.find((a: any) => a.id === 'acct-custom-nonliquid')?.is_liquid, false, 'custom asset without a liquid classification is not selectable as a payment account');
    const otherIncomePayload = { activity_type: 'other_income', entry_date: '2026-10-15', amount_minor: 12500, description: 'Interest received', asset_account_id: 'acct-bank', income_account_id: 'acct-other-income' };
    const otherIncome = await request(app).post('/api/accounting/activities').set(manager).set('Idempotency-Key', 'manual-income-001').send(otherIncomePayload);
    equal(otherIncome.status, 201, 'manager can record manual other income');
    equal(otherIncome.body.activity?.activity_type, 'other_income', 'other-income activity type is returned');
    const incomeJournalId = otherIncome.body.activity?.id;
    equal((db.prepare("SELECT COUNT(*) AS count FROM accounting_journal_entries WHERE source_type='accounting_manual_activity' AND source_event='other_income' AND status='posted'").get() as any).count, 1, 'other income creates one posted journal');
    const incomeTotals = db.prepare("SELECT SUM(debit_minor) AS debit, SUM(credit_minor) AS credit FROM accounting_journal_lines WHERE journal_entry_id=?").get(incomeJournalId) as any;
    equal(incomeTotals.debit, 12500, 'other income debits exact amount');
    equal(incomeTotals.credit, 12500, 'other income credits exact amount');
    equal((db.prepare("SELECT account.account_type FROM accounting_journal_lines line JOIN accounting_accounts account ON account.id=line.account_id WHERE line.journal_entry_id=? AND line.credit_minor>0").get(incomeJournalId) as any).account_type, 'revenue', 'other income credits revenue');
    const incomeRetry = await request(app).post('/api/accounting/activities').set(manager).set('Idempotency-Key', 'manual-income-001').send(otherIncomePayload);
    equal(incomeRetry.status, 201, 'manual other-income retry is accepted');
    equal(incomeRetry.body.activity?.id, incomeJournalId, 'manual other-income retry returns same journal');
    const incomeConflict = await request(app).post('/api/accounting/activities').set(manager).set('Idempotency-Key', 'manual-income-001').send({ ...otherIncomePayload, amount_minor: 12501 });
    equal(incomeConflict.status, 409, 'changed manual activity payload cannot reuse an idempotency key');

    const contribution = await request(app).post('/api/accounting/activities').set(manager).set('Idempotency-Key', 'manual-capital-001').send({ ...otherIncomePayload, activity_type: 'owner_contribution', description: 'Owner capital' });
    equal(contribution.status, 201, 'manager can record owner contribution');
    equal((db.prepare("SELECT account.account_type FROM accounting_journal_lines line JOIN accounting_accounts account ON account.id=line.account_id WHERE line.journal_entry_id=? AND line.credit_minor>0").get(contribution.body.activity?.id) as any).account_type, 'equity', 'owner contribution credits equity, not revenue');
    equal((db.prepare("SELECT COUNT(*) AS count FROM accounting_journal_lines line JOIN accounting_accounts account ON account.id=line.account_id WHERE line.journal_entry_id=? AND account.account_type='revenue'").get(contribution.body.activity?.id) as any).count, 0, 'owner contribution creates no revenue line');

    const drawing = await request(app).post('/api/accounting/activities').set(manager).set('Idempotency-Key', 'manual-drawing-001').send({ ...otherIncomePayload, activity_type: 'owner_drawing', description: 'Owner drawing' });
    equal(drawing.status, 201, 'manager can record owner drawing');
    equal((db.prepare("SELECT account.account_type FROM accounting_journal_lines line JOIN accounting_accounts account ON account.id=line.account_id WHERE line.journal_entry_id=? AND line.debit_minor>0").get(drawing.body.activity?.id) as any).account_type, 'equity', 'owner drawing debits equity, not expense');
    equal((db.prepare("SELECT COUNT(*) AS count FROM accounting_journal_lines line JOIN accounting_accounts account ON account.id=line.account_id WHERE line.journal_entry_id=? AND account.account_type='expense'").get(drawing.body.activity?.id) as any).count, 0, 'owner drawing creates no expense line');

    const invalidIncomeAccount = await request(app).post('/api/accounting/activities').set(manager).set('Idempotency-Key', 'manual-income-invalid').send({ ...otherIncomePayload, income_account_id: 'acct-sales-revenue' });
    equal(invalidIncomeAccount.status, 400, 'manual other income cannot post to POS sales revenue');

    const journalsBeforeInvalidAssets = (db.prepare("SELECT COUNT(*) AS count FROM accounting_journal_entries WHERE source_type='accounting_manual_activity'").get() as any).count;
    for (const [accountId, label] of [['acct-inventory', 'inventory'], ['acct-receivables', 'receivables'], ['acct-custom-nonliquid', 'custom non-liquid asset']] as const) {
      const invalidAsset = await request(app).post('/api/accounting/activities').set(manager)
        .set('Idempotency-Key', 'manual-income-invalid-asset-' + label.replace(/ /g, '-'))
        .send({ ...otherIncomePayload, asset_account_id: accountId });
      equal(invalidAsset.status, 400, label + ' cannot be used as a manual receipt account');
      equal(invalidAsset.body.code, 'invalid_liquid_asset', label + ' has a stable liquid-account validation error');
    }
    equal((db.prepare("SELECT COUNT(*) AS count FROM accounting_journal_entries WHERE source_type='accounting_manual_activity'").get() as any).count,
      journalsBeforeInvalidAssets, 'rejected non-liquid account requests leave the ledger untouched');
    
    const openingCashPayload = {
      account_id: 'acct-cash-drawer',
      entry_date: '2026-10-01',
      amount_minor: 125000,
      currency_code: 'INR',
      source_classification: 'cash_on_hand',
      description: 'Cash at accounting cutover',
    };
    const openingCash = await request(app).post('/api/accounting/opening-balances')
      .set(manager).set('Idempotency-Key', 'opening-cash-001').send(openingCashPayload);
    equal(openingCash.status, 201, 'manager can record a cash opening balance');
    equal(openingCash.body.opening_balance?.source_classification, 'cash_on_hand', 'opening balance retains its source classification');
    equal((db.prepare("SELECT status FROM accounting_journal_entries WHERE id=?").get(openingCash.body.opening_balance?.journal_entry_id) as any).status,
      'posted', 'opening balance is posted through the existing ledger');
    const openingCashJournalId = openingCash.body.opening_balance?.journal_entry_id;
    require('node:assert/strict').throws(
      () => db.prepare('UPDATE accounting_opening_balances SET amount_minor=? WHERE id=?').run(125001, openingCash.body.opening_balance?.id),
      /ACCOUNTING_OPENING_BALANCE_IMMUTABLE/,
      'opening-balance setup records cannot be silently edited',
    ); assertions++;
    require('node:assert/strict').throws(
      () => db.prepare('DELETE FROM accounting_opening_balances WHERE id=?').run(openingCash.body.opening_balance?.id),
      /ACCOUNTING_OPENING_BALANCE_IMMUTABLE/,
      'opening-balance setup records cannot be deleted',
    ); assertions++;
    equal((db.prepare('SELECT amount_minor FROM accounting_opening_balances WHERE id=?').get(openingCash.body.opening_balance?.id) as any).amount_minor,
      125000, 'rejected direct mutations preserve the recorded opening amount');
    const openingCashTotals = db.prepare("SELECT SUM(debit_minor) AS debit, SUM(credit_minor) AS credit FROM accounting_journal_lines WHERE journal_entry_id=?")
      .get(openingCashJournalId) as any;
    equal(openingCashTotals.debit, 125000, 'cash opening journal debits the exact amount');
    equal(openingCashTotals.credit, 125000, 'cash opening journal credits the exact amount');
    equal((db.prepare("SELECT COUNT(*) AS count FROM accounting_journal_lines line JOIN accounting_accounts account ON account.id=line.account_id WHERE line.journal_entry_id=? AND account.account_type IN ('revenue','expense')")
      .get(openingCashJournalId) as any).count, 0, 'cash opening balance does not create income or expense');
    const openingCashRetry = await request(app).post('/api/accounting/opening-balances')
      .set(manager).set('Idempotency-Key', 'opening-cash-001').send(openingCashPayload);
    equal(openingCashRetry.status, 201, 'identical opening balance request is safely retryable');
    equal(openingCashRetry.body.opening_balance?.id, openingCash.body.opening_balance?.id, 'opening balance retry returns the original setup record');
    equal(openingCashRetry.body.opening_balance?.duplicate, true, 'opening balance retry is marked duplicate');
    const openingCashChangedKey = await request(app).post('/api/accounting/opening-balances')
      .set(manager).set('Idempotency-Key', 'opening-cash-001').send({ ...openingCashPayload, amount_minor: 125001 });
    equal(openingCashChangedKey.status, 409, 'opening-balance idempotency key cannot be reused with changed payload');
    equal(openingCashChangedKey.body.code, 'idempotency_key_conflict', 'changed opening-balance retry has a stable error code');
    const duplicateOpening = await request(app).post('/api/accounting/opening-balances')
      .set(manager).set('Idempotency-Key', 'opening-cash-002').send(openingCashPayload);
    equal(duplicateOpening.status, 409, 'a second opening balance cannot be added to the same account');
    equal(duplicateOpening.body.code, 'opening_balance_exists', 'duplicate account opening balance has a stable error code');

    const openingPayable = await request(app).post('/api/accounting/opening-balances')
      .set(manager).set('Idempotency-Key', 'opening-payables-001')
      .send({ account_id: 'acct-payables', entry_date: '2026-10-01', amount_minor: 6500, currency_code: 'INR', source_classification: 'accounts_payable' });
    equal(openingPayable.status, 201, 'manager can record a payable opening balance');
    equal((db.prepare("SELECT account.account_type FROM accounting_journal_lines line JOIN accounting_accounts account ON account.id=line.account_id WHERE line.journal_entry_id=? AND line.credit_minor>0")
      .get(openingPayable.body.opening_balance?.journal_entry_id) as any).account_type, 'liability', 'payable opening balance credits the liability account');

    const openingCapital = await request(app).post('/api/accounting/opening-balances')
      .set(manager).set('Idempotency-Key', 'opening-capital-001')
      .send({ account_id: 'acct-owner-capital', entry_date: '2026-10-01', amount_minor: 11000, currency_code: 'INR', source_classification: 'owner_equity' });
    equal(openingCapital.status, 201, 'manager can record prior owner equity as an opening balance');
    equal((db.prepare("SELECT account.account_type FROM accounting_journal_lines line JOIN accounting_accounts account ON account.id=line.account_id WHERE line.journal_entry_id=? AND line.credit_minor>0")
      .get(openingCapital.body.opening_balance?.journal_entry_id) as any).account_type, 'equity', 'opening owner equity remains equity and is not income');

    const badClassification = await request(app).post('/api/accounting/opening-balances')
      .set(manager).set('Idempotency-Key', 'opening-bad-classification')
      .send({ account_id: 'acct-bank', entry_date: '2026-10-01', amount_minor: 4500, currency_code: 'INR', source_classification: 'cash_on_hand' });
    equal(badClassification.status, 400, 'opening-balance source classification must match selected account');
    equal(badClassification.body.code, 'opening_balance_classification_mismatch', 'classification mismatch has a stable error code');
    const inventoryOpening = await request(app).post('/api/accounting/opening-balances')
      .set(manager).set('Idempotency-Key', 'opening-inventory-deferred')
      .send({ account_id: 'acct-inventory', entry_date: '2026-10-01', amount_minor: 8000, currency_code: 'INR', source_classification: 'other_asset' });
    equal(inventoryOpening.status, 400, 'inventory valuation is not inferred by the opening-balance workflow');
    equal(inventoryOpening.body.code, 'opening_inventory_deferred', 'deferred inventory opening has a stable error code');
    const incomeOpening = await request(app).post('/api/accounting/opening-balances')
      .set(manager).set('Idempotency-Key', 'opening-income-invalid')
      .send({ account_id: 'acct-other-income', entry_date: '2026-10-01', amount_minor: 8000, currency_code: 'INR', source_classification: 'other_equity' });
    equal(incomeOpening.status, 400, 'income accounts cannot be assigned an opening balance as an equity counter');
    
    const openingList = await request(app).get('/api/accounting/opening-balances?limit=100').set(manager);
    equal(openingList.status, 200, 'manager can list opening-balance setup records');
    equal(openingList.body.opening_balances?.length, 3, 'opening balance listing shows only the three accepted opening records');
    const cashHistory = await request(app).get('/api/accounting/accounts/acct-cash-drawer/transactions?from=2026-10-01&to=2026-10-01').set(manager);
    equal(cashHistory.status, 200, 'manager can read account transaction history with date filters');
    equal(cashHistory.body.account?.balance_minor, 125000, 'account history balance reconciles to posted opening balance');
    equal(cashHistory.body.transactions?.length, 1, 'date-filtered account history contains opening entry');
    equal(cashHistory.body.transactions?.[0]?.source_type, 'accounting_opening_balance', 'account history identifies opening-balance source');
    equal(cashHistory.body.transactions?.[0]?.balance_after_minor, 125000, 'account history includes a correct running balance');


    const categoryResponse = await request(app).post('/api/accounting/expense-categories')
      .set(manager).send({ name: 'API Utilities', expense_account_id: 'acct-operating-expenses' });
    equal(categoryResponse.status, 201, 'manager can create expense category');
    const categoryId = categoryResponse.body.category?.id;
    ok(typeof categoryId === 'string' && categoryId.length > 0, 'category response contains an identifier');

    const invalidMappingResponse = await request(app).put('/api/accounting/payment-account-mappings/cash')
      .set(manager).send({ account_id: 'acct-inventory' });
    equal(invalidMappingResponse.status, 400, 'payment methods cannot be mapped to inventory');
    equal(invalidMappingResponse.body.code, 'invalid_payment_account', 'invalid payment account mapping has stable error code');
    const mappingResponse = await request(app).put('/api/accounting/payment-account-mappings/cash')
      .set(manager).send({ account_id: 'acct-cash-drawer' });
    equal(mappingResponse.status, 200, 'manager can configure payment-account mapping');
    db.prepare("UPDATE accounting_payment_method_mappings SET account_id='acct-inventory' WHERE payment_method_key='card'").run();
    const invalidPersistedMapping = await request(app).post('/api/accounting/expenses')
      .set(manager).set('Idempotency-Key', 'accounting-invalid-persisted-mapping')
      .send({ category_id: categoryId, expense_date: '2026-10-11', amount_minor: 5000, currency_code: 'INR', description: 'Must reject corrupted mapping', payment_status: 'paid', payment_method_key: 'card', payment_date: '2026-10-11' });
    equal(invalidPersistedMapping.status, 400, 'paid expense creation rejects a pre-existing invalid payment mapping');
    equal(invalidPersistedMapping.body.code, 'invalid_payment_account', 'corrupted persisted mapping is rejected with stable code');
    equal((db.prepare("SELECT COUNT(*) AS count FROM accounting_expenses WHERE idempotency_key='accounting-invalid-persisted-mapping'").get() as any).count,
      0, 'invalid persisted payment mapping does not create an expense');
    db.prepare("UPDATE accounting_payment_method_mappings SET account_id='acct-payment-clearing' WHERE payment_method_key='card'").run();

    const payload = {
      category_id: categoryId,
      expense_date: '2026-10-11',
      amount_minor: 9000,
      currency_code: 'INR',
      description: 'API test utility bill',
      payee: 'Utility company',
      reference_number: 'UTIL-9000',
      payment_status: 'paid',
      payment_method_key: 'cash',
      payment_date: '2026-10-11',
    };
    const first = await request(app).post('/api/accounting/expenses')
      .set(manager).set('Idempotency-Key', 'accounting-api-expense-0001').send(payload);
    equal(first.status, 201, 'manager can create paid expense with an idempotency key');
    const firstId = first.body.expense?.id;
    ok(typeof firstId === 'string' && firstId.length > 0, 'create response contains the expense identifier');

    const retry = await request(app).post('/api/accounting/expenses')
      .set(manager).set('Idempotency-Key', 'accounting-api-expense-0001').send(payload);
    equal(retry.status, 201, 'same idempotency request can be retried safely');
    equal(retry.body.expense?.id, firstId, 'retry returns the original expense');
    equal((db.prepare('SELECT COUNT(*) AS count FROM accounting_expenses WHERE idempotency_key = ?').get('accounting-api-expense-0001') as any).count,
      1, 'HTTP retry does not create a duplicate record');

    const conflict = await request(app).post('/api/accounting/expenses')
      .set(manager).set('Idempotency-Key', 'accounting-api-expense-0001').send({ ...payload, amount_minor: 9001 });
    equal(conflict.status, 409, 'reusing an idempotency key with a changed payload returns 409');
    equal(conflict.body.code, 'idempotency_key_conflict', 'idempotency conflict has a stable error code');

    const wrongCurrency = await request(app).post('/api/accounting/expenses')
      .set(manager).set('Idempotency-Key', 'accounting-api-expense-wrong-currency').send({ ...payload, currency_code: 'USD' });
    equal(wrongCurrency.status, 409, 'API rejects expense currency that differs from store currency');
    equal(wrongCurrency.body.code, 'expense_currency_mismatch', 'currency mismatch has a stable error code');

    equal((db.prepare("SELECT COUNT(*) AS count FROM accounting_audit_log WHERE entity_type='expense' AND entity_id=?").get(firstId) as any).count,
      1, 'idempotent retry does not duplicate the expense audit event');

    equal((await request(app).post('/api/accounting/expenses/' + firstId + '/post').set(cashier).send({})).status,
      403, 'cashier cannot post a manager-owned accounting expense');
    const postResponse = await request(app).post('/api/accounting/expenses/' + firstId + '/post').set(manager).send({});
    equal(postResponse.status, 200, 'manager can post a paid expense');
    equal(postResponse.body.expense?.status, 'posted', 'post endpoint returns posted expense state');
    const postedJournalId = postResponse.body.expense?.posted_journal_entry_id;
    ok(typeof postedJournalId === 'string' && postedJournalId.length > 0, 'post response links the journal entry');
    equal((db.prepare("SELECT COUNT(*) AS count FROM accounting_journal_entries WHERE source_type='expense' AND source_id=? AND source_event='expense_paid' AND status='posted'").get(firstId) as any).count,
      1, 'API posting creates exactly one posted expense journal');
    const postRetry = await request(app).post('/api/accounting/expenses/' + firstId + '/post').set(manager).send({});
    equal(postRetry.status, 200, 'reposting an expense is a successful idempotent retry');
    equal(postRetry.body.expense?.duplicate, true, 'post retry is explicitly marked duplicate');
    equal(postRetry.body.expense?.posted_journal_entry_id, postedJournalId, 'retry returns the existing journal link');

    const unpaidResponse = await request(app).post('/api/accounting/expenses').set(manager).send({
      ...payload, description: 'API unpaid expense', payment_status: 'unpaid', payment_method_key: undefined, payment_date: undefined,
    });
    equal(unpaidResponse.status, 201, 'manager can save an unpaid expense draft');
    const unpaidId = unpaidResponse.body.expense?.id;
    ok(typeof unpaidId === 'string' && unpaidId.length > 0, 'unpaid expense response contains an identifier');
    const postUnpaid = await request(app).post('/api/accounting/expenses/' + unpaidId + '/post').set(manager).send({});
    equal(postUnpaid.status, 409, 'unpaid expense cannot be posted as a cash outflow');
    equal(postUnpaid.body.code, 'expense_unpaid', 'unpaid posting rejection has a stable error code');
    equal((db.prepare("SELECT COUNT(*) AS count FROM accounting_journal_entries WHERE source_type='expense' AND source_id=?").get(unpaidId) as any).count,
      0, 'unpaid posting rejection leaves the ledger and cash account untouched');

    const reversePayload = { reason: 'API correction', reversal_date: '2026-10-12' };
    const reverseResponse = await request(app).post('/api/accounting/expenses/' + firstId + '/reverse').set(manager).send(reversePayload);
    equal(reverseResponse.status, 200, 'manager can reverse a posted expense with a reason and date');
    equal(reverseResponse.body.expense?.status, 'reversed', 'reverse endpoint returns reversed expense state');
    const reversalJournalId = reverseResponse.body.expense?.reversal_journal_entry_id;
    ok(typeof reversalJournalId === 'string' && reversalJournalId.length > 0, 'reverse response links a separate reversal journal');
    const reverseRetry = await request(app).post('/api/accounting/expenses/' + firstId + '/reverse').set(manager).send(reversePayload);
    equal(reverseRetry.status, 200, 'identical reversal retry is idempotent');
    equal(reverseRetry.body.expense?.duplicate, true, 'identical reversal retry is marked duplicate');
    equal((db.prepare("SELECT COUNT(*) AS count FROM accounting_journal_entries WHERE source_type='expense' AND source_id=?").get(firstId) as any).count,
      2, 'posted expense plus reversal leave exactly two posted source journals');
    const reverseConflict = await request(app).post('/api/accounting/expenses/' + firstId + '/reverse').set(manager)
      .send({ ...reversePayload, reason: 'Different correction' });
    equal(reverseConflict.status, 409, 'a reversal cannot be changed by retrying with a different reason');
    equal(reverseConflict.body.code, 'expense_reversal_conflict', 'reversal conflict has a stable error code');
    equal((await request(app).get('/api/accounting/transfers')).status, 401, 'unauthenticated transfer history is denied');
    const transferPayload = { source_account_id: 'acct-cash-drawer', destination_account_id: 'acct-bank', amount_minor: 7500, entry_date: '2026-10-12', description: 'API cash deposit' };
    const transferCountBeforeInvalid = (db.prepare("SELECT COUNT(*) AS count FROM accounting_journal_entries WHERE source_type='cash_bank_transfer'").get() as any).count;
    const inventoryTransfer = await request(app).post('/api/accounting/transfers').set(manager).set('Idempotency-Key', 'api-transfer-invalid-inventory')
      .send({ ...transferPayload, destination_account_id: 'acct-inventory' });
    equal(inventoryTransfer.status, 400, 'transfers cannot use inventory as a destination account');
    equal(inventoryTransfer.body.code, 'invalid_transfer_account_type', 'non-liquid transfer account has stable error code');
    const customTransfer = await request(app).post('/api/accounting/transfers').set(manager).set('Idempotency-Key', 'api-transfer-invalid-custom')
      .send({ ...transferPayload, destination_account_id: 'acct-custom-nonliquid' });
    equal(customTransfer.status, 400, 'transfers cannot use an unclassified custom asset');
    equal(customTransfer.body.code, 'invalid_transfer_account_type', 'custom non-liquid transfer rejection has stable error code');
    equal((db.prepare("SELECT COUNT(*) AS count FROM accounting_journal_entries WHERE source_type='cash_bank_transfer'").get() as any).count,
      transferCountBeforeInvalid, 'rejected transfers leave the ledger untouched');
    const transferResponse = await request(app).post('/api/accounting/transfers').set(manager).set('Idempotency-Key', 'api-transfer-stage3-1').send(transferPayload);
    equal(transferResponse.status, 201, 'manager can create a cash/bank transfer');
    equal(transferResponse.body.transfer?.status, 'posted', 'transfer route returns a posted journal');
    equal(transferResponse.body.transfer?.amount_minor, 7500, 'transfer route preserves exact amount');
    const transferRetry = await request(app).post('/api/accounting/transfers').set(manager).set('Idempotency-Key', 'api-transfer-stage3-1').send(transferPayload);
    equal(transferRetry.status, 201, 'identical transfer retry succeeds');
    equal(transferRetry.body.transfer?.duplicate, true, 'transfer retry is marked duplicate');
    equal((await request(app).get('/api/accounting/transfers').set(manager)).body.transfers?.length, 1, 'manager can list transfer history');
    const transferConflict = await request(app).post('/api/accounting/transfers').set(manager).set('Idempotency-Key', 'api-transfer-stage3-1').send({ ...transferPayload, amount_minor: 7600 });
    equal(transferConflict.status, 409, 'changed transfer payload cannot reuse an idempotency key');
    
    // Stage 3: pre-cutover records stay visible exceptions, not backfilled journals.
    const cutoverAt = '2026-10-19T23:59:59.000Z';
    db.prepare("INSERT OR REPLACE INTO settings (key,value,updated_at) VALUES ('accounting_cutover_at',?,?)").run(cutoverAt, now());
    const legacyStamp = '2024-01-01T10:00:00.000Z';
    const legacyOrder = db.prepare(
      'INSERT INTO orders (order_number,type,status,subtotal,tax_amount,total,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
    ).run('ACCT-LEGACY-RECON-1', 'takeaway', 'completed', 50, 0, 50, legacyStamp, legacyStamp);
    const legacyPayment = { payment_event_id: 'legacy-recon-cash-1', method: 'cash', amount: 30, timestamp: '2024-01-01T10:05:00.000Z' };
    const legacyBill = db.prepare(`
      INSERT INTO bills
        (bill_number,order_id,subtotal,tax_amount,tax_breakdown,tax_snapshot,discount_amount,
         delivery_charge,packaging_charge,service_charge,table_charge,takeaway_charge,round_off,
         total,paid_amount,balance,payment_status,payment_details,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run('ACCT-BILL-LEGACY-RECON-1', Number(legacyOrder.lastInsertRowid), 55, 0, '[]', '{}', 0,
      0, 0, 0, 0, 0, 0, 55, 55, 0, 'paid', JSON.stringify([legacyPayment,
        { payment_event_id: 'legacy-recon-wallet-1', method: 'wallet', amount: 20, timestamp: '2024-01-01T10:06:00.000Z' },
        { payment_event_id: 'legacy-recon-store-credit-1', method: 'store_credit', amount: 5, timestamp: '2024-01-01T10:07:00.000Z' }]),
      legacyStamp, legacyStamp);
    const sales = require('../main/accounting/sales');
    db.transaction(() => sales.postCollectionPaymentLines(db, Number(legacyBill.lastInsertRowid), [legacyPayment], 'accounting-api-manager'))();
    const refundInsert = db.prepare(`
      INSERT INTO refunds (bill_id,amount_cents,method,reason,approved_by,created_by,created_at)
      VALUES (?,?,?,?,?,?,?)
    `).run(Number(legacyBill.lastInsertRowid), 500, 'cash', 'pre-cutover reconciliation sample',
      'accounting-api-manager', 'accounting-api-manager', '2024-01-01T10:10:00.000Z');
    const legacyRefundResult = db.transaction(() => sales.postCommittedRefund(db, Number(refundInsert.lastInsertRowid), 'accounting-api-manager'))();
    equal(legacyRefundResult.reason, 'pre_cutover_bill', 'legacy monetary refund remains skipped instead of being silently backfilled');
    equal((db.prepare("SELECT COUNT(*) AS count FROM accounting_journal_entries WHERE source_type='bill_payment' AND source_id LIKE '%legacy-recon-cash-1%'").get() as any).count,
      0, 'pre-cutover cash payment does not create a historical journal');
    equal((db.prepare("SELECT COUNT(*) AS count FROM accounting_journal_entries WHERE source_type='refund' AND source_id=?").get(String(refundInsert.lastInsertRowid)) as any).count,
      0, 'pre-cutover monetary refund does not create a historical journal');

    const legacyOverview = await request(app).get('/api/accounting/reconciliation?limit=50').set(manager);
    equal(legacyOverview.status, 200, 'manager can read cutover reconciliation overview');
    equal(legacyOverview.body.legacy?.payment_count, 1, 'reconciliation counts only one real-money legacy payment and excludes wallet value');
    equal(legacyOverview.body.legacy?.payment_total_minor, 3000, 'legacy payment summary converts INR to accounting minor units once');
    equal(legacyOverview.body.legacy?.payment_by_method?.[0]?.method, 'cash', 'legacy summary exposes payment channel');
    equal(legacyOverview.body.legacy?.refund_count, 1, 'reconciliation exposes historical monetary refund exceptions');
    equal(legacyOverview.body.legacy?.refund_total_minor, 500, 'legacy refund summary preserves stored accounting minor units');
    equal(legacyOverview.body.audit_exceptions?.filter((row: any) => row.action === 'skipped_pre_cutover_payment').length, 1,
      'reconciliation surfaces the actual runtime audit exception for the legacy receipt');
    equal(legacyOverview.body.audit_exceptions?.filter((row: any) => row.action === 'skipped_pre_cutover_refund').length, 1,
      'reconciliation surfaces the actual runtime audit exception for the legacy refund');
    // POS legacy cash/refund records use getCurrencyMinorUnitFactor, while the accounting ledger
    // uses getAccountingMinorUnitFactor (notably: stored IRR is whole rials, but legacy cents use x100).
    const savedRegionalRows = db.prepare("SELECT key, value FROM settings WHERE key IN ('country','currency','timezone')").all() as Array<{key:string;value:string|null}>;
    const savedRegional = new Map(savedRegionalRows.map((row) => [row.key, row.value]));
    const setRegionalSetting = (key: string, value: string) => {
      db.prepare("INSERT OR REPLACE INTO settings (key,value,updated_at) VALUES (?,?,?)").run(key, value, now());
    };
    setRegionalSetting('country', 'IR');
    setRegionalSetting('currency', 'IRR');
    setRegionalSetting('timezone', 'Asia/Tehran');
    const rialOverview = await request(app).get('/api/accounting/reconciliation?limit=50').set(manager);
    equal(rialOverview.status, 200, 'legacy reconciliation supports Iranian rial settings');
    equal(rialOverview.body.legacy?.payment_total_minor, 30, 'legacy received cash is reported as whole rial ledger units');
    equal(rialOverview.body.legacy?.refund_total_minor, 5, 'legacy refund cents are converted to whole rials for accounting reports');
    for (const key of ['country','currency','timezone']) {
      if (savedRegional.has(key)) setRegionalSetting(key, String(savedRegional.get(key) ?? ''));
      else db.prepare('DELETE FROM settings WHERE key=?').run(key);
    }

    const afterCutoverAdjustment = await request(app).post('/api/accounting/reconciliation/adjustments')
      .set(manager).set('Idempotency-Key', 'api-recon-adjustment-after-cutover')
      .send({ account_id: 'acct-cash-drawer', adjustment_date: '2099-01-01', verified_balance_minor: 1,
        reason: 'Must use an ordinary current-period classification for future differences' });
    equal(afterCutoverAdjustment.status, 400, 'cutover reconciliation cannot use the opening-equity offset after the cutover business date');
    equal(afterCutoverAdjustment.body.code, 'reconciliation_adjustment_after_cutover', 'post-cutover correction requires its proper accounting classification');

    // A clean cash checkpoint compares against the ledger only when a prior opening cash balance exists.
    const currentCash = db.prepare(`
      SELECT COALESCE(SUM(line.debit_minor-line.credit_minor),0) AS balance_minor
      FROM accounting_journal_lines line
      JOIN accounting_journal_entries entry ON entry.id=line.journal_entry_id
      WHERE line.account_id='acct-cash-drawer' AND entry.status='posted' AND entry.entry_date <= '2099-01-01'
    `).get() as any;
    const expectedLedgerCash = Number(currentCash.balance_minor);
    const testCountedCash = expectedLedgerCash + 1500;
    db.prepare(`
      INSERT INTO cash_closures
        (scope,business_date,period_start,period_end,opening_float_cents,expected_cash_cents,
         counted_cash_cents,variance_cents,gross_collected_cents,refunded_cents,net_collected_cents,
         bill_count,refund_count,z_number,closed_by,notes,created_at)
      VALUES ('day','2099-01-01','2099-01-01 00:00:00','2099-01-01 23:59:59',0,?,?,?,0,0,0,0,0,99123001,
        'accounting-api-manager','reconciliation test checkpoint','2099-01-01 23:59:59')
    `).run(expectedLedgerCash, testCountedCash, 1500);
    const checkpoint = await request(app).get('/api/accounting/reconciliation?limit=50').set(manager);
    equal(checkpoint.status, 200, 'reconciliation reads an existing cash closure');
    equal(checkpoint.body.cash_checkpoints?.[0]?.comparison_status, 'difference', 'cash checkpoint shows a real ledger difference for review');
    equal(checkpoint.body.cash_checkpoints?.[0]?.difference_minor, 1500, 'cash checkpoint difference is calculated from counted cash minus GL balance');
    db.prepare("UPDATE accounting_payment_method_mappings SET account_id='acct-bank' WHERE payment_method_key='cash'").run();
    const wrongCashMapping = await request(app).get('/api/accounting/reconciliation?limit=50').set(manager);
    equal(wrongCashMapping.body.cash_checkpoints?.[0]?.comparison_status, 'requires_review_cash_mapping',
      'mapping cash receipts to bank prevents an automatic cash-drawer comparison');
    db.prepare("UPDATE accounting_payment_method_mappings SET account_id='acct-cash-drawer' WHERE payment_method_key='cash'").run();

    // Adjustments are posted only with a reason and traceable idempotency key, and never create income/expense.
    const adjustmentDate = '2026-10-19';
    const dayBalanceRow = db.prepare(`
      SELECT COALESCE(SUM(CASE WHEN account.normal_balance='debit' THEN line.debit_minor-line.credit_minor
                               ELSE line.credit_minor-line.debit_minor END),0) AS balance_minor
      FROM accounting_journal_lines line
      JOIN accounting_journal_entries entry ON entry.id=line.journal_entry_id
      JOIN accounting_accounts account ON account.id=line.account_id
      WHERE line.account_id='acct-cash-drawer' AND entry.status='posted' AND entry.entry_date <= ?
    `).get(adjustmentDate) as any;
    const ledgerBalanceBeforeAdjustment = Number(dayBalanceRow.balance_minor);
    const adjustmentPayload = {
      account_id: 'acct-cash-drawer',
      adjustment_date: adjustmentDate,
      verified_balance_minor: ledgerBalanceBeforeAdjustment + 1000,
      reason: 'Independent banknote count during controlled cutover reconciliation',
      source_reference: 'COUNT-2026-10-19-01',
    };
    const adjustment = await request(app).post('/api/accounting/reconciliation/adjustments')
      .set(manager).set('Idempotency-Key', 'api-recon-adjustment-001').send(adjustmentPayload);
    equal(adjustment.status, 201, 'manager can post an evidenced balance adjustment');
    equal(adjustment.body.adjustment?.difference_minor, 1000, 'adjustment records the exact verified-minus-ledger difference');
    equal(adjustment.body.adjustment?.reason, adjustmentPayload.reason, 'adjustment retains its reason');
    equal(adjustment.body.adjustment?.source_reference, adjustmentPayload.source_reference, 'adjustment retains its source evidence reference');
    equal(adjustment.body.adjustment?.journal_status, 'posted', 'adjustment is linked to a posted journal');
    const adjustmentJournalId = adjustment.body.adjustment?.journal_entry_id;
    const adjustmentTotals = db.prepare('SELECT SUM(debit_minor) AS debit, SUM(credit_minor) AS credit FROM accounting_journal_lines WHERE journal_entry_id=?')
      .get(adjustmentJournalId) as any;
    equal(adjustmentTotals.debit, 1000, 'reconciliation journal debits the exact adjustment amount');
    equal(adjustmentTotals.credit, 1000, 'reconciliation journal balances exactly');
    equal((db.prepare(`
      SELECT COUNT(*) AS count FROM accounting_journal_lines line
      JOIN accounting_accounts account ON account.id=line.account_id
      WHERE line.journal_entry_id=? AND account.account_type IN ('revenue','expense')
    `).get(adjustmentJournalId) as any).count, 0, 'reconciliation adjustment never posts to income or expense');
    const liabilityBefore = db.prepare(`
      SELECT COALESCE(SUM(line.credit_minor-line.debit_minor),0) AS balance_minor
      FROM accounting_journal_lines line
      JOIN accounting_journal_entries entry ON entry.id=line.journal_entry_id
      WHERE line.account_id='acct-payables' AND entry.status='posted' AND entry.entry_date <= ?
    `).get(adjustmentDate) as any;
    const liabilityAdjustment = await request(app).post('/api/accounting/reconciliation/adjustments')
      .set(manager).set('Idempotency-Key', 'api-recon-adjustment-payable')
      .send({ ...adjustmentPayload, account_id: 'acct-payables',
        verified_balance_minor: Number(liabilityBefore.balance_minor) + 250,
        reason: 'Supplier statement verified against payable opening balance', source_reference: 'SUPPLIER-RECON-001' });
    equal(liabilityAdjustment.status, 201, 'liability balance differences can be reconciled through the same controlled service');
    equal(liabilityAdjustment.body.adjustment?.difference_minor, 250, 'liability adjustment records a positive credit-side difference');
    const liabilityTargetLine = db.prepare('SELECT debit_minor,credit_minor FROM accounting_journal_lines WHERE journal_entry_id=? AND account_id=?')
      .get(liabilityAdjustment.body.adjustment?.journal_entry_id, 'acct-payables') as any;
    equal(liabilityTargetLine.debit_minor, 0, 'increased payable adjustment does not debit the liability account');
    equal(liabilityTargetLine.credit_minor, 250, 'increased payable adjustment credits the liability account');


    const adjustmentRetry = await request(app).post('/api/accounting/reconciliation/adjustments')
      .set(manager).set('Idempotency-Key', 'api-recon-adjustment-001').send(adjustmentPayload);
    equal(adjustmentRetry.status, 201, 'identical reconciliation adjustment retry succeeds');
    equal(adjustmentRetry.body.adjustment?.id, adjustment.body.adjustment?.id, 'idempotent retry returns the original adjustment');
    equal(adjustmentRetry.body.adjustment?.duplicate, true, 'identical reconciliation retry is marked duplicate');
    const adjustmentConflict = await request(app).post('/api/accounting/reconciliation/adjustments')
      .set(manager).set('Idempotency-Key', 'api-recon-adjustment-001').send({ ...adjustmentPayload, verified_balance_minor: adjustmentPayload.verified_balance_minor + 1 });
    equal(adjustmentConflict.status, 409, 'changed reconciliation payload cannot reuse its idempotency key');
    equal(adjustmentConflict.body.code, 'idempotency_key_conflict', 'changed reconciliation retry has a stable conflict code');

    const inventoryAdjustment = await request(app).post('/api/accounting/reconciliation/adjustments')
      .set(manager).set('Idempotency-Key', 'api-recon-adjustment-inventory')
      .send({ ...adjustmentPayload, account_id: 'acct-inventory', verified_balance_minor: 100 });
    equal(inventoryAdjustment.status, 400, 'inventory value cannot be reconciled until valuation and COGS are implemented');
    equal(inventoryAdjustment.body.code, 'invalid_reconciliation_account', 'inventory reconciliation rejection has a stable error code');
    const offsetAdjustment = await request(app).post('/api/accounting/reconciliation/adjustments')
      .set(manager).set('Idempotency-Key', 'api-recon-adjustment-offset')
      .send({ ...adjustmentPayload, account_id: 'acct-reconciliation-adjustment-equity' });
    equal(offsetAdjustment.status, 400, 'reconciliation offset equity cannot be adjusted against itself');

    require('node:assert/strict').throws(
      () => db.prepare('UPDATE accounting_reconciliation_adjustments SET reason=? WHERE id=?').run('tampered', adjustment.body.adjustment?.id),
      /ACCOUNTING_RECONCILIATION_ADJUSTMENT_IMMUTABLE/,
      'reconciliation adjustment metadata cannot be silently edited',
    );
    require('node:assert/strict').throws(
      () => db.prepare('DELETE FROM accounting_reconciliation_adjustments WHERE id=?').run(adjustment.body.adjustment?.id),
      /ACCOUNTING_RECONCILIATION_ADJUSTMENT_IMMUTABLE/,
      'reconciliation adjustment metadata cannot be silently deleted',
    );
    equal((db.prepare('SELECT reason FROM accounting_reconciliation_adjustments WHERE id=?').get(adjustment.body.adjustment?.id) as any).reason,
      adjustmentPayload.reason, 'failed metadata mutations preserve the original adjustment evidence');

    // With an unclassified physical drawer movement, report a review warning rather than suggesting a blind GL adjustment.
    db.prepare(`
      INSERT INTO cash_drawer_movements
        (business_date,movement_type,amount_cents,reason,created_by,created_at)
      VALUES ('2099-01-01','pay_out',200,'unclassified drawer event','accounting-api-manager','2099-01-01 12:00:00')
    `).run();
    const drawerMovementOverview = await request(app).get('/api/accounting/reconciliation?limit=50').set(manager);
    equal(drawerMovementOverview.body.cash_checkpoints?.[0]?.comparison_status, 'requires_review_drawer_movements',
      'cash drawer pay-outs force manual review before interpreting the GL difference');
    equal(drawerMovementOverview.body.cash_checkpoints?.[0]?.unclassified_drawer_movement_count, 1,
      'reconciliation identifies unclassified cash drawer movements');
    equal(drawerMovementOverview.body.adjustments?.length, 2, 'reconciliation lists both posted, traceable asset and liability adjustments');

    equal((await request(app).get('/api/accounting/reports')).status, 401, 'unauthenticated management reports are denied');
    equal((await request(app).get('/api/accounting/reports').set(cashier)).status, 403, 'cashier cannot read financial management reports');
    equal((await request(app).get('/api/accounting/forecast')).status, 401, 'unauthenticated forecast access is denied');
    equal((await request(app).get('/api/accounting/forecast').set(cashier)).status, 403, 'cashier cannot read financial forecasts');
    equal((await request(app).get('/api/accounting/trial-balance')).status, 401, 'unauthenticated trial balance is denied');
    equal((await request(app).get('/api/accounting/trial-balance').set(cashier)).status, 403, 'cashier cannot read trial balance');
    const reportLedger = require('../main/accounting/ledger');
    const postReportJournal = (input: any) => {
      const draft = reportLedger.createDraftJournalEntry(db, {
        entryDate: '2026-10-15',
        description: input.description,
        currencyCode: 'INR',
        lines: input.lines,
        createdBy: 'accounting-api-manager',
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        sourceEvent: input.sourceEvent,
        idempotencyKey: input.idempotencyKey,
      });
      reportLedger.postJournalEntry(db, draft.id, 'accounting-api-manager');
    };
    postReportJournal({
      description: 'Report test monetary sale', sourceType: 'bill_payment', sourceId: 'report-bill-1:report-payment-1',
      sourceEvent: 'money_received', idempotencyKey: 'report-test-payment-1',
      lines: [
        { accountId: 'acct-cash-drawer', debitMinor: 10000, creditMinor: 0, description: 'Cash received' },
        { accountId: 'acct-sales-revenue', debitMinor: 0, creditMinor: 10000, description: 'POS revenue' },
      ],
    });
    postReportJournal({
      description: 'Report test monetary refund', sourceType: 'refund', sourceId: 'report-refund-1',
      sourceEvent: 'money_refunded', idempotencyKey: 'report-test-refund-1',
      lines: [
        { accountId: 'acct-sales-returns', debitMinor: 2000, creditMinor: 0, description: 'Sales return' },
        { accountId: 'acct-cash-drawer', debitMinor: 0, creditMinor: 2000, description: 'Refund paid out' },
      ],
    });
    postReportJournal({
      description: 'Report test posted expense', sourceType: 'expense', sourceId: 'report-expense-1',
      sourceEvent: 'expense_paid', idempotencyKey: 'report-test-expense-1',
      lines: [
        { accountId: 'acct-operating-expenses', debitMinor: 1500, creditMinor: 0, description: 'Operating expense' },
        { accountId: 'acct-cash-drawer', debitMinor: 0, creditMinor: 1500, description: 'Expense paid' },
      ],
    });
    postReportJournal({
      description: 'Report test asset transfer', sourceType: 'cash_bank_transfer', sourceId: 'report-transfer-1',
      sourceEvent: 'transfer', idempotencyKey: 'report-test-transfer-1',
      lines: [
        { accountId: 'acct-bank', debitMinor: 3000, creditMinor: 0, description: 'Bank deposit' },
        { accountId: 'acct-cash-drawer', debitMinor: 0, creditMinor: 3000, description: 'Cash withdrawn for deposit' },
      ],
    });
    postReportJournal({
      description: 'Report test COGS journal must not enter the pre-COGS result', sourceType: 'test_cogs', sourceId: 'report-cogs-1',
      sourceEvent: 'cost_of_goods_sold', idempotencyKey: 'report-test-cogs-1',
      lines: [
        { accountId: 'acct-cogs', debitMinor: 900, creditMinor: 0, description: 'COGS' },
        { accountId: 'acct-cash-drawer', debitMinor: 0, creditMinor: 900, description: 'Cost settlement for test' },
      ],
    });
    postReportJournal({
      description: 'Report test tax payment recorded as an expense', sourceType: 'expense', sourceId: 'report-tax-payment-1',
      sourceEvent: 'expense_paid', idempotencyKey: 'report-test-tax-payment-1',
      lines: [
        { accountId: 'acct-tax-expenses', debitMinor: 700, creditMinor: 0, description: 'Tax paid to authority' },
        { accountId: 'acct-cash-drawer', debitMinor: 0, creditMinor: 700, description: 'Tax payment from cash' },
      ],
    });
    const periodReport = await request(app).get('/api/accounting/reports?from=2026-10-15&to=2026-10-15').set(manager);
    equal(periodReport.status, 200, 'manager can read the Phase 5 management report for a date range');
    equal(periodReport.body.currency_code, 'INR', 'management report uses the configured store currency');
    equal(periodReport.body.accounting_fraction_digits, 2, 'non-IRR reporting uses configured accounting minor-unit precision');
    equal(periodReport.body.summary.pos_sales_revenue_minor, 10000, 'POS sales revenue equals the posted revenue-account credit');
    equal(periodReport.body.summary.monetary_refunds_minor, 2000, 'monetary refunds are reported from the posted contra-revenue account');
    equal(periodReport.body.summary.sales_revenue_less_refunds_minor, 8000, 'sales revenue after refunds reconciles to posted revenue and returns');
    equal(periodReport.body.summary.other_income_minor, 12500, 'report counts manual other income but excludes owner contributions and drawings');
    equal(periodReport.body.summary.posted_expenses_minor, 2200, 'expense totals include posted operating expenses and tax payments');
    equal(periodReport.body.summary.posted_expenses_minor, 2200, 'the pre-COGS report excludes COGS while including tax paid as an expense');
    equal(periodReport.body.summary.tax_payments_expense_minor, 700, 'tax paid is separately visible as an expense');
    equal(periodReport.body.summary.result_before_cogs_minor, 18300, 'pre-COGS result subtracts tax paid as an expense without netting it from sales revenue');
    equal(periodReport.body.summary.result_before_cogs_minor, periodReport.body.summary.pos_sales_revenue_minor - periodReport.body.summary.monetary_refunds_minor + periodReport.body.summary.other_income_minor - periodReport.body.summary.posted_expenses_minor, 'asset transfers do not change report income or expense totals');
    equal(periodReport.body.profit_limitations.net_profit_available, false, 'report never claims net profit while COGS is unavailable');
    equal(periodReport.body.reporting_policy.sales_revenue_basis, 'actual_monetary_receipts', 'report defines sales revenue by actual monetary receipts');
    equal(periodReport.body.reporting_policy.tax_treatment, 'tax_payments_are_expenses_when_paid', 'report follows the policy that taxes are expenses when paid');
    ok(Array.isArray(periodReport.body.liquid_accounts), 'management report returns cash, bank and clearing account balances');
    ok(Array.isArray(periodReport.body.movements?.lines), 'management report returns posted ledger movement lines');
    ok(Array.isArray(periodReport.body.daily_trend?.points), 'management report returns data-backed income and expense trend points');
    const trendForReportDate = periodReport.body.daily_trend.points.find((point: any) => point.period === '2026-10-15');
    ok(Boolean(trendForReportDate), 'daily trend includes the requested report date');
    equal(trendForReportDate.income_minor, 20500, 'daily trend reconciles actual sales receipts, monetary refunds, and other income');
    equal(trendForReportDate.expense_minor, 2200, 'daily trend counts posted expenses once and excludes COGS and internal transfers');
    equal((await request(app).get('/api/accounting/reports?from=2026-10-16&to=2026-10-15').set(manager)).status, 400,
      'management report rejects a reversed date range');
    equal((await request(app).get('/api/accounting/reports?limit=101').set(manager)).status, 400,
      'management report rejects movement limits above the supported maximum');

    const trialBalance = await request(app).get('/api/accounting/trial-balance?from=2026-10-15&to=2026-10-15').set(manager);
    equal(trialBalance.status, 200, 'manager can read the read-only trial balance');
    equal(trialBalance.body.currency_code, 'INR', 'trial balance uses configured store currency');
    equal(trialBalance.body.read_only, true, 'trial balance explicitly declares its read-only behavior');
    equal(trialBalance.body.totals.closing_debit_minor, trialBalance.body.totals.closing_credit_minor, 'trial balance closing debit and credit totals match');
    equal(trialBalance.body.totals.period_debit_minor, trialBalance.body.totals.period_credit_minor, 'posted period movement debits and credits match');
    equal(trialBalance.body.integrity.balanced, true, 'all posted journals in the selected period pass per-entry integrity checks');
    ok(trialBalance.body.accounts.some((account: any) => account.id === 'acct-sales-revenue'), 'trial balance includes revenue accounts');
    equal((await request(app).get('/api/accounting/trial-balance?from=2026-02-30').set(manager)).status, 400, 'trial balance rejects impossible calendar dates');
    equal((await request(app).get('/api/accounting/trial-balance?from=2026-10-16&to=2026-10-15').set(manager)).status, 400, 'trial balance rejects reversed date ranges');
    equal((await request(app).get('/api/accounting/periods').set(cashier)).status, 403, 'cashier cannot read accounting periods');
    equal((await request(app).post('/api/accounting/periods/close').set(cashier).send({})).status, 403, 'cashier cannot close accounting periods');

    // Source timestamps must use the tenant's accounting business date, not the UTC date prefix.
    const boundarySettings = ['timezone', 'business_day_start_time'].map((key) => ({
      key,
      row: db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string | null } | undefined,
    }));
    let boundaryOrderId: number | null = null;
    let boundaryBillId: number | null = null;
    try {
      db.prepare("INSERT INTO settings (key,value,updated_at) VALUES ('timezone','Pacific/Kiritimati',?) ON CONFLICT(key) DO UPDATE SET value='Pacific/Kiritimati',updated_at=excluded.updated_at")
        .run(now());
      db.prepare("INSERT INTO settings (key,value,updated_at) VALUES ('business_day_start_time','00:00',?) ON CONFLICT(key) DO UPDATE SET value='00:00',updated_at=excluded.updated_at")
        .run(now());

      const boundaryTimestamp = '2099-10-20T12:00:00.000Z';
      const createdAt = '2099-10-20 12:00:00';
      const orderInsert = db.prepare('INSERT INTO orders (order_number,status,created_at,updated_at) VALUES (?,?,?,?)')
        .run('ACCT-BUSINESS-DATE-BOUNDARY', 'completed', createdAt, createdAt);
      boundaryOrderId = Number(orderInsert.lastInsertRowid);
      const paymentDetails = JSON.stringify([{
        amount: 10,
        method: 'cash',
        payment_event_id: 'date-boundary-payment',
        timestamp: boundaryTimestamp,
      }]);
      const billInsert = db.prepare('INSERT INTO bills (bill_number,order_id,subtotal,total,paid_amount,balance,payment_status,payment_details,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run('ACCT-BUSINESS-DATE-BOUNDARY', boundaryOrderId, 10, 10, 10, 0, 'paid', paymentDetails, createdAt, createdAt);
      boundaryBillId = Number(billInsert.lastInsertRowid);

      // 12:00 UTC is already 02:00 on the next calendar day in Pacific/Kiritimati.
      const boundaryReconciliation = getAccountingSourceEventReconciliation(db, {
        from: '2099-10-21', to: '2099-10-21', limit: 2000,
      });
      const boundaryEvent = boundaryReconciliation.events.find(
        (event: any) => event.source_id === String(boundaryBillId) + ':date-boundary-payment',
      );
      equal(boundaryEvent?.status, 'missing_journal',
        'UTC-boundary payment appears on its tenant accounting business date when its journal is missing');

      const boundaryClose = await request(app).post('/api/accounting/periods/close').set(manager).send({
        period_start: '2099-10-21',
        period_end: '2099-10-21',
        reason: 'Regression: block close for UTC-boundary receipt exception',
      });
      equal(boundaryClose.status, 409,
        'period close refuses unresolved monetary receipts dated by tenant business time');
      equal(boundaryClose.body.code, 'period_has_source_exceptions',
        'UTC-boundary receipt is not silently excluded from period-close reconciliation');
    } finally {
      if (boundaryBillId !== null) db.prepare('DELETE FROM bills WHERE id=?').run(boundaryBillId);
      if (boundaryOrderId !== null) db.prepare('DELETE FROM orders WHERE id=?').run(boundaryOrderId);
      for (const { key, row } of boundarySettings) {
        if (row) {
          db.prepare('UPDATE settings SET value=?,updated_at=? WHERE key=?').run(row.value, now(), key);
        } else {
          db.prepare('DELETE FROM settings WHERE key=?').run(key);
        }
      }
    }

    const journalToProtect = createDraftJournalEntry(db, {
      entryDate: '2020-01-01', description: 'Posted before period close', currencyCode: 'INR',
      lines: [
        { accountId: 'acct-bank', debitMinor: 100, creditMinor: 0 },
        { accountId: 'acct-sales-revenue', debitMinor: 0, creditMinor: 100 },
      ],
    });
    postJournalEntry(db, journalToProtect.id, 'accounting-api-owner');
    const closedPeriod = await request(app).post('/api/accounting/periods/close').set(manager).send({
      period_start: '2020-01-01', period_end: '2020-01-01', reason: 'Automated period-close regression test',
    });
    equal(closedPeriod.status, 201, 'manager can close a clean accounting period');
    equal(closedPeriod.body.period.status, 'closed', 'period close persists closed status');
    equal((db.prepare("SELECT COUNT(*) AS count FROM accounting_audit_log WHERE entity_type='accounting_period' AND entity_id=? AND action='closed'").get(closedPeriod.body.period.id) as any).count, 1,
      'database trigger audits the initial close exactly once');

    let directCloseReasonMutationBlocked = false;
    try {
      db.prepare('UPDATE accounting_period_closures SET close_reason=? WHERE id=?')
        .run('tampered without a transition', closedPeriod.body.period.id);
    } catch (error: any) {
      directCloseReasonMutationBlocked = String(error?.message || '').includes('ACCOUNTING_PERIOD_CLOSE_INVALID_TRANSITION');
    }
    equal(directCloseReasonMutationBlocked, true, 'database trigger blocks direct edits to a close reason');

    let directPeriodRangeMutationBlocked = false;
    try {
      db.prepare('UPDATE accounting_period_closures SET period_end=? WHERE id=?')
        .run('2020-01-02', closedPeriod.body.period.id);
    } catch (error: any) {
      directPeriodRangeMutationBlocked = String(error?.message || '').includes('ACCOUNTING_PERIOD_CLOSE_INVALID_TRANSITION');
    }
    equal(directPeriodRangeMutationBlocked, true, 'database trigger makes closed period identity and date range immutable');

    let directReopenedInsertBlocked = false;
    try {
      db.prepare("INSERT INTO accounting_period_closures (id, period_start, period_end, status, close_reason, closed_by, reopen_reason, reopened_by, reopened_at) VALUES (?, '2018-01-01', '2018-01-01', 'reopened', 'bypassed close', 'accounting-api-owner', 'fake reopen', 'sql-test', CURRENT_TIMESTAMP)")
        .run('closed-period-direct-reopen');
    } catch (error: any) {
      directReopenedInsertBlocked = String(error?.message || '').includes('ACCOUNTING_PERIOD_CLOSE_INVALID_TRANSITION');
    }
    equal(directReopenedInsertBlocked, true, 'database trigger rejects inserting an already-reopened period without a close transition');

    let directOverlapInsertBlocked = false;
    try {
      db.prepare("INSERT INTO accounting_period_closures (id, period_start, period_end, status, close_reason, closed_by) VALUES (?, '2019-12-31', '2020-01-02', 'closed', 'SQL overlap attempt', 'accounting-api-owner')")
        .run('closed-period-direct-overlap');
    } catch (error: any) {
      directOverlapInsertBlocked = String(error?.message || '').includes('ACCOUNTING_PERIOD_CLOSE_OVERLAP');
    }
    equal(directOverlapInsertBlocked, true, 'database trigger blocks overlapping close rows even for direct SQL writes');
    equal((await request(app).post('/api/accounting/periods/close').set(manager).send({
      period_start: '2020-01-01', period_end: '2020-01-01', reason: 'Changed reason',
    })).status, 409, 'a changed close retry cannot silently reuse the existing close record');
    const sameCloseRetry = await request(app).post('/api/accounting/periods/close').set(manager).send({
      period_start: '2020-01-01', period_end: '2020-01-01', reason: 'Automated period-close regression test',
    });
    equal(sameCloseRetry.status, 201, 'identical period-close retries are accepted idempotently');
    equal(sameCloseRetry.body.period.duplicate, true, 'identical period-close retry is identified as duplicate');
    equal((await request(app).post('/api/accounting/periods/close').set(manager).send({
      period_start: '2019-12-31', period_end: '2020-01-02', reason: 'Overlapping period',
    })).status, 409, 'overlapping closed periods are rejected');
    let directUpdateBlocked = false;
    db.prepare("INSERT INTO accounting_journal_entries (id, entry_number, entry_date, description, currency_code, status, payload_hash) VALUES (?, ?, ?, ?, ?, 'draft', ?)")
      .run('closed-period-direct-update', 'JE-CLOSED-DIRECT', '2020-01-01', 'Bypass attempt', 'INR', 'a'.repeat(64));
    db.prepare("INSERT INTO accounting_journal_lines (id, journal_entry_id, line_no, account_id, description, debit_minor, credit_minor) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run('closed-period-line-debit', 'closed-period-direct-update', 1, 'acct-bank', 'bypass', 100, 0);
    db.prepare("INSERT INTO accounting_journal_lines (id, journal_entry_id, line_no, account_id, description, debit_minor, credit_minor) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run('closed-period-line-credit', 'closed-period-direct-update', 2, 'acct-sales-revenue', 'bypass', 0, 100);
    try {
      db.prepare("UPDATE accounting_journal_entries SET status='posted', posted_at=CURRENT_TIMESTAMP WHERE id=?").run('closed-period-direct-update');
    } catch (error: any) { directUpdateBlocked = String(error?.message || '').includes('ACCOUNTING_PERIOD_CLOSED'); }
    equal(directUpdateBlocked, true, 'database trigger blocks direct draft-to-posted updates in a closed period');
    let postedHeaderMutationBlocked = false;
    try {
      db.prepare('UPDATE accounting_journal_entries SET description=? WHERE id=?').run('tampered after close', journalToProtect.id);
    } catch (error: any) { postedHeaderMutationBlocked = String(error?.message || '').includes('ACCOUNTING_PERIOD_CLOSED_IMMUTABLE'); }
    equal(postedHeaderMutationBlocked, true, 'database trigger blocks direct edits to a posted journal in a closed period');
    let postedLineMutationBlocked = false;
    try {
      db.prepare('UPDATE accounting_journal_lines SET description=? WHERE journal_entry_id=?').run('tampered line', journalToProtect.id);
    } catch (error: any) { postedLineMutationBlocked = String(error?.message || '').includes('ACCOUNTING_PERIOD_CLOSED_IMMUTABLE'); }
    equal(postedLineMutationBlocked, true, 'database trigger blocks direct edits to posted journal lines in a closed period');
    let postedLineDeleteBlocked = false;
    try {
      db.prepare('DELETE FROM accounting_journal_lines WHERE journal_entry_id=? AND line_no=1').run(journalToProtect.id);
    } catch (error: any) { postedLineDeleteBlocked = String(error?.message || '').includes('ACCOUNTING_PERIOD_CLOSED_IMMUTABLE'); }
    equal(postedLineDeleteBlocked, true, 'database trigger blocks direct deletion of posted journal lines in a closed period');
    const closedPeriodList = await request(app).get('/api/accounting/periods').set(manager);
    equal(closedPeriodList.status, 200, 'manager can list period close history');
    ok(closedPeriodList.body.periods.some((period: any) => period.id === closedPeriod.body.period.id), 'period list includes the newly closed period');
    let closedPeriodRejected = false;
    try {
      createDraftJournalEntry(db, {
        entryDate: '2020-01-01', description: 'Should be blocked by closed period', currencyCode: 'INR',
        lines: [
          { accountId: 'acct-bank', debitMinor: 100, creditMinor: 0 },
          { accountId: 'acct-sales-revenue', debitMinor: 0, creditMinor: 100 },
        ],
      });
    } catch (error: any) { closedPeriodRejected = error?.code === 'period_closed'; }
    equal(closedPeriodRejected, true, 'central ledger rejects new journals dated inside a closed period');
    const reopenedPeriod = await request(app).post('/api/accounting/periods/' + closedPeriod.body.period.id + '/reopen')
      .set(manager).send({ reason: 'Correction required after review' });
    equal(reopenedPeriod.status, 200, 'manager can reopen a period with a reason');
    equal(reopenedPeriod.body.period.status, 'reopened', 'period reopen is persisted');
    ok(reopenedPeriod.body.period.reopen_reason === 'Correction required after review', 'period reopen reason is persisted');
    const reopenedDraft = createDraftJournalEntry(db, {
      entryDate: '2020-01-01', description: 'Allowed after audited reopen', currencyCode: 'INR',
      lines: [
        { accountId: 'acct-bank', debitMinor: 100, creditMinor: 0 },
        { accountId: 'acct-sales-revenue', debitMinor: 0, creditMinor: 100 },
      ],
    });
    equal(reopenedDraft.status, 'draft', 'ledger permits a draft after period is explicitly reopened');
    equal((db.prepare("SELECT COUNT(*) AS count FROM accounting_audit_log WHERE entity_type='accounting_period' AND entity_id=?").get(closedPeriod.body.period.id) as any).count, 2,
      'period close and reopen each leave an audit record');

    // A malformed directly-seeded posted journal must prevent the period from being closed.
    // Normal app posting validates balance; this regression proves the period-close boundary
    // also refuses invalid posted data rather than freezing it into a closed period.
    const unbalancedJournalId = 'period-close-unbalanced-posted-entry';
    db.prepare("INSERT INTO accounting_journal_entries (id, entry_number, entry_date, description, currency_code, status, payload_hash) VALUES (?, ?, '2020-01-02', 'Unbalanced close gate regression', 'INR', 'draft', ?)")
      .run(unbalancedJournalId, 'JE-CLOSE-UNBALANCED', 'c'.repeat(64));
    db.prepare("INSERT INTO accounting_journal_lines (id, journal_entry_id, line_no, account_id, description, debit_minor, credit_minor) VALUES (?, ?, 1, 'acct-bank', 'unbalanced debit', 100, 0)")
      .run('period-close-unbalanced-debit', unbalancedJournalId);
    db.prepare("INSERT INTO accounting_journal_lines (id, journal_entry_id, line_no, account_id, description, debit_minor, credit_minor) VALUES (?, ?, 2, 'acct-sales-revenue', 'unbalanced credit', 0, 99)")
      .run('period-close-unbalanced-credit', unbalancedJournalId);
    // Simulate a damaged legacy/directly-tampered database: the normal journal-post guard
    // correctly blocks this state, so bypass it only inside this disposable regression fixture.
    // Period close must still detect the malformed posted ledger independently.
    db.exec('DROP TRIGGER accounting_journal_entry_post_guard');
    db.prepare("UPDATE accounting_journal_entries SET status='posted', posted_at=CURRENT_TIMESTAMP WHERE id=?").run(unbalancedJournalId);
    const unbalancedClose = await request(app).post('/api/accounting/periods/close').set(manager).send({
      period_start: '2020-01-02', period_end: '2020-01-02', reason: 'Reject unbalanced posted journal',
    });
    equal(unbalancedClose.status, 409, 'period close refuses an unbalanced posted journal');
    equal(unbalancedClose.body.code, 'period_has_unbalanced_journals', 'period close reports the journal-integrity failure distinctly');
    equal((db.prepare("SELECT COUNT(*) AS count FROM accounting_period_closures WHERE period_start='2020-01-02' AND period_end='2020-01-02' AND status='closed'").get() as any).count, 0,
      'a period containing an unbalanced posted journal remains open');

    // Phase 7 Stage 1: due registration is separate from actual settlement.
    const todayAccountingDate = accountingDate(db, new Date().toISOString());
    const dayBeforeTodayAccountingDate = (() => {
      const date = new Date(todayAccountingDate + 'T00:00:00.000Z');
      date.setUTCDate(date.getUTCDate() - 1);
      return date.toISOString().slice(0, 10);
    })();
    const futureIncomingPayload = {
      record_type: 'receipt', direction: 'incoming', due_date: todayAccountingDate,
      amount_minor: 5000, currency_code: 'INR', description: 'Future service receipt',
      counterparty: 'Future customer', reference_number: 'RCPT-FUTURE-001',
      classification_account_id: 'acct-other-income', auto_register: true,
    };
    const futureIncomingResponse = await request(app).post('/api/accounting/future-items')
      .set(manager).set('Idempotency-Key', 'future-incoming-001').send(futureIncomingPayload);
    equal(futureIncomingResponse.status, 201, 'manager can create a future receipt');
    const futureIncomingId = futureIncomingResponse.body.item?.id;
    ok(!!futureIncomingId, 'future receipt receives a stable identity');
    equal(futureIncomingResponse.body.item?.status, 'scheduled', 'creating a future receipt does not post its future event');
    equal((db.prepare("SELECT COUNT(*) AS count FROM accounting_journal_entries WHERE source_type='accounting_future_item' AND source_id=?").get(futureIncomingId) as any).count, 0,
      'future receipt creation does not create a ledger journal');
    const journalsBeforeForecast = (db.prepare('SELECT COUNT(*) AS count FROM accounting_journal_entries').get() as any).count;
    const scheduledForecast = await request(app).get('/api/accounting/forecast?from=' + todayAccountingDate + '&to=' + todayAccountingDate).set(manager);
    equal(scheduledForecast.status, 200, 'manager can read the forecast for a valid date range');
    equal(scheduledForecast.body.summary.expected_inflows_minor, 5000, 'scheduled receipt appears as an expected cash inflow');
    equal(scheduledForecast.body.summary.projected_income_minor, 5000, 'unregistered future receipt is a projection rather than posted income');
    equal((db.prepare('SELECT COUNT(*) AS count FROM accounting_journal_entries').get() as any).count, journalsBeforeForecast,
      'reading the forecast never creates accounting journals');
    equal((await request(app).get('/api/accounting/forecast?from=2026-02-30').set(manager)).status, 400,
      'forecast rejects impossible calendar dates');
    equal((await request(app).get('/api/accounting/forecast?horizon_days=367').set(manager)).status, 400,
      'forecast rejects horizons longer than 366 days');
    const futureIncomingRetry = await request(app).post('/api/accounting/future-items')
      .set(manager).set('Idempotency-Key', 'future-incoming-001').send(futureIncomingPayload);
    equal(futureIncomingRetry.status, 201, 'identical future receipt retry is idempotent');
    equal(futureIncomingRetry.body.item?.id, futureIncomingId, 'identical future receipt retry returns the existing record');
    equal(futureIncomingRetry.body.item?.duplicate, true, 'future receipt retry is marked duplicate');
    equal((await request(app).post('/api/accounting/future-items').set(manager).set('Idempotency-Key', 'future-incoming-001')
      .send({ ...futureIncomingPayload, amount_minor: 5001 })).status, 409, 'a changed future-item payload cannot reuse its idempotency key');
    equal((await request(app).post('/api/accounting/future-items').set(manager).set('Idempotency-Key', 'future-invalid-date')
      .send({ ...futureIncomingPayload, due_date: '2099-02-30' })).status, 400, 'future items reject impossible dates');
    equal((await request(app).post('/api/accounting/future-items').set(manager).set('Idempotency-Key', 'future-invalid-account')
      .send({ ...futureIncomingPayload, classification_account_id: 'acct-operating-expenses' })).status, 400,
      'incoming future items cannot be mapped to an expense account');
    for (const prohibitedIncomeAccount of ['acct-sales-revenue', 'acct-sales-returns', 'acct-sales-discounts']) {
      equal((await request(app).post('/api/accounting/future-items').set(manager)
        .set('Idempotency-Key', 'future-prohibited-income-' + prohibitedIncomeAccount)
        .send({ ...futureIncomingPayload, classification_account_id: prohibitedIncomeAccount })).status, 400,
      'future receipts cannot bypass POS posting rules through ' + prohibitedIncomeAccount);
    }
    equal((await request(app).post('/api/accounting/future-items').set(manager).set('Idempotency-Key', 'future-invalid-receipt-direction')
      .send({ ...futureIncomingPayload, direction: 'outgoing', classification_account_id: 'acct-operating-expenses' })).status, 400,
      'a receipt record cannot represent an outgoing payment; outgoing instruments must use the cheque type');

    const futureNotDuePass = processDueFutureItems(db, dayBeforeTodayAccountingDate);
    equal(futureNotDuePass.checked, 0, 'due processor leaves future items untouched before their due date');
    const autoDuePass = processDueFutureItems(db, todayAccountingDate);
    equal(autoDuePass.registered, 1, 'automatic mode registers the item when its due date is reached');
    const futureIncomingRow = db.prepare('SELECT * FROM accounting_future_items WHERE id=?').get(futureIncomingId) as any;
    equal(futureIncomingRow.status, 'registered', 'automatic due processing moves the item to registered');
    const registeredForecast = await request(app).get('/api/accounting/forecast?from=' + todayAccountingDate + '&to=' + todayAccountingDate).set(manager);
    equal(registeredForecast.status, 200, 'forecast remains available after due registration');
    equal(registeredForecast.body.summary.projected_income_minor, 0, 'registered-but-unsettled receipt is not projected as new income');
    equal(registeredForecast.body.summary.recognized_unpaid_minor, 5000, 'registered-but-unsettled receipt is reported separately as an unpaid obligation');
    const dueJournal = db.prepare('SELECT id, status, entry_date FROM accounting_journal_entries WHERE id=?').get(futureIncomingRow.due_journal_entry_id) as any;
    equal(dueJournal.status, 'posted', 'automatic due registration posts through the normal ledger');
    equal(dueJournal.entry_date, todayAccountingDate, 'due journal uses the stored canonical ISO due date');
    const dueLines = db.prepare('SELECT account_id, debit_minor, credit_minor FROM accounting_journal_lines WHERE journal_entry_id=? ORDER BY line_no').all(dueJournal.id) as any[];
    equal(dueLines.reduce((n, line) => n + line.debit_minor, 0), 5000, 'due registration debits the exact amount');
    equal(dueLines.reduce((n, line) => n + line.credit_minor, 0), 5000, 'due registration credits the exact amount');
    ok(dueLines.some((line) => line.account_id === 'acct-receivables' && line.debit_minor === 5000),
      'incoming due registration debits receivables rather than pretending cash arrived');
    ok(dueLines.some((line) => line.account_id === 'acct-future-receipt-clearing' && line.credit_minor === 5000),
      'incoming due registration offsets receivables to the future-receipt liability clearing account');
    ok(!dueLines.some((line) => line.account_id === 'acct-other-income' || line.account_id === 'acct-sales-revenue'),
      'incoming due registration does not recognize income before actual settlement');
    ok(!dueLines.some((line) => line.account_id === 'acct-bank' || line.account_id === 'acct-cash-drawer'),
      'due registration does not change a cash or bank account before actual settlement');
    const futureIncomeBeforeSettlement = await request(app).get('/api/accounting/reports?from=' + todayAccountingDate + '&to=' + todayAccountingDate).set(manager);
    equal(futureIncomeBeforeSettlement.status, 200, "manager can inspect the report on the future item's due date");
    equal(futureIncomeBeforeSettlement.body.summary.other_income_minor, 0,
      'future receipt due registration is excluded from reported income until actual settlement');
    const managerFutureList = await request(app).get('/api/accounting/future-items?from=' + todayAccountingDate + '&to=' + todayAccountingDate).set(manager);
    equal(managerFutureList.status, 200, 'manager can filter future items by their due-date range');
    equal(managerFutureList.body.items?.find((item: any) => item.id === futureIncomingId)?.status, 'registered',
      'future-item history reflects the automatic posting state');

    const futureDatedSettlement = await request(app).post('/api/accounting/future-items/' + futureIncomingId + '/settle')
      .set(manager).set('Idempotency-Key', 'future-incoming-settlement-future-date')
      .send({ settlement_date: '2099-10-22', settlement_account_id: 'acct-bank' });
    equal(futureDatedSettlement.status, 400, 'actual settlement rejects a future calendar date');
    equal(db.prepare('SELECT status FROM accounting_future_items WHERE id=?').get(futureIncomingId)?.status, 'registered',
      'rejecting a future-dated settlement leaves the due item registered and cash unchanged');
    const settlementPayload = { settlement_date: todayAccountingDate, settlement_account_id: 'acct-bank' };
    const settledIncoming = await request(app).post('/api/accounting/future-items/' + futureIncomingId + '/settle')
      .set(manager).set('Idempotency-Key', 'future-incoming-settlement-001').send(settlementPayload);
    equal(settledIncoming.status, 200, 'manager can confirm actual settlement separately from due registration');
    equal(settledIncoming.body.item?.status, 'settled', 'confirmed incoming settlement moves item to settled');
    const settlementJournal = db.prepare('SELECT id, status, entry_date FROM accounting_journal_entries WHERE id=?')
      .get(settledIncoming.body.item?.settlement_journal_entry_id) as any;
    equal(settlementJournal.status, 'posted', 'actual settlement posts a separate journal');
    equal(settlementJournal.entry_date, todayAccountingDate, 'settlement journal uses the actual settlement date');
    const settlementLines = db.prepare('SELECT account_id, debit_minor, credit_minor FROM accounting_journal_lines WHERE journal_entry_id=?').all(settlementJournal.id) as any[];
    ok(settlementLines.some((line) => line.account_id === 'acct-bank' && line.debit_minor === 5000),
      'actual incoming settlement debits the chosen bank account');
    ok(settlementLines.some((line) => line.account_id === 'acct-receivables' && line.credit_minor === 5000),
      'actual incoming settlement clears receivables');
    ok(settlementLines.some((line) => line.account_id === 'acct-future-receipt-clearing' && line.debit_minor === 5000),
      'actual incoming settlement releases the deferred-receipt clearing liability');
    const settlementRangeForecast = await request(app).get('/api/accounting/forecast?from=' + dayBeforeTodayAccountingDate + '&to=' + todayAccountingDate).set(manager);
    equal(settlementRangeForecast.status, 200, 'forecast can include actual ledger movements after its opening date');
    ok(settlementRangeForecast.body.events.some((event: any) => event.source === 'ledger' && event.id === settlementJournal.id && event.actual_cash_in_minor === 5000),
      'settled receipt appears as actual cash movement when it occurs after the forecast opening date');
    equal(settlementRangeForecast.body.events.some((event: any) => event.source === 'future_item' && event.id === futureIncomingId), false,
      'settled receipt is not also counted as an unsettled future projection');
    ok(settlementLines.some((line) => line.account_id === 'acct-other-income' && line.credit_minor === 5000),
      'actual incoming settlement recognizes income in its configured revenue account');
    const futureIncomeAfterSettlement = await request(app).get('/api/accounting/reports?from=' + todayAccountingDate + '&to=' + todayAccountingDate).set(manager);
    equal(futureIncomeAfterSettlement.status, 200, 'manager can inspect the report on the actual settlement date');
    equal(futureIncomeAfterSettlement.body.summary.other_income_minor, 5000,
      'future receipt is counted as other income on the date actual settlement is confirmed');
    const settlementRetry = await request(app).post('/api/accounting/future-items/' + futureIncomingId + '/settle')
      .set(manager).set('Idempotency-Key', 'future-incoming-settlement-001').send(settlementPayload);
    equal(settlementRetry.status, 200, 'identical actual-settlement retry is accepted');
    equal(settlementRetry.body.item?.duplicate, true, 'identical actual-settlement retry is marked duplicate');
    equal((await request(app).post('/api/accounting/future-items/' + futureIncomingId + '/settle')
      .set(manager).set('Idempotency-Key', 'future-incoming-settlement-001')
       .send({ ...settlementPayload, settlement_account_id: 'acct-cash-drawer' })).status, 409,
      'changed settlement payload cannot reuse its idempotency key');

    const manualOutgoingPayload = {
      record_type: 'cheque', direction: 'outgoing', due_date: todayAccountingDate,
      amount_minor: 2500, currency_code: 'INR', description: 'Issued service cheque',
      counterparty: 'Service supplier', reference_number: 'CHQ-OUT-001',
      classification_account_id: 'acct-operating-expenses', auto_register: false,
    };
    const outgoingDueReportBefore = await request(app)
      .get('/api/accounting/reports?from=' + todayAccountingDate + '&to=' + todayAccountingDate).set(manager);
    equal(outgoingDueReportBefore.status, 200, 'baseline expense report is available before outgoing due registration');
    const manualOutgoing = await request(app).post('/api/accounting/future-items')
      .set(manager).set('Idempotency-Key', 'future-outgoing-manual-001').send(manualOutgoingPayload);
    equal(manualOutgoing.status, 201, 'manager can create an outgoing cheque in manual-confirmation mode');
    const manualOutgoingId = manualOutgoing.body.item?.id;
    const manualDuePass = processDueFutureItems(db, todayAccountingDate);
    equal(manualDuePass.awaitingConfirmation, 1, 'manual mode moves a due item to awaiting confirmation without posting');
    equal(db.prepare('SELECT status FROM accounting_future_items WHERE id=?').get(manualOutgoingId)?.status, 'awaiting_confirmation',
      'manual due item persists awaiting-confirmation status');
    equal((db.prepare("SELECT COUNT(*) AS count FROM accounting_journal_entries WHERE source_type='accounting_future_item' AND source_id=? AND source_event='due_registration'").get(manualOutgoingId) as any).count, 0,
      'manual due item has no due journal before explicit confirmation');
    const manuallyRegistered = await request(app).post('/api/accounting/future-items/' + manualOutgoingId + '/register').set(manager).send({});
    equal(manuallyRegistered.status, 200, 'manager can explicitly register a due manual item');
    equal(manuallyRegistered.body.item?.status, 'registered', 'manual confirmation moves the item to registered');
    const manualDueLines = db.prepare('SELECT account_id, debit_minor, credit_minor FROM accounting_journal_lines WHERE journal_entry_id=?')
      .all(manuallyRegistered.body.item?.due_journal_entry_id) as any[];
    ok(manualDueLines.some((line) => line.account_id === 'acct-future-payment-clearing' && line.debit_minor === 2500),
      'outgoing due registration offsets the payable to the pending-payment clearing asset');
    ok(!manualDueLines.some((line) => line.account_id === 'acct-operating-expenses' || line.account_id === 'acct-expenses'),
      'outgoing due registration does not recognize an expense before actual payment');
    ok(manualDueLines.some((line) => line.account_id === 'acct-payables' && line.credit_minor === 2500),
      'outgoing due registration credits payables without claiming the payment was made');
    const outgoingDueReportAfter = await request(app)
      .get('/api/accounting/reports?from=' + todayAccountingDate + '&to=' + todayAccountingDate).set(manager);
    equal(outgoingDueReportAfter.status, 200, 'expense report remains available after outgoing due registration');
    equal(outgoingDueReportAfter.body.summary.posted_expenses_minor, outgoingDueReportBefore.body.summary.posted_expenses_minor,
      'an unpaid due cheque does not change reported paid expenses');
    const manualSettlementDate = todayAccountingDate;
    const outgoingSettlementReportBefore = await request(app)
      .get('/api/accounting/reports?from=' + manualSettlementDate + '&to=' + manualSettlementDate).set(manager);
    equal(outgoingSettlementReportBefore.status, 200, 'baseline report is available for the actual payment date');
    const manualSettled = await request(app).post('/api/accounting/future-items/' + manualOutgoingId + '/settle')
      .set(manager).set('Idempotency-Key', 'future-outgoing-settlement-001')
      .send({ settlement_date: manualSettlementDate, settlement_account_id: 'acct-bank' });
    equal(manualSettled.status, 200, 'manager can settle an outgoing cheque after the due event was registered');
    equal(manualSettled.body.item?.status, 'settled', 'outgoing cheque reaches settled status after actual payment confirmation');
    const manualSettlementLines = db.prepare('SELECT account_id, debit_minor, credit_minor FROM accounting_journal_lines WHERE journal_entry_id=?')
      .all(manualSettled.body.item?.settlement_journal_entry_id) as any[];
    ok(manualSettlementLines.some((line) => line.account_id === 'acct-payables' && line.debit_minor === 2500),
      'actual outgoing settlement clears payables');
    ok(manualSettlementLines.some((line) => line.account_id === 'acct-bank' && line.credit_minor === 2500),
      'actual outgoing settlement credits the chosen bank account');
    ok(manualSettlementLines.some((line) => line.account_id === 'acct-operating-expenses' && line.debit_minor === 2500),
      'actual outgoing settlement recognizes the configured expense only when paid');
    ok(manualSettlementLines.some((line) => line.account_id === 'acct-future-payment-clearing' && line.credit_minor === 2500),
      'actual outgoing settlement clears the pending-payment asset');
    const outgoingSettlementReportAfter = await request(app)
      .get('/api/accounting/reports?from=' + manualSettlementDate + '&to=' + manualSettlementDate).set(manager);
    equal(outgoingSettlementReportAfter.status, 200, 'expense report is available after actual outgoing settlement');
    equal(outgoingSettlementReportAfter.body.summary.posted_expenses_minor,
      outgoingSettlementReportBefore.body.summary.posted_expenses_minor + 2500,
      'actual outgoing settlement recognizes the expense exactly once on the actual payment date');

    const cancelDueDate = (() => {
      const date = new Date(todayAccountingDate + 'T00:00:00.000Z'); date.setUTCDate(date.getUTCDate() + 30); return date.toISOString().slice(0, 10);
    })();
    const cancellable = await request(app).post('/api/accounting/future-items').set(manager).set('Idempotency-Key', 'future-cancel-001')
      .send({ ...futureIncomingPayload, due_date: cancelDueDate, auto_register: false, reference_number: 'RCPT-CANCEL-001' });
    equal(cancellable.status, 201, 'manager can create a future item that has not been registered');
    const cancelled = await request(app).post('/api/accounting/future-items/' + cancellable.body.item?.id + '/cancel')
      .set(manager).send({ reason: 'Source document voided' });
    equal(cancelled.status, 200, 'manager can cancel a scheduled unposted item with a reason');
    equal(cancelled.body.item?.status, 'cancelled', 'cancelled future item is terminal');
    equal(cancelled.body.item?.cancellation_reason, 'Source document voided', 'cancellation reason is persisted');
    let immutablePayloadBlocked = false;
    try {
      db.prepare('UPDATE accounting_future_items SET amount_minor=1 WHERE id=?').run(futureIncomingId);
    } catch (error: any) { immutablePayloadBlocked = String(error?.message || '').includes('ACCOUNTING_FUTURE_ITEM_PAYLOAD_IMMUTABLE'); }
    equal(immutablePayloadBlocked, true, 'database trigger prevents changing the immutable registered source payload');
    let futureItemDeleteBlocked = false;
    try { db.prepare('DELETE FROM accounting_future_items WHERE id=?').run(futureIncomingId); }
    catch (error: any) { futureItemDeleteBlocked = String(error?.message || '').includes('ACCOUNTING_FUTURE_ITEM_IMMUTABLE'); }
    equal(futureItemDeleteBlocked, true, 'database trigger prevents deleting future-item audit records');

    const futureTestClosedPeriod = await request(app).post('/api/accounting/periods/close').set(manager).send({
      period_start: '2019-01-01', period_end: '2019-01-01', reason: 'Regression: future-item posting into a closed period',
    });
    equal(futureTestClosedPeriod.status, 201, 'fixture creates a clean closed period for future-item retry safety');
    const closedDueItem = await request(app).post('/api/accounting/future-items').set(manager).set('Idempotency-Key', 'future-closed-period-001')
      .send({ ...futureIncomingPayload, due_date: '2019-01-01', reference_number: 'RCPT-CLOSED-001' });
    equal(closedDueItem.status, 201, 'a future item can be captured even if its historical due date is later found to fall in a closed period');
    const closedDuePass = processDueFutureItems(db, '2019-01-01');
    ok(closedDuePass.failed >= 1, 'automatic due registration reports failure for a closed-period posting');
    equal(db.prepare('SELECT status FROM accounting_future_items WHERE id=?').get(closedDueItem.body.item?.id)?.status, 'failed',
      'closed-period future item stays visible as failed and retryable');
    equal((db.prepare("SELECT COUNT(*) AS count FROM accounting_journal_entries WHERE source_type='accounting_future_item' AND source_id=?").get(closedDueItem.body.item?.id) as any).count, 0,
      'closed-period failure creates no partial journal');

    // Custom chart-of-accounts management: create, rename, classify cash/bank as liquid, and preserve ledger identity.
    equal((await request(app).get('/api/accounting/accounts/managed')).status, 401, 'managed account list denies unauthenticated access');
    equal((await request(app).get('/api/accounting/accounts/managed').set(cashier)).status, 403, 'cashier cannot manage chart-of-accounts records');
    equal((await request(app).post('/api/accounting/accounts').set(cashier).send({ name: 'Blocked account', account_kind: 'bank' })).status, 403,
      'cashier cannot create accounting accounts');
    const createdBank = await request(app).post('/api/accounting/accounts').set(manager)
      .send({ name: 'Test bank account', account_kind: 'bank', description: 'Created by route test', is_active: true });
    equal(createdBank.status, 201, 'manager can create a custom bank account');
    const customBank = createdBank.body.account;
    ok(typeof customBank.id === 'string' && customBank.id.length > 10, 'custom account has a stable generated id');
    equal(customBank.account_type, 'asset', 'custom bank is represented as an asset account');
    equal(customBank.is_liquid, true, 'custom bank is explicitly marked as a liquid account');
    ok(String(customBank.system_key).startsWith('custom_liquid:bank:'), 'custom bank has a dedicated non-colliding liquid classification');
    equal(customBank.balance_minor, 0, 'new account starts with a zero ledger balance, not a fabricated opening balance');
    const renamedBank = await request(app).put('/api/accounting/accounts/' + customBank.id).set(manager)
      .send({ name: 'Renamed test bank', description: 'Renamed without changing chart identity', account_type: 'expense', account_code: '5999', is_active: true });
    equal(renamedBank.status, 200, 'manager can rename a chart-of-accounts entry');
    equal(renamedBank.body.account.name, 'Renamed test bank', 'account display name is updated');
    equal(renamedBank.body.account.account_code, customBank.account_code, 'rename cannot change the account code');
    equal(renamedBank.body.account.account_type, 'asset', 'rename cannot change the account type');
    equal(renamedBank.body.account.system_key, customBank.system_key, 'rename cannot change the protected account classification');
    const managedList = await request(app).get('/api/accounting/accounts/managed').set(manager);
    equal(managedList.status, 200, 'manager can read the managed chart of accounts');
    equal(managedList.body.accounts.find((a: any) => a.id === customBank.id)?.name, 'Renamed test bank', 'renamed account appears in the account list');
    equal((db.prepare("SELECT COUNT(*) AS count FROM accounting_audit_log WHERE entity_type='accounting_account' AND entity_id=?").get(customBank.id) as any).count, 2,
      'account create and rename both append audit records');
    const customBankTransfer = await request(app).post('/api/accounting/transfers').set(manager).set('Idempotency-Key', 'custom-bank-transfer-ui-test')
      .send({ source_account_id: 'acct-cash-drawer', destination_account_id: customBank.id, amount_minor: 5000, entry_date: todayAccountingDate, description: 'Custom bank transfer test' });
    equal(customBankTransfer.status, 201, 'newly created bank account can receive a cash/bank transfer');
    equal(customBankTransfer.body.transfer?.amount_minor, 5000, 'custom bank transfer preserves the exact stored amount');
    const customBankLines = db.prepare('SELECT account_id, debit_minor, credit_minor FROM accounting_journal_lines WHERE journal_entry_id=?')
      .all(customBankTransfer.body.transfer?.id) as any[];
    equal(customBankLines.length, 2, 'custom bank transfer has exactly two ledger lines');
    equal(customBankLines.reduce((sum, line) => sum + line.debit_minor, 0), customBankLines.reduce((sum, line) => sum + line.credit_minor, 0),
      'custom bank transfer remains balanced');
    const disabledSystemAccount = await request(app).put('/api/accounting/accounts/acct-bank').set(manager)
      .send({ name: 'Bank accounts', description: '', is_active: false });
    equal(disabledSystemAccount.status, 409, 'system account cannot be deactivated through the management API');

    const deactivatedBank = await request(app).put('/api/accounting/accounts/' + customBank.id).set(manager)
      .send({ name: 'Renamed test bank', description: 'Retained after deactivation', is_active: false });
    equal(deactivatedBank.status, 200, 'a custom account without active dependencies can be deactivated');
    equal(deactivatedBank.body.account.is_active, 0, 'successful deactivation marks the custom account inactive');
    equal(deactivatedBank.body.account.balance_minor, 5000, 'deactivation preserves posted account balance and history');
    const afterDeactivationList = await request(app).get('/api/accounting/accounts/managed').set(manager);
    equal(afterDeactivationList.body.accounts.find((a: any) => a.id === customBank.id)?.is_active, 0,
      'inactive account remains visible in account management');

    const dependentExpense = await request(app).post('/api/accounting/accounts').set(manager)
      .send({ name: 'Expense with active category', account_kind: 'expense', description: 'Dependency regression', is_active: true });
    equal(dependentExpense.status, 201, 'dependency test creates a custom expense account');
    const dependentCategory = await request(app).post('/api/accounting/expense-categories').set(manager)
      .send({ name: 'Active dependency test category', expense_account_id: dependentExpense.body.account.id });
    equal(dependentCategory.status, 201, 'active expense category references the test account');
    const blockedDeactivation = await request(app).put('/api/accounting/accounts/' + dependentExpense.body.account.id).set(manager)
      .send({ name: 'Expense with active category', description: 'Dependency regression', is_active: false });
    equal(blockedDeactivation.status, 409, 'account with an active expense-category dependency cannot be deactivated');
    equal((db.prepare('SELECT is_active FROM accounting_accounts WHERE id=?').get(dependentExpense.body.account.id) as any).is_active, 1,
      'blocked deactivation leaves the dependent account active');

    // Management reports page posted journal entries, not individual lines, so every line
    // in a journal remains together while older entries stay accessible by page.
    const ledgerPageOne = await request(app).get('/api/accounting/reports?limit=1&page=1').set(manager);
    equal(ledgerPageOne.status, 200, 'management report accepts the first ledger page');
    equal(ledgerPageOne.body.movements.page, 1, 'ledger report returns the requested page number');
    equal(ledgerPageOne.body.movements.page_size, 1, 'ledger report reflects the requested page size');
    ok(ledgerPageOne.body.movements.entries_count > 1, 'ledger pagination reports all posted entries, not just the current page');
    equal(ledgerPageOne.body.movements.total_pages, ledgerPageOne.body.movements.entries_count,
      'a one-entry page size yields one page for each posted entry');
    const cashMovementReport = await request(app)
      .get('/api/accounting/reports?from=' + todayAccountingDate + '&to=' + todayAccountingDate + '&limit=1&page=1').set(manager);
    equal(cashMovementReport.status, 200, 'report provides simplified cash movements for a selected date range');
    ok(Array.isArray(cashMovementReport.body.recent_liquid_movements),
      'management report supplies the simplified liquid-account movement feed');
    ok(cashMovementReport.body.recent_liquid_movements.some((movement: any) =>
      movement.account_id === customBank.id && movement.change_minor === 5000),
    'simplified movement feed represents an increase to the selected bank account without debit/credit presentation');
    const ledgerPageTwo = await request(app).get('/api/accounting/reports?limit=1&page=2').set(manager);
    equal(ledgerPageTwo.status, 200, 'management report accepts later ledger pages');
    equal(ledgerPageTwo.body.movements.page, 2, 'later ledger page is reflected in the response');
    ok(ledgerPageOne.body.movements.lines[0]?.journal_entry_id !== ledgerPageTwo.body.movements.lines[0]?.journal_entry_id,
      'successive ledger pages expose different entries without skipping the page boundary');
    equal((await request(app).get('/api/accounting/reports?limit=1&page=0').set(manager)).status, 400,
      'ledger report rejects a non-positive page number');

    console.log('Accounting routes: ' + assertions + ' assertions passed.');
  } finally {
    try { closeDatabase(); } catch {}
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
    try { Module._load = originalLoad; } catch {}
  }
}

main().catch((error) => {
  console.error('Accounting routes test failed:', error);
  process.exitCode = 1;
});
