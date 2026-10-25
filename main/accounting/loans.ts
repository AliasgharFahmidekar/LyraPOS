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
  // A cancelled loan has had its original liability journal reversed. Preserve its
  // original principal as historical data, but do not present it as an outstanding debt.
  if (loan.cancelled_at) return 0;
  const paid = db.prepare("SELECT COALESCE(SUM(principal_minor),0) AS total FROM accounting_loan_installments WHERE loan_id=? AND status='settled'").get(loan.id) as {total:number};
  return Number(loan.initial_outstanding_minor) - Number(paid.total);
}
function reversePostedLoanJournal(db: DB, entryId: string, input: {entryDate:string;description:string;sourceId:string;sourceEvent:string;idempotencyKey:string;actorId:string|null;expectedSourceEvent:string}): any {
  const original=db.prepare('SELECT id,status,source_type,source_id,source_event,currency_code FROM accounting_journal_entries WHERE id=?').get(entryId) as any;
  if(!original||original.status!=='posted'||original.source_type!=='accounting_loan'||original.source_id!==input.sourceId||original.source_event!==input.expectedSourceEvent) fail('loan_journal_not_reversible','The original loan journal is missing or does not match the expected source event.',409);
  const lines=db.prepare('SELECT account_id,debit_minor,credit_minor,description FROM accounting_journal_lines WHERE journal_entry_id=? ORDER BY line_no').all(entryId) as any[];
  if(!lines.length) fail('loan_journal_not_reversible','The original loan journal has no posted lines.',409);
  return post(db,{entryDate:input.entryDate,description:input.description,currencyCode:original.currency_code,
    lines:lines.map(line=>({accountId:line.account_id,debitMinor:Number(line.credit_minor),creditMinor:Number(line.debit_minor),description:'Reversal: '+String(line.description||input.description).slice(0,350)})),
    actorId:input.actorId,sourceId:input.sourceId,sourceEvent:input.sourceEvent,idempotencyKey:input.idempotencyKey});
}

