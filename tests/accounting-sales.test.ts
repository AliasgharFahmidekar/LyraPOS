import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
let activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-accounting-sales-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => activeTestDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const dbModule = require('../main/db');
const { initDatabase, getDatabase, closeDatabase, now } = dbModule;
const sales = require('../main/accounting/sales');

let assertions = 0;
function equal(actual: unknown, expected: unknown, message: string): void { assert.equal(actual, expected, message); assertions++; }
function ok(value: unknown, message: string): void { assert.ok(value, message); assertions++; }
function throws(fn: () => unknown, pattern: RegExp, message: string): void { assert.throws(fn, pattern, message); assertions++; }

function freshDb() {
  try { closeDatabase(); } catch {}
  activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-accounting-sales-case-'));
  initDatabase();
  const db = getDatabase();
  const timestamp = now();
  db.prepare("INSERT OR REPLACE INTO settings (key,value,updated_at) VALUES ('country','IR',?)").run(timestamp);
  db.prepare("INSERT OR REPLACE INTO settings (key,value,updated_at) VALUES ('currency','IRR',?)").run(timestamp);
  db.prepare("INSERT OR REPLACE INTO settings (key,value,updated_at) VALUES ('timezone','Asia/Tehran',?)").run(timestamp);
  // This test begins after cutover; legacy behavior is covered in a separate scenario.
  db.prepare("INSERT OR REPLACE INTO settings (key,value,updated_at) VALUES ('accounting_cutover_at','2000-01-01T00:00:00.000Z',?)").run(timestamp);
  db.prepare("INSERT OR IGNORE INTO users (id,name,password,role,is_active,created_at,updated_at) VALUES ('test-owner-accounting','Test Owner','test-password','owner',1,?,?)").run(timestamp, timestamp);
  return db;
}

