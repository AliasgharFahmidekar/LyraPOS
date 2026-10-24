import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { resolveTenantCurrency } from '../countries';
import { createDraftJournalEntry, postJournalEntry } from './ledger';
import { isLiquidAccountSystemKey } from './chart-of-accounts';
import { accountingDate } from './sales';

type DB = Database.Database;
type LoanMode = 'new' | 'opening';

export class AccountingLoanError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400) {
    super(message);
    this.name = 'AccountingLoanError';
  }
}
function fail(code: string, message: string, statusCode = 400): never {
  throw new AccountingLoanError(code, message, statusCode);
}
function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') fail('invalid_' + field, field + ' must be text.');
  const result = value.trim();
  if (!result || result.length > max) fail('invalid_' + field, field + ' must be between 1 and ' + max + ' characters.');
  return result;
}
function optionalText(value: unknown, field: string, max: number): string | null {
  if (value == null || value === '') return null;
  return text(value, field, max);
}
function date(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('invalid_' + field, field + ' must use YYYY-MM-DD.');
  const parsed = new Date(value + 'T00:00:00.000Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail('invalid_' + field, field + ' must be a real calendar date.');
  return value;
}
function currency(db: DB): string {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key IN ('country','currency')").all() as {key:string;value:string|null}[];
  const settings = Object.fromEntries(rows.map(r => [r.key, r.value ?? '']));
  try { return resolveTenantCurrency(settings.currency, settings.country); }
  catch { fail('accounting_currency_not_configured', 'Configure store country and currency before recording a loan.', 409); }
}
function account(db: DB, idInput: unknown, types: string[], field: string): any {
  const id = text(idInput, field, 100);
  const row = db.prepare('SELECT id, account_type, system_key, normal_balance, is_active, is_postable FROM accounting_accounts WHERE id=?').get(id) as any;
  if (!row) fail('account_not_found', 'Selected accounting account was not found.', 404);
  if (row.is_active !== 1) fail('account_inactive', 'Choose an active accounting account.', 409);
  if (row.is_postable !== 1) fail('account_not_postable', 'Choose a postable accounting account.', 409);
  if (!types.includes(row.account_type)) fail('invalid_account_type', field + ' requires account type ' + types.join(' or ') + '.');
  const normal = row.account_type === 'asset' || row.account_type === 'expense' ? 'debit'
    : row.account_type === 'liability' || row.account_type === 'equity' || row.account_type === 'revenue' ? 'credit' : null;
  if (normal && row.normal_balance !== normal) fail('invalid_account_normal_balance', 'Selected account has an incompatible normal balance.');
  return row;
}
function liquid(db: DB, idInput: unknown): any {
  const row = account(db, idInput, ['asset'], 'cash_account_id');
  if (!isLiquidAccountSystemKey(row.system_key)) {
    fail('invalid_cash_account', 'Loan proceeds and repayments must use a cash, bank, or payment-clearing account.');
  }
  return row;
}
function key(value: unknown): string { return text(value, 'idempotency_key', 200); }
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function actor(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function post(db: DB, input: {entryDate:string;description:string;currencyCode:string;lines:{accountId:string;debitMinor:number;creditMinor:number;description:string}[];actorId:string|null;sourceId:string;sourceEvent:string;idempotencyKey:string}): any {
  const draft = createDraftJournalEntry(db, {
    entryDate: input.entryDate, description: input.description, currencyCode: input.currencyCode, lines: input.lines,
    createdBy: input.actorId, sourceType: 'accounting_loan', sourceId: input.sourceId, sourceEvent: input.sourceEvent,
    idempotencyKey: input.idempotencyKey,
  });
  const posted = postJournalEntry(db, draft.id, input.actorId ?? 'system');
  if (posted.status !== 'posted') fail('loan_journal_not_posted', 'Loan journal did not reach posted status.', 409);
  return posted;
}
function loanRow(db: DB, idInput: unknown): any {
  const id = text(idInput, 'loan_id', 100);
  const row = db.prepare('SELECT * FROM accounting_loans WHERE id=?').get(id) as any;
  if (!row) fail('loan_not_found', 'Loan was not found.', 404);
  return row;
}
function outstanding(db: DB, loan: any): number {
  const paid = db.prepare("SELECT COALESCE(SUM(principal_minor),0) AS total FROM accounting_loan_installments WHERE loan_id=? AND status='settled'").get(loan.id) as {total:number};
  return Number(loan.initial_outstanding_minor) - Number(paid.total);
}
export function createLoan(db: DB, input: any, actorId: string | null, idempotencyInput: unknown): any {
  const mode = input?.mode;
  if (mode !== 'new' && mode !== 'opening') fail('invalid_loan_mode', 'Loan mode must be new or opening.');
  const lender = text(input?.lender, 'lender', 200);
  const description = optionalText(input?.description, 'description', 500);
  const reference = optionalText(input?.reference_number, 'reference_number', 160);
  const loanDate = date(input?.loan_date, 'loan_date');
  const accountingStartDate = mode === 'opening' ? date(input?.accounting_start_date ?? loanDate, 'accounting_start_date') : loanDate;
  const currentBusinessDate = accountingDate(db, new Date().toISOString());
  if (loanDate > currentBusinessDate) fail('loan_date_in_future', 'Loan origination date cannot be in the future.', 400);
  if (accountingStartDate > currentBusinessDate) fail('accounting_start_date_in_future', 'Accounting opening date cannot be in the future.', 400);
  if (accountingStartDate < loanDate) fail('opening_date_before_origination', 'The accounting opening date cannot precede the actual loan origination date.', 400);
  const currencyCode = currency(db);
  if (input?.currency_code !== undefined && String(input.currency_code).trim().toUpperCase() !== currencyCode) fail('currency_mismatch', 'Loan must use the configured store currency.', 409);
  const liability = account(db, input?.liability_account_id, ['liability'], 'liability_account_id');
  if (liability.system_key && liability.system_key !== 'loans_payable') fail('invalid_loan_liability_account','Use the dedicated Loans payable account or a custom liability account, not general payables or customer advances.');
  const rawRemaining = mode === 'new' ? undefined : input?.remaining_principal_minor;
  const rawOriginal = input?.original_principal_minor === undefined || input?.original_principal_minor === null || input?.original_principal_minor === ''
    ? (mode === 'opening' ? rawRemaining : input?.principal_minor)
    : input.original_principal_minor;
  const initialOutstanding = mode === 'new' ? rawOriginal : rawRemaining;
  if (!Number.isSafeInteger(initialOutstanding) || initialOutstanding <= 0) {
    fail('invalid_remaining_principal', 'Remaining principal must be a positive integer in accounting currency units.');
  }
  const original = rawOriginal;
  if (!Number.isSafeInteger(original) || original <= 0 || initialOutstanding > original) {
    fail('invalid_original_principal', 'Original principal must be positive and at least the remaining principal.');
  }
  const rawHistorical = mode === 'opening'
    ? (input?.historical_principal_repaid_minor === undefined || input?.historical_principal_repaid_minor === null || input?.historical_principal_repaid_minor === ''
      ? original - initialOutstanding : input.historical_principal_repaid_minor)
    : 0;
  if (!Number.isSafeInteger(rawHistorical) || rawHistorical < 0 || rawHistorical !== original - initialOutstanding) {
    fail('invalid_historical_principal_repaid', 'Historical principal repaid must equal original principal minus the opening outstanding principal.');
  }
  const historicalPrincipalRepaid = rawHistorical;
  const cash = mode === 'new' ? liquid(db, input?.cash_account_id) : null;
  if (mode === 'opening' && input?.cash_account_id != null && input.cash_account_id !== '') {
    fail('opening_loan_cash_forbidden', 'An existing loan opening balance must not create a new cash/bank movement.');
  }
  const idempotencyKey = key(idempotencyInput);
  const payload = {mode,lender,description,reference,loanDate,accountingStartDate,currencyCode,original,initialOutstanding,historicalPrincipalRepaid,liabilityAccountId:liability.id,cashAccountId:cash?.id ?? null};
  const payloadHash = hash(payload);
  return db.transaction(() => {
    const old = db.prepare('SELECT * FROM accounting_loans WHERE idempotency_key=?').get(idempotencyKey) as any;
    if (old) {
      if (old.payload_hash !== payloadHash) fail('idempotency_conflict', 'Idempotency key was reused with different loan data.', 409);
      return {...old,duplicate:true,remaining_principal_minor:outstanding(db,old)};
    }
    const id = randomUUID();
    db.prepare(`INSERT INTO accounting_loans
      (id,mode,lender,description,reference_number,loan_date,origination_date,accounting_start_date,currency_code,
       original_principal_minor,initial_outstanding_minor,historical_principal_repaid_minor,
       liability_account_id,cash_account_id,idempotency_key,payload_hash,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id,mode,lender,description,reference,loanDate,loanDate,accountingStartDate,currencyCode,
        original,initialOutstanding,historicalPrincipalRepaid,liability.id,cash?.id ?? null,idempotencyKey,payloadHash,actor(actorId));
    const offset = mode === 'new' ? cash!.id : 'acct-opening-balance-equity';
    const lines = mode === 'new'
      ? [{accountId:offset,debitMinor:initialOutstanding,creditMinor:0,description:'Loan proceeds received'},{accountId:liability.id,debitMinor:0,creditMinor:initialOutstanding,description:'Loan principal liability'}]
      : [{accountId:offset,debitMinor:initialOutstanding,creditMinor:0,description:'Opening balance offset; no new cash received'},{accountId:liability.id,debitMinor:0,creditMinor:initialOutstanding,description:'Existing outstanding loan principal'}];
    const journal = post(db,{entryDate:accountingStartDate,description:(mode==='new'?'Loan received: ':'Opening loan balance: ')+lender,currencyCode,lines,actorId,sourceId:id,sourceEvent:mode==='new'?'loan_received':'loan_opening_balance',idempotencyKey:'loan:'+id+':'+mode});
    db.prepare('UPDATE accounting_loans SET initial_journal_entry_id=? WHERE id=?').run(journal.id,id);
    return {...loanRow(db,id),duplicate:false,remaining_principal_minor:initialOutstanding,entry_number:journal.entryNumber};
  })();
}
export function listLoans(db: DB, filters: any = {}): any[] {
  const status = filters?.status == null || filters.status === '' ? null : String(filters.status);
  if (status && !['active','closed'].includes(status)) fail('invalid_status','Unknown loan status.');
  const rows = db.prepare(`SELECT l.*, a.account_code AS liability_account_code, a.name AS liability_account_name,
    cash.account_code AS cash_account_code, cash.name AS cash_account_name, j.entry_number AS initial_entry_number
    FROM accounting_loans l JOIN accounting_accounts a ON a.id=l.liability_account_id
    LEFT JOIN accounting_accounts cash ON cash.id=l.cash_account_id
    LEFT JOIN accounting_journal_entries j ON j.id=l.initial_journal_entry_id
    WHERE (? IS NULL OR l.status=?) ORDER BY COALESCE(l.accounting_start_date,l.loan_date),l.created_at,l.id`).all(status,status) as any[];
  return rows.map(loan => {
    const remaining = outstanding(db,loan);
    const installments = db.prepare(`SELECT i.*, due.entry_number AS due_entry_number, settlement.entry_number AS settlement_entry_number FROM accounting_loan_installments i
      LEFT JOIN accounting_journal_entries due ON due.id=i.due_journal_entry_id
      LEFT JOIN accounting_journal_entries settlement ON settlement.id=i.settlement_journal_entry_id
      WHERE i.loan_id=? ORDER BY i.due_date,i.created_at,i.id`).all(loan.id) as any[];
    const pending = db.prepare("SELECT COUNT(*) AS count FROM accounting_loan_installments WHERE loan_id=? AND status IN ('scheduled','awaiting_confirmation','registered','failed')").get(loan.id) as {count:number};
    return {...loan,remaining_principal_minor:remaining,principal_repaid_minor:Number(loan.initial_outstanding_minor)-remaining,
      historical_principal_repaid_minor:Number(loan.historical_principal_repaid_minor ?? 0),
      status:remaining===0 && Number(pending.count)===0?'closed':loan.status,installments};
  });
}
export function updateLoanOriginationDate(db: DB, loanIdInput: unknown, originationDateInput: unknown, actorId: string | null): any {
  const originationDate = date(originationDateInput, 'origination_date');
  return db.transaction(() => {
    const loan = loanRow(db, loanIdInput);
    if (loan.mode !== 'opening') fail('loan_origination_not_editable', 'Only existing opening-balance loans can have their historical origination date recorded.', 409);
    const accountingStartDate = loan.accounting_start_date ?? loan.loan_date;
    if (originationDate > accountingStartDate) fail('loan_origination_after_accounting_start', 'The original loan date cannot follow the accounting opening date.', 400);
    if (loan.origination_date === originationDate) return {...loan, duplicate: true};
    if (loan.origination_date) fail('loan_origination_already_recorded', 'The historical origination date has already been recorded.', 409);
    db.prepare('UPDATE accounting_loans SET origination_date=? WHERE id=?').run(originationDate, loan.id);
    db.prepare(`INSERT INTO accounting_audit_log (entity_type,entity_id,action,actor_user_id,before_json,after_json)
      VALUES ('accounting_loan',?,?, ?, ?, ?)`)
      .run(loan.id, 'origination_date_recorded', actor(actorId),
        JSON.stringify({origination_date: null}),
        JSON.stringify({origination_date: originationDate, accounting_start_date: accountingStartDate}));
    return {...loanRow(db, loan.id), duplicate: false};
  })();
}

export function createLoanInstallments(db: DB, loanIdInput: unknown, input: any, actorId: string | null, idempotencyInput: unknown): any {
  const loan = loanRow(db,loanIdInput);
  if (!Array.isArray(input?.installments) || input.installments.length<1 || input.installments.length>120) fail('invalid_installments','Provide between 1 and 120 instalments.');
  const idempotencyKey=key(idempotencyInput);
  const normalized: Array<{dueDate:string;principal:number;interest:number;fees:number;interestAccountId:string|null;feesAccountId:string|null;auto:boolean;index:number}> = input.installments.map((item:any,index:number)=>{
    const dueDate=date(item?.due_date,'due_date');
    if (dueDate < (loan.accounting_start_date ?? loan.loan_date)) fail('installment_before_loan_date','An installment due date cannot precede the accounting start date.');
    const principal=item?.principal_minor, interest=item?.interest_minor ?? 0, fees=item?.fees_minor ?? 0;
    for(const [field,value] of [['principal_minor',principal],['interest_minor',interest],['fees_minor',fees]] as [string,any][]) {
      if(!Number.isSafeInteger(value)||value<0) fail('invalid_'+field,field+' must be a non-negative integer.');
    }
    if(principal+interest+fees<=0 || !Number.isSafeInteger(principal+interest+fees)) fail('invalid_installment_amount','Each instalment must have a positive total amount.');
    const interestAccount=interest>0?account(db,item?.interest_account_id,['expense'],'interest_account_id'):null;
    const feesAccount=fees>0?account(db,item?.fees_account_id,['expense'],'fees_account_id'):null;
    const auto=item?.auto_register===undefined?false:item.auto_register;
    if(typeof auto!=='boolean') fail('invalid_auto_register','auto_register must be true or false.');
    return {dueDate,principal,interest,fees,interestAccountId:interestAccount?.id??null,feesAccountId:feesAccount?.id??null,auto,index};
  });
  if(new Set(normalized.map(i=>i.dueDate)).size!==normalized.length) fail('duplicate_installment_due_date','Installment due dates must be unique within a schedule.');
  const principalTotal=normalized.reduce((sum,i)=>sum+i.principal,0);
  const payloadHash=hash({loanId:loan.id,installments:normalized.map(({index,...i})=>i)});
  return db.transaction(()=>{
    const old=db.prepare('SELECT * FROM accounting_loan_installment_batches WHERE idempotency_key=?').get(idempotencyKey) as any;
    if(old) {
      if(old.payload_hash!==payloadHash) fail('idempotency_conflict','Idempotency key was reused with different instalment data.',409);
      const rows=db.prepare('SELECT * FROM accounting_loan_installments WHERE batch_id=? ORDER BY due_date').all(old.id);
      return {batch:old,installments:rows,duplicate:true};
    }
    const currentLoan = loanRow(db,loan.id);
    if (currentLoan.status !== 'active') fail('loan_not_active','Cannot add instalments to a closed loan.',409);
    // Failed auto-registration is still an outstanding contractual installment until it is retried or cancelled.
    const alreadyScheduled = db.prepare("SELECT COALESCE(SUM(principal_minor),0) AS total FROM accounting_loan_installments WHERE loan_id=? AND status IN ('scheduled','awaiting_confirmation','registered','failed')").get(currentLoan.id) as {total:number};
    if(!Number.isSafeInteger(principalTotal) || principalTotal + Number(alreadyScheduled.total) > outstanding(db,currentLoan)) fail('principal_schedule_exceeds_balance','Combined scheduled principal exceeds the loan remaining principal.',409);
    const batchId=randomUUID();
    db.prepare('INSERT INTO accounting_loan_installment_batches (id,loan_id,idempotency_key,payload_hash,created_by) VALUES (?,?,?,?,?)')
      .run(batchId,loan.id,idempotencyKey,payloadHash,actor(actorId));
    const insert=db.prepare(`INSERT INTO accounting_loan_installments
      (id,batch_id,loan_id,due_date,principal_minor,interest_minor,fees_minor,interest_account_id,fees_account_id,auto_register,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    const created=[];
    for(const item of normalized) {
      const id=randomUUID();
      insert.run(id,batchId,loan.id,item.dueDate,item.principal,item.interest,item.fees,item.interestAccountId,item.feesAccountId,item.auto?1:0,actor(actorId));
      created.push(db.prepare('SELECT * FROM accounting_loan_installments WHERE id=?').get(id));
    }
    return {batch:{id:batchId,loan_id:loan.id,idempotency_key:idempotencyKey},installments:created,duplicate:false};
  })();
}
export function registerLoanInstallment(db: DB, installmentIdInput: unknown, actorId: string | null, asOfInput?: unknown): any {
  const id=text(installmentIdInput,'installment_id',100);
  const asOf=asOfInput===undefined?accountingDate(db,new Date().toISOString()):date(asOfInput,'as_of_date');
  return db.transaction(()=>{
    const item=db.prepare('SELECT * FROM accounting_loan_installments WHERE id=?').get(id) as any;
    if(!item) fail('installment_not_found','Loan instalment was not found.',404);
    if(['registered','settled'].includes(item.status)) return {...item,duplicate:true};
    if(item.status==='cancelled') fail('installment_cancelled','Cancelled instalment cannot be registered.',409);
    if(item.due_date>asOf) fail('installment_not_due','Instalment cannot be registered before its due date.',409);
    const loan=loanRow(db,item.loan_id);
    if (item.due_date < (loan.accounting_start_date ?? loan.loan_date)) fail('installment_before_loan_date','An installment due date cannot precede the accounting start date.',409);
    const closedPeriod = db.prepare("SELECT 1 FROM accounting_period_closures WHERE status='closed' AND ? BETWEEN period_start AND period_end LIMIT 1").get(item.due_date);
    if (closedPeriod) fail('period_closed','Accounting period is closed; reopen it with a reason before registering the installment due event.',409);
    const dueLines:any[]=[];
    if(item.interest_minor>0) {
      account(db,item.interest_account_id,['expense'],'interest_account_id');
      dueLines.push({accountId:item.interest_account_id,debitMinor:item.interest_minor,creditMinor:0,description:'Loan interest accrued at installment due date'});
    }
    if(item.fees_minor>0) {
      account(db,item.fees_account_id,['expense'],'fees_account_id');
      dueLines.push({accountId:item.fees_account_id,debitMinor:item.fees_minor,creditMinor:0,description:'Loan fees accrued at installment due date'});
    }
    let dueJournal:any=null;
    const accrued=Number(item.interest_minor)+Number(item.fees_minor);
    if(!Number.isSafeInteger(accrued)) fail('invalid_installment_amount','Interest and fee total is invalid.');
    if(accrued>0) {
      dueLines.push({accountId:loan.liability_account_id,debitMinor:0,creditMinor:accrued,description:'Interest/fees added to amount owed; no cash movement'});
      dueJournal=post(db,{entryDate:item.due_date,description:'Loan installment due accrual: '+loan.lender,currencyCode:loan.currency_code,
        lines:dueLines,actorId,sourceId:id,sourceEvent:'installment_due_registration',idempotencyKey:'loan-installment:'+id+':due-registration'});
    }
    db.prepare("UPDATE accounting_loan_installments SET status='registered',registered_at=CURRENT_TIMESTAMP,registered_by=?,due_journal_entry_id=?,last_error_code=NULL,last_error_message=NULL WHERE id=?")
      .run(actor(actorId),dueJournal?.id??null,id);
    const updated = db.prepare('SELECT * FROM accounting_loan_installments WHERE id=?').get(id) as Record<string, unknown> | undefined;
    if (!updated) fail('installment_not_found','Loan instalment disappeared during registration.',500);
    return {...updated,duplicate:false,due_entry_number:dueJournal?.entryNumber??null};
  })();
}
export function processDueLoanInstallments(db: DB, asOfInput?: unknown): {checked:number;registered:number;awaitingConfirmation:number;failed:number} {
  const asOf=asOfInput===undefined?accountingDate(db,new Date().toISOString()):date(asOfInput,'as_of_date');
  const due=db.prepare("SELECT id,auto_register,status FROM accounting_loan_installments WHERE due_date<=? AND status='scheduled' ORDER BY due_date,created_at,id").all(asOf) as any[];
  let registered=0,awaitingConfirmation=0,failed=0;
  for(const item of due) {
    if(item.auto_register===1) {
      try {
        const result=registerLoanInstallment(db,item.id,'system',asOf);
        if(!result.duplicate) registered++;
      } catch(error:any) {
        const code=typeof error?.code==='string'&&error.code.trim()?String(error.code).slice(0,100):'loan_installment_registration_failed';
        const message=String(error?.message||'Loan installment due registration failed.').slice(0,500);
        try {
          db.prepare("UPDATE accounting_loan_installments SET status='failed',last_error_code=?,last_error_message=? WHERE id=? AND status='scheduled'")
            .run(code,message,item.id);
        } catch { /* preserve the original posting failure; the row remains visible for review */ }
        failed++;
      }
      continue;
    }
    if(item.status==='scheduled') {
      const changed=db.prepare("UPDATE accounting_loan_installments SET status='awaiting_confirmation' WHERE id=? AND status='scheduled'")
        .run(item.id);
      if(changed.changes) awaitingConfirmation++;
    }
  }
  return {checked:due.length,registered,awaitingConfirmation,failed};
}
export function settleLoanInstallment(db: DB, installmentIdInput: unknown, input: any, actorId: string | null, idempotencyInput: unknown): any {
  const id=text(installmentIdInput,'installment_id',100);
  const settlementDate=date(input?.settlement_date,'settlement_date');
  const businessDate=accountingDate(db,new Date().toISOString());
  if(settlementDate>businessDate) fail('settlement_in_future','Actual loan payment date cannot be in the future.');
  const settlementAccountId=text(input?.settlement_account_id,'settlement_account_id',100);
  const idempotencyKey=key(idempotencyInput);
  return db.transaction(()=>{
    const item=db.prepare('SELECT * FROM accounting_loan_installments WHERE id=?').get(id) as any;
    if(!item) fail('installment_not_found','Loan instalment was not found.',404);
    if(item.status==='cancelled') fail('installment_cancelled','Cancelled instalment cannot be settled.',409);
    const settlementPayloadHash=hash({installmentId:id,settlementDate,settlementAccountId,principalMinor:item.principal_minor,interestMinor:item.interest_minor,feesMinor:item.fees_minor});
    if(item.status==='settled') {
      if(item.settlement_idempotency_key===idempotencyKey) {
        if(item.settlement_payload_hash!==settlementPayloadHash) fail('idempotency_conflict','Settlement idempotency key was reused with different payment details.',409);
        return {...item,duplicate:true};
      }
      fail('installment_already_settled','Instalment is already settled.',409);
    }
    if(item.status!=='registered') fail('installment_not_registered','Register the due installment before confirming its actual payment.',409);
    const cash=liquid(db,settlementAccountId);
    const loan=loanRow(db,item.loan_id);
    if(settlementDate<loan.loan_date) fail('settlement_before_loan_date','Settlement date cannot precede the loan date.');
    if(settlementDate<item.due_date) fail('settlement_before_due_date','Settlement date cannot precede the installment due date.');
    if(item.principal_minor>outstanding(db,loan)) fail('principal_schedule_exceeds_balance','Principal payment exceeds current outstanding principal.',409);
    const total=Number(item.principal_minor)+Number(item.interest_minor)+Number(item.fees_minor);
    if(!Number.isSafeInteger(total)||total<=0) fail('invalid_installment_amount','Instalment total is invalid.');
    const liabilityReduction=Number(item.principal_minor)+Number(item.interest_minor)+Number(item.fees_minor);
    if(!Number.isSafeInteger(liabilityReduction)||liabilityReduction<=0) fail('invalid_installment_amount','Liability reduction is invalid.');
    const lines:any[]=[
      {accountId:loan.liability_account_id,debitMinor:liabilityReduction,creditMinor:0,description:'Loan amount owed reduced by principal, accrued interest and fees'},
      {accountId:cash.id,debitMinor:0,creditMinor:total,description:'Actual loan instalment payment'},
    ];
    const journal=post(db,{entryDate:settlementDate,description:'Loan instalment payment: '+loan.lender,currencyCode:loan.currency_code,lines,actorId,sourceId:id,sourceEvent:'installment_settlement',idempotencyKey:'loan-installment:'+id+':settlement'});
    db.prepare("UPDATE accounting_loan_installments SET status='settled',settlement_date=?,settlement_account_id=?,settlement_journal_entry_id=?,settled_at=CURRENT_TIMESTAMP,settled_by=?,settlement_idempotency_key=?,settlement_payload_hash=? WHERE id=?")
      .run(settlementDate,cash.id,journal.id,actor(actorId),idempotencyKey,settlementPayloadHash,id);
    const updated=db.prepare('SELECT * FROM accounting_loan_installments WHERE id=?').get(id) as any;
    const remaining = outstanding(db,loan);
    const pending = db.prepare("SELECT COUNT(*) AS count FROM accounting_loan_installments WHERE loan_id=? AND status IN ('scheduled','awaiting_confirmation','registered','failed')").get(loan.id) as {count:number};
    if (remaining === 0 && Number(pending.count) === 0) db.prepare("UPDATE accounting_loans SET status='closed' WHERE id=? AND status='active'").run(loan.id);
    return {...updated,duplicate:false,entry_number:journal.entryNumber,remaining_principal_minor:remaining};
  })();
}
export function cancelLoanInstallment(db: DB, installmentIdInput: unknown, reasonInput: unknown, actorId: string | null): any {
  const id=text(installmentIdInput,'installment_id',100), reason=text(reasonInput,'reason',500);
  return db.transaction(()=>{
    const item=db.prepare('SELECT * FROM accounting_loan_installments WHERE id=?').get(id) as any;
    if(!item) fail('installment_not_found','Loan instalment was not found.',404);
    if(item.status==='cancelled' && item.cancellation_reason===reason) return {...item,duplicate:true};
    if(item.status!=='scheduled' && item.status!=='awaiting_confirmation' && item.status!=='failed') fail('installment_not_cancellable','Only unregistered/unpaid instalments can be cancelled.',409);
    db.prepare("UPDATE accounting_loan_installments SET status='cancelled',cancellation_reason=?,cancelled_by=?,cancelled_at=CURRENT_TIMESTAMP,last_error_code=NULL,last_error_message=NULL WHERE id=?")
      .run(reason,actor(actorId),id);
    const loan=loanRow(db,item.loan_id);
    const pending=db.prepare("SELECT COUNT(*) AS count FROM accounting_loan_installments WHERE loan_id=? AND status IN ('scheduled','awaiting_confirmation','registered','failed')").get(loan.id) as {count:number};
    if(outstanding(db,loan)===0 && Number(pending.count)===0) db.prepare("UPDATE accounting_loans SET status='closed' WHERE id=? AND status='active'").run(loan.id);
    const updated = db.prepare('SELECT * FROM accounting_loan_installments WHERE id=?').get(id) as Record<string, unknown> | undefined;
    if (!updated) fail('installment_not_found','Loan instalment disappeared during cancellation.',500);
    return {...updated,duplicate:false};
  })();
}
