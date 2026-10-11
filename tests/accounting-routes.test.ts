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
      equal((await request(app).post('/api/accounting/expenses').set(headers).send({})).status, 403, role + ' cannot create accounting expenses');
    }
    equal((await request(app).get('/api/accounting/accounts').set(owner)).status, 200, 'owner can read posting accounts');
    equal((await request(app).get('/api/accounting/accounts').set(manager)).status, 200, 'manager can read posting accounts');

    const categoryResponse = await request(app).post('/api/accounting/expense-categories')
      .set(manager).send({ name: 'API Utilities', expense_account_id: 'acct-operating-expenses' });
    equal(categoryResponse.status, 201, 'manager can create expense category');
    const categoryId = categoryResponse.body.category?.id;
    ok(typeof categoryId === 'string' && categoryId.length > 0, 'category response contains an identifier');

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