function makeBill(db: any, suffix: string, total = 100, tax = 10, createdAt = now()) {
  const order = db.prepare(
    'INSERT INTO orders (order_number,type,status,subtotal,tax_amount,total,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
  ).run('ACCT-' + suffix, 'takeaway', 'pending', total - tax, tax, total, createdAt, createdAt);
  const bill = db.prepare(
    'INSERT INTO bills (bill_number,order_id,subtotal,tax_amount,tax_breakdown,tax_snapshot,discount_amount,delivery_charge,packaging_charge,service_charge,table_charge,takeaway_charge,round_off,total,paid_amount,balance,payment_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run('ACCT-BILL-' + suffix, Number(order.lastInsertRowid), total - tax, tax, '[]', '{}', 0, 0, 0, 0, 0, 0, 0, total, 0, total, 'unpaid', createdAt, createdAt);
  return { orderId: Number(order.lastInsertRowid), billId: Number(bill.lastInsertRowid), createdAt };
}

function journalForSource(db: any, sourceType: string, sourceId: string, sourceEvent: string) {
  return db.prepare(
    'SELECT * FROM accounting_journal_entries WHERE source_type=? AND source_id=? AND source_event=?',
  ).get(sourceType, sourceId, sourceEvent) as any;
}
function linesForJournal(db: any, journalId: string) {
  return db.prepare(
    'SELECT line.*, account.system_key, account.account_type FROM accounting_journal_lines line JOIN accounting_accounts account ON account.id=line.account_id WHERE line.journal_entry_id=? ORDER BY line.line_no',
  ).all(journalId) as any[];
}
function balanced(db: any, journalId: string): void {
  const row = db.prepare('SELECT SUM(debit_minor) AS debits,SUM(credit_minor) AS credits,COUNT(*) AS line_count FROM accounting_journal_lines WHERE journal_entry_id=?').get(journalId) as any;
  equal(row.line_count >= 2, true, 'posted journal has at least two lines');
  equal(row.debits, row.credits, 'posted journal debits equal credits');
  const status = db.prepare('SELECT status FROM accounting_journal_entries WHERE id=?').get(journalId) as any;
  equal(status.status, 'posted', 'journal is actually posted');
}

try {
  // Scenario 1: Sale recognition is separate from collection and is idempotent.
  {
    const db = freshDb();
    const { billId } = makeBill(db, 'SALE');
    const first = sales.finalizeBillSale(db, billId, 'test-owner-accounting');
    equal(first.duplicate, false, 'first finalization creates the sale journal');
    balanced(db, first.journalEntryId);
    const saleLines = linesForJournal(db, first.journalEntryId);
    equal(saleLines.find((line: any) => line.system_key === 'accounts_receivable')?.debit_minor, 100, 'sale debits receivables for the complete bill total');
    equal(saleLines.find((line: any) => line.system_key === 'sales_revenue')?.credit_minor, 90, 'sale credits revenue net of persisted tax');
    equal(saleLines.find((line: any) => line.system_key === 'sales_tax_payable')?.credit_minor, 10, 'sale credits the internally tracked tax liability');
    const again = sales.finalizeBillSale(db, billId, 'test-owner-accounting');
    equal(again.duplicate, true, 'repeated finalization returns the original sale journal');
    equal(db.prepare("SELECT COUNT(*) AS n FROM accounting_journal_entries WHERE source_type='bill' AND source_id=? AND source_event='sale_recognized'").get(String(billId)).n, 1, 'sale is never posted twice');
    throws(() => db.prepare('UPDATE bills SET total=101 WHERE id=?').run(billId), /ACCOUNTING_FINALIZED_BILL_AMOUNT_IMMUTABLE/i, 'finalized commercial amount cannot be silently edited');
    closeDatabase();
  }

  // Scenario 2: A partial collection creates only an A/R settlement; replay does not duplicate it.
  {
    const db = freshDb();
    const { billId } = makeBill(db, 'COLLECTION');
    const payment = { payment_event_id: 'payment-event-cash-001', method: 'cash', amount: 40, timestamp: '2026-10-14T08:00:00.000Z' };
    db.transaction(() => sales.postCollectionPaymentLines(db, billId, [payment], 'test-owner-accounting'))();
    const sale = journalForSource(db, 'bill', String(billId), 'sale_recognized');
    ok(sale, 'first collection transaction finalizes the bill and posts its sale');
    balanced(db, sale.id);
    const collection = journalForSource(db, 'bill_payment', String(billId) + ':' + payment.payment_event_id, 'collected');
    ok(collection, 'collection is sourced by bill ID plus stable payment event ID');
    balanced(db, collection.id);
    const collectionLines = linesForJournal(db, collection.id);
    equal(collectionLines.find((line: any) => line.system_key === 'cash_drawer')?.debit_minor, 40, 'collection debits mapped cash by applied amount');
    equal(collectionLines.find((line: any) => line.system_key === 'accounts_receivable')?.credit_minor, 40, 'collection credits receivables, not sales income');
    db.transaction(() => sales.postCollectionPaymentLines(db, billId, [payment], 'test-owner-accounting'))();
    equal(db.prepare("SELECT COUNT(*) AS n FROM accounting_journal_entries WHERE source_type='bill_payment' AND source_id=? AND source_event='collected'").get(String(billId) + ':' + payment.payment_event_id).n, 1, 'retry of the same payment event creates no second journal');
    equal(db.prepare("SELECT COUNT(*) AS n FROM accounting_journal_entries WHERE source_type='bill' AND source_id=? AND source_event='sale_recognized'").get(String(billId)).n, 1, 'collection retry also does not duplicate revenue');
    closeDatabase();
  }

  // Scenario 3: Cashback accrual funds the customer-credit liability before wallet redemption.
  {
    const db = freshDb();
    const { billId } = makeBill(db, 'CASHBACK', 100, 0);
    const sale = sales.finalizeBillSale(db, billId, 'test-owner-accounting');
    const first = sales.postCashbackReward(db, billId, 10, 'test-owner-accounting');
    equal(first.posted, true, 'awarded cashback creates an accounting journal');
    const cashback = journalForSource(db, 'loyalty_reward', String(billId), 'cashback_credited');
    ok(cashback, 'cashback journal has a stable bill-based source identity');
    balanced(db, cashback.id);
    const cashbackLines = linesForJournal(db, cashback.id);
    equal(cashbackLines.find((line: any) => line.system_key === 'sales_discounts')?.debit_minor, 10, 'cashback debit is contra-revenue');
    equal(cashbackLines.find((line: any) => line.system_key === 'customer_advances')?.credit_minor, 10, 'cashback accrues customer-credit liability');
    const again = sales.postCashbackReward(db, billId, 10, 'test-owner-accounting');
    equal(again.duplicate, true, 'cashback retry resolves to the original journal');
    db.transaction(() => sales.postCollectionPaymentLines(db, billId, [
      { payment_event_id: 'wallet-redemption-001', method: 'wallet', amount: 10, timestamp: '2026-10-14 08:01:00' },
    ], 'test-owner-accounting'))();
    const collection = journalForSource(db, 'bill_payment', String(billId) + ':wallet-redemption-001', 'collected');
    ok(collection, 'wallet redemption has its own collection source event');
    balanced(db, collection.id);
    const walletLines = linesForJournal(db, collection.id);
    equal(walletLines.find((line: any) => line.system_key === 'customer_advances')?.debit_minor, 10, 'wallet redemption consumes previously accrued liability');
    equal(walletLines.find((line: any) => line.system_key === 'cash_drawer')?.debit_minor, undefined, 'wallet redemption does not debit cash');
    equal(db.prepare("SELECT COUNT(*) AS n FROM accounting_journal_entries WHERE source_type='loyalty_reward' AND source_id=? AND source_event='cashback_credited'").get(String(billId)).n, 1, 'cashback reward is not journaled twice');
    balanced(db, sale.id);
    closeDatabase();
  }

  // Scenario 4: Refunds use the committed refund row and the actual payout method.
  {
    const db = freshDb();
    const { billId } = makeBill(db, 'REFUND');
    const sale = sales.finalizeBillSale(db, billId, 'test-owner-accounting');
    const stamp = now();
    const refund = db.prepare(
      'INSERT INTO refunds (bill_id,amount_cents,method,reason,approved_by,created_by,created_at) VALUES (?,?,?,?,?,?,?)',
    ).run(billId, 25, 'cash', 'test partial refund', 'test-owner-accounting', 'test-owner-accounting', stamp);
    const first = sales.postCommittedRefund(db, Number(refund.lastInsertRowid), 'test-owner-accounting');
    equal(first.posted, true, 'committed refund is posted');
    const refundJournal = journalForSource(db, 'refund', String(refund.lastInsertRowid), 'refund_committed');
    ok(refundJournal, 'refund source identity is the persisted refund row ID');
    balanced(db, refundJournal.id);
    const refundLines = linesForJournal(db, refundJournal.id);
    equal(refundLines.find((line: any) => line.system_key === 'sales_discounts')?.debit_minor, 22, 'partial refund debits net sales returns after proportional tax allocation');
    equal(refundLines.find((line: any) => line.system_key === 'sales_tax_payable')?.debit_minor, 3, 'partial refund reverses proportional internal tax liability');
    equal(refundLines.find((line: any) => line.system_key === 'cash_drawer')?.credit_minor, 25, 'refund credits the actual mapped payout account');
    const again = sales.postCommittedRefund(db, Number(refund.lastInsertRowid), 'test-owner-accounting');
    equal(again.posted, true, 'refund retry resolves through the original source journal');
    equal(db.prepare("SELECT COUNT(*) AS n FROM accounting_journal_entries WHERE source_type='refund' AND source_id=? AND source_event='refund_committed'").get(String(refund.lastInsertRowid)).n, 1, 'refund retry never duplicates refund journal');
    balanced(db, sale.id);
    closeDatabase();
  }

  // Scenario 4: pre-cutover bills keep POS behavior but are not silently backfilled.
  {
    const db = freshDb();
    const legacyStamp = '2024-01-01T10:00:00.000Z';
    const { billId } = makeBill(db, 'LEGACY', 100, 0, legacyStamp);
    db.prepare("UPDATE settings SET value='2025-01-01T00:00:00.000Z' WHERE key='accounting_cutover_at'").run();
    const payment = { payment_event_id: 'legacy-payment-001', method: 'cash', amount: 20, timestamp: '2024-01-01T10:05:00.000Z' };
    db.transaction(() => sales.postCollectionPaymentLines(db, billId, [payment], 'test-owner-accounting'))();
    equal(journalForSource(db, 'bill', String(billId), 'sale_recognized'), undefined, 'legacy bill is not backfilled as a sale');
    equal(journalForSource(db, 'bill_payment', String(billId) + ':' + payment.payment_event_id, 'collected'), undefined, 'legacy collection is not backfilled');
    ok(db.prepare("SELECT 1 FROM accounting_audit_log WHERE entity_type='accounting_source_event' AND entity_id=? AND action='skipped_pre_cutover_payment'").get('payment:' + payment.payment_event_id), 'legacy skip is documented in audit history');
    throws(() => sales.finalizeBillSale(db, billId, 'test-owner-accounting'), /predates accounting cutover/i, 'manual finalization cannot silently backfill a legacy bill');
    closeDatabase();
  }

  console.log('PASS: ' + assertions + ' accounting sales/collections/refunds assertions');
} catch (error: any) {
  try { closeDatabase(); } catch {}
  console.error(error);
  process.exitCode = 1;
} finally {
  Module._load = originalLoad;
}
