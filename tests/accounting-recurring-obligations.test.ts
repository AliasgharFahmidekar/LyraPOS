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
  const cancelled=cancelRecurringObligation(db,created.id,'No longer needed','test-manager');
  equal(cancelled.status,'cancelled','schedule cancellation is recorded');
  equal(listRecurringObligations(db,{id:created.id})[0].occurrences.every((o:any)=>o.status==='cancelled'),true,'cancellation cancels unregistered future occurrences');
  const account=db.prepare("SELECT id FROM accounting_accounts WHERE account_type='asset' AND is_active=1 AND is_postable=1 LIMIT 1").get() as any;
  let invalid=false;
  try { createRecurringObligation(db,{...payload,classification_account_id:account.id},'test-manager','recurring-invalid-account'); } catch(e:any) { invalid=e.code==='invalid_expense_account'; }
  ok(invalid,'asset/liquid account cannot be used as expense classification');
  console.log('PASS accounting recurring obligations: '+assertions+' assertions');
 } finally { closeDatabase(); }
}
main();