function accrueLoanInstallment(db: DB, item: any, loan: any, entryDate: string, actorId: string|null): any|null {
  const accrued=Number(item.interest_minor)+Number(item.fees_minor);
  if(!Number.isSafeInteger(accrued)||accrued<0) fail('invalid_installment_amount','Interest and fee total is invalid.');
  if(accrued===0) return null;
  const lines:any[]=[];
  if(Number(item.interest_minor)>0){account(db,item.interest_account_id,['expense'],'interest_account_id');lines.push({accountId:item.interest_account_id,debitMinor:Number(item.interest_minor),creditMinor:0,description:'Loan interest accrued at installment recognition date'});}
  if(Number(item.fees_minor)>0){account(db,item.fees_account_id,['expense'],'fees_account_id');lines.push({accountId:item.fees_account_id,debitMinor:Number(item.fees_minor),creditMinor:0,description:'Loan fees accrued at installment recognition date'});}
  lines.push({accountId:loan.liability_account_id,debitMinor:0,creditMinor:accrued,description:'Interest/fees added to amount owed; no cash movement'});
  return post(db,{entryDate,description:'Loan installment due accrual: '+loan.lender,currencyCode:loan.currency_code,lines,actorId,sourceId:item.id,sourceEvent:'installment_due_registration',idempotencyKey:'loan-installment:'+item.id+':due-registration'});
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
    cash.account_code AS cash_account_code, cash.name AS cash_account_name, j.entry_number AS initial_entry_number,
    cancellation.entry_number AS cancellation_entry_number
    FROM accounting_loans l JOIN accounting_accounts a ON a.id=l.liability_account_id
    LEFT JOIN accounting_accounts cash ON cash.id=l.cash_account_id
    LEFT JOIN accounting_journal_entries j ON j.id=l.initial_journal_entry_id
    LEFT JOIN accounting_journal_entries cancellation ON cancellation.id=l.cancellation_journal_entry_id
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
      historical_principal_known:loan.mode!=='opening' || Number(loan.original_principal_minor)>Number(loan.initial_outstanding_minor),
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
export function updateLoanInstallment(db: DB, installmentIdInput: unknown, input: any, actorId: string|null): any {
  const id=text(installmentIdInput,'installment_id',100);
  const dueDate=date(input?.due_date,'due_date'), principal=input?.principal_minor, interest=input?.interest_minor??0, fees=input?.fees_minor??0;
  for(const [field,value] of [['principal_minor',principal],['interest_minor',interest],['fees_minor',fees]] as [string,any][]) if(!Number.isSafeInteger(value)||value<0) fail('invalid_'+field,field+' must be a non-negative integer.');
  if(!Number.isSafeInteger(principal+interest+fees)||principal+interest+fees<=0) fail('invalid_installment_amount','Installment total must be positive.');
  if(typeof input?.auto_register!=='boolean') fail('invalid_auto_register','auto_register must be true or false.');
  return db.transaction(()=>{
    const item=db.prepare('SELECT * FROM accounting_loan_installments WHERE id=?').get(id) as any;
    if(!item) fail('installment_not_found','Loan installment was not found.',404);
    if(!['scheduled','awaiting_confirmation','failed'].includes(item.status)) fail('installment_not_editable','Only installments without a posted accrual/payment can be edited. Cancel a registered installment and create a replacement.',409);
    const loan=loanRow(db,item.loan_id);
    if(loan.cancelled_at||loan.status!=='active') fail('loan_not_active','Cannot edit an installment for a closed or cancelled loan.',409);
    if(dueDate<(loan.accounting_start_date??loan.loan_date)) fail('installment_before_loan_date','Due date cannot precede the accounting start date.');
    const duplicate=db.prepare("SELECT id FROM accounting_loan_installments WHERE loan_id=? AND due_date=? AND id<>? AND status<>'cancelled' LIMIT 1").get(loan.id,dueDate,id);
    if(duplicate) fail('duplicate_installment_due_date','Another active installment already has this due date.',409);
    const interestAccount=interest>0?account(db,input?.interest_account_id,['expense'],'interest_account_id'):null;
    const feesAccount=fees>0?account(db,input?.fees_account_id,['expense'],'fees_account_id'):null;
    const scheduled=db.prepare("SELECT COALESCE(SUM(principal_minor),0) AS total FROM accounting_loan_installments WHERE loan_id=? AND id<>? AND status IN ('scheduled','awaiting_confirmation','registered','failed')").get(loan.id,id) as {total:number};
    if(principal+Number(scheduled.total)>outstanding(db,loan)) fail('principal_schedule_exceeds_balance','Combined scheduled principal exceeds remaining principal.',409);
    const before={due_date:item.due_date,principal_minor:item.principal_minor,interest_minor:item.interest_minor,fees_minor:item.fees_minor,interest_account_id:item.interest_account_id,fees_account_id:item.fees_account_id,auto_register:item.auto_register,status:item.status};
    db.prepare("UPDATE accounting_loan_installments SET due_date=?,principal_minor=?,interest_minor=?,fees_minor=?,interest_account_id=?,fees_account_id=?,auto_register=?,status='scheduled',registered_at=NULL,registered_by=NULL,due_journal_entry_id=NULL,last_error_code=NULL,last_error_message=NULL WHERE id=?")
      .run(dueDate,principal,interest,fees,interestAccount?.id??null,feesAccount?.id??null,input.auto_register?1:0,id);
    const after={due_date:dueDate,principal_minor:principal,interest_minor:interest,fees_minor:fees,interest_account_id:interestAccount?.id??null,fees_account_id:feesAccount?.id??null,auto_register:input.auto_register?1:0,status:'scheduled'};
    db.prepare("INSERT INTO accounting_audit_log(entity_type,entity_id,action,actor_user_id,before_json,after_json) VALUES('accounting_loan_installment',?,'edited',?,?,?)")
      .run(id,actor(actorId),JSON.stringify(before),JSON.stringify(after));
    return {...(db.prepare('SELECT * FROM accounting_loan_installments WHERE id=?').get(id) as any),duplicate:false};
  })();
}
export function registerLoanInstallment(db: DB, installmentIdInput: unknown, actorId: string | null, asOfInput?: unknown): any {
  const id=text(installmentIdInput,'installment_id',100);
  const asOf=asOfInput===undefined?accountingDate(db,new Date().toISOString()):date(asOfInput,'as_of_date');
  return db.transaction(()=>{
    const item=db.prepare('SELECT * FROM accounting_loan_installments WHERE id=?').get(id) as any;
    if(!item) fail('installment_not_found','Loan installment was not found.',404);
    if(['registered','settled'].includes(item.status)) return {...item,duplicate:true};
    if(item.status==='cancelled') fail('installment_cancelled','Cancelled installment cannot be registered.',409);
    if(item.due_date>asOf) fail('installment_not_due','Installment cannot be registered before its due date.',409);
    const loan=loanRow(db,item.loan_id);
    if(loan.cancelled_at||loan.status!=='active') fail('loan_not_active','Cannot register an installment for a closed or cancelled loan.',409);
    if(item.due_date<(loan.accounting_start_date??loan.loan_date)) fail('installment_before_loan_date','Due date cannot precede the accounting start date.',409);
    if(db.prepare("SELECT 1 FROM accounting_period_closures WHERE status='closed' AND ? BETWEEN period_start AND period_end LIMIT 1").get(item.due_date)) fail('period_closed','Accounting period is closed; reopen it with a reason before registering the installment.',409);
    const dueJournal=accrueLoanInstallment(db,item,loan,item.due_date,actorId);
    db.prepare("UPDATE accounting_loan_installments SET status='registered',registered_at=CURRENT_TIMESTAMP,registered_by=?,due_journal_entry_id=?,last_error_code=NULL,last_error_message=NULL WHERE id=?")
      .run(actor(actorId),dueJournal?.id??null,id);
    const updated=db.prepare('SELECT * FROM accounting_loan_installments WHERE id=?').get(id) as Record<string,unknown>|undefined;
    if(!updated) fail('installment_not_found','Loan installment disappeared during registration.',500);
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
  const id=text(installmentIdInput,'installment_id',100), settlementDate=date(input?.settlement_date,'settlement_date');
  const businessDate=accountingDate(db,new Date().toISOString());
  if(settlementDate>businessDate) fail('settlement_in_future','Actual loan payment date cannot be in the future.');
  const settlementAccountId=text(input?.settlement_account_id,'settlement_account_id',100), idempotencyKey=key(idempotencyInput);
  return db.transaction(()=>{
    const item=db.prepare('SELECT * FROM accounting_loan_installments WHERE id=?').get(id) as any;
    if(!item) fail('installment_not_found','Loan installment was not found.',404);
    if(item.status==='cancelled') fail('installment_cancelled','Cancelled installment cannot be settled.',409);
    const payloadHash=hash({installmentId:id,settlementDate,settlementAccountId,principalMinor:item.principal_minor,interestMinor:item.interest_minor,feesMinor:item.fees_minor});
    if(item.status==='settled'){
      if(item.settlement_idempotency_key===idempotencyKey){if(item.settlement_payload_hash!==payloadHash) fail('idempotency_conflict','Settlement key reused with different details.',409);return {...item,duplicate:true};}
      fail('installment_already_settled','Installment is already settled.',409);
    }
    if(!['registered','scheduled','awaiting_confirmation','failed'].includes(item.status)) fail('installment_not_settleable','Installment is not payable.',409);
    const cash=liquid(db,settlementAccountId), loan=loanRow(db,item.loan_id);
    if(loan.cancelled_at||loan.status!=='active') fail('loan_not_active','Cannot settle an installment for a closed or cancelled loan.',409);
    if(settlementDate<(loan.accounting_start_date??loan.loan_date)) fail('settlement_before_loan_date','Settlement date cannot precede the accounting opening date.');
    if(item.principal_minor>outstanding(db,loan)) fail('principal_schedule_exceeds_balance','Payment principal exceeds outstanding principal.',409);
    const total=Number(item.principal_minor)+Number(item.interest_minor)+Number(item.fees_minor);
    if(!Number.isSafeInteger(total)||total<=0) fail('invalid_installment_amount','Installment total is invalid.');
    let dueJournalId:string|null=item.due_journal_entry_id??null;
    if(item.status!=='registered'){
      const accrualDate=settlementDate<item.due_date?settlementDate:item.due_date;
      const dueJournal=accrueLoanInstallment(db,item,loan,accrualDate,actorId);
      dueJournalId=dueJournal?.id??null;
    }
    const journal=post(db,{entryDate:settlementDate,description:'Loan installment payment: '+loan.lender,currencyCode:loan.currency_code,
      lines:[{accountId:loan.liability_account_id,debitMinor:total,creditMinor:0,description:'Loan amount owed reduced by principal, accrued interest and fees'},
        {accountId:cash.id,debitMinor:0,creditMinor:total,description:'Actual loan installment payment'}],
      actorId,sourceId:id,sourceEvent:'installment_settlement',idempotencyKey:'loan-installment:'+id+':settlement'});
    db.prepare("UPDATE accounting_loan_installments SET status='settled',registered_at=COALESCE(registered_at,CURRENT_TIMESTAMP),registered_by=COALESCE(registered_by,?),due_journal_entry_id=?,settlement_date=?,settlement_account_id=?,settlement_journal_entry_id=?,settled_at=CURRENT_TIMESTAMP,settled_by=?,settlement_idempotency_key=?,settlement_payload_hash=?,last_error_code=NULL,last_error_message=NULL WHERE id=?")
      .run(actor(actorId),dueJournalId,settlementDate,cash.id,journal.id,actor(actorId),idempotencyKey,payloadHash,id);
    const updated=db.prepare('SELECT * FROM accounting_loan_installments WHERE id=?').get(id) as any;
    const remaining=outstanding(db,loan);
    const pending=db.prepare("SELECT COUNT(*) AS count FROM accounting_loan_installments WHERE loan_id=? AND status IN ('scheduled','awaiting_confirmation','registered','failed')").get(loan.id) as {count:number};
    if(remaining===0&&Number(pending.count)===0) db.prepare("UPDATE accounting_loans SET status='closed' WHERE id=? AND status='active'").run(loan.id);
    return {...updated,duplicate:false,entry_number:journal.entryNumber,due_entry_number:dueJournalId?((db.prepare('SELECT entry_number FROM accounting_journal_entries WHERE id=?').get(dueJournalId) as any)?.entry_number??null):null,remaining_principal_minor:remaining};
  })();
}
function cancelLoanInstallmentInTransaction(db: DB, id: string, reason: string, actorId: string|null): any {
  const item=db.prepare('SELECT * FROM accounting_loan_installments WHERE id=?').get(id) as any;
  if(!item) fail('installment_not_found','Loan installment was not found.',404);
  if(item.status==='cancelled'){if(item.cancellation_reason===reason)return {...item,duplicate:true};fail('installment_already_cancelled','Installment was already cancelled with a different reason.',409);}
  if(!['scheduled','awaiting_confirmation','failed','registered'].includes(item.status)) fail('installment_not_cancellable','Paid installments cannot be cancelled.',409);
  const loan=loanRow(db,item.loan_id);
  let reversal:any=null;
  if(item.due_journal_entry_id){
    const reversalDate=accountingDate(db,new Date().toISOString());
    reversal=reversePostedLoanJournal(db,item.due_journal_entry_id,{entryDate:reversalDate,description:'Loan installment accrual cancellation: '+loan.lender,
      sourceId:id,sourceEvent:'installment_due_reversal',expectedSourceEvent:'installment_due_registration',idempotencyKey:'loan-installment:'+id+':due-cancellation',actorId});
  }
  db.prepare("UPDATE accounting_loan_installments SET status='cancelled',cancellation_reason=?,cancelled_by=?,cancelled_at=CURRENT_TIMESTAMP,cancelled_due_journal_entry_id=?,cancellation_reversal_journal_entry_id=?,due_journal_entry_id=NULL,last_error_code=NULL,last_error_message=NULL WHERE id=?")
    .run(reason,actor(actorId),item.due_journal_entry_id??null,reversal?.id??null,id);
  const pending=db.prepare("SELECT COUNT(*) AS count FROM accounting_loan_installments WHERE loan_id=? AND status IN ('scheduled','awaiting_confirmation','registered','failed')").get(loan.id) as {count:number};
  if(outstanding(db,loan)===0&&Number(pending.count)===0) db.prepare("UPDATE accounting_loans SET status='closed' WHERE id=? AND status='active'").run(loan.id);
  return {...(db.prepare('SELECT * FROM accounting_loan_installments WHERE id=?').get(id) as any),duplicate:false,cancellation_reversal_journal_entry_id:reversal?.id??null};
}
export function cancelLoanInstallment(db: DB, installmentIdInput: unknown, reasonInput: unknown, actorId: string|null): any {
  const id=text(installmentIdInput,'installment_id',100), reason=text(reasonInput,'reason',500);
  return db.transaction(()=>cancelLoanInstallmentInTransaction(db,id,reason,actorId))();
}
function cancelLoanInTransaction(db: DB, loanId: string, reason: string, actorId: string|null): any {
  const loan=loanRow(db,loanId);
  if(loan.cancelled_at){if(loan.cancellation_reason===reason)return {...loan,duplicate:true,remaining_principal_minor:outstanding(db,loan)};fail('loan_already_cancelled','Loan was already cancelled with a different reason.',409);}
  if(loan.status!=='active') fail('loan_not_cancellable','Only active loans can be cancelled.',409);
  const settled=db.prepare("SELECT COUNT(*) AS count FROM accounting_loan_installments WHERE loan_id=? AND status='settled'").get(loan.id) as {count:number};
  if(Number(settled.count)>0) fail('loan_has_settled_installments','A loan with an actual settled installment cannot be cancelled wholesale.',409);
  const items=db.prepare("SELECT id FROM accounting_loan_installments WHERE loan_id=? AND status IN ('scheduled','awaiting_confirmation','registered','failed') ORDER BY due_date,id").all(loan.id) as Array<{id:string}>;
  for(const item of items) cancelLoanInstallmentInTransaction(db,item.id,reason,actorId);
  if(!loan.initial_journal_entry_id) fail('loan_initial_journal_missing','Loan does not have its original posted journal.',409);
  const reversalDate=accountingDate(db,new Date().toISOString());
  const reversal=reversePostedLoanJournal(db,loan.initial_journal_entry_id,{entryDate:reversalDate,description:'Loan cancellation reversal: '+loan.lender,sourceId:loan.id,
    sourceEvent:'loan_cancellation_reversal',expectedSourceEvent:loan.mode==='new'?'loan_received':'loan_opening_balance',idempotencyKey:'loan:'+loan.id+':cancellation',actorId});
  db.prepare("UPDATE accounting_loans SET status='closed',cancelled_at=CURRENT_TIMESTAMP,cancellation_reason=?,cancelled_by=?,cancellation_journal_entry_id=? WHERE id=? AND status='active' AND cancelled_at IS NULL")
    .run(reason,actor(actorId),reversal.id,loan.id);
  db.prepare("INSERT INTO accounting_audit_log(entity_type,entity_id,action,actor_user_id,before_json,after_json) VALUES('accounting_loan',?,'cancelled',?,?,?)")
    .run(loan.id,actor(actorId),JSON.stringify({status:loan.status,cancelled_at:null}),JSON.stringify({status:'closed',reason,cancellation_journal_entry_id:reversal.id}));
  const cancelledLoan=loanRow(db,loan.id);
  return {...cancelledLoan,duplicate:false,cancellation_journal_entry_id:reversal.id,remaining_principal_minor:outstanding(db,cancelledLoan)};
}
export function cancelLoan(db: DB, loanIdInput: unknown, reasonInput: unknown, actorId: string|null): any {
  const id=text(loanIdInput,'loan_id',100), reason=text(reasonInput,'reason',500);
  return db.transaction(()=>cancelLoanInTransaction(db,id,reason,actorId))();
}
export function correctLoan(db: DB, loanIdInput: unknown, input: any, actorId: string|null, idempotencyInput: unknown): any {
  const id=text(loanIdInput,'loan_id',100), reason=text(input?.reason,'reason',500), idempotencyKey=key(idempotencyInput);
  if(!input?.loan||typeof input.loan!=='object') fail('invalid_corrected_loan','Provide corrected loan details.');
  const correctionHash=hash({loanId:id,loan:input.loan,reason});
  return db.transaction(()=>{
    const existing=db.prepare('SELECT * FROM accounting_loans WHERE corrected_from_loan_id=?').get(id) as any;
    if(existing){if(existing.correction_payload_hash!==correctionHash) fail('loan_correction_conflict','A different corrected loan is already linked to this entry.',409);return {...existing,duplicate:true,remaining_principal_minor:outstanding(db,existing)};}
    const original=loanRow(db,id);
    if(original.cancelled_at) fail('loan_already_cancelled','This loan has already been cancelled.',409);
    cancelLoanInTransaction(db,id,reason,actorId);
    const replacement=createLoan(db,input.loan,actorId,idempotencyKey);
    db.prepare('UPDATE accounting_loans SET corrected_from_loan_id=?,correction_payload_hash=? WHERE id=? AND corrected_from_loan_id IS NULL').run(id,correctionHash,replacement.id);
    db.prepare("INSERT INTO accounting_audit_log(entity_type,entity_id,action,actor_user_id,before_json,after_json) VALUES('accounting_loan',?,'corrected_from',?,?,?)")
      .run(replacement.id,actor(actorId),JSON.stringify({corrected_from_loan_id:null}),JSON.stringify({corrected_from_loan_id:id,correction_reason:reason}));
    const fixed=loanRow(db,replacement.id);
    return {...fixed,duplicate:false,corrected_from_loan_id:id,remaining_principal_minor:outstanding(db,fixed)};
  })();
}
