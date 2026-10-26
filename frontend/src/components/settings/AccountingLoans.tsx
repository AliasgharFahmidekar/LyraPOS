'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useLocale } from 'use-intl';
import { useAuthStore } from '@/store/auth';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import { CalendarClock, CircleCheck, Plus } from 'lucide-react';
import { formatAccountingMoney, formatAccountingAmountInput, getCurrencyUnitAdapter, parseAccountingAmountToMinor } from '@/lib/countries';
import { accountingSystemAccountName, accountingErrorMessage, accountingStatusLabel, formatAccountingDate } from '@/lib/accounting-i18n';
import { JalaliDateInput } from '@/components/ui/JalaliDateInput';

type Account = { id:string; account_code:string; name:string; account_type:string; system_key:string|null; is_active:number; is_postable:number };
type Installment = { id:string; due_date:string; principal_minor:number; interest_minor:number; fees_minor:number; status:string; auto_register:number; interest_account_id?:string|null; fees_account_id?:string|null; last_error_message?:string|null; due_entry_number?:string|null; settlement_entry_number?:string|null; settlement_journal_entry_id?:string|null; cancellation_reversal_journal_entry_id?:string|null };
type Loan = { id:string; mode:'new'|'opening'; lender:string; description?:string|null; reference_number?:string|null; loan_date:string; origination_date:string|null; accounting_start_date:string; original_principal_minor:number; initial_outstanding_minor:number; remaining_principal_minor:number; principal_repaid_minor:number; historical_principal_repaid_minor:number; historical_principal_known:boolean; currency_code:string; status:string; liability_account_id:string; liability_account_name:string; cash_account_id:string|null; cash_account_name:string|null; initial_entry_number:string|null; cancellation_entry_number?:string|null; cancelled_at?:string|null; cancellation_reason?:string|null; corrected_from_loan_id?:string|null; installments:Installment[] };
type InstallmentEditDraft = { due_date:string; principal:string; interest:string; fees:string };
const today = () => { const d=new Date(); return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10); };
const token = () => typeof crypto!=='undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Date.now())+'-'+Math.random();
type InstallmentDraft = { key: string; due_date: string; principal: string; interest: string; fees: string };

