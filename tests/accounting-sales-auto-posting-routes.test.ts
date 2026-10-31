import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-accounting-sales-auto-posting-routes-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-accounting-sales-auto-posting';
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
    const owner = seedUser(db, 'accounting-auto-post-owner', 'owner');
    const manager = seedUser(db, 'accounting-auto-post-manager', 'manager');
    const cashier = seedUser(db, 'accounting-auto-post-cashier', 'cashier');
    const app = createApp({ '/api/accounting': accountingRoutes });
    db.prepare("DELETE FROM settings WHERE key='accounting_auto_post_sales'").run();

    equal((await request(app).get('/api/accounting/sales-auto-posting')).status, 401,
      'unauthenticated users cannot read the automatic sales posting preference');
    equal((await request(app).get('/api/accounting/sales-auto-posting').set(cashier)).status, 403,
      'cashiers cannot read the automatic sales posting preference');
    equal((await request(app).put('/api/accounting/sales-auto-posting').set(cashier).send({ enabled: true })).status, 403,
      'cashiers cannot change the automatic sales posting preference');

    const defaultPreference = await request(app).get('/api/accounting/sales-auto-posting').set(owner);
    equal(defaultPreference.status, 200, 'owner can read the automatic sales posting preference');
    equal(defaultPreference.body.enabled, false, 'missing preference defaults to disabled');
    equal((await request(app).put('/api/accounting/sales-auto-posting').set(owner).send({ enabled: 'true' })).status, 400,
      'preference endpoint rejects non-boolean values');

    const enabled = await request(app).put('/api/accounting/sales-auto-posting').set(manager).send({ enabled: true });
    equal(enabled.status, 200, 'manager can enable automatic sales posting');
    equal(enabled.body.enabled, true, 'enabled preference is persisted');
    equal((await request(app).get('/api/accounting/sales-auto-posting').set(owner)).body.enabled, true,
      'owner reads the persisted enabled preference');

    const disabled = await request(app).put('/api/accounting/sales-auto-posting').set(owner).send({ enabled: false });
    equal(disabled.status, 200, 'owner can disable automatic sales posting');
    equal(disabled.body.enabled, false, 'disabled preference is persisted');
    process.stdout.write('PASS accounting sales auto-posting routes: ' + assertions + ' assertions\n');
  } finally {
    closeDatabase();
    Module._load = originalLoad;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
