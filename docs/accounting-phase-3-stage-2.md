# Phase 3 — Stage 2: policy closure and posting readiness

**Status on PR #19:** Stage 2 policy closure and payment-event identity are implemented on this branch. Runtime sale/collection/refund posting has been added as Stage 3. The final regression workflow must pass on the final branch head before this phase can be marked release-ready.

## 1. Stable payment identities

- Each newly accepted line written by `applyPaymentBatch` carries a generated `payment_event_id` UUID.
- A line's identity is independent of bill ID, payment method, optional processor transaction ID and HTTP request idempotency key.
- A retry returns the persisted bill/payment line, not a newly generated source identity.
- Legacy payment JSON remains readable; no older line is rewritten or backfilled with an accounting journal.
- `tests/integration-payments.test.ts` asserts newly written lines have non-empty, distinct event identities.

## 2. Decisions resolved in the implementation policy

The decisions and reasons are recorded in [accounting-phase-3-policy-proposal.md](accounting-phase-3-policy-proposal.md) and the full worked contract is [accounting-phase-3-operating-rules.md](accounting-phase-3-operating-rules.md).

1. **Recognition:** an explicit finalization endpoint posts the sale from a persisted immutable bill snapshot; the first accepted payment can finalize it in the same SQLite transaction. Bill generation alone never posts revenue.
2. **Sale/charges/tax:** debit Accounts Receivable by the stored bill total, credit Sales Revenue by total minus stored POS tax, and credit a generic internal tax-liability account by that tax amount. Discount, customer charges and payable rounding are already reflected in the total and are not separate Phase 3 journal lines. This is internal management accounting, not jurisdiction-specific tax compliance.
3. **Payment accounts:** cash, card/clearing and wallet/customer-credit liability have safe defaults. Custom methods default to the clearing account and are configurable. Explicit invalid mappings fail closed.
4. **Refunds:** use the committed refund ID and the actual payout method. Partial refund tax is proportionally allocated to cumulative refunds because an arbitrary amount-only refund does not necessarily identify exact tax lines; this limitation is explicit and not a statutory tax allocation.
5. **Cutover:** migration v105 stores `accounting_cutover_at`. Historic bills/refunds are not backfilled. A pre-cutover payment can keep working operationally but records a visible accounting audit exception; explicit finalization of legacy bills is refused.
6. **Dates/amounts:** currency-specific integer minor units and the store's configured timezone/business-day start govern posting amounts/dates.
7. **Other financial movements:** an owner contribution and opening balance are not income; transfers are asset-to-asset; paid expenses post from saved source/account snapshots; inventory cost/COGS remains out of scope.

## 3. Stage 2 exit criteria

- [x] The sale-finalization trigger is explicit and distinct from bill generation.
- [x] Financial treatment for the initial chart (net POS revenue, internal tax liability, collection mappings, refunds, wallet, historical cutover and accounting date) is documented.
- [x] Migration v105 adds the finalization snapshot/link and safe cutover/mapping defaults.
- [x] New payment lines have stable IDs and regression assertions.
- [x] Missing/invalid payment mapping or ledger-write errors cannot be silently accepted as successfully accounted for on post-cutover events.
- [ ] Final focused and full regression suites pass on the final branch head.
- [ ] PR review confirms migration safety, route compatibility and accounting acceptance examples.

Stage 2 is an implementation milestone, not an independent license to merge. The final green run must correspond to the actual final code head.
