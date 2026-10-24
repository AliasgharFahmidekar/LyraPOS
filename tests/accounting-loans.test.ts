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
const { initDatabase, getDatabase, getCurrentSchemaVersion, closeDatabase, MIGRATIONS } = dbModule;
const originalMigrations = [...MIGRATIONS];
const loans = require('../main/accounting/loans');
const { getAccountingManagementReport } = require('../main/accounting/reports');
const { getAccountingForecast } = require('../main/accounting/forecast');
const { closeAccountingPeriod } = require('../main/accounting/period-close');
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
    equal(getCurrentSchemaVersion(), 117, 'fresh database includes loan schema v117');
    for (const table of ['accounting_loans','accounting_loan_installment_batches','accounting_loan_installments']) {
      ok(!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), 'loan migration creates ' + table);
    }

    // Loan creation intentionally requires configured tenant regional settings.
    // Keep the test fixture realistic instead of weakening that production guard.
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('country', 'IR', CURRENT_TIMESTAMP)").run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('currency', 'IRR', CURRENT_TIMESTAMP)").run();
    equal((db.prepare("SELECT value FROM settings WHERE key='country'").get() as any).value, 'IR', 'loan fixture configures the store country');
    equal((db.prepare("SELECT value FROM settings WHERE key='currency'").get() as any).value, 'IRR', 'loan fixture configures the store currency');

    const loanInput = {
      mode: 'new', lender: 'Test lender', loan_date: '2026-10-01', principal_minor: 1000,
      liability_account_id: 'acct-loans-payable', cash_account_id: 'acct-bank', currency_code: 'IRR',
      reference_number: 'LN-001',
    };
    const journalsBeforeFutureLoan = (db.prepare('SELECT COUNT(*) AS n FROM accounting_journal_entries').get() as any).n;
    const loansBeforeFutureLoan = (db.prepare('SELECT COUNT(*) AS n FROM accounting_loans').get() as any).n;
    throws(() => loans.createLoan(db, {...loanInput, loan_date:'2099-01-01'}, 'test-owner', 'loan-future-date'),
      'loan_date_in_future', 'actual loan receipt/opening cannot be dated in the future');
    equal((db.prepare('SELECT COUNT(*) AS n FROM accounting_journal_entries').get() as any).n, journalsBeforeFutureLoan,
      'rejecting a future-dated loan creates no journal');
    equal((db.prepare('SELECT COUNT(*) AS n FROM accounting_loans').get() as any).n, loansBeforeFutureLoan,
      'rejecting a future-dated loan creates no loan record');
    const created = loans.createLoan(db, loanInput, 'test-owner', 'loan-create-001');
    equal(created.mode, 'new', 'new borrowing creates a loan record');
    equal(created.remaining_principal_minor, 1000, 'new loan outstanding principal equals received principal');
    const duplicateLoan = loans.createLoan(db, loanInput, 'test-owner', 'loan-create-001');
    equal(duplicateLoan.duplicate, true, 'identical loan creation retry is idempotent');
    throws(() => loans.createLoan(db, {...loanInput, principal_minor: 1100}, 'test-owner', 'loan-create-001'), 'idempotency_conflict', 'changed loan payload under same key is rejected');
    throws(() => loans.createLoan(db, {...loanInput, liability_account_id:'acct-payables'}, 'test-owner', 'loan-wrong-liability'), 'invalid_loan_liability_account', 'general accounts payable cannot be reused as the loan liability account');

    const receiptLines = journalLines(db, created.initial_journal_entry_id);
    equal(receiptLines.length, 2, 'loan receipt creates a two-line balanced journal');
    equal(receiptLines.find((line:any)=>line.account_id==='acct-bank')?.debit_minor, 1000, 'new loan debits actual destination bank');
    equal(receiptLines.find((line:any)=>line.account_id==='acct-loans-payable')?.credit_minor, 1000, 'new loan credits liability, not revenue');
    ok(!receiptLines.some((line:any)=>line.account_id==='acct-sales-revenue' || line.account_id==='acct-other-income'), 'loan proceeds are not posted as income');

    const batchesBeforeValidationCases = (db.prepare('SELECT COUNT(*) AS n FROM accounting_loan_installment_batches').get() as any).n;
    throws(() => loans.createLoanInstallments(db, created.id, {installments:[{
      due_date:'2026-10-12', principal_minor:-1, interest_minor:0, fees_minor:0, auto_register:false,
    }]}, 'test-owner', 'loan-negative-principal'), 'invalid_principal_minor', 'negative principal is rejected');
    throws(() => loans.createLoanInstallments(db, created.id, {installments:[{
      due_date:'2026-02-30', principal_minor:1, interest_minor:0, fees_minor:0, auto_register:false,
    }]}, 'test-owner', 'loan-invalid-calendar-date'), 'invalid_due_date', 'impossible calendar dates are rejected');
    throws(() => loans.createLoanInstallments(db, created.id, {installments:[
      {due_date:'2026-10-12', principal_minor:1, interest_minor:0, fees_minor:0, auto_register:false},
      {due_date:'2026-10-12', principal_minor:1, interest_minor:0, fees_minor:0, auto_register:false},
    ]}, 'test-owner', 'loan-duplicate-dates'), 'duplicate_installment_due_date', 'duplicate due dates within a batch are rejected');
    throws(() => loans.createLoanInstallments(db, created.id, {installments:Array.from({length:121}, (_, index) => ({
      due_date:'2027-01-01', principal_minor:1, interest_minor:0, fees_minor:0, auto_register:false,
    }))}, 'test-owner', 'loan-too-many-installments'), 'invalid_installments', 'a batch above 120 installments is rejected');
    db.prepare("UPDATE accounting_accounts SET is_active=0 WHERE id='acct-operating-expenses'").run();
    throws(() => loans.createLoanInstallments(db, created.id, {installments:[{
      due_date:'2026-10-12', principal_minor:1, interest_minor:1, fees_minor:0,
      interest_account_id:'acct-operating-expenses', auto_register:false,
    }]}, 'test-owner', 'loan-inactive-expense-account'), 'account_inactive', 'inactive expense accounts are rejected for installment accrual');
    db.prepare("UPDATE accounting_accounts SET is_active=1 WHERE id='acct-operating-expenses'").run();
    equal((db.prepare('SELECT COUNT(*) AS n FROM accounting_loan_installment_batches').get() as any).n, batchesBeforeValidationCases,
      'invalid batch requests do not create a partial batch');
    const batchesBeforeEarlyInstallment = (db.prepare('SELECT COUNT(*) AS n FROM accounting_loan_installment_batches').get() as any).n;
    throws(() => loans.createLoanInstallments(db, created.id, {installments:[{
      due_date:'2026-09-30', principal_minor:1, interest_minor:0, fees_minor:0, auto_register:false,
    }]}, 'test-owner', 'loan-installment-before-origination'), 'installment_before_loan_date',
      'an installment cannot be scheduled before the loan date');
    equal((db.prepare('SELECT COUNT(*) AS n FROM accounting_loan_installment_batches').get() as any).n, batchesBeforeEarlyInstallment,
      'rejected pre-origination installment leaves no schedule batch');

    const batch = loans.createLoanInstallments(db, created.id, {installments:[{
      due_date:'2026-10-10', principal_minor:400, interest_minor:50, fees_minor:10,
      interest_account_id:'acct-operating-expenses', fees_account_id:'acct-payment-fees', auto_register:true,
    }]}, 'test-owner', 'loan-installments-001');
    equal(batch.installments.length, 1, 'lender-provided repayment schedule creates one installment occurrence');
    const sameBatchRetry = loans.createLoanInstallments(db, created.id, {installments:[{
      due_date:'2026-10-10', principal_minor:400, interest_minor:50, fees_minor:10,
      interest_account_id:'acct-operating-expenses', fees_account_id:'acct-payment-fees', auto_register:true,
    }]}, 'test-owner', 'loan-installments-001');
    equal(sameBatchRetry.duplicate, true, 'identical group submission returns the original batch without adding installments');
    throws(() => loans.createLoanInstallments(db, created.id, {installments:[{
      due_date:'2026-10-10', principal_minor:401, interest_minor:50, fees_minor:10,
      interest_account_id:'acct-operating-expenses', fees_account_id:'acct-payment-fees', auto_register:true,
    }]}, 'test-owner', 'loan-installments-001'), 'idempotency_conflict', 'changed batch payload under the same key is rejected');
    const installment = batch.installments[0];
    const dueResult = loans.processDueLoanInstallments(db, '2026-10-22');
    equal(dueResult.checked, 1, 'due processor checks the overdue loan installment');
    equal(dueResult.registered, 1, 'automatic mode registers a due installment');
    const registered = db.prepare('SELECT status,due_journal_entry_id FROM accounting_loan_installments WHERE id=?').get(installment.id) as any;
    equal(registered.status, 'registered', 'due registration does not mark installment paid');
    ok(!!registered.due_journal_entry_id, 'interest/fee due registration links an accrual journal');
    equal(db.prepare("SELECT COUNT(*) AS n FROM accounting_journal_entries WHERE source_type='accounting_loan' AND source_id=? AND source_event='installment_settlement'").get(installment.id).n, 0, 'due registration creates no fake cash/payment journal');
    const dueLines = journalLines(db, registered.due_journal_entry_id);
    equal(dueLines.find((line:any)=>line.account_id==='acct-operating-expenses')?.debit_minor, 50, 'due registration recognizes the interest expense');
    equal(dueLines.find((line:any)=>line.account_id==='acct-payment-fees')?.debit_minor, 10, 'due registration recognizes the fee expense');
    equal(dueLines.find((line:any)=>line.account_id==='acct-loans-payable')?.credit_minor, 60, 'due registration accrues interest and fees as additional amount owed');
    ok(!dueLines.some((line:any)=>line.account_id==='acct-bank' || line.account_id==='acct-cash-drawer'), 'due accrual does not move cash or bank');
    const beforeSettlementReport = getAccountingManagementReport(db,{from:'2026-10-01',to:'2026-10-31'});
    equal(beforeSettlementReport.summary.posted_expenses_minor,0,'unpaid loan accrual is excluded from cash-basis paid expenses');
    equal(beforeSettlementReport.summary.loan_interest_fees_paid_minor,0,'unpaid interest and fees are not reported as paid');
    const journalsBeforeLoanForecast = (db.prepare('SELECT COUNT(*) AS n FROM accounting_journal_entries').get() as any).n;
    const forecastBeforeLoanSettlement = getAccountingForecast(db, {from:'2026-10-10',to:'2026-10-10'});
    equal(forecastBeforeLoanSettlement.summary.expected_outflows_minor,460,'registered installment predicts the full principal plus interest and fees cash outflow');
    equal(forecastBeforeLoanSettlement.summary.projected_expense_minor,0,'registered unpaid loan costs are not counted again as projected expenses');
    equal(forecastBeforeLoanSettlement.summary.recognized_unpaid_minor,60,'registered unpaid interest and fees are shown separately');
    equal(forecastBeforeLoanSettlement.summary.loan_principal_due_minor,400,'loan principal is separately identified in the forecast');
    equal(forecastBeforeLoanSettlement.projected_ending_liquid_balance_minor,540,'forecast ending balance subtracts the unpaid installment from received loan cash');
    ok(forecastBeforeLoanSettlement.events.some((event:any)=>event.source==='loan' && event.id===installment.id && event.principal_minor===400),
      'forecast exposes the matching loan installment event');
    equal((db.prepare('SELECT COUNT(*) AS n FROM accounting_journal_entries').get() as any).n, journalsBeforeLoanForecast,
      'reading the loan forecast creates no journal entries');

    throws(() => loans.settleLoanInstallment(db, installment.id, {settlement_date:'2026-10-09',settlement_account_id:'acct-bank'}, 'test-owner', 'loan-before-due'), 'settlement_before_due_date', 'actual loan payment cannot precede its due date');
    const journalsBeforeInactiveSettlement = (db.prepare('SELECT COUNT(*) AS n FROM accounting_journal_entries').get() as any).n;
    db.prepare("UPDATE accounting_accounts SET is_active=0 WHERE id='acct-bank'").run();
    throws(() => loans.settleLoanInstallment(db, installment.id, {settlement_date:'2026-10-22',settlement_account_id:'acct-bank'}, 'test-owner', 'loan-settlement-inactive-account'),
      'account_inactive', 'settlement cannot use an inactive bank account');
    equal((db.prepare('SELECT status FROM accounting_loan_installments WHERE id=?').get(installment.id) as any).status, 'registered',
      'failed settlement leaves the installment registered and unpaid');
    equal((db.prepare('SELECT COUNT(*) AS n FROM accounting_journal_entries').get() as any).n, journalsBeforeInactiveSettlement,
      'failed settlement creates no partial journal');
    db.prepare("UPDATE accounting_accounts SET is_active=1 WHERE id='acct-bank'").run();
    const settled = loans.settleLoanInstallment(db, installment.id, {
      settlement_date:'2026-10-22', settlement_account_id:'acct-bank',
    }, 'test-owner', 'loan-settle-001');
    equal(settled.status, 'settled', 'explicit settlement marks installment paid');
    equal(settled.remaining_principal_minor, 600, 'settled principal reduces outstanding loan principal');
    const paymentLines = journalLines(db, settled.settlement_journal_entry_id);
    equal(paymentLines.find((line:any)=>line.account_id==='acct-loans-payable')?.debit_minor, 460, 'payment clears principal plus accrued interest and fees from liability');
    equal(paymentLines.find((line:any)=>line.account_id==='acct-operating-expenses')?.debit_minor, undefined, 'settlement does not expense interest twice');
    equal(paymentLines.find((line:any)=>line.account_id==='acct-payment-fees')?.debit_minor, undefined, 'settlement does not expense fees twice');
    equal(paymentLines.find((line:any)=>line.account_id==='acct-bank')?.credit_minor, 460, 'actual settlement credits bank for principal, interest and fees');
    equal(paymentLines.reduce((sum:number,line:any)=>sum+line.debit_minor,0), 460, 'installment journal debits balance actual cash outflow');
    equal(paymentLines.reduce((sum:number,line:any)=>sum+line.credit_minor,0), 460, 'installment journal credits balance actual cash outflow');
    const afterSettlementReport = getAccountingManagementReport(db,{from:'2026-10-01',to:'2026-10-31'});
    equal(afterSettlementReport.summary.posted_expenses_minor,60,'paid loan interest and fees enter expense totals on settlement date');
    equal(afterSettlementReport.summary.loan_interest_fees_paid_minor,60,'report identifies paid loan costs as a subset of expenses');
    equal(afterSettlementReport.summary.tax_payments_expense_minor,0,'loan interest is not misclassified as tax paid');
    const settledLoanForecast = getAccountingForecast(db, {from:'2026-10-10',to:'2026-10-22'});
    equal(settledLoanForecast.summary.actual_outflows_minor,460,'actual loan settlement appears once in the forecast window as a real cash outflow');
    ok(settledLoanForecast.events.some((event:any)=>event.source==='ledger' && event.id===settled.settlement_journal_entry_id && event.actual_cash_out_minor===460),
      'settled loan installment is represented by its actual posted cash journal');
    equal(settledLoanForecast.events.some((event:any)=>event.source==='loan' && event.id===installment.id),false,
      'settled loan installment is excluded from future projection after its actual settlement');
    equal(settledLoanForecast.projected_ending_liquid_balance_minor,540,'settled loan installment is not double-counted against the projected ending balance');
    equal(loans.settleLoanInstallment(db, installment.id, {settlement_date:'2026-10-22',settlement_account_id:'acct-bank'}, 'test-owner', 'loan-settle-001').duplicate, true, 'identical settlement retry is idempotent');

    const retryBatch=loans.createLoanInstallments(db,created.id,{installments:[{
      due_date:'2026-10-12',principal_minor:100,interest_minor:5,fees_minor:0,
      interest_account_id:'acct-operating-expenses',auto_register:true,
    }]},'test-owner','loan-installments-retry-001');
    db.prepare("UPDATE accounting_accounts SET is_active=0 WHERE id='acct-operating-expenses'").run();
    const failedDue=loans.processDueLoanInstallments(db,'2026-10-22');
    equal(failedDue.failed,1,'automatic due accrual failure is surfaced instead of marked registered');
    const failedInstallment=db.prepare('SELECT * FROM accounting_loan_installments WHERE id=?').get(retryBatch.installments[0].id) as any;
    equal(failedInstallment.status,'failed','failed automatic accrual remains visible and retryable');
    equal(failedInstallment.last_error_code,'account_inactive','failed due registration stores the concrete accounting error');
    equal(failedInstallment.due_journal_entry_id,null,'failed due accrual leaves no partial journal link');
    equal(db.prepare("SELECT COUNT(*) AS n FROM accounting_journal_entries WHERE source_type='accounting_loan' AND source_id=? AND source_event='installment_due_registration'").get(failedInstallment.id).n,0,'failed due accrual rolls back its journal atomically');
    db.prepare("UPDATE accounting_accounts SET is_active=1 WHERE id='acct-operating-expenses'").run();
    const retriedDue=loans.registerLoanInstallment(db,failedInstallment.id,'test-owner','2026-10-22');
    equal(retriedDue.status,'registered','owner can retry a failed due accrual after fixing its account');
    ok(!!retriedDue.due_journal_entry_id,'successful retry links the due accrual journal');
    throws(() => loans.settleLoanInstallment(db, installment.id, {settlement_date:'2026-10-22',settlement_account_id:'acct-cash-drawer'}, 'test-owner', 'loan-settle-001'), 'idempotency_conflict', 'changed settlement payload under the same key conflicts');
    throws(() => loans.settleLoanInstallment(db, installment.id, {settlement_date:'2026-10-22',settlement_account_id:'acct-cash-drawer'}, 'test-owner', 'different-key'), 'installment_already_settled', 'settled installment cannot be paid twice');
    throws(() => db.prepare('UPDATE accounting_loan_installments SET settlement_payload_hash=? WHERE id=?').run('a'.repeat(64),installment.id), 'ACCOUNTING_LOAN_INSTALLMENT_', 'settled loan settlement payload is immutable');

    const constrainedLoan = loans.createLoan(db, {...loanInput, principal_minor:1000, reference_number:'LN-FAILED-SCHEDULE'}, 'test-owner', 'loan-failed-schedule-create');
    const failedPrincipalBatch = loans.createLoanInstallments(db, constrainedLoan.id, {installments:[{
      due_date:'2026-10-20', principal_minor:700, interest_minor:5, fees_minor:0,
      interest_account_id:'acct-operating-expenses', auto_register:true,
    }]}, 'test-owner', 'loan-failed-principal-batch');
    db.prepare("UPDATE accounting_accounts SET is_active=0 WHERE id='acct-operating-expenses'").run();
    const failedPrincipalPass = loans.processDueLoanInstallments(db, '2026-10-22');
    equal(failedPrincipalPass.failed,1,'failed auto-registration keeps an installment pending for review');
    const failedPrincipalId = failedPrincipalBatch.installments[0].id;
    equal((db.prepare('SELECT status FROM accounting_loan_installments WHERE id=?').get(failedPrincipalId) as any).status,'failed',
      'failed principal installment remains an outstanding scheduled obligation');
    throws(() => loans.createLoanInstallments(db, constrainedLoan.id, {installments:[{
      due_date:'2026-11-10', principal_minor:400, interest_minor:0, fees_minor:0, auto_register:false,
    }]}, 'test-owner', 'loan-overbook-after-failure'), 'principal_schedule_exceeds_balance',
      'failed installment principal still counts against remaining principal and blocks over-scheduling');
    db.prepare("UPDATE accounting_accounts SET is_active=1 WHERE id='acct-operating-expenses'").run();
    const recoveredFailedPrincipal = loans.registerLoanInstallment(db, failedPrincipalId, 'test-owner', '2026-10-22');
    equal(recoveredFailedPrincipal.status,'registered','failed principal installment can be retried once its account is repaired');

    throws(() => loans.createLoanInstallments(db, created.id, {installments:[{
      due_date:'2026-11-10', principal_minor:700, interest_minor:0, fees_minor:0, auto_register:false,
    }]}, 'test-owner', 'loan-installments-too-large'), 'principal_schedule_exceeds_balance', 'combined future principal cannot exceed remaining liability');

    const opening = loans.createLoan(db, {
      mode:'opening', lender:'Existing lender', loan_date:'2025-03-10', accounting_start_date:'2026-10-01',
      original_principal_minor:1000, remaining_principal_minor:700,
      liability_account_id:'acct-loans-payable', currency_code:'IRR',
    }, 'test-owner', 'loan-opening-001');
    equal(opening.remaining_principal_minor, 700, 'opening an existing loan uses remaining principal, not original principal');
    equal(opening.cash_account_id, null, 'opening balance has no cash account');
    equal(opening.accounting_start_date, '2026-10-01', 'opening loan records accounting start separately from origination');
    equal(opening.historical_principal_repaid_minor, 300, 'historical repayments equal original principal less opening balance');
    const openingEntryDate = (db.prepare('SELECT entry_date FROM accounting_journal_entries WHERE id=?').get(opening.initial_journal_entry_id) as any).entry_date;
    equal(openingEntryDate, '2026-10-01', 'opening journal is posted on accounting start date');
    const openingLines = journalLines(db, opening.initial_journal_entry_id);
    equal(openingLines.find((line:any)=>line.account_id==='acct-opening-balance-equity')?.debit_minor, 700, 'existing loan opening uses opening-equity offset');
    equal(openingLines.find((line:any)=>line.account_id==='acct-loans-payable')?.credit_minor, 700, 'existing loan opening credits only remaining liability');
    ok(!openingLines.some((line:any)=>line.account_id==='acct-bank' || line.account_id==='acct-cash-drawer'), 'existing loan opening does not invent cash received');
    const journalsBeforeOriginationBackfill = (db.prepare('SELECT COUNT(*) AS n FROM accounting_journal_entries').get() as any).n;
    // Simulate the pre-v117 row shape: the old schema has no recorded origination date.
    db.exec('DROP TRIGGER IF EXISTS accounting_loans_identity_guard');
    db.prepare('UPDATE accounting_loans SET origination_date=NULL WHERE id=?').run(opening.id);
    db.exec(`CREATE TRIGGER accounting_loans_identity_guard BEFORE UPDATE ON accounting_loans
      WHEN NEW.id<>OLD.id OR NEW.mode<>OLD.mode OR NEW.lender<>OLD.lender
        OR COALESCE(NEW.description,'')<>COALESCE(OLD.description,'')
        OR COALESCE(NEW.reference_number,'')<>COALESCE(OLD.reference_number,'')
        OR NEW.loan_date<>OLD.loan_date OR NEW.currency_code<>OLD.currency_code
        OR COALESCE(NEW.accounting_start_date,'')<>COALESCE(OLD.accounting_start_date,'')
        OR NEW.historical_principal_repaid_minor<>OLD.historical_principal_repaid_minor
        OR (OLD.mode='new' AND COALESCE(NEW.origination_date,'')<>COALESCE(OLD.origination_date,''))
        OR (OLD.mode='opening' AND OLD.origination_date IS NOT NULL AND COALESCE(NEW.origination_date,'')<>COALESCE(OLD.origination_date,''))
        OR (NEW.origination_date IS NOT NULL AND NEW.origination_date>NEW.accounting_start_date)
        OR NEW.original_principal_minor<>OLD.original_principal_minor
        OR NEW.initial_outstanding_minor<>OLD.initial_outstanding_minor
        OR NEW.liability_account_id<>OLD.liability_account_id
        OR COALESCE(NEW.cash_account_id,'')<>COALESCE(OLD.cash_account_id,'')
        OR NEW.idempotency_key<>OLD.idempotency_key OR NEW.payload_hash<>OLD.payload_hash
        OR COALESCE(NEW.created_by,'')<>COALESCE(OLD.created_by,'')
        OR (OLD.initial_journal_entry_id IS NOT NULL AND NEW.initial_journal_entry_id<>OLD.initial_journal_entry_id)
      BEGIN SELECT RAISE(ABORT,'ACCOUNTING_LOAN_IDENTITY_IMMUTABLE'); END;`);
    const correctedOrigin = loans.updateLoanOriginationDate(db, opening.id, '2025-03-11', 'test-owner');
    equal(correctedOrigin.origination_date, '2025-03-11', 'legacy loan accepts the actual origination date');
    equal(correctedOrigin.accounting_start_date, '2026-10-01', 'origination entry leaves accounting start unchanged');
    equal((db.prepare('SELECT entry_date FROM accounting_journal_entries WHERE id=?').get(opening.initial_journal_entry_id) as any).entry_date, '2026-10-01', 'historical date correction does not backdate the opening journal');
    equal((db.prepare('SELECT COUNT(*) AS n FROM accounting_journal_entries').get() as any).n, journalsBeforeOriginationBackfill, 'date correction creates no journal or cash flow');
    equal((db.prepare("SELECT COUNT(*) AS n FROM accounting_audit_log WHERE entity_type='accounting_loan' AND entity_id=? AND action='origination_date_recorded'").get(opening.id) as any).n, 1, 'origination-date correction is audited');
    throws(() => loans.updateLoanOriginationDate(db, opening.id, '2026-10-02', 'test-owner'), 'loan_origination_after_accounting_start', 'origination cannot follow accounting start');
    throws(() => loans.createLoan(db, {mode:'opening', lender:'bad history', loan_date:'2025-01-01', accounting_start_date:'2026-10-01', original_principal_minor:1000, remaining_principal_minor:700, historical_principal_repaid_minor:200, liability_account_id:'acct-loans-payable', currency_code:'IRR'}, 'test-owner', 'loan-opening-bad-history'), 'invalid_historical_principal_repaid', 'historical repayments cannot contradict original and remaining principal');
    throws(() => loans.createLoanInstallments(db, opening.id, {installments:[{due_date:'2026-09-30',principal_minor:1,interest_minor:0,fees_minor:0,auto_register:false}]}, 'test-owner', 'loan-opening-before-accounting-start'), 'installment_before_loan_date', 'installments cannot predate accounting start');

    const schedule = loans.createLoanInstallments(db, opening.id, {installments:[
      {due_date:'2026-12-01',principal_minor:600,interest_minor:0,fees_minor:0,auto_register:false},
      {due_date:'2026-10-15',principal_minor:100,interest_minor:0,fees_minor:0,auto_register:false},
    ]}, 'test-owner', 'loan-installments-002');
    const future = schedule.installments.find((item:any)=>item.due_date==='2026-12-01');
    const manual = schedule.installments.find((item:any)=>item.due_date==='2026-10-15');
    const manualDue = loans.processDueLoanInstallments(db, '2026-11-01');
    equal(manualDue.checked, 1, 'due processor catches up overdue manual-mode loan installment');
    equal(manualDue.awaitingConfirmation, 1, 'manual mode waits for authorized due registration');
    equal(db.prepare('SELECT status FROM accounting_loan_installments WHERE id=?').get(manual.id).status,'awaiting_confirmation','manual due remains unpaid and awaits registration');
    throws(() => loans.registerLoanInstallment(db, future.id, 'test-owner', '2026-11-01'), 'installment_not_due', 'manual due registration rejects early dates');
    const manuallyRegistered = loans.registerLoanInstallment(db,manual.id,'test-owner','2026-11-01');
    equal(manuallyRegistered.status,'registered','owner can register a due installment manually');
    throws(() => loans.settleLoanInstallment(db, manual.id, {settlement_date:'2026-09-30',settlement_account_id:'acct-bank'}, 'test-owner', 'loan-opening-payment-before-start'),
      'settlement_before_loan_date', 'existing loan settlement cannot precede the accounting opening date');
    const cancelled = loans.cancelLoanInstallment(db, future.id, 'Schedule corrected', 'test-owner');
    equal(cancelled.status, 'cancelled', 'unregistered installment can be cancelled with a reason');
    throws(() => loans.cancelLoanInstallment(db, installment.id, 'too late', 'test-owner'), 'installment_not_cancellable', 'settled installment cannot be cancelled');

    const closedPeriodLoan = loans.createLoan(db, {
      mode:'new', lender:'Closed-period test lender', loan_date:'2018-12-01', principal_minor:1000,
      liability_account_id:'acct-loans-payable', cash_account_id:'acct-bank', currency_code:'IRR',
    }, 'test-owner', 'loan-closed-period-create');
    const closedPeriod = closeAccountingPeriod(db, {
      period_start:'2019-01-01', period_end:'2019-01-01', reason:'Regression: closed-period principal-only installment registration',
    }, 'test-owner');
    equal(closedPeriod.status,'closed','regression setup closes the period containing the principal-only due date');
    const closedPeriodBatch = loans.createLoanInstallments(db, closedPeriodLoan.id, {installments:[{
      due_date:'2019-01-01', principal_minor:500, interest_minor:0, fees_minor:0, auto_register:false,
    }]}, 'test-owner', 'loan-closed-period-installment');
    throws(() => loans.registerLoanInstallment(db, closedPeriodBatch.installments[0].id, 'test-owner', '2019-01-01'),
      'period_closed','principal-only due registration cannot bypass the closed-period guard just because it creates no accrual journal');
    equal((db.prepare('SELECT status FROM accounting_loan_installments WHERE id=?').get(closedPeriodBatch.installments[0].id) as any).status,'scheduled',
      'closed-period registration rejection leaves the installment unchanged');
    equal((db.prepare('SELECT due_journal_entry_id FROM accounting_loan_installments WHERE id=?').get(closedPeriodBatch.installments[0].id) as any).due_journal_entry_id,null,
      'closed-period principal-only rejection creates no due journal');

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

