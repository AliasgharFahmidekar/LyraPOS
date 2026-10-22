import * as assert from 'node:assert/strict';
import { getAccountingSourceEventReconciliation } from '../main/accounting/source-reconciliation';

type Fixture = {
  cutoff?: string;
  bills?: Array<{ id: number; created_at: string; payment_details: string }>;
  refunds?: Array<{ id: number; bill_id: number; amount_cents: number; method: string; created_at: string; bill_created_at: string }>;
  expenses?: Array<{ id: string; payment_date: string; expense_date: string; amount_minor: number; payment_method_key: string; payment_status: string; status: string; posted_journal_entry_id: string | null }>;
  journals?: Array<{ source_type: string; source_id: string; source_event: string; id: string; entry_number: string; status: string }>;
};

function fakeDb(fixture: Fixture): any {
  return {
    prepare(sql: string) {
      return {
        get(...args: any[]) {
          if (sql.includes("SELECT value FROM settings")) return fixture.cutoff ? { value: fixture.cutoff } : undefined;
          return undefined;
        },
        all(...args: any[]) {
          if (sql.includes("SELECT key, value FROM settings WHERE key IN ('country','currency','timezone')")) {
            return [
              { key: 'country', value: 'IN' },
              { key: 'currency', value: 'INR' },
              { key: 'timezone', value: 'Asia/Kolkata' },
            ];
          }
          if (sql.includes('FROM bills WHERE payment_details')) return fixture.bills || [];
          if (sql.includes('FROM refunds r JOIN bills')) return fixture.refunds || [];
          if (sql.includes('FROM accounting_expenses WHERE payment_status')) return fixture.expenses || [];
          if (sql.includes('FROM accounting_journal_entries WHERE source_type')) {
            return (fixture.journals || []).filter((j) => j.source_type === args[0] && j.source_id === args[1] && j.source_event === args[2]);
          }
          return [];
        },
      };
    },
  };
}

function test(name: string, fn: () => void): void {
  fn();
  process.stdout.write('✓ ' + name + '\n');
}

test('reconciles one real-money receipt against exactly one posted journal', () => {
  const result = getAccountingSourceEventReconciliation(fakeDb({
    cutoff: '2026-10-01T00:00:00Z',
    bills: [{ id: 10, created_at: '2026-10-02 12:00:00', payment_details: JSON.stringify([{ payment_event_id: 'evt-1', method: 'cash', amount: 1200, timestamp: '2026-10-02 12:01:00' }]) }],
    journals: [{ source_type: 'bill_payment', source_id: '10:evt-1', source_event: 'money_received', id: 'j-1', entry_number: 'JE-1', status: 'posted' }],
  }));
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].status, 'posted_once');
  assert.deepEqual(result.events[0].journal_entry_ids, ['j-1']);
  assert.equal(result.read_only, true);
});

test('wallet activity is excluded and a missing monetary event identity is visible', () => {
  const result = getAccountingSourceEventReconciliation(fakeDb({
    cutoff: '2026-10-01T00:00:00Z',
    bills: [{ id: 11, created_at: '2026-10-02 12:00:00', payment_details: JSON.stringify([
      { payment_event_id: 'wallet-1', method: 'wallet', amount: 900 },
      { method: 'card', amount: 300, timestamp: '2026-10-02 12:02:00' },
    ]) }],
  }));
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].status, 'missing_source_identity');
});

test('pre-cutover receipt is shown as intentionally skipped, not auto-posted', () => {
  const result = getAccountingSourceEventReconciliation(fakeDb({
    cutoff: '2026-10-02T12:00:00Z',
    bills: [{ id: 12, created_at: '2024-01-01 11:59:00', payment_details: JSON.stringify([{ payment_event_id: 'old-1', method: 'cash', amount: 500, timestamp: '2026-10-02T11:59:00Z' }]) }],
  }));
  assert.equal(result.events[0].status, 'skipped_pre_cutover');
  assert.deepEqual(result.events[0].journal_entry_ids, []);
});

test('post-cutover receipt on a legacy bill is reconciled by receipt timestamp', () => {
  const result = getAccountingSourceEventReconciliation(fakeDb({
    cutoff: '2026-10-02T12:00:00Z',
    bills: [{ id: 14, created_at: '2024-01-01 10:00:00', payment_details: JSON.stringify([
      { payment_event_id: 'late-payment-1', method: 'cash', amount: 500, timestamp: '2026-10-02T12:05:00Z' },
    ]) }],
  }));
  assert.equal(result.events[0].status, 'missing_journal', 'a post-cutover receipt is not skipped merely because its bill is old');
  assert.equal(result.events[0].source_id, '14:late-payment-1');
});

test('a receipt without its own timestamp remains an unresolved exception', () => {
  const result = getAccountingSourceEventReconciliation(fakeDb({
    cutoff: '2026-10-02T12:00:00Z',
    bills: [{ id: 15, created_at: '2024-01-01 10:00:00', payment_details: JSON.stringify([
      { payment_event_id: 'timestamp-missing-1', method: 'cash', amount: 500 },
    ]) }],
  }));
  assert.equal(result.events[0].status, 'missing_source_identity');
  assert.equal(result.events[0].event_date, null);
});

test('post-cutover refund on a legacy bill is reconciled by refund timestamp', () => {
  const result = getAccountingSourceEventReconciliation(fakeDb({
    cutoff: '2026-10-02T12:00:00Z',
    refunds: [{ id: 16, bill_id: 99, amount_cents: 500, method: 'cash', created_at: '2026-10-02T12:05:00Z', bill_created_at: '2024-01-01T10:00:00Z' }],
  }));
  assert.equal(result.events[0].status, 'missing_journal', 'a post-cutover refund is not skipped because its bill was created before cutover');
  assert.equal(result.events[0].event_date, '2026-10-02T12:05:00Z');
});

test('legacy pre-cutover payment line without timestamp or event ID is excluded under the explicit no-backfill policy', () => {
  const result = getAccountingSourceEventReconciliation(fakeDb({
    cutoff: '2026-10-02T12:00:00Z',
    bills: [{ id: 17, created_at: '2024-03-01 10:00:00', payment_details: JSON.stringify([
      { method: 'cash', amount: 500 },
    ]) }],
  }));
  assert.equal(result.events[0].status, 'skipped_pre_cutover');
  assert.equal(result.events[0].event_date, null);
  assert.match(result.events[0].reason || '', /no event ID or timestamp/i);
});

test('date range and limit validation reject invalid filters', () => {
  const db = fakeDb({});
  assert.throws(() => getAccountingSourceEventReconciliation(db, { from: '2026-02-30' }), /real calendar date/);
  assert.throws(() => getAccountingSourceEventReconciliation(db, { from: '2026-10-20', to: '2026-10-01' }), /on or before/);
  assert.throws(() => getAccountingSourceEventReconciliation(db, { limit: 2001 }), /between 1 and 2000/);
});

test('a missing journal is an exception and not silently repaired', () => {
  const result = getAccountingSourceEventReconciliation(fakeDb({
    cutoff: '2026-10-01T00:00:00Z',
    bills: [{ id: 13, created_at: '2026-10-02 12:00:00', payment_details: JSON.stringify([{ payment_event_id: 'evt-missing', method: 'card', amount: 100, timestamp: '2026-10-02T12:01:00Z' }]) }],
  }));
  assert.equal(result.events[0].status, 'missing_journal');
  assert.equal(result.events[0].journal_entry_ids.length, 0);
  assert.equal(result.events[0].reason, 'No journal entry matches this operational source event.');
});

process.stdout.write('Accounting source reconciliation: 5 assertions groups passed.\n');
