import { getDatabase } from '../db';
import { processDueFutureItems } from './future-items';

const FUTURE_ITEM_POLL_INTERVAL_MS = 60_000;
let timer: NodeJS.Timeout | null = null;
let stopped = false;
let processing = false;

/**
 * Runs due one-off receipts/cheques after database startup and while the desktop app is
 * running. Settlement is never automated: the due handler only records the scheduled
 * accounting event and leaves the cash/bank leg for an explicit settlement confirmation.
 */
export function startAccountingFutureItemScheduler(): void {
  if (timer) return;
  stopped = false;
  const tick = () => {
    if (stopped || processing) return;
    processing = true;
    try {
      const result = processDueFutureItems(getDatabase());
      if (result.checked > 0) {
        console.info('[Accounting] Future-item due pass:', result);
      }
    } catch (error) {
      // This must not crash or block POS startup. Due items remain persisted and can be
      // retried; the scheduler will run again on the next interval.
      console.error('[Accounting] Future-item due pass failed:', error);
    } finally {
      processing = false;
    }
  };
  tick();
  timer = setInterval(tick, FUTURE_ITEM_POLL_INTERVAL_MS);
  timer.unref?.();
}

export function stopAccountingFutureItemScheduler(): void {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = null;
}