function migrationUpgradeChecks(): void {
  const priorDir = activeTestDir;
  activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-accounting-loan-v116-upgrade-'));
  try {
    closeDatabase();
    MIGRATIONS.length = 0;
    MIGRATIONS.push(...originalMigrations.filter((migration: any) => migration.version <= 116));
    initDatabase();
    const legacyDb = getDatabase();
    equal(getCurrentSchemaVersion(), 116, 'legacy-loan upgrade fixture starts at schema v116');
    legacyDb.prepare(`
      INSERT INTO accounting_loans
        (id,mode,status,lender,loan_date,currency_code,original_principal_minor,initial_outstanding_minor,
         liability_account_id,cash_account_id,initial_journal_entry_id,idempotency_key,payload_hash,created_by)
      VALUES ('legacy-v116-loan','opening','active','Legacy lender','2026-10-01','IRR',1000,700,
        'acct-loans-payable',NULL,NULL,'legacy-v116-loan-key',?, 'test-owner')
    `).run('a'.repeat(64));
    const entriesBefore = (legacyDb.prepare('SELECT COUNT(*) AS n FROM accounting_journal_entries').get() as any).n;
    closeDatabase();

    MIGRATIONS.length = 0;
    MIGRATIONS.push(...originalMigrations);
    initDatabase();
    const upgradedDb = getDatabase();
    equal(getCurrentSchemaVersion(), 117, 'legacy-loan fixture upgrades to schema v117');
    const upgradedLoan = upgradedDb.prepare(`
      SELECT origination_date,accounting_start_date,historical_principal_repaid_minor,cash_account_id
      FROM accounting_loans WHERE id='legacy-v116-loan'
    `).get() as any;
    equal(upgradedLoan.origination_date, null, 'migration does not guess the actual origination date of a legacy opening loan');
    equal(upgradedLoan.accounting_start_date, '2026-10-01', 'migration preserves legacy opening date as accounting start');
    equal(upgradedLoan.historical_principal_repaid_minor, 300, 'migration calculates historical principal repayments from known amounts');
    equal(upgradedLoan.cash_account_id, null, 'migration does not invent a cash account for an existing loan');
    equal((upgradedDb.prepare('SELECT COUNT(*) AS n FROM accounting_journal_entries').get() as any).n, entriesBefore,
      'v116-to-v117 migration posts no artificial cash or journal entry');
    ok(!!upgradedDb.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='accounting_loans_opening_fields_insert_guard'").get(),
      'v117 migration reinstates loan opening-field integrity guard');
    equal((upgradedDb.pragma('integrity_check') as any[])[0].integrity_check, 'ok', 'v116-to-v117 loan migration preserves SQLite integrity');
    console.log('✓ legacy loan migration tests passed');
  } finally {
    try { closeDatabase(); } catch {}
    MIGRATIONS.length = 0;
    MIGRATIONS.push(...originalMigrations);
    fs.rmSync(activeTestDir, { recursive: true, force: true });
    activeTestDir = priorDir;
  }
}

main();
migrationUpgradeChecks();
