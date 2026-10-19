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
    for (const [role, headers] of [['cashier', cashier], ['server', server], ['chef', chef]] as const) {
      equal((await request(app).get('/api/accounting/accounts').set(headers)).status, 403, role + ' cannot read accounting accounts');
      equal((await request(app).get('/api/accounting/transfers').set(headers)).status, 403, role + ' cannot read accounting transfers');
      equal((await request(app).post('/api/accounting/transfers').set(headers).send({})).status, 403, role + ' cannot create accounting transfers');
      equal((await request(app).post('/api/accounting/expenses').set(headers).send({})).status, 403, role + ' cannot create accounting expenses');
      equal((await request(app).post('/api/accounting/expenses/not-an-id/post').set(headers).send({})).status, 403, role + ' cannot post accounting expenses');
      equal((await request(app).post('/api/accounting/expenses/not-an-id/reverse').set(headers).send({ reason: 'x', reversal_date: '2026-10-11' })).status, 403, role + ' cannot reverse accounting expenses');
    }
    equal((await request(app).get('/api/accounting/activities').set(cashier)).status, 403, 'cashier cannot read manual accounting activities');
    equal((await request(app).post('/api/accounting/activities').set(cashier).send({})).status, 403, 'cashier cannot create manual accounting activities');
    equal((await request(app).get('/api/accounting/accounts').set(owner)).status, 200, 'owner can read posting accounts');
    equal((await request(app).get('/api/accounting/accounts').set(manager)).status, 200, 'manager can read posting accounts');
    const accountList = await request(app).get('/api/accounting/accounts').set(manager);
    equal(accountList.body.accounts.find((a: any) => a.id === 'acct-bank')?.is_liquid, true, 'bank is explicitly marked as a liquid asset');
    equal(accountList.body.accounts.find((a: any) => a.id === 'acct-inventory')?.is_liquid, false, 'inventory is explicitly marked as non-liquid');
    equal(accountList.body.accounts.find((a: any) => a.id === 'acct-custom-nonliquid')?.is_liquid, false, 'custom asset without a liquid classification is not selectable as a payment account');

    db.prepare(`
      INSERT INTO accounting_accounts
        (id, system_key, account_code, name, account_type, normal_balance, parent_account_id, is_system, is_active, is_postable)
      VALUES ('acct-custom-nonliquid', NULL, '1199', 'Custom non-liquid asset', 'asset', 'debit', 'acct-assets', 0, 1, 1)
    `).run();
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
