import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-accounting-recurring-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};
const { initTestDb, closeDatabase, now } = require('./helpers/test-setup');
const { createRecurringObligation, listRecurringObligations, cancelRecurringObligation } = require('../main/accounting/recurring-obligations');
const { registerFutureItem } = require('../main/accounting/future-items');
const { startAccountingFutureItemScheduler, stopAccountingFutureItemScheduler } = require('../main/accounting/future-items-scheduler');
let assertions=0;
function equal(actual: unknown, expected: unknown, message: string) { require('node:assert/strict').equal(actual,expected,message); assertions++; }
function ok(value: unknown, message: string) { require('node:assert/strict').ok(value,message); assertions++; }
function main() {
 const db=initTestDb();
 try {
  const currency=db.prepare("SELECT value FROM settings WHERE key='currency'").get() as any;
  const country=db.prepare("SELECT value FROM settings WHERE key='country'").get() as any;
  ok(!!currency?.value && !!country?.value,'test database has regional currency settings');
  const expense=db.prepare("SELECT id FROM accounting_accounts WHERE account_type='expense' AND is_active=1 AND is_postable=1 ORDER BY id LIMIT 1").get() as any;
  ok(!!expense?.id,'test database has a valid expense account');
  const payload={frequency:'every_n_days',interval_days:7,first_due_date:'2026-10-01',occurrence_count:3,amount_minor:1200,currency_code:currency.value,description:'Weekly cleaning',counterparty:'Cleaning vendor',classification_account_id:expense.id,auto_register:false};
  const created=createRecurringObligation(db,payload,'test-manager','recurring-test-001');
  equal(created.generated_occurrences,3,'finite schedule creates all three occurrence records');
  const listed=listRecurringObligations(db,{id:created.id});
  equal(listed.length,1,'schedule can be listed');
  equal(listed[0].occurrences.length,3,'occurrence history is available');
  equal(listed[0].occurrences[0].due_date,'2026-10-01','first occurrence preserves anchor date');
  equal(listed[0].occurrences[1].due_date,'2026-10-08','every-N-days uses exact calendar arithmetic');
  equal(listed[0].occurrences[2].due_date,'2026-10-15','every-N-days continues from original anchor');
  equal(listed[0].occurrences[0].status,'scheduled','occurrence remains unpaid until actual settlement');
  const journalCount=(db.prepare("SELECT COUNT(*) AS n FROM accounting_journal_entries WHERE source_type='accounting_future_item'").get() as any).n;
  equal(journalCount,0,'schedule creation does not post journals before due registration');
  const retry=createRecurringObligation(db,payload,'test-manager','recurring-test-001');
  equal(retry.id,created.id,'identical schedule retry returns original schedule');
  equal(retry.duplicate,true,'identical schedule retry is marked duplicate');
  let conflict=false;
  try { createRecurringObligation(db,{...payload,amount_minor:1201},'test-manager','recurring-test-001'); } catch(e:any) { conflict=e.code==='idempotency_conflict' && e.statusCode===409; }
  ok(conflict,'changed payload under same idempotency key conflicts');
  const monthly=createRecurringObligation(db,{...payload,frequency:'monthly',interval_days:undefined,first_due_date:'2026-01-31',occurrence_count:4},'test-manager','recurring-monthly-001');
  const months=listRecurringObligations(db,{id:monthly.id})[0].occurrences.map((o:any)=>o.due_date);
  equal(months[0],'2026-01-31','monthly schedule uses first due date as immutable anchor');
  equal(months[1],'2026-02-28','monthly schedule clamps 31st to shorter month');
  equal(months[2],'2026-03-31','monthly schedule returns to original anchor day without drift');
  equal(months[3],'2026-04-30','monthly schedule clamps 31st in a 30-day month');
  const firstOccurrence=listRecurringObligations(db,{id:created.id})[0].occurrences[0];
  const postedDue=registerFutureItem(db,firstOccurrence.future_item_id,'test-manager','2026-10-22');
  equal(postedDue.status,'registered','test setup registers one occurrence before schedule cancellation');
  const dueJournalId=postedDue.due_journal_entry_id;
  const cancelled=cancelRecurringObligation(db,created.id,'No longer needed','test-manager');
  equal(cancelled.status,'cancelled','schedule cancellation is recorded');
  const cancelledOccurrences=listRecurringObligations(db,{id:created.id})[0].occurrences;
  equal(cancelledOccurrences.find((o:any)=>o.future_item_id===firstOccurrence.future_item_id)?.status,'registered',
    'cancelling a recurring schedule preserves an already-registered occurrence');
  equal(cancelledOccurrences.filter((o:any)=>o.status==='cancelled').length,2,
    'cancellation cancels only the still-unregistered occurrences');
  equal((db.prepare('SELECT status FROM accounting_journal_entries WHERE id=?').get(dueJournalId) as any).status,'posted',
    'cancelling a schedule cannot remove or reverse an already-posted due journal');
  const account=db.prepare("SELECT id FROM accounting_accounts WHERE account_type='asset' AND is_active=1 AND is_postable=1 LIMIT 1").get() as any;
  let invalid=false;
  try { createRecurringObligation(db,{...payload,classification_account_id:account.id},'test-manager','recurring-invalid-account'); } catch(e:any) { invalid=e.code==='invalid_expense_account'; }
  ok(invalid,'asset/liquid account cannot be used as expense classification');

  // Cover the Jalali leap-year boundary: Esfand 30 exists in 1403, but the following Esfand clamps to 29.
  db.prepare("INSERT OR REPLACE INTO settings (key,value,updated_at) VALUES ('country','IR',CURRENT_TIMESTAMP)").run();
  db.prepare("INSERT OR REPLACE INTO settings (key,value,updated_at) VALUES ('currency','IRR',CURRENT_TIMESTAMP)").run();
  equal((db.prepare("SELECT value FROM settings WHERE key='country'").get() as any).value,'IR','Jalali recurrence fixture configures Iran');
  const jalali=createRecurringObligation(db,{
    frequency:'monthly',first_due_date:'2025-03-20',occurrence_count:14,amount_minor:500,
    currency_code:'IRR',description:'Jalali Esfand boundary',classification_account_id:expense.id,auto_register:false,
  },'test-manager','recurring-jalali-esfand-001');
  const jalaliDates=listRecurringObligations(db,{id:jalali.id})[0].occurrences.map((o:any)=>o.due_date);
  equal(jalaliDates[0],'2025-03-20','Jalali schedule retains Esfand 30 anchor in leap year 1403');
  equal(jalaliDates[1],'2025-04-19','Jalali schedule advances to Farvardin 30 after leap Esfand');
  equal(jalaliDates[12],'2026-03-20','non-leap Esfand clamps the original day 30 to day 29');
  equal(jalaliDates[13],'2026-04-19','monthly recurrence returns to original day 30 after Esfand clamp without drift');
  // Exercise the real startup scheduler, not only the due-processing helper.
  // First boot catches up the due occurrence; a subsequent restart must not post twice.
  const startupSchedule=createRecurringObligation(db,{
    frequency:'monthly',first_due_date:'2026-10-01',occurrence_count:1,amount_minor:800,
    currency_code:'IRR',description:'Startup catch-up regression',classification_account_id:expense.id,auto_register:true,
  },'test-manager','recurring-startup-catchup-001');
  const startupOccurrence=listRecurringObligations(db,{id:startupSchedule.id})[0].occurrences[0];
  const startupJournalCountBefore=(db.prepare("SELECT COUNT(*) AS n FROM accounting_journal_entries WHERE source_type='accounting_future_item' AND source_event='due_registration'").get() as any).n;
  try {
    startAccountingFutureItemScheduler();
    equal((db.prepare('SELECT status FROM accounting_future_items WHERE id=?').get(startupOccurrence.future_item_id) as any).status,'registered',
      'scheduler startup catches up the overdue auto-register occurrence');
    const dueJournalId=(db.prepare('SELECT due_journal_entry_id FROM accounting_future_items WHERE id=?').get(startupOccurrence.future_item_id) as any).due_journal_entry_id;
    ok(!!dueJournalId,'startup catch-up records a due journal reference');
    const startupJournalCountAfter=(db.prepare("SELECT COUNT(*) AS n FROM accounting_journal_entries WHERE source_type='accounting_future_item' AND source_event='due_registration'").get() as any).n;
    equal(startupJournalCountAfter-startupJournalCountBefore,1,'first scheduler startup creates exactly one due journal');
    stopAccountingFutureItemScheduler();
    startAccountingFutureItemScheduler();
    stopAccountingFutureItemScheduler();
    equal((db.prepare("SELECT COUNT(*) AS n FROM accounting_journal_entries WHERE source_type='accounting_future_item' AND source_event='due_registration' AND id=?").get(dueJournalId) as any).n,1,
      'scheduler restart does not duplicate the previously registered journal');
    equal((db.prepare("SELECT COUNT(*) AS n FROM accounting_journal_entries WHERE source_type='accounting_future_item' AND source_event='due_registration'").get() as any).n,startupJournalCountAfter,
      'restart does not create an additional due journal for the same occurrence');
  } finally {
    stopAccountingFutureItemScheduler();
  }
  console.log('PASS accounting recurring obligations: '+assertions+' assertions');
 } finally { closeDatabase(); }
}
main();
