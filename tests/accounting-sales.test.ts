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
  // Scenario 1: Bill finalization stores an immutable snapshot but no journal.
  {
    const db = freshDb();
    const { orderId, billId } = makeBill(db, 'SALE');
    db.prepare('UPDATE bills SET discount_amount=10, discount_type=\'fixed\', discount_value=10 WHERE id=?').run(billId);
    const first = sales.finalizeBillSale(db, billId, 'test-owner-accounting');
    equal(first.duplicate, false, 'first finalization stores the snapshot');
    equal(first.journalEntryId, null, 'bill finalization creates no journal');
    const again = sales.finalizeBillSale(db, billId, 'test-owner-accounting');
    equal(again.duplicate, true, 'repeated finalization reuses the snapshot');
    equal(db.prepare('SELECT COUNT(*) AS n FROM accounting_journal_entries').get().n, 0, 'bill amount, tax and discount alone create no journal');
    throws(() => db.prepare('UPDATE bills SET total=101 WHERE id=?').run(billId), /ACCOUNTING_FINALIZED_BILL_AMOUNT_IMMUTABLE/i, 'finalized amount cannot be silently edited');
    sales.assertOrderCancellationAccountingSafe(db, orderId);
    equal(true, true, 'snapshot-only bill does not block cancellation');
    closeDatabase();
  }

  // Scenario 2: Split bill snapshots alone do not create journals.
  {
    const db = freshDb();
    const { orderId, billId: firstChildId } = makeBill(db, 'SPLIT-A', 60, 0);
    const groupId = 'split-accounting-group-001';
    db.prepare('UPDATE bills SET split_group_id=?, split_label=? WHERE id=?').run(groupId, 'A', firstChildId);
    const stamp = now();
    const second = db.prepare(
      'INSERT INTO bills (bill_number,order_id,subtotal,tax_amount,tax_breakdown,tax_snapshot,discount_amount,delivery_charge,packaging_charge,service_charge,table_charge,takeaway_charge,round_off,total,paid_amount,balance,payment_status,created_at,updated_at,split_group_id,split_label) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run('ACCT-BILL-SPLIT-B', orderId, 40, 0, '[]', '{}', 0, 0, 0, 0, 0, 0, 0, 40, 0, 40, 'unpaid', stamp, stamp, groupId, 'B');
    const secondChildId = Number(second.lastInsertRowid);
    sales.finalizeBillSale(db, firstChildId, 'test-owner-accounting');
    sales.finalizeBillSale(db, secondChildId, 'test-owner-accounting');
    equal(db.prepare('SELECT COUNT(*) AS n FROM accounting_journal_entries').get().n, 0, 'split bill finalization does not create journals');
    closeDatabase();
  }

  // Scenario 3: Actual cash receipt alone creates revenue; retries are idempotent.
  {
    const db = freshDb();
    const { orderId, billId } = makeBill(db, 'COLLECTION');
    const payment = { payment_event_id: 'payment-event-cash-001', method: 'cash', amount: 40, timestamp: '2026-10-14T08:00:00.000Z' };
    db.transaction(() => sales.postCollectionPaymentLines(db, billId, [payment], 'test-owner-accounting'))();
    equal(journalForSource(db, 'bill', String(billId), 'sale_recognized'), undefined, 'payment does not create a separate bill-level sale journal');
    const receipt = journalForSource(db, 'bill_payment', String(billId) + ':' + payment.payment_event_id, 'money_received');
    ok(receipt, 'receipt is sourced by bill ID plus stable payment event ID');
    balanced(db, receipt.id);
    const receiptLines = linesForJournal(db, receipt.id);
    equal(receiptLines.find((line: any) => line.system_key === 'cash_drawer')?.debit_minor, 40, 'receipt debits mapped cash by applied amount');
    equal(receiptLines.find((line: any) => line.system_key === 'sales_revenue')?.credit_minor, 40, 'receipt credits revenue only by money received');
    db.transaction(() => sales.postCollectionPaymentLines(db, billId, [payment], 'test-owner-accounting'))();
    equal(db.prepare("SELECT COUNT(*) AS n FROM accounting_journal_entries WHERE source_type='bill_payment' AND source_id=? AND source_event='money_received'").get(String(billId) + ':' + payment.payment_event_id).n, 1, 'retry creates no second receipt journal');
    throws(() => sales.assertOrderCancellationAccountingSafe(db, orderId), /accounting-recorded monetary receipt/i, 'cancellation is guarded after actual money has been journaled');
    closeDatabase();
  }

  // Scenario 4: Loyalty awards/redemptions never create accounting entries.
  {
    const db = freshDb();
    const { billId: walletBillId } = makeBill(db, 'WALLET', 100, 0);
    db.transaction(() => sales.postCollectionPaymentLines(db, walletBillId, [
      { payment_event_id: 'wallet-redemption-001', method: 'wallet', amount: 10, timestamp: '2026-10-14 08:01:00' },
    ], 'test-owner-accounting'))();
    equal(db.prepare('SELECT COUNT(*) AS n FROM accounting_journal_entries').get().n, 0, 'wallet redemption is ignored by accounting');
    const realPayment = { payment_event_id: 'mixed-card-001', method: 'card', amount: 75, timestamp: '2026-10-14 08:02:00' };
    db.transaction(() => sales.postCollectionPaymentLines(db, walletBillId, [realPayment], 'test-owner-accounting'))();
    const receipt = journalForSource(db, 'bill_payment', String(walletBillId) + ':mixed-card-001', 'money_received');
    ok(receipt, 'real card money alongside wallet redemption is posted');
    const receiptLines = linesForJournal(db, receipt.id);
    equal(receiptLines.find((line: any) => line.system_key === 'payment_clearing')?.debit_minor, 75, 'only actual card money is debited');
    equal(receiptLines.find((line: any) => line.system_key === 'sales_revenue')?.credit_minor, 75, 'only actual card money is revenue');
    equal(db.prepare("SELECT COUNT(*) AS n FROM accounting_journal_entries WHERE source_type='loyalty_reward'").get().n, 0, 'loyalty rewards never have journals');
    closeDatabase();
  }

  // Scenario 5: Monetary refunds reverse revenue; wallet refunds are ignored.
  {
    const db = freshDb();
    const { billId } = makeBill(db, 'REFUND');
    sales.finalizeBillSale(db, billId, 'test-owner-accounting');
    const stamp = now();
    const refund = db.prepare(
      'INSERT INTO refunds (bill_id,amount_cents,method,reason,approved_by,created_by,created_at) VALUES (?,?,?,?,?,?,?)',
    ).run(billId, 25, 'cash', 'test monetary refund', 'test-owner-accounting', 'test-owner-accounting', stamp);
    const first = sales.postCommittedRefund(db, Number(refund.lastInsertRowid), 'test-owner-accounting');
    equal(first.posted, true, 'committed monetary refund is posted');
    const refundJournal = journalForSource(db, 'refund', String(refund.lastInsertRowid), 'money_refunded');
    ok(refundJournal, 'refund source identity is the persisted refund row ID');
    balanced(db, refundJournal.id);
    const refundLines = linesForJournal(db, refundJournal.id);
    equal(refundLines.find((line: any) => line.system_key === 'sales_discounts')?.debit_minor, 25, 'full monetary refund debits contra-revenue');
    equal(refundLines.find((line: any) => line.system_key === 'cash_drawer')?.credit_minor, 25, 'refund credits actual payout account');
    const again = sales.postCommittedRefund(db, Number(refund.lastInsertRowid), 'test-owner-accounting');
    equal(again.posted, true, 'refund retry resolves through original source journal');
    equal(db.prepare("SELECT COUNT(*) AS n FROM accounting_journal_entries WHERE source_type='refund' AND source_id=? AND source_event='money_refunded'").get(String(refund.lastInsertRowid)).n, 1, 'refund retry never duplicates journal');
    const walletRefund = db.prepare(
      'INSERT INTO refunds (bill_id,amount_cents,method,reason,approved_by,created_by,created_at) VALUES (?,?,?,?,?,?,?)',
    ).run(billId, 10, 'wallet', 'non-monetary store credit', 'test-owner-accounting', 'test-owner-accounting', now());
    const ignored = sales.postCommittedRefund(db, Number(walletRefund.lastInsertRowid), 'test-owner-accounting');
    equal(ignored.posted, false, 'wallet refund is ignored');
    equal(db.prepare("SELECT COUNT(*) AS n FROM accounting_journal_entries WHERE source_type='refund'").get().n, 1, 'wallet refund creates no journal');
    closeDatabase();
  }

  // Scenario 6: pre-cutover bills keep POS behavior but are not silently backfilled.
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
    db.prepare("UPDATE bills SET payment_status='paid', paid_at=?, paid_amount=100, balance=0 WHERE id=?").run(now(), billId);
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
