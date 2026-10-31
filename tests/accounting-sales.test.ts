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
function throwsCode(fn: () => unknown, code: string, message: string): void {
  assert.throws(fn, (error: unknown) => error instanceof sales.AccountingPostingError && error.code === code, message);
  assertions++;
}

function freshDb() {
  try { closeDatabase(); } catch {}
  activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-accounting-sales-case-'));
  initDatabase();
  const db = getDatabase();
  const timestamp = now();
  db.prepare("INSERT OR REPLACE INTO settings (key,value,updated_at) VALUES ('country','IR',?)").run(timestamp);
  db.prepare("INSERT OR REPLACE INTO settings (key,value,updated_at) VALUES ('currency','IRR',?)").run(timestamp);
  db.prepare("INSERT OR REPLACE INTO settings (key,value,updated_at) VALUES ('timezone','Asia/Tehran',?)").run(timestamp);
  db.prepare("INSERT OR REPLACE INTO settings (key,value,updated_at) VALUES ('accounting_auto_post_sales','true',?)").run(timestamp);
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
    db.prepare('UPDATE bills SET discount_amount=10 WHERE id=?').run(billId);
    const first = sales.finalizeBillSale(db, billId, 'test-owner-accounting');
    equal(first.duplicate, false, 'first finalization stores the snapshot');
    equal(first.journalEntryId, null, 'bill finalization creates no journal');
    const again = sales.finalizeBillSale(db, billId, 'test-owner-accounting');
    equal(again.duplicate, true, 'repeated finalization reuses the snapshot');
    equal(db.prepare('SELECT COUNT(*) AS n FROM accounting_journal_entries').get().n, 0, 'bill amount, tax and discount alone create no journal');
    throws(() => db.prepare('UPDATE bills SET total=101 WHERE id=?').run(billId), /ACCOUNTING_FINALIZED_BILL_AMOUNT_IMMUTABLE/i, 'finalized amount cannot be silently edited');
    sales.assertOrderCancellationAccountingSafe(db, orderId);
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
    db.prepare("UPDATE bills SET payment_status='partial', paid_amount=40, balance=60 WHERE id=?").run(billId);
    const payment = { payment_event_id: 'payment-event-cash-001', method: 'cash', amount: 40, timestamp: '2026-10-14T08:00:00.000Z' };
    db.transaction(() => sales.postCollectionPaymentLines(db, billId, [payment], 'test-owner-accounting'))();
    equal((db.prepare('SELECT accounting_finalized_at FROM bills WHERE id=?').get(billId) as any).accounting_finalized_at ?? null,
      null, 'a partial monetary receipt does not lock the commercial bill snapshot');
    equal(journalForSource(db, 'bill', String(billId), 'sale_recognized'), undefined, 'payment does not create a separate bill-level sale journal');
    const receipt = journalForSource(db, 'bill_payment', String(billId) + ':' + payment.payment_event_id, 'money_received');
    ok(receipt, 'receipt is sourced by bill ID plus stable payment event ID');
    balanced(db, receipt.id);
    const receiptLines = linesForJournal(db, receipt.id);
    equal(receiptLines.find((line: any) => line.system_key === 'cash_drawer')?.debit_minor, 40, 'receipt debits mapped cash by applied amount');
    equal(receiptLines.find((line: any) => line.system_key === 'sales_revenue')?.credit_minor, 40, 'receipt credits revenue only by money received');
    db.transaction(() => sales.postCollectionPaymentLines(db, billId, [payment], 'test-owner-accounting'))();
    equal(db.prepare("SELECT COUNT(*) AS n FROM accounting_journal_entries WHERE source_type='bill_payment' AND source_id=? AND source_event='money_received'").get(String(billId) + ':' + payment.payment_event_id).n, 1, 'retry creates no second receipt journal');

    db.prepare("UPDATE bills SET payment_status='paid', paid_amount=100, balance=0 WHERE id=?").run(billId);
    const finalPayment = { payment_event_id: 'payment-event-cash-002', method: 'cash', amount: 60, timestamp: '2026-10-14T08:01:00.000Z' };
    db.transaction(() => sales.postCollectionPaymentLines(db, billId, [finalPayment], 'test-owner-accounting'))();
    const finalSnapshot = db.prepare('SELECT accounting_finalized_at, accounting_snapshot_json FROM bills WHERE id=?').get(billId) as any;
    ok(finalSnapshot.accounting_finalized_at, 'the fully settled bill receives its final commercial snapshot');
    equal(JSON.parse(finalSnapshot.accounting_snapshot_json).fields.total, 100, 'the final snapshot captures the settled bill total');
    equal((db.prepare(`
      SELECT SUM(line.credit_minor) AS total
      FROM accounting_journal_lines line JOIN accounting_journal_entries entry ON entry.id=line.journal_entry_id
      JOIN accounting_accounts account ON account.id=line.account_id
      WHERE entry.source_type='bill_payment' AND entry.source_id LIKE ? AND entry.status='posted' AND account.system_key='sales_revenue'
    `).get(String(billId) + ':%') as any).total, 100, 'partial and final receipts recognize only the 100 actually received');
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

  // Scenario 5: USD POS amounts are converted to cents, unlike canonical IRR/rial.
  {
    const db = freshDb();
    const stamp = now();
    db.prepare("INSERT OR REPLACE INTO settings (key,value,updated_at) VALUES ('country','US',?)").run(stamp);
    db.prepare("INSERT OR REPLACE INTO settings (key,value,updated_at) VALUES ('currency','USD',?)").run(stamp);
    db.prepare("INSERT OR REPLACE INTO settings (key,value,updated_at) VALUES ('timezone','America/New_York',?)").run(stamp);
    const { billId } = makeBill(db, 'USD-COLLECTION');
    const payment = { payment_event_id: 'payment-event-usd-001', method: 'cash', amount: 40, timestamp: '2026-10-14T08:00:00.000Z' };
    db.transaction(() => sales.postCollectionPaymentLines(db, billId, [payment], 'test-owner-accounting'))();
    const receipt = journalForSource(db, 'bill_payment', String(billId) + ':' + payment.payment_event_id, 'money_received');
    ok(receipt, 'USD receipt is journaled');
    const receiptLines = linesForJournal(db, receipt.id);
    equal(receiptLines.find((line: any) => line.system_key === 'cash_drawer')?.debit_minor, 4000, 'USD 40.00 is stored as 4000 cents');
    equal(receiptLines.find((line: any) => line.system_key === 'sales_revenue')?.credit_minor, 4000, 'USD revenue uses the same cents denomination');
    balanced(db, receipt.id);
    closeDatabase();
  }

  // Scenario 6: Toman is a display preference; POS sale receipts remain canonical rials.
  {
    const db = freshDb();
    const stamp = now();
    db.prepare("INSERT OR REPLACE INTO settings (key,value,updated_at) VALUES ('currency_display','toman',?)").run(stamp);
    const { billId } = makeBill(db, 'IRR-TOMAN-CANONICAL', 1500000, 0);
    const payment = {
      payment_event_id: 'payment-event-irr-toman-001',
      method: 'cash',
      amount: 1234500,
      timestamp: '2026-10-14T08:00:00.000Z',
    };
    db.transaction(() => sales.postCollectionPaymentLines(db, billId, [payment], 'test-owner-accounting'))();
    const receipt = journalForSource(db, 'bill_payment', String(billId) + ':' + payment.payment_event_id, 'money_received');
    ok(receipt, 'IRR sale receipt with toman display preference is journaled');
    const receiptLines = linesForJournal(db, receipt.id);
    equal(receiptLines.find((line: any) => line.system_key === 'cash_drawer')?.debit_minor, 1234500,
      'toman display preference does not divide or multiply the POS rial amount');
    equal(receiptLines.find((line: any) => line.system_key === 'sales_revenue')?.credit_minor, 1234500,
      'sales revenue is credited in the same canonical rial units as the actual payment');
    balanced(db, receipt.id);

    const journalsBeforeInvalidPrecision = (db.prepare('SELECT COUNT(*) AS n FROM accounting_journal_entries').get() as any).n;
    const invalidPayment = { ...payment, payment_event_id: 'payment-event-irr-fractional-rial', amount: 1234500.5 };
    throwsCode(() => db.transaction(() => sales.postCollectionPaymentLines(db, billId, [invalidPayment], 'test-owner-accounting'))(),
      'accounting_amount_invalid', 'fractional-rial POS receipt is rejected instead of rounded');
    equal((db.prepare('SELECT COUNT(*) AS n FROM accounting_journal_entries').get() as any).n, journalsBeforeInvalidPrecision,
      'rejecting out-of-precision sale receipt creates no partial journal');
    closeDatabase();
  }

  // Scenario 7: A corrupted/stale cash-method mapping must not post receipts to non-liquid assets.
  {
    const db = freshDb();
    const { billId } = makeBill(db, 'INVALID-LIQUID-MAPPING');
    db.prepare(`
      INSERT INTO accounting_accounts
        (id, system_key, account_code, name, account_type, normal_balance, parent_account_id, is_system, is_active, is_postable)
      VALUES ('acct-sales-nonliquid', NULL, '1199', 'Unclassified asset', 'asset', 'debit', 'acct-assets', 0, 1, 1)
    `).run();
    // Simulate legacy/corrupted persisted state; the settings API itself refuses this mapping.
    db.prepare("UPDATE accounting_payment_method_mappings SET account_id='acct-sales-nonliquid' WHERE payment_method_key='cash'").run();
    const payment = { payment_event_id: 'payment-invalid-liquid-target-001', method: 'cash', amount: 100, timestamp: '2026-10-14T08:00:00.000Z' };
    throws(() => db.transaction(() => sales.postCollectionPaymentLines(db, billId, [payment], 'test-owner-accounting'))(),
      /must target an active postable cash, bank, or payment-clearing account/i,
      'POS receipt posting revalidates persisted payment mappings instead of trusting old settings');
    equal(db.prepare('SELECT COUNT(*) AS n FROM accounting_journal_entries').get().n, 0,
      'invalid non-liquid payment mapping is rejected before any receipt journal is created');
    equal(db.prepare("SELECT COUNT(*) AS n FROM accounting_journal_entries WHERE source_type='bill_payment' AND source_event='money_received'").get().n, 0,
      'rejected non-liquid mapping cannot recognize revenue');
    closeDatabase();
  }

  // Scenario 7: Monetary refunds reverse revenue; wallet refunds are ignored.
  {
    const db = freshDb();
    const { billId } = makeBill(db, 'REFUND');
    const received = { payment_event_id: 'refund-test-receipt-001', method: 'cash', amount: 100, timestamp: now() };
    db.transaction(() => sales.postCollectionPaymentLines(db, billId, [received], 'test-owner-accounting'))();
    sales.finalizeBillSale(db, billId, 'test-owner-accounting');
    const stamp = now();
    const refund = db.prepare(
      'INSERT INTO refunds (bill_id,amount_cents,method,reason,approved_by,created_by,created_at) VALUES (?,?,?,?,?,?,?)',
     ).run(billId, 2500, 'cash', 'test monetary refund', 'test-owner-accounting', 'test-owner-accounting', stamp);
    const first = sales.postCommittedRefund(db, Number(refund.lastInsertRowid), 'test-owner-accounting');
    equal(first.posted, true, 'committed monetary refund is posted');
    const refundJournal = journalForSource(db, 'refund', String(refund.lastInsertRowid), 'money_refunded');
    ok(refundJournal, 'refund source identity is the persisted refund row ID');
    balanced(db, refundJournal.id);
    const refundLines = linesForJournal(db, refundJournal.id);
    equal(refundLines.find((line: any) => line.system_key === 'sales_returns')?.debit_minor, 25, 'full monetary refund debits contra-revenue');
    equal(refundLines.find((line: any) => line.system_key === 'cash_drawer')?.credit_minor, 25, 'refund credits actual payout account');
    const again = sales.postCommittedRefund(db, Number(refund.lastInsertRowid), 'test-owner-accounting');
    equal(again.posted, true, 'refund retry resolves through original source journal');
    equal(db.prepare("SELECT COUNT(*) AS n FROM accounting_journal_entries WHERE source_type='refund' AND source_id=? AND source_event='money_refunded'").get(String(refund.lastInsertRowid)).n, 1, 'refund retry never duplicates journal');

    const excessRefund = db.prepare(
      'INSERT INTO refunds (bill_id,amount_cents,method,reason,approved_by,created_by,created_at) VALUES (?,?,?,?,?,?,?)',
    ).run(billId, 7600, 'cash', 'refund exceeds unrefunded recorded receipts', 'test-owner-accounting', 'test-owner-accounting', now());
    const excessResult = sales.postCommittedRefund(db, Number(excessRefund.lastInsertRowid), 'test-owner-accounting');
    equal(excessResult.posted, false, 'refund above remaining posted receipts is retained operationally but not overstated in accounting');
    equal(excessResult.reason, 'refund_exceeds_recorded_receipts', 'excess refund returns an explicit reconciliation reason');
    equal(journalForSource(db, 'refund', String(excessRefund.lastInsertRowid), 'money_refunded'), undefined,
      'excess refund creates no negative or unmatched sales-return journal');
    ok(db.prepare("SELECT 1 FROM accounting_audit_log WHERE entity_type='accounting_source_event' AND entity_id=? AND action='skipped_unmatched_refund_posting'")
      .get('refund:' + Number(excessRefund.lastInsertRowid)), 'excess refund is flagged for reconciliation');

    const walletRefund = db.prepare(
      'INSERT INTO refunds (bill_id,amount_cents,method,reason,approved_by,created_by,created_at) VALUES (?,?,?,?,?,?,?)',
    ).run(billId, 10, 'wallet', 'non-monetary store credit', 'test-owner-accounting', 'test-owner-accounting', now());
    const ignored = sales.postCommittedRefund(db, Number(walletRefund.lastInsertRowid), 'test-owner-accounting');
    equal(ignored.posted, false, 'wallet refund is ignored');
    equal(db.prepare("SELECT COUNT(*) AS n FROM accounting_journal_entries WHERE source_type='refund'").get().n, 1, 'wallet refund creates no journal');
    const storeCreditRefund = db.prepare(
      'INSERT INTO refunds (bill_id,amount_cents,method,reason,approved_by,created_by,created_at) VALUES (?,?,?,?,?,?,?)',
    ).run(billId, 2500, 'store_credit', 'non-monetary store credit refund', 'test-owner-accounting', 'test-owner-accounting', now());
    const ignoredStoreCredit = sales.postCommittedRefund(db, Number(storeCreditRefund.lastInsertRowid), 'test-owner-accounting');
    equal(ignoredStoreCredit.posted, false, 'store-credit refund is ignored as non-monetary');
    equal(ignoredStoreCredit.reason, 'non_monetary_refund_ignored', 'store-credit refund returns the explicit non-monetary result');
    equal(db.prepare("SELECT COUNT(*) AS n FROM accounting_journal_entries WHERE source_type='refund'").get().n, 1, 'store-credit refund creates no journal');
    closeDatabase();
  }

  // Refunds cannot create returns against income that was never recognized.
  {
    const db = freshDb();
    const { billId } = makeBill(db, 'REFUND-WITHOUT-RECEIPT');
    const refund = db.prepare(
      'INSERT INTO refunds (bill_id,amount_cents,method,reason,approved_by,created_by,created_at) VALUES (?,?,?,?,?,?,?)',
    ).run(billId, 1000, 'cash', 'no ledger receipt exists', 'test-owner-accounting', 'test-owner-accounting', now());
    const result = sales.postCommittedRefund(db, Number(refund.lastInsertRowid), 'test-owner-accounting');
    equal(result.posted, false, 'automatic posting does not post a refund when no monetary receipt exists in the ledger');
    equal(result.reason, 'no_accounting_recorded_receipt', 'unmatched refund reports the absence of an accounting receipt');
    equal(journalForSource(db, 'refund', String(refund.lastInsertRowid), 'money_refunded'), undefined,
      'unmatched refund does not create negative sales returns or a payout journal');
    ok(db.prepare("SELECT 1 FROM accounting_audit_log WHERE entity_type='accounting_source_event' AND entity_id=? AND action='skipped_unmatched_refund_posting'")
      .get('refund:' + Number(refund.lastInsertRowid)), 'unmatched refund is retained for source reconciliation');
    closeDatabase();
  }

  // Scenario 8: pre-cutover bills keep POS behavior but are not silently backfilled.
  {
    const db = freshDb();
    const legacyStamp = '2024-01-01T10:00:00.000Z';
    const { billId } = makeBill(db, 'LEGACY', 100, 0, legacyStamp);
    db.prepare("UPDATE settings SET value='2025-01-01T00:00:00.000Z' WHERE key='accounting_cutover_at'").run();
    const payment = { payment_event_id: 'legacy-payment-001', method: 'cash', amount: 20, timestamp: '2024-01-01T10:05:00.000Z' };
    db.transaction(() => sales.postCollectionPaymentLines(db, billId, [payment], 'test-owner-accounting'))();
    equal(journalForSource(db, 'bill', String(billId), 'sale_recognized'), undefined, 'legacy bill is not backfilled as a sale');
    equal(journalForSource(db, 'bill_payment', String(billId) + ':' + payment.payment_event_id, 'money_received'), undefined, 'legacy collection is not backfilled');
    ok(db.prepare("SELECT 1 FROM accounting_audit_log WHERE entity_type='accounting_source_event' AND entity_id=? AND action='skipped_pre_cutover_payment'").get('payment:' + payment.payment_event_id), 'legacy skip is documented in audit history');
    throws(() => sales.finalizeBillSale(db, billId, 'test-owner-accounting'), /predates accounting cutover/i, 'manual finalization cannot silently backfill a legacy bill');
    db.prepare("UPDATE bills SET payment_status='paid', paid_at=?, paid_amount=100, balance=0 WHERE id=?").run(now(), billId);
    closeDatabase();
  }

  // Scenario 9: post-cutover money events on legacy bills are recognized by event time.
  {
    const db = freshDb();
    const legacyStamp = '2024-01-01T10:00:00.000Z';
    const { billId } = makeBill(db, 'LEGACY-POST-CUTOVER', 100, 0, legacyStamp);
    db.prepare("UPDATE settings SET value='2025-01-01T00:00:00.000Z' WHERE key='accounting_cutover_at'").run();
    const payment = { payment_event_id: 'late-payment-001', method: 'cash', amount: 20, timestamp: '2025-01-01T00:00:01.000Z' };
    db.prepare('UPDATE bills SET payment_status=?, payment_details=? WHERE id=?').run('paid', JSON.stringify([payment]), billId);
    db.transaction(() => sales.postCollectionPaymentLines(db, billId, [payment], 'test-owner-accounting'))();
    const receiptJournal = journalForSource(db, 'bill_payment', String(billId) + ':' + payment.payment_event_id, 'money_received');
    ok(receiptJournal, 'post-cutover receipt is posted even when the bill itself predates cutover');
    equal(receiptJournal.status, 'posted', 'legacy bill receipt is posted through the normal ledger');
    equal(receiptJournal.entry_date, '2025-01-01', 'receipt posting date comes from the actual receipt timestamp');
    equal(db.prepare("SELECT COUNT(*) AS n FROM accounting_audit_log WHERE entity_type='accounting_source_event' AND entity_id=? AND action='skipped_pre_cutover_payment'").get('payment:' + payment.payment_event_id).n, 0, 'new receipt event is not incorrectly audited as a skipped legacy receipt');

    const refund = db.prepare(
      'INSERT INTO refunds (bill_id, amount_cents, method, reason, approved_by, created_by, created_at) VALUES (?,?,?,?,?,?,?)',
    ).run(billId, 1000, 'cash', 'Post-cutover refund within the recorded receipt', 'test-owner-accounting', 'test-owner-accounting', '2025-01-02T08:00:00.000Z');
    const refundResult = sales.postCommittedRefund(db, Number(refund.lastInsertRowid), 'test-owner-accounting');
    equal(refundResult.posted, true, 'post-cutover refund is posted even when its source bill predates cutover');
    const refundJournal = journalForSource(db, 'refund', String(refund.lastInsertRowid), 'money_refunded');
    equal(refundJournal.status, 'posted', 'legacy-bill refund follows the normal posted-journal path');
    equal(db.prepare("SELECT COUNT(*) AS n FROM accounting_audit_log WHERE entity_type='accounting_source_event' AND entity_id=? AND action='skipped_pre_cutover_refund'").get('refund:' + Number(refund.lastInsertRowid)).n, 0, 'new refund is not incorrectly audited as a skipped legacy refund');
    closeDatabase();
  }


  // An unassigned method uses the global default for receipts and refunds; explicit mapping has priority.
  {
    const db = freshDb();
    db.prepare("UPDATE settings SET value='acct-bank' WHERE key='accounting_default_payment_account_id'").run();
    const { billId } = makeBill(db, 'DEFAULT-PAYMENT-FALLBACK');
    db.prepare("DELETE FROM accounting_payment_method_mappings WHERE payment_method_key='cash'").run();
    const payment = { payment_event_id: 'payment-default-fallback-001', method: 'cash', amount: 75, timestamp: '2026-10-14T08:00:00.000Z' };
    db.transaction(() => sales.postCollectionPaymentLines(db, billId, [payment], 'test-owner-accounting'))();
    const receipt = journalForSource(db, 'bill_payment', String(billId) + ':' + payment.payment_event_id, 'money_received');
    ok(receipt, 'unassigned cash method posts a receipt using the configured default account');
    const receiptLines = linesForJournal(db, receipt.id);
    equal(receiptLines.find((line: any) => line.system_key === 'bank_accounts')?.debit_minor, 75,
      'unassigned payment debits the configured default bank account');
    equal(receiptLines.find((line: any) => line.system_key === 'sales_revenue')?.credit_minor, 75,
      'fallback routing still recognizes the actual amount as revenue exactly once');
    balanced(db, receipt.id);

    sales.finalizeBillSale(db, billId, 'test-owner-accounting');
    const refund = db.prepare(
      'INSERT INTO refunds (bill_id,amount_cents,method,reason,approved_by,created_by,created_at) VALUES (?,?,?,?,?,?,?)',
    ).run(billId, 2500, 'cash', 'fallback refund uses configured default', 'test-owner-accounting', 'test-owner-accounting', now());
    const refunded = sales.postCommittedRefund(db, Number(refund.lastInsertRowid), 'test-owner-accounting');
    equal(refunded.posted, true, 'monetary refund can use the configured default when its method has no account');
    const refundJournal = journalForSource(db, 'refund', String(refund.lastInsertRowid), 'money_refunded');
    equal(linesForJournal(db, refundJournal.id).find((line: any) => line.system_key === 'bank_accounts')?.credit_minor, 25,
      'fallback refund credits the actual default payout account');
    balanced(db, refundJournal.id);

    const { billId: explicitBillId } = makeBill(db, 'EXPLICIT-PAYMENT-PRIORITY');
    db.prepare("INSERT INTO accounting_payment_method_mappings (payment_method_key,account_id,updated_by) VALUES ('cash','acct-cash-drawer','test-owner-accounting')").run();
    const explicitPayment = { payment_event_id: 'payment-explicit-priority-001', method: 'cash', amount: 20, timestamp: '2026-10-14T08:01:00.000Z' };
    db.transaction(() => sales.postCollectionPaymentLines(db, explicitBillId, [explicitPayment], 'test-owner-accounting'))();
    const explicitReceipt = journalForSource(db, 'bill_payment', String(explicitBillId) + ':' + explicitPayment.payment_event_id, 'money_received');
    equal(linesForJournal(db, explicitReceipt.id).find((line: any) => line.system_key === 'cash_drawer')?.debit_minor, 20,
      'explicit method mapping wins even when the global default points to a bank account');
    balanced(db, explicitReceipt.id);

    // Built-in card has its own mapping and must override the global default.
    db.prepare("UPDATE accounting_payment_method_mappings SET account_id='acct-payment-clearing' WHERE payment_method_key='card'").run();
    const { billId: cardMappedBillId } = makeBill(db, 'CARD-METHOD-ACCOUNT');
    const cardMappedPayment = {
      payment_event_id: 'payment-card-specific-account-001', method: 'card', amount: 18,
      timestamp: '2026-10-14T08:01:30.000Z',
    };
    db.transaction(() => sales.postCollectionPaymentLines(db, cardMappedBillId, [cardMappedPayment], 'test-owner-accounting'))();
    const cardMappedReceipt = journalForSource(
      db, 'bill_payment', String(cardMappedBillId) + ':' + cardMappedPayment.payment_event_id, 'money_received',
    );
    ok(cardMappedReceipt, 'built-in card payment posts a receipt');
    const cardMappedLines = linesForJournal(db, cardMappedReceipt.id);
    equal(cardMappedLines.find((line: any) => line.system_key === 'payment_clearing')?.debit_minor, 18,
      'card receipt debits its specifically mapped clearing account rather than the global bank default');
    equal(cardMappedLines.find((line: any) => line.system_key === 'bank_accounts'), undefined,
      'card receipt does not also debit the default bank account');
    equal(cardMappedLines.find((line: any) => line.system_key === 'cash_drawer'), undefined,
      'card receipt does not debit the cash drawer');
    equal(cardMappedLines.find((line: any) => line.system_key === 'sales_revenue')?.credit_minor, 18,
      'card receipt credits revenue only for actual money received');
    equal((db.prepare(
      "SELECT COUNT(*) AS n FROM accounting_journal_entries WHERE source_type='bill_payment' AND source_id=? AND source_event='money_received' AND status='posted'",
    ).get(String(cardMappedBillId) + ':' + cardMappedPayment.payment_event_id) as any).n, 1,
    'specific card mapping results in one posted receipt journal');
    balanced(db, cardMappedReceipt.id);

    // Newly-created custom methods remain unmapped and therefore use the current default.
    const customMethod = db.prepare(
      'INSERT INTO payment_methods (name,is_active,sort_order,created_at,updated_at) VALUES (?,1,999,?,?)',
    ).run('Custom Bank Transfer', now(), now());
    const customMethodId = Number(customMethod.lastInsertRowid);
    const customKey = 'custom:' + customMethodId;
    equal((db.prepare('SELECT COUNT(*) AS n FROM accounting_payment_method_mappings WHERE payment_method_key=?').get(customKey) as any).n,
      0, 'a newly-created custom payment method is not silently hard-wired to clearing');
    const { billId: customDefaultBillId } = makeBill(db, 'CUSTOM-DEFAULT-ACCOUNT');
    const customDefaultPayment = {
      payment_event_id: 'custom-default-payment-001', payment_method_id: customMethodId,
      method: 'custom', amount: 33, timestamp: '2026-10-14T08:02:00.000Z',
    };
    db.transaction(() => sales.postCollectionPaymentLines(db, customDefaultBillId, [customDefaultPayment], 'test-owner-accounting'))();
    const customDefaultReceipt = journalForSource(db, 'bill_payment', String(customDefaultBillId) + ':' + customDefaultPayment.payment_event_id, 'money_received');
    ok(customDefaultReceipt, 'custom payment with no mapping posts through the configured default');
    equal(linesForJournal(db, customDefaultReceipt.id).find((line: any) => line.system_key === 'bank_accounts')?.debit_minor, 33,
      'new custom method uses the configured default bank account');
    equal(linesForJournal(db, customDefaultReceipt.id).find((line: any) => line.system_key === 'sales_revenue')?.credit_minor, 33,
      'custom payment fallback credits only the actual received amount');
    balanced(db, customDefaultReceipt.id);

    db.prepare('INSERT INTO accounting_payment_method_mappings (payment_method_key,account_id,updated_by) VALUES (?,?,?)')
      .run(customKey, 'acct-cash-drawer', 'test-owner-accounting');
    const { billId: customExplicitBillId } = makeBill(db, 'CUSTOM-EXPLICIT-ACCOUNT');
    const customExplicitPayment = {
      payment_event_id: 'custom-explicit-payment-001', payment_method_id: customMethodId,
      method: 'custom', amount: 21, timestamp: '2026-10-14T08:03:00.000Z',
    };
    db.transaction(() => sales.postCollectionPaymentLines(db, customExplicitBillId, [customExplicitPayment], 'test-owner-accounting'))();
    const customExplicitReceipt = journalForSource(db, 'bill_payment', String(customExplicitBillId) + ':' + customExplicitPayment.payment_event_id, 'money_received');
    ok(customExplicitReceipt, 'explicit custom-method mapping posts the receipt');
    equal(linesForJournal(db, customExplicitReceipt.id).find((line: any) => line.system_key === 'cash_drawer')?.debit_minor, 21,
      'custom-method specific account takes priority over the global default');
    equal(linesForJournal(db, customExplicitReceipt.id).find((line: any) => line.system_key === 'bank_accounts'), undefined,
      'an explicit custom mapping does not also debit the default bank account');
    balanced(db, customExplicitReceipt.id);

    // Clearing a method-specific mapping must immediately restore fallback behavior.
    db.prepare('DELETE FROM accounting_payment_method_mappings WHERE payment_method_key=?').run(customKey);
    const { billId: customClearedBillId } = makeBill(db, 'CUSTOM-CLEARED-ACCOUNT');
    const customClearedPayment = {
      payment_event_id: 'custom-cleared-payment-001', payment_method_id: customMethodId,
      method: 'custom', amount: 11, timestamp: '2026-10-14T08:04:00.000Z',
    };
    db.transaction(() => sales.postCollectionPaymentLines(db, customClearedBillId, [customClearedPayment], 'test-owner-accounting'))();
    const customClearedReceipt = journalForSource(db, 'bill_payment', String(customClearedBillId) + ':' + customClearedPayment.payment_event_id, 'money_received');
    ok(customClearedReceipt, 'cleared custom mapping still accepts actual money through fallback');
    equal(linesForJournal(db, customClearedReceipt.id).find((line: any) => line.system_key === 'bank_accounts')?.debit_minor, 11,
      'cleared custom mapping returns to the configured default account');
    equal((db.prepare("SELECT COUNT(*) AS n FROM accounting_journal_entries WHERE source_type='bill_payment' AND source_event='money_received' AND source_id LIKE ?").get(String(customClearedBillId) + ':%') as any).n,
      1, 'custom fallback posts exactly one receipt journal');
    balanced(db, customClearedReceipt.id);
    closeDatabase();
  }

  // User-created cash/bank accounts must work as payment destinations just like the built-in liquid accounts.
  {
    const db = freshDb();
    const chart = require('../main/accounting/chart-of-accounts');
    const expenses = require('../main/accounting/expenses');
    const newCash = chart.createManagedAccountingAccount(db, {
      name: 'User-created till account',
      account_kind: 'cash',
    }, 'test-owner-accounting');
    const newBank = chart.createManagedAccountingAccount(db, {
      name: 'User-created bank account',
      account_kind: 'bank',
    }, 'test-owner-accounting');

    ok(newCash.is_liquid, 'newly created cash account is classified as liquid');
    ok(newBank.is_liquid, 'newly created bank account is classified as liquid');
    ok(String(newCash.system_key).startsWith('custom_liquid:cash:'), 'new cash account gets the supported custom liquid key');
    ok(String(newBank.system_key).startsWith('custom_liquid:bank:'), 'new bank account gets the supported custom liquid key');

    expenses.setPaymentAccountMapping(db, 'cash', newBank.id, 'test-owner-accounting');
    const { billId: bankBillId } = makeBill(db, 'USER-CREATED-BANK-MAPPING');
    const bankPayment = {
      payment_event_id: 'payment-user-created-bank-001',
      method: 'cash',
      amount: 43,
      timestamp: '2026-10-14T08:05:00.000Z',
    };
    db.transaction(() => sales.postCollectionPaymentLines(db, bankBillId, [bankPayment], 'test-owner-accounting'))();
    const bankReceipt = journalForSource(db, 'bill_payment', String(bankBillId) + ':' + bankPayment.payment_event_id, 'money_received');
    ok(bankReceipt, 'sale mapped to a user-created bank account posts successfully');
    const bankLines = linesForJournal(db, bankReceipt.id);
    equal(bankLines.find((line: any) => line.account_id === newBank.id)?.debit_minor, 43,
      'mapped user-created bank account receives the exact actual payment');
    equal(bankLines.find((line: any) => line.system_key === 'sales_revenue')?.credit_minor, 43,
      'revenue remains equal to actual money received with a custom bank destination');
    equal(bankLines.some((line: any) => line.system_key === 'cash_drawer' || line.system_key === 'payment_clearing'), false,
      'custom bank mapping does not also post to a built-in cash or clearing account');
    equal((db.prepare("SELECT COUNT(*) AS n FROM accounting_journal_entries WHERE source_type='bill_payment' AND source_id=? AND source_event='money_received' AND status='posted'").get(String(bankBillId) + ':' + bankPayment.payment_event_id) as any).n,
      1, 'user-created bank mapping produces exactly one posted receipt journal');
    balanced(db, bankReceipt.id);

    const customMethod = db.prepare(
      'INSERT INTO payment_methods (name,is_active,sort_order,created_at,updated_at) VALUES (?,1,999,?,?)',
    ).run('User-created cash destination method', now(), now());
    const customMethodId = Number(customMethod.lastInsertRowid);
    expenses.setPaymentAccountMapping(db, 'custom:' + customMethodId, newCash.id, 'test-owner-accounting');
    const { billId: cashBillId } = makeBill(db, 'USER-CREATED-CASH-MAPPING');
    const cashPayment = {
      payment_event_id: 'payment-user-created-cash-001',
      payment_method_id: customMethodId,
      method: 'custom',
      amount: 29,
      timestamp: '2026-10-14T08:06:00.000Z',
    };
    db.transaction(() => sales.postCollectionPaymentLines(db, cashBillId, [cashPayment], 'test-owner-accounting'))();
    const cashReceipt = journalForSource(db, 'bill_payment', String(cashBillId) + ':' + cashPayment.payment_event_id, 'money_received');
    ok(cashReceipt, 'custom payment mapped to a user-created cash account posts successfully');
    const cashLines = linesForJournal(db, cashReceipt.id);
    equal(cashLines.find((line: any) => line.account_id === newCash.id)?.debit_minor, 29,
      'user-created cash account receives the exact custom-method payment');
    equal(cashLines.find((line: any) => line.system_key === 'sales_revenue')?.credit_minor, 29,
      'custom-method revenue is recorded once for the actual received amount');
    equal(cashLines.some((line: any) => line.system_key === 'cash_drawer' || line.system_key === 'payment_clearing'), false,
      'custom cash mapping does not duplicate the posting to a built-in account');
    balanced(db, cashReceipt.id);

    const refund = db.prepare(
      'INSERT INTO refunds (bill_id,amount_cents,method,reason,approved_by,created_by,created_at) VALUES (?,?,?,?,?,?,?)',
    ).run(cashBillId, 2500, 'custom:' + customMethodId, 'User-created cash account refund', 'test-owner-accounting', 'test-owner-accounting', '2026-10-14T08:07:00.000Z');
    const refundResult = sales.postCommittedRefund(db, Number(refund.lastInsertRowid), 'test-owner-accounting');
    equal(refundResult.posted, true, 'refund to a user-created cash account posts successfully');
    const refundJournal = journalForSource(db, 'refund', String(refund.lastInsertRowid), 'money_refunded');
    const refundLines = linesForJournal(db, refundJournal.id);
    equal(refundLines.find((line: any) => line.account_id === newCash.id)?.credit_minor, 25,
      'user-created cash account is credited for the actual refunded amount');
    equal(refundLines.find((line: any) => line.system_key === 'sales_returns')?.debit_minor, 25,
      'refund still debits sales returns rather than operating expense');
    balanced(db, refundJournal.id);
    closeDatabase();
  }

  // Invalid global defaults fail closed; they never recognize revenue into the wrong account.
  {
    const db = freshDb();
    const { billId } = makeBill(db, 'INVALID-DEFAULT-PAYMENT');
    db.prepare("UPDATE settings SET value='acct-inventory' WHERE key='accounting_default_payment_account_id'").run();
    db.prepare("DELETE FROM accounting_payment_method_mappings WHERE payment_method_key='cash'").run();
    const payment = { payment_event_id: 'payment-invalid-default-001', method: 'cash', amount: 100, timestamp: '2026-10-14T08:00:00.000Z' };
    throwsCode(() => db.transaction(() => sales.postCollectionPaymentLines(db, billId, [payment], 'test-owner-accounting'))(),
      'payment_default_mapping_invalid', 'invalid default account is rejected before a cash receipt can post');
    equal(db.prepare('SELECT COUNT(*) AS n FROM accounting_journal_entries').get().n, 0,
      'invalid default account creates no journal or revenue');
    closeDatabase();
  }

  // Scenario 10: automatic sales posting is opt-in; posted-sale refunds remain linked.
  {
    const db = freshDb();
    db.prepare("DELETE FROM settings WHERE key='accounting_auto_post_sales'").run();
    equal(sales.isAutomaticSalesPostingEnabled(db), false, 'missing preference defaults automatic sales posting to disabled');
    const { billId: preCutoverBillId } = makeBill(db, 'AUTO-POST-OFF-LEGACY');
    const preCutoverPayment = {
      payment_event_id: 'auto-off-pre-cutover-payment-001', method: 'cash', amount: 25,
      timestamp: '1999-12-31T23:59:00.000Z',
    };
    db.transaction(() => sales.postCollectionPaymentLines(db, preCutoverBillId, [preCutoverPayment], 'test-owner-accounting'))();
    ok(db.prepare("SELECT 1 FROM accounting_audit_log WHERE entity_type='accounting_source_event' AND entity_id=? AND action='skipped_pre_cutover_payment'")
      .get('payment:' + preCutoverPayment.payment_event_id),
      'pre-cutover receipt keeps its legacy classification even when automatic posting is disabled');
    equal(db.prepare("SELECT COUNT(*) AS n FROM accounting_audit_log WHERE entity_type='accounting_source_event' AND entity_id=? AND action='skipped_auto_sales_posting'")
      .get('payment:' + preCutoverPayment.payment_event_id).n, 0,
      'pre-cutover receipt is not mislabeled as a post-cutover auto-posting skip');
    equal(journalForSource(db, 'bill_payment', String(preCutoverBillId) + ':' + preCutoverPayment.payment_event_id, 'money_received'), undefined,
      'pre-cutover receipt is never backfilled while automatic posting is disabled');

    const { billId: skippedBillId } = makeBill(db, 'AUTO-POST-OFF', 30, 0);
    db.prepare("UPDATE bills SET paid_amount=30,balance=0,payment_status='paid' WHERE id=?").run(skippedBillId);
    const skippedPayment = { payment_event_id: 'auto-off-payment-001', method: 'cash', amount: 30, timestamp: now() };
    db.transaction(() => sales.postCollectionPaymentLines(db, skippedBillId, [skippedPayment], 'test-owner-accounting'))();
    equal(journalForSource(db, 'bill_payment', String(skippedBillId) + ':' + skippedPayment.payment_event_id, 'money_received'), undefined,
      'disabled automatic sales posting creates no receipt journal');
    const skippedSnapshot = db.prepare('SELECT accounting_finalized_at,accounting_snapshot_json FROM bills WHERE id=?').get(skippedBillId) as any;
    ok(skippedSnapshot.accounting_finalized_at, 'paid bill still receives an immutable snapshot while automatic journal posting is disabled');
    equal(JSON.parse(skippedSnapshot.accounting_snapshot_json).journalEntryId, null,
      'disabled posting snapshot explicitly contains no sales journal');
    ok(db.prepare("SELECT 1 FROM accounting_audit_log WHERE entity_type='accounting_source_event' AND entity_id=? AND action='skipped_auto_sales_posting'")
      .get('payment:' + skippedPayment.payment_event_id), 'disabled receipt is retained in the accounting audit log');

    const skippedRefund = db.prepare(
      'INSERT INTO refunds (bill_id,amount_cents,method,reason,approved_by,created_by,created_at) VALUES (?,?,?,?,?,?,?)',
    ).run(skippedBillId, 500, 'cash', 'refund for unposted sale', 'test-owner-accounting', 'test-owner-accounting', now());
    const skippedRefundResult = sales.postCommittedRefund(db, Number(skippedRefund.lastInsertRowid), 'test-owner-accounting');
    equal(skippedRefundResult.posted, false, 'refund of an unposted sale is not journaled when automatic sales posting is disabled');
    equal(skippedRefundResult.reason, 'automatic_sales_posting_disabled', 'unposted-sale refund reports the intentional skip reason');
    ok(db.prepare("SELECT 1 FROM accounting_audit_log WHERE entity_type='accounting_source_event' AND entity_id=? AND action='skipped_auto_refund_posting'")
      .get('refund:' + Number(skippedRefund.lastInsertRowid)), 'unposted-sale refund skip is audited');

    db.prepare("INSERT OR REPLACE INTO settings (key,value,updated_at) VALUES ('accounting_auto_post_sales','true',CURRENT_TIMESTAMP)").run();
    equal(sales.isAutomaticSalesPostingEnabled(db), true, 'owner-enabled preference activates future receipt posting');
    const { billId: postedBillId } = makeBill(db, 'AUTO-POST-ON');
    const postedPayment = { payment_event_id: 'auto-on-payment-001', method: 'cash', amount: 40, timestamp: now() };
    db.transaction(() => sales.postCollectionPaymentLines(db, postedBillId, [postedPayment], 'test-owner-accounting'))();
    const postedReceipt = journalForSource(db, 'bill_payment', String(postedBillId) + ':' + postedPayment.payment_event_id, 'money_received');
    ok(postedReceipt, 'enabled automatic sales posting creates the normal receipt journal');

    const { billId: missingTimestampBillId } = makeBill(db, 'AUTO-POST-MISSING-TIMESTAMP');
    const missingTimestampPayment = { payment_event_id: 'auto-on-payment-missing-timestamp-001', method: 'cash', amount: 10 };
    throwsCode(() => db.transaction(() => sales.postCollectionPaymentLines(db, missingTimestampBillId, [missingTimestampPayment], 'test-owner-accounting'))(),
      'payment_event_timestamp_missing', 'enabled posting rejects a payment without its actual event timestamp instead of inventing one');
    equal(journalForSource(db, 'bill_payment', String(missingTimestampBillId) + ':' + missingTimestampPayment.payment_event_id, 'money_received'), undefined,
      'missing payment timestamp creates no journal under a synthetic current date');

    db.prepare("UPDATE settings SET value='false' WHERE key='accounting_auto_post_sales'").run();
    const postedRefund = db.prepare(
      'INSERT INTO refunds (bill_id,amount_cents,method,reason,approved_by,created_by,created_at) VALUES (?,?,?,?,?,?,?)',
    ).run(postedBillId, 500, 'cash', 'refund after automatic posting disabled', 'test-owner-accounting', 'test-owner-accounting', now());
    const postedRefundResult = sales.postCommittedRefund(db, Number(postedRefund.lastInsertRowid), 'test-owner-accounting');
    equal(postedRefundResult.posted, true, 'refund of a previously posted sale still posts after automatic sales posting is disabled');
    ok(journalForSource(db, 'refund', String(postedRefund.lastInsertRowid), 'money_refunded'),
      'previously posted sale refund retains its linked contra-revenue journal');
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
