import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
let activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-accounting-loans-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => activeTestDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const dbModule = require('../main/db');
const { initDatabase, getDatabase, getCurrentSchemaVersion, closeDatabase } = dbModule;
const loans = require('../main/accounting/loans');
let assertions = 0;
function ok(value: unknown, message: string): void { assert.ok(value, message); assertions++; }
function equal(actual: unknown, expected: unknown, message: string): void { assert.equal(actual, expected, message); assertions++; }
function throws(operation: () => unknown, code: string, message: string): void {
  assert.throws(operation, (error: any) => error?.code === code || String(error?.message || '').includes(code), message);
  assertions++;
}
function journalLines(db: any, entryId: string): any[] {
  return db.prepare('SELECT account_id, debit_minor, credit_minor FROM accounting_journal_lines WHERE journal_entry_id=? ORDER BY line_no').all(entryId) as any[];
}

function main(): void {
  try {
    initDatabase();
    const db = getDatabase();
    equal(getCurrentSchemaVersion(), 116, 'fresh database includes loan schema v116');
    for (const table of ['accounting_loans','accounting_loan_installment_batches','accounting_loan_installments']) {
      ok(!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), 'loan migration creates ' + table);
    }

    const loanInput = {
      mode: 'new', lender: 'Test lender', loan_date: '2026-10-01', principal_minor: 1000,
      liability_account_id: 'acct-payables', cash_account_id: 'acct-bank', currency_code: 'IRR',
      reference_number: 'LN-001',
    };
    const created = loans.createLoan(db, loanInput, 'test-owner', 'loan-create-001');
    equal(created.mode, 'new', 'new borrowing creates a loan record');
    equal(created.remaining_principal_minor, 1000, 'new loan outstanding principal equals received principal');
    const duplicateLoan = loans.createLoan(db, loanInput, 'test-owner', 'loan-create-001');
    equal(duplicateLoan.duplicate, true, 'identical loan creation retry is idempotent');
    throws(() => loans.createLoan(db, {...loanInput, principal_minor: 1100}, 'test-owner', 'loan-create-001'), 'idempotency_conflict', 'changed loan payload under same key is rejected');

    const receiptLines = journalLines(db, created.initial_journal_entry_id);
    equal(receiptLines.length, 2, 'loan receipt creates a two-line balanced journal');
    equal(receiptLines.find((line:any)=>line.account_id==='acct-bank')?.debit_minor, 1000, 'new loan debits actual destination bank');
    equal(receiptLines.find((line:any)=>line.account_id==='acct-payables')?.credit_minor, 1000, 'new loan credits liability, not revenue');
    ok(!receiptLines.some((line:any)=>line.account_id==='acct-sales-revenue' || line.account_id==='acct-other-income'), 'loan proceeds are not posted as income');

    const batch = loans.createLoanInstallments(db, created.id, {installments:[{
      due_date:'2026-10-10', principal_minor:400, interest_minor:50, fees_minor:10,
      interest_account_id:'acct-tax-expenses', fees_account_id:'acct-payment-fees', auto_register:true,
    }]}, 'test-owner', 'loan-installments-001');
    equal(batch.installments.length, 1, 'lender-provided repayment schedule creates one installment occurrence');
    const installment = batch.installments[0];
    const dueResult = loans.processDueLoanInstallments(db, '2026-10-22');
    equal(dueResult.checked, 1, 'due processor checks the overdue loan installment');
    equal(dueResult.registered, 1, 'automatic mode registers a due installment');
    equal(db.prepare('SELECT status FROM accounting_loan_installments WHERE id=?').get(installment.id).status, 'registered', 'due registration does not mark installment paid');
    equal(db.prepare("SELECT COUNT(*) AS n FROM accounting_journal_entries WHERE source_type='accounting_loan' AND source_id=? AND source_event='installment_settlement'").get(installment.id).n, 0, 'due registration alone creates no fake cash/payment journal');

    const settled = loans.settleLoanInstallment(db, installment.id, {
      settlement_date:'2026-10-22', settlement_account_id:'acct-bank',
    }, 'test-owner', 'loan-settle-001');
    equal(settled.status, 'settled', 'explicit settlement marks installment paid');
    equal(settled.remaining_principal_minor, 600, 'settled principal reduces outstanding loan principal');
    const paymentLines = journalLines(db, settled.settlement_journal_entry_id);
    equal(paymentLines.find((line:any)=>line.account_id==='acct-payables')?.debit_minor, 400, 'principal repayment debits liability');
    equal(paymentLines.find((line:any)=>line.account_id==='acct-tax-expenses')?.debit_minor, 50, 'interest posts to the selected expense account');
    equal(paymentLines.find((line:any)=>line.account_id==='acct-payment-fees')?.debit_minor, 10, 'fees post to the selected fee expense account');
    equal(paymentLines.find((line:any)=>line.account_id==='acct-bank')?.credit_minor, 460, 'actual settlement credits bank for principal, interest and fees');
    equal(paymentLines.reduce((sum:number,line:any)=>sum+line.debit_minor,0), 460, 'installment journal debits balance actual cash outflow');
    equal(paymentLines.reduce((sum:number,line:any)=>sum+line.credit_minor,0), 460, 'installment journal credits balance actual cash outflow');
    equal(loans.settleLoanInstallment(db, installment.id, {settlement_date:'2026-10-22',settlement_account_id:'acct-bank'}, 'test-owner', 'loan-settle-001').duplicate, true, 'identical settlement retry is idempotent');
    throws(() => loans.settleLoanInstallment(db, installment.id, {settlement_date:'2026-10-23',settlement_account_id:'acct-bank'}, 'test-owner', 'different-key'), 'installment_already_settled', 'settled installment cannot be paid twice');

    throws(() => loans.createLoanInstallments(db, created.id, {installments:[{
      due_date:'2026-11-10', principal_minor:700, interest_minor:0, fees_minor:0, auto_register:false,
    }]}, 'test-owner', 'loan-installments-too-large'), 'principal_schedule_exceeds_balance', 'combined future principal cannot exceed remaining liability');

    const opening = loans.createLoan(db, {
      mode:'opening', lender:'Existing lender', loan_date:'2026-10-01',
      original_principal_minor:1000, remaining_principal_minor:700,
      liability_account_id:'acct-payables', currency_code:'IRR',
    }, 'test-owner', 'loan-opening-001');
    equal(opening.remaining_principal_minor, 700, 'opening an existing loan uses remaining principal, not original principal');
    equal(opening.cash_account_id, null, 'opening balance has no cash account');
    const openingLines = journalLines(db, opening.initial_journal_entry_id);
    equal(openingLines.find((line:any)=>line.account_id==='acct-opening-balance-equity')?.debit_minor, 700, 'existing loan opening uses opening-equity offset');
    equal(openingLines.find((line:any)=>line.account_id==='acct-payables')?.credit_minor, 700, 'existing loan opening credits only remaining liability');
    ok(!openingLines.some((line:any)=>line.account_id==='acct-bank' || line.account_id==='acct-cash-drawer'), 'existing loan opening does not invent cash received');

    const schedule = loans.createLoanInstallments(db, opening.id, {installments:[{
      due_date:'2026-12-01',principal_minor:700,interest_minor:0,fees_minor:0,auto_register:false,
    }]}, 'test-owner', 'loan-installments-002');
    const future = schedule.installments[0];
    const manualDue = loans.processDueLoanInstallments(db, '2026-11-01');
    equal(manualDue.awaitingConfirmation, 0, 'future installment is not registered early');
    throws(() => loans.registerLoanInstallment(db, future.id, 'test-owner', '2026-11-01'), 'installment_not_due', 'manual due registration rejects early dates');
    const cancelled = loans.cancelLoanInstallment(db, future.id, 'Schedule corrected', 'test-owner');
    equal(cancelled.status, 'cancelled', 'unregistered installment can be cancelled with a reason');
    throws(() => loans.cancelLoanInstallment(db, installment.id, 'too late', 'test-owner'), 'installment_not_cancellable', 'settled installment cannot be cancelled');

    const auditCount = db.prepare("SELECT COUNT(*) AS n FROM accounting_audit_log WHERE entity_type IN ('accounting_loan','accounting_loan_installment','accounting_loan_installment_batch')").get().n;
    ok(auditCount >= 7, 'loan creation, schedule, due-state and settlement actions are audited');
    equal((db.pragma('integrity_check') as any[])[0].integrity_check, 'ok', 'loan workflow leaves SQLite integrity intact');
    console.log('✓ accounting loan tests passed (' + assertions + ' assertions)');
  } catch (error) {
    console.error('✗ accounting loan tests failed after ' + assertions + ' assertions');
    throw error;
  } finally {
    closeDatabase();
    Module._load = originalLoad;
  }
}
main();
