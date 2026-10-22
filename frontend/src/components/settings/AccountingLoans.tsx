'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useLocale } from 'use-intl';
import api from '@/lib/api';
import toast from 'react-hot-toast';

type Account = { id:string; account_code:string; name:string; account_type:string; system_key:string|null; is_active:number; is_postable:number };
type Installment = { id:string; due_date:string; principal_minor:number; interest_minor:number; fees_minor:number; status:string; auto_register:number; last_error_message?:string|null; due_entry_number?:string|null; settlement_entry_number?:string|null; settlement_journal_entry_id?:string|null };
type Loan = { id:string; mode:'new'|'opening'; lender:string; loan_date:string; original_principal_minor:number; initial_outstanding_minor:number; remaining_principal_minor:number; principal_repaid_minor:number; currency_code:string; status:string; liability_account_name:string; cash_account_name:string|null; initial_entry_number:string|null; installments:Installment[] };
const today = () => { const d=new Date(); return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10); };
const token = () => typeof crypto!=='undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Date.now())+'-'+Math.random();

export function AccountingLoans() {
  const locale=useLocale();
  const fa=locale.toLowerCase().startsWith('fa');
  const [accounts,setAccounts]=useState<Account[]>([]);
  const [loans,setLoans]=useState<Loan[]>([]);
  const [currency,setCurrency]=useState('IRR');
  const [digits,setDigits]=useState(0);
  const [mode,setMode]=useState<'new'|'opening'>('new');
  const [lender,setLender]=useState('');
  const [loanDate,setLoanDate]=useState(today());
  const [originalAmount,setOriginalAmount]=useState('');
  const [remainingAmount,setRemainingAmount]=useState('');
  const [liabilityAccount,setLiabilityAccount]=useState('');
  const [cashAccount,setCashAccount]=useState('');
  const [selectedLoan,setSelectedLoan]=useState('');
  const [dueDate,setDueDate]=useState(today());
  const [principal,setPrincipal]=useState('');
  const [interest,setInterest]=useState('');
  const [fees,setFees]=useState('');
  const [interestAccount,setInterestAccount]=useState('');
  const [feesAccount,setFeesAccount]=useState('');
  const [autoRegister,setAutoRegister]=useState(false);
  const [settlementDate,setSettlementDate]=useState(today());
  const [settlementAccount,setSettlementAccount]=useState('');
  const [busy,setBusy]=useState(false);
  const t=fa?{
    title:'وام‌ها',note:'دریافت وام درآمد نیست. بازپرداخت اصل وام بدهی را کم می‌کند و فقط سود و کارمزد در حساب هزینه ثبت می‌شوند. ثبت خودکار یعنی ثبت سررسید، نه پرداخت خودکار؛ خروج وجه فقط پس از تأیید پرداخت واقعی ثبت می‌شود.',
    newLoan:'ثبت وام',mode:'نوع ثبت',newMode:'وام جدید و دریافت وجه',openingMode:'وام قبلی؛ ثبت مانده بدهی',lender:'وام‌دهنده',date:'تاریخ دریافت / تاریخ مبنا',original:'اصل اولیه وام',remaining:'مانده اصل بدهی فعلی',liability:'حساب بدهی وام',cash:'حساب واقعی دریافت وجه',create:'ثبت وام',loans:'وام‌های ثبت‌شده',empty:'وامی ثبت نشده است',remainingLabel:'مانده اصل',repaid:'اصل بازپرداخت‌شده',reference:'سند اولیه',schedule:'ثبت قسط از برنامه وام‌دهنده',selectLoan:'انتخاب وام',due:'سررسید قسط',principal:'اصل قسط',interest:'سود قسط',fees:'کارمزد',interestAccount:'حساب هزینه سود',feesAccount:'حساب هزینه کارمزد',auto:'ثبت خودکار سررسید',addInstallment:'ثبت قسط',installments:'اقساط',status:'وضعیت',total:'مجموع قسط',register:'ثبت سررسید',settle:'تأیید پرداخت واقعی',settlementDate:'تاریخ پرداخت واقعی',settlementAccount:'حساب صندوق / بانک پرداخت',cancel:'لغو قسط',cancelReason:'دلیل لغو قسط',dueEntry:'سند سررسید',settlementEntry:'سند پرداخت',actions:'عملیات',active:'فعال',closed:'تسویه‌شده',scheduled:'در انتظار سررسید',awaiting_confirmation:'در انتظار تأیید ثبت سررسید',registered:'سررسید ثبت‌شده؛ پرداخت نشده',failed:'خطای ثبت؛ نیازمند تلاش مجدد',settled:'پرداخت‌شده',cancelled:'لغوشده',required:'اطلاعات ضروری و مبلغ معتبر را وارد کنید.',saved:'ثبت شد.',error:'عملیات انجام نشد؛ اطلاعات و وضعیت حسابداری را بررسی کنید.',noInstallments:'قسطی ثبت نشده است.'
  }:{
    title:'Loans',note:'Loan proceeds are not income. Principal repayment reduces the liability; only interest and fees post to expense accounts. Automatic mode registers a due event, not an automatic payment. Cash/bank outflow is recorded only after actual payment is confirmed.',
    newLoan:'Register loan',mode:'Record type',newMode:'New loan; funds received',openingMode:'Existing loan; opening liability',lender:'Lender',date:'Receipt / opening date',original:'Original principal',remaining:'Current remaining principal',liability:'Loan liability account',cash:'Actual proceeds account',create:'Save loan',loans:'Registered loans',empty:'No loans recorded',remainingLabel:'Remaining principal',repaid:'Principal repaid',reference:'Initial journal',schedule:'Add installment from lender schedule',selectLoan:'Select loan',due:'Installment due date',principal:'Principal',interest:'Interest',fees:'Fees',interestAccount:'Interest expense account',feesAccount:'Fee expense account',auto:'Automatically register due event',addInstallment:'Add installment',installments:'Installments',status:'Status',total:'Installment total',register:'Register due event',settle:'Confirm actual payment',settlementDate:'Actual payment date',settlementAccount:'Actual cash / bank account',cancel:'Cancel installment',cancelReason:'Cancellation reason',dueEntry:'Due journal',settlementEntry:'Payment journal',actions:'Actions',active:'Active',closed:'Paid off',scheduled:'Scheduled',awaiting_confirmation:'Awaiting due registration',registered:'Due registered; unpaid',failed:'Registration failed; retry required',settled:'Paid',cancelled:'Cancelled',required:'Enter valid required fields and amounts.',saved:'Saved.',error:'Operation failed. Check inputs and accounting state.',noInstallments:'No installments recorded.'
  };
  const load=useCallback(async()=>{
    const [a,l]=await Promise.all([api.get('/accounting/accounts'),api.get('/accounting/loans')]);
    const rows:Account[]=a.data.accounts||[];
    setAccounts(rows); setLoans(l.data.loans||[]);
    const code=a.data.currency_code||'IRR'; setCurrency(code);
    try{setDigits(new Intl.NumberFormat(locale,{style:'currency',currency:code}).resolvedOptions().maximumFractionDigits??0);}catch{setDigits(0);}
    const liquid=rows.filter(x=>x.account_type==='asset'&&x.is_active===1&&x.is_postable===1&&['cash_drawer','bank_accounts','payment_clearing'].includes(x.system_key||''));
    setCashAccount(current=>liquid.some(x=>x.id===current)?current:(liquid[0]?.id||''));
    setSettlementAccount(current=>liquid.some(x=>x.id===current)?current:(liquid[0]?.id||''));
    const liabilities=rows.filter(x=>x.account_type==='liability'&&x.is_active===1&&x.is_postable===1&&(!x.system_key||x.system_key==='loans_payable'));
    setLiabilityAccount(current=>liabilities.some(x=>x.id===current)?current:(liabilities.find(x=>x.system_key==='loans_payable')?.id||liabilities[0]?.id||''));
    const expenses=rows.filter(x=>x.account_type==='expense'&&x.is_active===1&&x.is_postable===1);
    setInterestAccount(current=>expenses.some(x=>x.id===current)?current:(expenses[0]?.id||''));
    setFeesAccount(current=>expenses.some(x=>x.id===current)?current:(expenses[0]?.id||''));
    setSelectedLoan(current=>l.data.loans?.some((x:Loan)=>x.id===current&&x.status==='active')?current:(l.data.loans?.find((x:Loan)=>x.status==='active')?.id||''));
  },[locale]);
  useEffect(()=>{void Promise.resolve().then(()=>load()).catch(()=>toast.error(t.error));},[load,t.error]);
  const money=useMemo(()=> (value:number)=>new Intl.NumberFormat(locale,{style:'currency',currency,maximumFractionDigits:digits}).format(value/(10**digits)),[locale,currency,digits]);
  const liquidAccounts=accounts.filter(a=>a.account_type==='asset'&&a.is_active===1&&a.is_postable===1&&['cash_drawer','bank_accounts','payment_clearing'].includes(a.system_key||''));
  const liabilityAccounts=accounts.filter(a=>a.account_type==='liability'&&a.is_active===1&&a.is_postable===1&&(!a.system_key||a.system_key==='loans_payable'));
  const expenseAccounts=accounts.filter(a=>a.account_type==='expense'&&a.is_active===1&&a.is_postable===1);
  function amountMinor(raw:string,allowZero=false):number|null{
    const normalized=raw.trim().replace(/[۰-۹]/g,d=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g,d=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[٬,]/g,'').replace(/٫/g,'.');
    if(!/^\d+(\.\d+)?$/.test(normalized))return null;
    const [whole,fraction='']=normalized.split('.');
    if(fraction.length>digits)return null;
    const result=Number(whole)*(10**digits)+Number((fraction+'0'.repeat(digits)).slice(0,digits)||'0');
    return Number.isSafeInteger(result)&&(allowZero?result>=0:result>0)?result:null;
  }
  async function createLoan(e:FormEvent){
    e.preventDefault();
    const remaining=mode==='opening'?amountMinor(remainingAmount):amountMinor(originalAmount);
    const original=mode==='opening'?(originalAmount.trim()?amountMinor(originalAmount):remaining):remaining;
    if(!lender.trim()||!loanDate||!original||!remaining||!liabilityAccount||(mode==='new'&&!cashAccount)){toast.error(t.required);return;}
    setBusy(true);
    try{
      await api.post('/accounting/loans',{mode,lender:lender.trim(),loan_date:loanDate,original_principal_minor:original,principal_minor:original,remaining_principal_minor:remaining,liability_account_id:liabilityAccount,cash_account_id:mode==='new'?cashAccount:null,currency_code:currency},{headers:{'Idempotency-Key':token()}});
      setLender('');setOriginalAmount('');setRemainingAmount('');toast.success(t.saved);await load();
    }catch{toast.error(t.error);}finally{setBusy(false);}
  }
  async function addInstallment(e:FormEvent){
    e.preventDefault();
    const p=amountMinor(principal,true),i=amountMinor(interest||'0',true),f=amountMinor(fees||'0',true);
    if(!selectedLoan||!dueDate||p===null||i===null||f===null||p+i+f<=0||(i>0&&!interestAccount)||(f>0&&!feesAccount)){toast.error(t.required);return;}
    setBusy(true);
    try{
      await api.post('/accounting/loans/'+encodeURIComponent(selectedLoan)+'/installments',{installments:[{due_date:dueDate,principal_minor:p,interest_minor:i,fees_minor:f,interest_account_id:i>0?interestAccount:null,fees_account_id:f>0?feesAccount:null,auto_register:autoRegister}]},{headers:{'Idempotency-Key':token()}});
      setPrincipal('');setInterest('');setFees('');toast.success(t.saved);await load();
    }catch{toast.error(t.error);}finally{setBusy(false);}
  }
  async function registerInstallment(item:Installment){
    setBusy(true);try{await api.post('/accounting/loan-installments/'+encodeURIComponent(item.id)+'/register',{});await load();}catch{toast.error(t.error);}finally{setBusy(false);}
  }
  async function settleInstallment(item:Installment){
    if(!settlementDate||!settlementAccount){toast.error(t.required);return;}
    setBusy(true);try{await api.post('/accounting/loan-installments/'+encodeURIComponent(item.id)+'/settle',{settlement_date:settlementDate,settlement_account_id:settlementAccount},{headers:{'Idempotency-Key':token()}});await load();}catch{toast.error(t.error);}finally{setBusy(false);}
  }
  async function cancelInstallment(item:Installment){
    const reason=window.prompt(t.cancelReason);if(!reason?.trim())return;
    setBusy(true);try{await api.post('/accounting/loan-installments/'+encodeURIComponent(item.id)+'/cancel',{reason:reason.trim()});await load();}catch{toast.error(t.error);}finally{setBusy(false);}
  }
  const statusText=(status:string)=>(t as Record<string,string>)[status]||status;
  const card='rounded-xl border border-border bg-card p-4 space-y-3';
  const field='w-full rounded-lg border border-border bg-card px-3 py-2 text-sm';
  return <section dir={fa?'rtl':'ltr'} className="w-full max-w-6xl space-y-5">
    <h2 className="text-xl font-semibold">{t.title}</h2>
    <p className="rounded-lg border border-border p-3 text-sm text-muted-foreground">{t.note}</p>
    <form onSubmit={e=>void createLoan(e)} className={card}>
      <h3 className="font-semibold">{t.newLoan}</h3>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <label className="space-y-1 text-sm"><span>{t.mode}</span><select value={mode} onChange={e=>setMode(e.target.value as 'new'|'opening')} className={field}><option value="new">{t.newMode}</option><option value="opening">{t.openingMode}</option></select></label>
        <label className="space-y-1 text-sm"><span>{t.lender}</span><input required maxLength={200} value={lender} onChange={e=>setLender(e.target.value)} className={field}/></label>
        <label className="space-y-1 text-sm"><span>{t.date}</span><input required type="date" value={loanDate} onChange={e=>setLoanDate(e.target.value)} className={field}/></label>
        <label className="space-y-1 text-sm"><span>{mode==='opening'?(fa?'اصل اولیه وام (در صورت اطلاع)':'Original principal (if known)'):t.original} · {currency}</span><input required={mode==='new'} inputMode="decimal" value={originalAmount} onChange={e=>setOriginalAmount(e.target.value)} className={field}/></label>
        {mode==='opening'&&<label className="space-y-1 text-sm"><span>{t.remaining} · {currency}</span><input required inputMode="decimal" value={remainingAmount} onChange={e=>setRemainingAmount(e.target.value)} className={field}/></label>}
        <label className="space-y-1 text-sm"><span>{t.liability}</span><select required value={liabilityAccount} onChange={e=>setLiabilityAccount(e.target.value)} className={field}><option value="">—</option>{liabilityAccounts.map(a=><option key={a.id} value={a.id}>{a.account_code} · {a.name}</option>)}</select></label>
        {mode==='new'&&<label className="space-y-1 text-sm"><span>{t.cash}</span><select required value={cashAccount} onChange={e=>setCashAccount(e.target.value)} className={field}><option value="">—</option>{liquidAccounts.map(a=><option key={a.id} value={a.id}>{a.account_code} · {a.name}</option>)}</select></label>}
      </div>
      <button disabled={busy||!liabilityAccounts.length||(mode==='new'&&!liquidAccounts.length)} className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{t.create}</button>
    </form>
    <form onSubmit={e=>void addInstallment(e)} className={card}>
      <h3 className="font-semibold">{t.schedule}</h3>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <label className="space-y-1 text-sm"><span>{t.selectLoan}</span><select required value={selectedLoan} onChange={e=>setSelectedLoan(e.target.value)} className={field}><option value="">—</option>{loans.filter(l=>l.status==='active').map(l=><option key={l.id} value={l.id}>{l.lender} · {money(l.remaining_principal_minor)}</option>)}</select></label>
        <label className="space-y-1 text-sm"><span>{t.due}</span><input required type="date" value={dueDate} onChange={e=>setDueDate(e.target.value)} className={field}/></label>
        <label className="space-y-1 text-sm"><span>{t.principal} · {currency}</span><input required inputMode="decimal" value={principal} onChange={e=>setPrincipal(e.target.value)} className={field}/></label>
        <label className="space-y-1 text-sm"><span>{t.interest} · {currency}</span><input inputMode="decimal" value={interest} onChange={e=>setInterest(e.target.value)} className={field}/></label>
        <label className="space-y-1 text-sm"><span>{t.interestAccount}</span><select value={interestAccount} onChange={e=>setInterestAccount(e.target.value)} className={field}><option value="">—</option>{expenseAccounts.map(a=><option key={a.id} value={a.id}>{a.account_code} · {a.name}</option>)}</select></label>
        <label className="space-y-1 text-sm"><span>{t.fees} · {currency}</span><input inputMode="decimal" value={fees} onChange={e=>setFees(e.target.value)} className={field}/></label>
        <label className="space-y-1 text-sm"><span>{t.feesAccount}</span><select value={feesAccount} onChange={e=>setFeesAccount(e.target.value)} className={field}><option value="">—</option>{expenseAccounts.map(a=><option key={a.id} value={a.id}>{a.account_code} · {a.name}</option>)}</select></label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={autoRegister} onChange={e=>setAutoRegister(e.target.checked)}/>{t.auto}</label>
      </div>
      <button disabled={busy||!selectedLoan} className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{t.addInstallment}</button>
    </form>
    <div className={card}>
      <h3 className="font-semibold">{t.loans}</h3>
      {!loans.length?<p className="text-sm text-muted-foreground">{t.empty}</p>:loans.map(loan=><article key={loan.id} className="rounded-lg border border-border p-3 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h4 className="font-medium">{loan.lender}</h4><p className="text-sm text-muted-foreground">{loan.mode==='opening'?t.openingMode:t.newMode} · {loan.liability_account_name} · {loan.loan_date}</p><p className="text-sm">{t.remainingLabel}: <strong>{money(loan.remaining_principal_minor)}</strong> · {t.repaid}: {money(loan.principal_repaid_minor)}</p><p className="text-xs text-muted-foreground">{t.reference}: {loan.initial_entry_number||'—'}</p></div>
          <div className="flex items-center gap-2"><span className="text-sm">{loan.status==='closed'?t.closed:t.active}</span>{loan.status==='active'&&<button type="button" onClick={()=>setSelectedLoan(loan.id)} className="text-sm text-brand underline">{t.selectLoan}</button>}</div>
        </div>
        {!loan.installments.length?<p className="text-sm text-muted-foreground">{t.noInstallments}</p>:<div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b"><th className="p-2 text-start">{t.due}</th><th className="p-2 text-start">{t.principal}</th><th className="p-2 text-start">{t.interest}</th><th className="p-2 text-start">{t.fees}</th><th className="p-2 text-start">{t.total}</th><th className="p-2 text-start">{t.status}</th><th className="p-2 text-start">{t.dueEntry}</th><th className="p-2 text-start">{t.settlementEntry}</th><th className="p-2 text-start">{t.actions}</th></tr></thead><tbody>{loan.installments.map(item=><tr key={item.id} className="border-b border-border/60"><td className="p-2 whitespace-nowrap">{item.due_date}</td><td className="p-2">{money(item.principal_minor)}</td><td className="p-2">{money(item.interest_minor)}</td><td className="p-2">{money(item.fees_minor)}</td><td className="p-2">{money(item.principal_minor+item.interest_minor+item.fees_minor)}</td><td className="p-2">{statusText(item.status)}{item.last_error_message?<span className="block text-xs text-destructive">{item.last_error_message}</span>:null}</td><td className="p-2">{item.due_entry_number||'—'}</td><td className="p-2">{item.settlement_entry_number||'—'}</td><td className="p-2 whitespace-nowrap">{['scheduled','awaiting_confirmation','failed'].includes(item.status)&&<><button type="button" disabled={busy||item.due_date>today()} onClick={()=>void registerInstallment(item)} className="me-2 text-brand underline disabled:opacity-40">{t.register}</button><button type="button" disabled={busy} onClick={()=>void cancelInstallment(item)} className="text-brand underline">{t.cancel}</button></>}{['registered'].includes(item.status)&&<button type="button" disabled={busy} onClick={()=>void settleInstallment(item)} className="text-brand underline">{t.settle}</button>}</td></tr>)}</tbody></table></div>}
      </article>)}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2"><label className="space-y-1 text-sm"><span>{t.settlementDate}</span><input type="date" value={settlementDate} onChange={e=>setSettlementDate(e.target.value)} className={field}/></label><label className="space-y-1 text-sm"><span>{t.settlementAccount}</span><select value={settlementAccount} onChange={e=>setSettlementAccount(e.target.value)} className={field}>{liquidAccounts.map(a=><option key={a.id} value={a.id}>{a.account_code} · {a.name}</option>)}</select></label></div>
    </div>
  </section>;
}