export function AccountingLoans() {
  const locale=useLocale();
  const tenant=useAuthStore((s)=>s.currentTenant);
  const fa=locale.toLowerCase().startsWith('fa');
  const [accounts,setAccounts]=useState<Account[]>([]);
  const [loans,setLoans]=useState<Loan[]>([]);
  const [currency,setCurrency]=useState(tenant?.currency || 'IRR');
  const [fractionDigits,setFractionDigits]=useState(0);
  const [mode,setMode]=useState<'new'|'opening'>('new');
  const [lender,setLender]=useState('');
  const [loanDate,setLoanDate]=useState(today());
  const [accountingStartDate,setAccountingStartDate]=useState(today());
  const [legacyOriginationDates,setLegacyOriginationDates]=useState<Record<string,string>>({});
  const [originalAmount,setOriginalAmount]=useState('');
  const [remainingAmount,setRemainingAmount]=useState('');
  const [liabilityAccount,setLiabilityAccount]=useState('');
  const [cashAccount,setCashAccount]=useState('');
  const [selectedLoan,setSelectedLoan]=useState('');
  const [editingLoan,setEditingLoan]=useState<Loan|null>(null);
  const [correctionReason,setCorrectionReason]=useState('');
  const [correctionKey,setCorrectionKey]=useState('');
  const [editingInstallmentId,setEditingInstallmentId]=useState('');
  const [installmentEdit,setInstallmentEdit]=useState<InstallmentEditDraft|null>(null);
  const [scheduleCount,setScheduleCount]=useState('12');
  const [scheduleInterval,setScheduleInterval]=useState('1');
  const [firstDueDate,setFirstDueDate]=useState(today());
  const [schedulePrincipalTotal,setSchedulePrincipalTotal]=useState('');
  const [scheduleInterestPer,setScheduleInterestPer]=useState('0');
  const [scheduleFeesPer,setScheduleFeesPer]=useState('0');
  const [installmentDrafts,setInstallmentDrafts]=useState<InstallmentDraft[]>([]);
  const [scheduleRetry,setScheduleRetry]=useState<{fingerprint:string;key:string}|null>(null);
  const [interestAccount,setInterestAccount]=useState('');
  const [feesAccount,setFeesAccount]=useState('');
  const [autoRegister,setAutoRegister]=useState(false);
  const [settlementDate,setSettlementDate]=useState(today());
  const [settlementMinDate,setSettlementMinDate]=useState<string|undefined>(undefined);
  const [settlementAccount,setSettlementAccount]=useState('');
  const [busy,setBusy]=useState(false);
  const t=fa?{
    title:'وام‌ها',note:'دریافت وام درآمد نیست. بازپرداخت اصل وام بدهی را کم می‌کند و فقط سود و کارمزد هزینه‌اند. ثبت خودکار یعنی ثبت سررسید، نه پرداخت واقعی؛ پرداخت قسط پیش از سررسید هم ممکن است.',
    newLoan:'ثبت وام',correctLoan:'اصلاح و ثبت مجدد وام',cancelCorrection:'انصراف از اصلاح',correctionReason:'دلیل اصلاح',cancelLoan:'لغو وام',cancelledLoan:'لغوشده',editInstallment:'ویرایش قسط',saveChanges:'ذخیره اصلاحات',discardEdit:'انصراف از ویرایش',earlyPayment:'پرداخت زودتر از سررسید هم مجاز است؛ تاریخ واقعی و حساب پرداخت ثبت می‌شوند.',mode:'نوع ثبت',newMode:'وام جدید و دریافت وجه',openingMode:'وام قبلی؛ ثبت مانده بدهی',lender:'وام‌دهنده',newDate:'تاریخ دریافت وجه',originationDate:'تاریخ واقعی دریافت وام',accountingStartDate:'تاریخ شروع حسابداری و ثبت مانده',original:'اصل اولیه وام',remaining:'مانده اصل بدهی فعلی',liability:'حساب بدهی وام',cash:'حساب واقعی دریافت وجه',create:'ثبت وام',loans:'وام‌های ثبت‌شده',empty:'وامی ثبت نشده است',remainingLabel:'مانده اصل',repaid:'اصل بازپرداخت‌شده در LyraPOS',historicalRepaid:'اصل بازپرداخت‌شده پیش از شروع حسابداری',historicalUnknown:'نامشخص؛ اصل اولیه وارد نشده یا با مانده برابر است',originationUnknown:'تاریخ واقعی این وام قدیمی ثبت نشده است',saveOriginationDate:'ثبت تاریخ واقعی وام',historicalInfo:'این مبلغ فقط سابقه است و هیچ دریافت وجه یا هزینه‌ای در دفترکل ثبت نمی‌کند.',reference:'سند اولیه',schedule:'ساخت برنامه اقساط',selectLoan:'انتخاب وام',due:'سررسید قسط',principal:'اصل قسط',interest:'سود قسط',fees:'کارمزد',interestAccount:'حساب هزینه سود',feesAccount:'حساب هزینه کارمزد',auto:'ثبت خودکار رویداد سررسید',buildSchedule:'ساخت پیش‌نمایش',registerAll:'ثبت همه اقساط',count:'تعداد اقساط',firstDue:'تاریخ اولین سررسید',interval:'فاصله بین اقساط (ماه)',principalTotal:'مجموع اصل اقساط',interestPer:'سود هر قسط',feesPer:'کارمزد هر قسط',generateHint:'برنامه پیش‌نمایش ساخته می‌شود؛ تا پیش از ثبت گروهی هیچ قسطی به دفترکل اضافه نمی‌شود.',sumPrincipal:'مجموع اصل',sumInterest:'مجموع سود',sumFees:'مجموع کارمزد',sumAll:'مجموع کل برنامه',addInstallment:'افزودن ردیف',remove:'حذف ردیف',installments:'اقساط',status:'وضعیت',total:'مجموع قسط',register:'ثبت سررسید',settle:'تأیید پرداخت واقعی',settlementDate:'تاریخ پرداخت واقعی',settlementAccount:'حساب صندوق / بانک پرداخت',cancel:'لغو قسط',cancelReason:'دلیل لغو',dueEntry:'سند سررسید',settlementEntry:'سند پرداخت',actions:'عملیات',active:'فعال',closed:'تسویه‌شده',scheduled:'در انتظار سررسید',awaiting_confirmation:'در انتظار تأیید ثبت سررسید',registered:'سررسید ثبت‌شده؛ پرداخت نشده',failed:'خطای ثبت؛ نیازمند تلاش مجدد',settled:'پرداخت‌شده',cancelled:'لغوشده',required:'اطلاعات ضروری و مبلغ معتبر را وارد کنید.',saved:'ثبت شد.',error:'عملیات انجام نشد؛ اطلاعات و وضعیت حسابداری را بررسی کنید.',noInstallments:'قسطی ثبت نشده است.'
  }:{
    title:'Loans',note:'Loan proceeds are not income. Principal repayment reduces the liability; only interest and fees are expenses. Automatic mode registers a due event, not an automatic payment. An installment may be paid before its due date.',
    newLoan:'Register loan',correctLoan:'Correct and re-enter loan',cancelCorrection:'Discard correction',correctionReason:'Reason for correction',cancelLoan:'Cancel loan',cancelledLoan:'Cancelled',editInstallment:'Edit installment',saveChanges:'Save changes',discardEdit:'Discard edit',earlyPayment:'Early payment is allowed; the actual payment date and cash/bank account are posted.',mode:'Record type',newMode:'New loan; funds received',openingMode:'Existing loan; opening liability',lender:'Lender',newDate:'Date funds were received',originationDate:'Actual original loan date',accountingStartDate:'Accounting opening-balance date',original:'Original principal',remaining:'Current remaining principal',liability:'Loan liability account',cash:'Actual proceeds account',create:'Save loan',loans:'Registered loans',empty:'No loans recorded',remainingLabel:'Remaining principal',repaid:'Principal repaid in LyraPOS',historicalRepaid:'Principal repaid before accounting started',historicalUnknown:'Unknown (original principal missing or equals opening balance)',originationUnknown:'Original loan date has not been recorded for this legacy loan',saveOriginationDate:'Save original loan date',historicalInfo:'Historical context only; no cash receipt or expense is posted.',reference:'Initial journal',schedule:'Build installment schedule',selectLoan:'Select loan',due:'Installment due date',principal:'Principal',interest:'Interest',fees:'Fees',interestAccount:'Interest expense account',feesAccount:'Fee expense account',auto:'Automatically register due event',buildSchedule:'Build preview',registerAll:'Register all installments',count:'Number of installments',firstDue:'First due date',interval:'Interval (months)',principalTotal:'Total scheduled principal',interestPer:'Interest per installment',feesPer:'Fee per installment',generateHint:'This is a preview. No installment or ledger entry is saved until the batch is registered.',sumPrincipal:'Principal total',sumInterest:'Interest total',sumFees:'Fees total',sumAll:'Schedule total',addInstallment:'Add row',remove:'Remove row',installments:'Installments',status:'Status',total:'Installment total',register:'Register due event',settle:'Confirm actual payment',settlementDate:'Actual payment date',settlementAccount:'Actual cash / bank account',cancel:'Cancel installment',cancelReason:'Cancellation reason',dueEntry:'Due journal',settlementEntry:'Payment journal',actions:'Actions',active:'Active',closed:'Paid off',scheduled:'Scheduled',awaiting_confirmation:'Awaiting due registration',registered:'Due registered; unpaid',failed:'Registration failed; retry required',settled:'Paid',cancelled:'Cancelled',required:'Enter valid required fields and amounts.',saved:'Saved.',error:'Operation failed. Check inputs and accounting state.',noInstallments:'No installments recorded.'
  };
  const load=useCallback(async()=>{
    const [a,l]=await Promise.all([api.get('/accounting/accounts'),api.get('/accounting/loans')]);
    const rows:Account[]=a.data.accounts||[];
    setAccounts(rows); setLoans(l.data.loans||[]);
    const code=a.data.currency_code||'IRR'; setCurrency(code); setFractionDigits(Number(a.data.accounting_fraction_digits ?? 0));
    const liquid=rows.filter(x=>x.account_type==='asset'&&x.is_active===1&&x.is_postable===1&&(['cash_drawer','bank_accounts','payment_clearing'].includes(x.system_key||'')||(x.system_key||'').startsWith('custom_liquid:cash:')||(x.system_key||'').startsWith('custom_liquid:bank:')));
    setCashAccount(current=>liquid.some(x=>x.id===current)?current:(liquid[0]?.id||''));
    setSettlementAccount(current=>liquid.some(x=>x.id===current)?current:(liquid[0]?.id||''));
    const liabilities=rows.filter(x=>x.account_type==='liability'&&x.is_active===1&&x.is_postable===1&&(!x.system_key||x.system_key==='loans_payable'));
    setLiabilityAccount(current=>liabilities.some(x=>x.id===current)?current:(liabilities.find(x=>x.system_key==='loans_payable')?.id||liabilities[0]?.id||''));
    const expenses=rows.filter(x=>x.account_type==='expense'&&x.is_active===1&&x.is_postable===1);
    setInterestAccount(current=>expenses.some(x=>x.id===current)?current:(expenses[0]?.id||''));
    setFeesAccount(current=>expenses.some(x=>x.id===current)?current:(expenses[0]?.id||''));
    setSelectedLoan(current=>l.data.loans?.some((x:Loan)=>x.id===current&&x.status==='active')?current:(l.data.loans?.find((x:Loan)=>x.status==='active')?.id||''));
  },[]);
  useEffect(()=>{void Promise.resolve().then(()=>load()).catch(()=>toast.error(t.error));},[load,t.error]);
  const preferences = useMemo(() => ({ currencyDisplay: tenant?.currency_display, digits: tenant?.number_digits, calendar: tenant?.calendar }), [tenant?.currency_display, tenant?.number_digits, tenant?.calendar]);
  const unitAdapter=useMemo(()=>getCurrencyUnitAdapter(currency,tenant?.country,preferences),[currency,tenant?.country,preferences]);
  const money=useMemo(()=> (value:number)=>formatAccountingMoney(value,{currency,fractionDigits,locale,countryCode:tenant?.country,preferences}),[locale,currency,fractionDigits,tenant?.country,preferences]);
  const liquidAccounts=accounts.filter(a=>a.account_type==='asset'&&a.is_active===1&&a.is_postable===1&&(['cash_drawer','bank_accounts','payment_clearing'].includes(a.system_key||'')||(a.system_key||'').startsWith('custom_liquid:cash:')||(a.system_key||'').startsWith('custom_liquid:bank:')));
  const liabilityAccounts=accounts.filter(a=>a.account_type==='liability'&&a.is_active===1&&a.is_postable===1&&(!a.system_key||a.system_key==='loans_payable'));
  const expenseAccounts=accounts.filter(a=>a.account_type==='expense'&&a.is_active===1&&a.is_postable===1);
  function amountMinor(raw:string,allowZero=false):number|null {
    return parseAccountingAmountToMinor(raw,{currency,fractionDigits,locale,countryCode:tenant?.country,preferences},allowZero);
  }
  const displayFromMinor=(minor:number)=>formatAccountingAmountInput(minor,{currency,fractionDigits,locale,countryCode:tenant?.country,preferences});
  const selectedLoanData=loans.find((loan)=>loan.id===selectedLoan);
  function dueDateAtMonthOffset(firstDate:string,offset:number):string{
    const [year,month,day]=firstDate.split('-').map(Number);
    const targetMonth=new Date(Date.UTC(year,month-1+offset,1));
    const lastDay=new Date(Date.UTC(targetMonth.getUTCFullYear(),targetMonth.getUTCMonth()+1,0)).getUTCDate();
    return new Date(Date.UTC(targetMonth.getUTCFullYear(),targetMonth.getUTCMonth(),Math.min(day,lastDay))).toISOString().slice(0,10);
  }
  const selectedScheduledPrincipal=selectedLoanData?.installments.filter((item)=>['scheduled','awaiting_confirmation','registered','failed'].includes(item.status)).reduce((sum,item)=>sum+item.principal_minor,0)??0;
  const selectedAvailablePrincipal=selectedLoanData?Math.max(0,selectedLoanData.remaining_principal_minor-selectedScheduledPrincipal):0;
  function generateSchedule(e:FormEvent){
    e.preventDefault();
    const count=Number(scheduleCount),interval=Number(scheduleInterval),selected=loans.find((loan)=>loan.id===selectedLoan);
    const principalTotal=schedulePrincipalTotal.trim()?amountMinor(schedulePrincipalTotal):selected?Math.max(0,selected.remaining_principal_minor-selected.installments.filter((item)=>['scheduled','awaiting_confirmation','registered','failed'].includes(item.status)).reduce((sum,item)=>sum+item.principal_minor,0)):null;
    const interestAmount=amountMinor(scheduleInterestPer||'0',true),feesAmount=amountMinor(scheduleFeesPer||'0',true);
    if(!selected||!Number.isInteger(count)||count<1||count>120||!Number.isInteger(interval)||interval<1||interval>120||!firstDueDate||principalTotal===null||principalTotal<=0||interestAmount===null||feesAmount===null||(principalTotal<count&&interestAmount+feesAmount===0)){toast.error(t.required);return;}
    if(firstDueDate<selected.accounting_start_date||(interestAmount>0&&!interestAccount)||(feesAmount>0&&!feesAccount)){toast.error(t.required);return;}
    const base=Math.floor(principalTotal/count),remainder=principalTotal%count;
    const drafts:InstallmentDraft[]=Array.from({length:count},(_,index)=>({key:token(),due_date:dueDateAtMonthOffset(firstDueDate,index*interval),principal:displayFromMinor(base+(index<remainder?1:0)),interest:displayFromMinor(interestAmount),fees:displayFromMinor(feesAmount)}));
    setInstallmentDrafts(drafts);setScheduleRetry(null);
  }
  function updateDraft(key:string,field:'due_date'|'principal'|'interest'|'fees',value:string){setInstallmentDrafts(current=>current.map(row=>row.key===key?{...row,[field]:value}:row));setScheduleRetry(null);}
  function removeDraft(key:string){setInstallmentDrafts(current=>current.filter(row=>row.key!==key));setScheduleRetry(null);}
  function addDraft(){const last=installmentDrafts[installmentDrafts.length-1];const date=last?dueDateAtMonthOffset(last.due_date,Number(scheduleInterval)||1):firstDueDate;setInstallmentDrafts(current=>[...current,{key:token(),due_date:date,principal:'0',interest:'0',fees:'0'}]);setScheduleRetry(null);}
  async function submitSchedule(e:FormEvent){
    e.preventDefault();const loan=loans.find((item)=>item.id===selectedLoan);if(!loan||!installmentDrafts.length){toast.error(t.required);return;}
    const installments=installmentDrafts.map((row)=>({due_date:row.due_date,principal_minor:amountMinor(row.principal,true),interest_minor:amountMinor(row.interest||'0',true),fees_minor:amountMinor(row.fees||'0',true)}));
    if(installments.some((row)=>!row.due_date||row.principal_minor===null||row.interest_minor===null||row.fees_minor===null||(row.principal_minor||0)+(row.interest_minor||0)+(row.fees_minor||0)<=0)||installments.some((row)=>row.due_date<loan.accounting_start_date)||new Set(installments.map((row)=>row.due_date)).size!==installments.length){toast.error(t.required);return;}
    if(installments.some((row)=>((row.interest_minor||0)>0&&!interestAccount)||((row.fees_minor||0)>0&&!feesAccount))){toast.error(t.required);return;}
    const scheduled=loan.installments.filter((item)=>['scheduled','awaiting_confirmation','registered','failed'].includes(item.status)).reduce((sum,item)=>sum+item.principal_minor,0);
    const principalTotal=installments.reduce((sum,item)=>sum+(item.principal_minor||0),0);if(principalTotal+scheduled>loan.remaining_principal_minor){toast.error(t.required);return;}
    const payload={installments:installments.map((row)=>({...row,interest_account_id:(row.interest_minor||0)>0?interestAccount:null,fees_account_id:(row.fees_minor||0)>0?feesAccount:null,auto_register:autoRegister}))};
    const fingerprint=JSON.stringify({loanId:selectedLoan,payload});const requestKey=scheduleRetry?.fingerprint===fingerprint?scheduleRetry.key:token();setScheduleRetry({fingerprint,key:requestKey});setBusy(true);
    try{await api.post('/accounting/loans/'+encodeURIComponent(selectedLoan)+'/installments',payload,{headers:{'Idempotency-Key':requestKey}});setInstallmentDrafts([]);setScheduleRetry(null);setSchedulePrincipalTotal('');toast.success(t.saved);await load();}
    catch(error:unknown){const message=(error as {response?:{data?:{error?:unknown}}})?.response?.data?.error;toast.error(accountingErrorMessage(message, locale, t.error));}finally{setBusy(false);}
  }
  async function createLoan(e:FormEvent){
    e.preventDefault();
    const remaining=mode==='opening'?amountMinor(remainingAmount):amountMinor(originalAmount);
    const original=mode==='opening'?(originalAmount.trim()?amountMinor(originalAmount):remaining):remaining;
    if(!lender.trim()||!loanDate||!original||!remaining||!liabilityAccount||(mode==='new'&&!cashAccount)||(mode==='opening'&&(!accountingStartDate||accountingStartDate<loanDate))){toast.error(t.required);return;}
    if(mode==='opening'&&(original===null||remaining===null||original<remaining)){toast.error(t.required);return;}
    if(editingLoan&&!correctionReason.trim()){toast.error(t.required);return;}
    const payload={mode,lender:lender.trim(),description:editingLoan?.description??null,reference_number:editingLoan?.reference_number??null,
      loan_date:loanDate,accounting_start_date:mode==='opening'?accountingStartDate:loanDate,
      original_principal_minor:original,principal_minor:original,remaining_principal_minor:remaining,
      liability_account_id:liabilityAccount,cash_account_id:mode==='new'?cashAccount:null,currency_code:currency};
    setBusy(true);
    try{
      if(editingLoan){
        await api.post('/accounting/loans/'+encodeURIComponent(editingLoan.id)+'/correct',{loan:payload,reason:correctionReason.trim()},{headers:{'Idempotency-Key':correctionKey||token()}});
        setEditingLoan(null);setCorrectionReason('');setCorrectionKey('');setSelectedLoan('');
      }else{
        await api.post('/accounting/loans',payload,{headers:{'Idempotency-Key':token()}});
      }
      setLender('');setOriginalAmount('');setRemainingAmount('');setLoanDate(today());setAccountingStartDate(today());setMode('new');
      toast.success(t.saved);await load();
    }catch(error:unknown){const message=(error as {response?:{data?:{error?:unknown}}})?.response?.data?.error;toast.error(accountingErrorMessage(message,locale,t.error));}finally{setBusy(false);}
  }
  async function saveLoanOriginationDate(e:FormEvent, loan:Loan){
    e.preventDefault();
    const originationDate=legacyOriginationDates[loan.id]||'';
    if(!originationDate||originationDate>loan.accounting_start_date){toast.error(t.required);return;}
    setBusy(true);
    try{
      await api.put('/accounting/loans/'+encodeURIComponent(loan.id)+'/origination-date',{origination_date:originationDate});
      setLegacyOriginationDates(current=>({...current,[loan.id]:''}));
      toast.success(t.saved);
      await load();
    }catch(error:unknown){
      const message=(error as {response?:{data?:{error?:unknown}}})?.response?.data?.error;
      toast.error(accountingErrorMessage(message,locale,t.error));
    }finally{setBusy(false);}
  }
  function beginLoanCorrection(loan:Loan){
    if(loan.cancelled_at||loan.status!=='active'||loan.installments.some(item=>item.status==='settled'))return;
    setEditingLoan(loan);setCorrectionReason('');setCorrectionKey(token());setMode(loan.mode);setLender(loan.lender);
    setLoanDate(loan.origination_date||loan.loan_date);setAccountingStartDate(loan.accounting_start_date||loan.loan_date);
    setOriginalAmount(displayFromMinor(loan.original_principal_minor));setRemainingAmount(displayFromMinor(loan.initial_outstanding_minor));
    setLiabilityAccount(loan.liability_account_id);setCashAccount(loan.cash_account_id||'');
  }
  function discardLoanCorrection(){
    setEditingLoan(null);setCorrectionReason('');setCorrectionKey('');setLender('');setOriginalAmount('');setRemainingAmount('');
    setMode('new');setLoanDate(today());setAccountingStartDate(today());
  }
  async function cancelLoanRecord(loan:Loan){
    const reason=window.prompt(t.cancelReason);if(!reason?.trim())return;
    setBusy(true);try{await api.post('/accounting/loans/'+encodeURIComponent(loan.id)+'/cancel',{reason:reason.trim()});toast.success(t.saved);await load();}
    catch(error:unknown){const message=(error as {response?:{data?:{error?:unknown}}})?.response?.data?.error;toast.error(accountingErrorMessage(message,locale,t.error));}finally{setBusy(false);}
  }
  async function registerInstallment(item:Installment){
    setBusy(true);try{await api.post('/accounting/loan-installments/'+encodeURIComponent(item.id)+'/register',{});await load();}catch{toast.error(t.error);}finally{setBusy(false);}
  }
  async function settleInstallment(item:Installment, loan:Loan){
    const minimumDate=loan.accounting_start_date||loan.loan_date;
    setSettlementMinDate(minimumDate);
    if(!settlementDate||!settlementAccount){toast.error(t.required);return;}
    if(settlementDate<minimumDate){setSettlementDate(minimumDate);toast.error(t.required);return;}
    setBusy(true);try{await api.post('/accounting/loan-installments/'+encodeURIComponent(item.id)+'/settle',{settlement_date:settlementDate,settlement_account_id:settlementAccount},{headers:{'Idempotency-Key':token()}});toast.success(t.saved);await load();}
    catch(error:unknown){const message=(error as {response?:{data?:{error?:unknown}}})?.response?.data?.error;toast.error(accountingErrorMessage(message,locale,t.error));}finally{setBusy(false);}
  }
  async function cancelInstallment(item:Installment){
    const reason=window.prompt(t.cancelReason);if(!reason?.trim())return;
    setBusy(true);try{await api.post('/accounting/loan-installments/'+encodeURIComponent(item.id)+'/cancel',{reason:reason.trim()});toast.success(t.saved);await load();}
    catch(error:unknown){const message=(error as {response?:{data?:{error?:unknown}}})?.response?.data?.error;toast.error(accountingErrorMessage(message,locale,t.error));}finally{setBusy(false);}
  }
  function beginInstallmentEdit(item:Installment){
    setEditingInstallmentId(item.id);
    setInstallmentEdit({due_date:item.due_date,principal:displayFromMinor(item.principal_minor),interest:displayFromMinor(item.interest_minor),fees:displayFromMinor(item.fees_minor)});
  }
  async function saveInstallmentEdit(item:Installment){
    if(!installmentEdit)return;
    const principal=amountMinor(installmentEdit.principal,true),interest=amountMinor(installmentEdit.interest||'0',true),fees=amountMinor(installmentEdit.fees||'0',true);
    if(!installmentEdit.due_date||principal===null||interest===null||fees===null||principal+interest+fees<=0){toast.error(t.required);return;}
    if(interest>0&&!(item.interest_account_id||interestAccount)||fees>0&&!(item.fees_account_id||feesAccount)){toast.error(t.required);return;}
    setBusy(true);
    try{
      await api.put('/accounting/loan-installments/'+encodeURIComponent(item.id),{due_date:installmentEdit.due_date,principal_minor:principal,interest_minor:interest,fees_minor:fees,
        interest_account_id:interest>0?(item.interest_account_id||interestAccount):null,fees_account_id:fees>0?(item.fees_account_id||feesAccount):null,auto_register:Boolean(item.auto_register)});
      setEditingInstallmentId('');setInstallmentEdit(null);toast.success(t.saved);await load();
    }catch(error:unknown){const message=(error as {response?:{data?:{error?:unknown}}})?.response?.data?.error;toast.error(accountingErrorMessage(message,locale,t.error));}finally{setBusy(false);}
  }
  const statusText=(status:string)=>(t as Record<string,string>)[status]||accountingStatusLabel(status, locale, t.error);
  const card='acct-panel p-4 space-y-3';
  const field='w-full rounded-lg border border-border bg-card px-3 py-2 text-sm';
  return <section dir={fa?'rtl':'ltr'} className="w-full max-w-6xl space-y-5">
    <h2 className="text-xl font-semibold">{t.title}</h2>
    <p className="rounded-lg border border-border p-3 text-sm text-muted-foreground">{t.note}</p>
    <form onSubmit={e=>void createLoan(e)} className={card}>
      <h3 className="font-semibold">{editingLoan?t.correctLoan:t.newLoan}</h3>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <label className="space-y-1 text-sm"><span>{t.mode}</span><select disabled={Boolean(editingLoan)} value={mode} onChange={e=>{const next=e.target.value as 'new'|'opening';setMode(next);setLoanDate(next==='opening'?'':today());setAccountingStartDate(today());}} className={field}><option value="new">{t.newMode}</option><option value="opening">{t.openingMode}</option></select></label>
        <label className="space-y-1 text-sm"><span>{t.lender}</span><input required maxLength={200} value={lender} onChange={e=>setLender(e.target.value)} className={field}/></label>
        <label className="space-y-1 text-sm"><span>{mode==='opening'?t.originationDate:t.newDate}</span><JalaliDateInput required max={today()} value={loanDate} onChange={e=>setLoanDate(e.target.value)} className={field}/></label>
        {mode==='opening'&&<label className="space-y-1 text-sm"><span>{t.accountingStartDate}</span><JalaliDateInput required min={loanDate||undefined} max={today()} value={accountingStartDate} onChange={e=>setAccountingStartDate(e.target.value)} className={field}/></label>}
        <label className="space-y-1 text-sm"><span>{mode==='opening'?(fa?'اصل اولیه وام (در صورت اطلاع)':'Original principal (if known)'):t.original} · {unitAdapter.label}</span><input required={mode==='new'} inputMode="decimal" value={originalAmount} onChange={e=>setOriginalAmount(e.target.value)} className={field}/></label>
        {mode==='opening'&&<label className="space-y-1 text-sm"><span>{t.remaining} · {unitAdapter.label}</span><input required inputMode="decimal" value={remainingAmount} onChange={e=>setRemainingAmount(e.target.value)} className={field}/></label>}
        <label className="space-y-1 text-sm"><span>{t.liability}</span><select required value={liabilityAccount} onChange={e=>setLiabilityAccount(e.target.value)} className={field}><option value="">—</option>{liabilityAccounts.map(a=><option key={a.id} value={a.id}>{a.account_code} · {accountingSystemAccountName(a.system_key, a.name, locale)}</option>)}</select></label>
        {mode==='new'&&<label className="space-y-1 text-sm"><span>{t.cash}</span><select required value={cashAccount} onChange={e=>setCashAccount(e.target.value)} className={field}><option value="">—</option>{liquidAccounts.map(a=><option key={a.id} value={a.id}>{a.account_code} · {accountingSystemAccountName(a.system_key, a.name, locale)}</option>)}</select></label>}
      </div>
      {editingLoan&&<label className="block space-y-1 text-sm"><span>{t.correctionReason}</span><input required maxLength={500} value={correctionReason} onChange={e=>setCorrectionReason(e.target.value)} className={field}/></label>}
      <div className="flex flex-wrap gap-2"><button disabled={busy||!liabilityAccounts.length||(mode==='new'&&!liquidAccounts.length)} className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{editingLoan?t.correctLoan:t.create}</button>{editingLoan&&<button type="button" disabled={busy} onClick={discardLoanCorrection} className="rounded-lg border border-border px-4 py-2 text-sm">{t.cancelCorrection}</button>}</div>
    </form>
    <form onSubmit={e=>void generateSchedule(e)} className={card}>
      <div className="acct-panel-heading !p-0"><div><h3 className="font-semibold">{t.schedule}</h3><p className="mt-1 text-xs text-muted-foreground">{t.generateHint}</p></div></div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        <label className="space-y-1 text-sm"><span>{t.selectLoan}</span><select required value={selectedLoan} onChange={e=>{setSelectedLoan(e.target.value);setSchedulePrincipalTotal('');setInstallmentDrafts([]);setScheduleRetry(null);}} className={field}><option value="">—</option>{loans.filter(l=>l.status==='active').map(l=><option key={l.id} value={l.id}>{l.lender} · {money(l.remaining_principal_minor)}</option>)}</select></label>
        <label className="space-y-1 text-sm"><span>{t.count}</span><input required min={1} max={120} type="number" value={scheduleCount} onChange={e=>setScheduleCount(e.target.value)} className={field}/></label>
        <label className="space-y-1 text-sm"><span>{t.firstDue}</span><JalaliDateInput required min={selectedLoanData?.accounting_start_date} value={firstDueDate} onChange={e=>setFirstDueDate(e.target.value)} className={field}/></label>
        <label className="space-y-1 text-sm"><span>{t.interval}</span><input required min={1} max={120} type="number" value={scheduleInterval} onChange={e=>setScheduleInterval(e.target.value)} className={field}/></label>
        <label className="space-y-1 text-sm"><span>{t.principalTotal} · {unitAdapter.label}</span><input inputMode="decimal" value={schedulePrincipalTotal} onChange={e=>setSchedulePrincipalTotal(e.target.value)} placeholder={selectedLoanData?displayFromMinor(selectedAvailablePrincipal):'0'} className={field}/></label>
        <label className="space-y-1 text-sm"><span>{t.interestPer} · {unitAdapter.label}</span><input inputMode="decimal" value={scheduleInterestPer} onChange={e=>setScheduleInterestPer(e.target.value)} className={field}/></label>
        <label className="space-y-1 text-sm"><span>{t.interestAccount}</span><select value={interestAccount} onChange={e=>setInterestAccount(e.target.value)} className={field}><option value="">—</option>{expenseAccounts.map(a=><option key={a.id} value={a.id}>{a.account_code} · {accountingSystemAccountName(a.system_key, a.name, locale)}</option>)}</select></label>
        <label className="space-y-1 text-sm"><span>{t.feesPer} · {unitAdapter.label}</span><input inputMode="decimal" value={scheduleFeesPer} onChange={e=>setScheduleFeesPer(e.target.value)} className={field}/></label>
        <label className="space-y-1 text-sm"><span>{t.feesAccount}</span><select value={feesAccount} onChange={e=>setFeesAccount(e.target.value)} className={field}><option value="">—</option>{expenseAccounts.map(a=><option key={a.id} value={a.id}>{a.account_code} · {accountingSystemAccountName(a.system_key, a.name, locale)}</option>)}</select></label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={autoRegister} onChange={e=>{setAutoRegister(e.target.checked);setScheduleRetry(null);}}/>{t.auto}</label>
      </div>
      <button disabled={busy||!selectedLoanData} className="acct-button acct-button-primary" type="submit"><CalendarClock size={16}/>{t.buildSchedule}</button>
    </form>
    {installmentDrafts.length>0&&<form onSubmit={e=>void submitSchedule(e)} className="acct-panel space-y-3 p-4">
      <div className="acct-panel-heading !p-0"><div><h3 className="font-semibold">{t.installments}</h3><p className="mt-1 text-xs text-muted-foreground">{selectedLoanData?.lender} · {installmentDrafts.length.toLocaleString(locale)} {t.count}</p></div></div>
      <div className="acct-table-wrap"><table className="acct-table min-w-[760px]"><thead><tr><th>{t.due}</th><th>{t.principal}</th><th>{t.interest}</th><th>{t.fees}</th><th>{t.total}</th><th>{t.actions}</th></tr></thead><tbody>
        {installmentDrafts.map((row)=>{const p=amountMinor(row.principal,true)??0,i=amountMinor(row.interest||'0',true)??0,f=amountMinor(row.fees||'0',true)??0;return <tr key={row.key}>
          <td><JalaliDateInput aria-label={t.due} min={selectedLoanData?.accounting_start_date} value={row.due_date} onChange={e=>updateDraft(row.key,'due_date',e.target.value)} className={field}/></td>
          <td><input aria-label={t.principal} inputMode="decimal" value={row.principal} onChange={e=>updateDraft(row.key,'principal',e.target.value)} className={field}/></td>
          <td><input aria-label={t.interest} inputMode="decimal" value={row.interest} onChange={e=>updateDraft(row.key,'interest',e.target.value)} className={field}/></td>
          <td><input aria-label={t.fees} inputMode="decimal" value={row.fees} onChange={e=>updateDraft(row.key,'fees',e.target.value)} className={field}/></td>
          <td className="whitespace-nowrap font-semibold">{money(p+i+f)}</td><td><button type="button" className="acct-table-action" onClick={()=>removeDraft(row.key)}>{t.remove}</button></td>
        </tr>;})}
      </tbody></table></div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="acct-kpi-card"><p className="acct-kpi-heading">{t.sumPrincipal}</p><p className="acct-money">{money(installmentDrafts.reduce((s,row)=>s+(amountMinor(row.principal,true)||0),0))}</p></div>
        <div className="acct-kpi-card"><p className="acct-kpi-heading">{t.sumInterest}</p><p className="acct-money">{money(installmentDrafts.reduce((s,row)=>s+(amountMinor(row.interest||'0',true)||0),0))}</p></div>
        <div className="acct-kpi-card"><p className="acct-kpi-heading">{t.sumFees}</p><p className="acct-money">{money(installmentDrafts.reduce((s,row)=>s+(amountMinor(row.fees||'0',true)||0),0))}</p></div>
        <div className="acct-kpi-card"><p className="acct-kpi-heading">{t.sumAll}</p><p className="acct-money">{money(installmentDrafts.reduce((s,row)=>s+(amountMinor(row.principal,true)||0)+(amountMinor(row.interest||'0',true)||0)+(amountMinor(row.fees||'0',true)||0),0))}</p></div>
      </div>
      <div className="flex flex-wrap gap-2"><button type="button" className="acct-button acct-button-secondary" disabled={busy} onClick={addDraft}><Plus size={16}/>{t.addInstallment}</button><button type="submit" disabled={busy||!selectedLoan} className="acct-button acct-button-primary"><CircleCheck size={16}/>{t.registerAll} ({installmentDrafts.length.toLocaleString(locale)})</button></div>
    </form>}
    <div className={card}>
      <h3 className="font-semibold">{t.loans}</h3>
      {!loans.length?<p className="text-sm text-muted-foreground">{t.empty}</p>:loans.map(loan=><article key={loan.id} className="rounded-lg border border-border p-3 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h4 className="font-medium">{loan.lender}</h4><p className="text-sm text-muted-foreground">{loan.mode==='opening'?t.openingMode:t.newMode} · {accountingSystemAccountName(accounts.find((a) => a.name === loan.liability_account_name)?.system_key, loan.liability_account_name, locale)}</p><p className="text-sm text-muted-foreground">{loan.mode==='opening'?`${t.originationDate}: ${loan.origination_date?formatAccountingDate(loan.origination_date, locale, tenant?.calendar):t.originationUnknown} · ${t.accountingStartDate}: ${formatAccountingDate(loan.accounting_start_date, locale, tenant?.calendar)}`:`${t.newDate}: ${formatAccountingDate(loan.origination_date||loan.loan_date, locale, tenant?.calendar)}`}</p><p className="text-sm">{t.remainingLabel}: <strong>{money(loan.remaining_principal_minor)}</strong> · {t.repaid}: {money(loan.principal_repaid_minor)}</p>{loan.mode==='opening'&&<p className="text-sm">{t.historicalRepaid}: {loan.historical_principal_known?money(loan.historical_principal_repaid_minor):t.historicalUnknown}</p>}<p className="text-xs text-muted-foreground">{t.reference}: {loan.initial_entry_number||'—'}{loan.cancellation_entry_number?' · '+(fa?'سند لغو':'cancellation journal')+': '+loan.cancellation_entry_number:''}</p>{loan.cancelled_at&&loan.cancellation_reason&&<p className="text-xs text-muted-foreground">{t.cancelReason}: {loan.cancellation_reason}</p>}</div>
          <div className="flex flex-wrap items-center gap-2"><span className="text-sm">{loan.cancelled_at?t.cancelledLoan:loan.status==='closed'?t.closed:t.active}</span>{loan.status==='active'&&!loan.cancelled_at&&<><button type="button" onClick={()=>setSelectedLoan(loan.id)} className="inline-flex min-h-9 items-center rounded-md border border-border px-3 py-1.5 text-sm font-medium text-brand hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50">{t.selectLoan}</button>{!loan.installments.some(item=>item.status==='settled')&&<><button type="button" disabled={busy} onClick={()=>beginLoanCorrection(loan)} className="inline-flex min-h-9 items-center rounded-md border border-border px-3 py-1.5 text-sm font-medium text-brand hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50">{t.correctLoan}</button><button type="button" disabled={busy} onClick={()=>void cancelLoanRecord(loan)} className="inline-flex min-h-9 items-center rounded-md border border-destructive/30 px-3 py-1.5 text-sm font-medium text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50">{t.cancelLoan}</button></>}</>}</div>
          {loan.status==='active'&&!loan.cancelled_at&&loan.installments.some(item=>item.status==='settled')&&<p className="mt-2 max-w-2xl text-xs text-muted-foreground">{fa?'چون حداقل یک قسط پرداخت واقعی شده، لغو یا بازنویسی کامل وام غیرفعال است تا سابقه پرداخت دست‌کاری نشود؛ برای اصلاح مانده از تعدیل حسابداریِ ثبت‌شده استفاده شود.':'Because at least one installment has been actually paid, full loan cancellation/correction is disabled to preserve payment history. Correct the remaining balance through an audited accounting adjustment.'}</p>}
        </div>
        {loan.mode==='opening'&&!loan.origination_date&&<form onSubmit={e=>void saveLoanOriginationDate(e,loan)} className="flex flex-wrap items-end gap-2 rounded-md border border-border p-3"><label className="space-y-1 text-sm"><span>{t.originationDate}</span><JalaliDateInput required max={loan.accounting_start_date} value={legacyOriginationDates[loan.id]||''} onChange={e=>setLegacyOriginationDates(current=>({...current,[loan.id]:e.target.value}))} className={field}/></label><button disabled={busy||!legacyOriginationDates[loan.id]} className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50">{t.saveOriginationDate}</button></form>}
        {!loan.installments.length?<p className="text-sm text-muted-foreground">{t.noInstallments}</p>:<div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b"><th className="p-2 text-start">{t.due}</th><th className="p-2 text-start">{t.principal}</th><th className="p-2 text-start">{t.interest}</th><th className="p-2 text-start">{t.fees}</th><th className="p-2 text-start">{t.total}</th><th className="p-2 text-start">{t.status}</th><th className="p-2 text-start">{t.dueEntry}</th><th className="p-2 text-start">{t.settlementEntry}</th><th className="p-2 text-start">{t.actions}</th></tr></thead><tbody>{loan.installments.map(item=>{const editing=editingInstallmentId===item.id&&installmentEdit!==null;const editable=['scheduled','awaiting_confirmation','failed'].includes(item.status);return <tr key={item.id} className="border-b border-border/60">
          <td className="p-2 whitespace-nowrap">{editing?<JalaliDateInput aria-label={t.due} min={loan.accounting_start_date||loan.loan_date} value={installmentEdit!.due_date} onChange={e=>setInstallmentEdit(v=>v?{...v,due_date:e.target.value}:v)} className={field}/>:formatAccountingDate(item.due_date, locale, tenant?.calendar)}</td>
          <td className="p-2">{editing?<input aria-label={t.principal} inputMode="decimal" value={installmentEdit!.principal} onChange={e=>setInstallmentEdit(v=>v?{...v,principal:e.target.value}:v)} className={field}/>:money(item.principal_minor)}</td>
          <td className="p-2">{editing?<input aria-label={t.interest} inputMode="decimal" value={installmentEdit!.interest} onChange={e=>setInstallmentEdit(v=>v?{...v,interest:e.target.value}:v)} className={field}/>:money(item.interest_minor)}</td>
          <td className="p-2">{editing?<input aria-label={t.fees} inputMode="decimal" value={installmentEdit!.fees} onChange={e=>setInstallmentEdit(v=>v?{...v,fees:e.target.value}:v)} className={field}/>:money(item.fees_minor)}</td>
          <td className="p-2">{money(editing?(amountMinor(installmentEdit!.principal,true)||0)+(amountMinor(installmentEdit!.interest||'0',true)||0)+(amountMinor(installmentEdit!.fees||'0',true)||0):item.principal_minor+item.interest_minor+item.fees_minor)}</td>
          <td className="p-2">{statusText(item.status)}{item.last_error_message?<span className="block text-xs text-destructive">{accountingErrorMessage(item.last_error_message, locale, t.error)}</span>:null}</td>
          <td className="p-2">{item.due_entry_number||'—'}</td><td className="p-2">{item.settlement_entry_number||'—'}</td>
          <td className="p-2 whitespace-nowrap">
            {editing?<><button type="button" disabled={busy} onClick={()=>void saveInstallmentEdit(item)} className="me-2 inline-flex min-h-9 items-center rounded-md border border-border px-3 py-1.5 text-sm font-medium text-brand hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50">{t.saveChanges}</button><button type="button" disabled={busy} onClick={()=>{setEditingInstallmentId('');setInstallmentEdit(null);}} className="inline-flex min-h-9 items-center rounded-md border border-border px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50">{t.discardEdit}</button></>
             :<>{editable&&<><button type="button" disabled={busy||item.due_date>today()} onClick={()=>void registerInstallment(item)} className="me-2 inline-flex min-h-9 items-center rounded-md border border-border px-3 py-1.5 text-sm font-medium text-brand hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40">{t.register}</button><button type="button" disabled={busy} onClick={()=>beginInstallmentEdit(item)} className="me-2 inline-flex min-h-9 items-center rounded-md border border-border px-3 py-1.5 text-sm font-medium text-brand hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50">{t.editInstallment}</button></>}
              {['scheduled','awaiting_confirmation','failed','registered'].includes(item.status)&&<><button type="button" disabled={busy} onClick={()=>void settleInstallment(item,loan)} className="me-2 inline-flex min-h-9 items-center rounded-md border border-border px-3 py-1.5 text-sm font-medium text-brand hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50">{t.settle}</button><button type="button" disabled={busy} onClick={()=>void cancelInstallment(item)} className="inline-flex min-h-9 items-center rounded-md border border-destructive/30 px-3 py-1.5 text-sm font-medium text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50">{t.cancel}</button></>}</>}
          </td>
        </tr>})}</tbody></table></div>}
      </article>)}
      <p className="text-xs text-muted-foreground">{t.earlyPayment}</p><div className="grid grid-cols-1 gap-3 md:grid-cols-2"><label className="space-y-1 text-sm"><span>{t.settlementDate}</span><JalaliDateInput min={settlementMinDate} value={settlementDate} onChange={e=>setSettlementDate(e.target.value)} className={field}/></label><label className="space-y-1 text-sm"><span>{t.settlementAccount}</span><select value={settlementAccount} onChange={e=>setSettlementAccount(e.target.value)} className={field}>{liquidAccounts.map(a=><option key={a.id} value={a.id}>{a.account_code} · {accountingSystemAccountName(a.system_key, a.name, locale)}</option>)}</select></label></div>
    </div>
  </section>;
}
