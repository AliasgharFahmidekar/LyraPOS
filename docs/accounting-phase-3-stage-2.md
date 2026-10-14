# Phase 3 — Stage 2: policy closure and posting-readiness work

**Status:** In progress; the payment-event identity slice is CI-verified. The current policy proposal is documented in [accounting-phase-3-policy-proposal.md](accounting-phase-3-policy-proposal.md). Automatic sales, collection, loyalty and refund journal posting remains disabled until the owner approves the financial-policy checklist and the implementation/tests for the resulting policies pass.

## 1. Changes implemented in this slice

- New payment lines written by `applyPaymentBatch` receive a generated `payment_event_id` (UUID) before they are persisted into `bills.payment_details`.
- Each payment line in one batch receives its own ID, independent of the bill ID, payment method, optional processor transaction ID, or HTTP idempotency key.
- A request replay returns the already-persisted bill/payment lines; it does not generate replacement identities.
- Existing legacy payment JSON is still readable. No historical line is silently rewritten and no historical journal is backfilled.
- `tests/integration-payments.test.ts` asserts that newly persisted payment lines have non-empty, distinct event identities.

This is an additive change to the existing POS payment flow. It does not change applied amounts, cash tender/change calculations, payment status, wallet debits, order completion, or payment request idempotency.

## 2. Posting policies that can be treated as implementation invariants

These are safety invariants rather than jurisdiction-specific accounting advice:

1. A bill generated but not financially finalized must not automatically create a revenue journal.
2. Every newly accepted payment line is a distinct collection event. Use its persisted `payment_event_id` as the stable identity; the bill ID alone is insufficient for partial/split collections.
3. Collection amount is the persisted applied `amount`, never `tendered_amount` or `requested_amount`; this avoids recording cash change as a collection.
4. A custom payment method resolves by `custom:<payment_method_id>`, never by translated/display name.
5. A refund is sourced only from its committed `refunds.id` row. The payout account follows the actual refund method, which can differ from the original collection method.
6. Wallet redemption/store-credit refund must not be treated as cash/bank movement.
7. Existing ledger source identity, payload-hash idempotency, active/postable-account validation, integer minor units, and exact balancing remain mandatory.
8. Legacy transactions are not silently posted on upgrade. Any future cutover/backfill must be explicit and reconciled.
9. Tax, payment or refund entries must fail closed if the required account mapping or approved treatment is missing. Do not create placeholder accounts or silently omit a financial line.

## 3. Product decisions still required before runtime journals can be enabled

Concrete recommended defaults and the approval checklist are now recorded in [accounting-phase-3-policy-proposal.md](accounting-phase-3-policy-proposal.md). These are proposals only, not silently treated as approved product decisions.

The current repository does not contain an approved business decision for the following. They must not be guessed in code:

### A. Revenue-recognition trigger
The existing bill-generation endpoint can resynchronize an unpaid bill, so it is not a safe finalization event. Select one policy:
- **Accrual / explicit finalization (recommended):** add an explicit immutable bill-finalization action/snapshot; recognize the sale then, and record later collections against receivables.
- **Cash basis:** recognize revenue only as payment is accepted, with a defined allocation for partial and split payments. This does not create receivables for unpaid bills and has different reporting meaning.

Do not use order completion or `paid_at` as an implicit proxy without an explicit decision.

### B. Tax and charge allocation
The bill persists tax snapshots and separate discount, delivery, packaging, service, table, takeaway and rounding amounts. There is no approved jurisdiction-neutral rule that determines which of these amounts are taxable or which tax-liability account applies. The current starter chart does not supply a universal tax-payable mapping.

Until configured and approved, a tax-bearing bill must not be posted as if its tax treatment were known. The system must not claim statutory compliance.

### C. Loyalty valuation
The POS uses a configured/fixed redemption calculation for points and stores loyalty-ledger amounts in points, not in currency minor units. The approved accounting value for reward liability, cashback expense/contra-revenue and any rounding must be recorded before those events are journaled. A wallet-funded payment's currency amount is not permission to infer the value of all outstanding points.

### D. Historical cutover and opening balances
Choose an effective date for automatic posting. Recommended safe default: no automatic posting of pre-activation bills/payments/refunds; reconcile opening balances separately before the cutover. If a historical backfill is required, it needs a separate idempotent reconciliation plan and must not double-post existing activity.

### E. Accounting date and closed periods
The ledger currently accepts a validated calendar date, but the source events have timestamps and store-local business-day rules. Confirm whether source event time maps to the store's business date and whether posting into a closed period is prohibited or adjusted in the next open period.

## 4. Technical sequence after decisions are approved

1. Add forward-only migration fields for immutable sale finalization/snapshot and test fresh install plus upgrades from populated v104 databases. Never edit old migrations or rewrite historical bills.
2. Implement a pure builder that turns a finalized persisted bill snapshot into balanced journal lines in configured currency minor units. Tax/charge allocation must be policy-driven and fail closed when incomplete.
3. Atomically finalize the sale and post its journal; add each new payment collection journal inside the same SQLite transaction as the source payment mutation wherever feasible.
4. Post committed refund rows atomically with refund creation, resolving the actual payout method to an explicit account key.
5. Add retry, rollback/failure-injection, split-check, partial-payment, refund, legacy-cutover and reconciliation tests. Preserve the current POS payment/refund behavior.
6. Only enable automatic posting after the decision gates and the full regression workflow are green.

## 5. Acceptance status

- [x] New payment lines receive unique, persisted `payment_event_id` values.
- [x] Payment integration test asserts non-empty and distinct event IDs.
- [x] Legacy payment JSON remains compatible; no automatic historical backfill.
- [ ] Approve revenue-recognition basis and finalization trigger.
- [ ] Approve tax/discount/charge allocation and required account mapping.
- [ ] Approve loyalty reward valuation.
- [ ] Approve effective cutover/opening-balance policy.
- [ ] Approve accounting-date/closed-period behavior.
- [ ] Implement finalization snapshot, sale/collection/refund posting and full regression coverage.

## 6. Verification of the current Stage 2 slice

- [x] GitHub Actions regression run [#316](https://github.com/AliasgharFahmidekar/LyraPOS/actions/runs/38548162343) passed for commit `27fccc7f3fda7caf51c28c9e8e431bd56bf94d72`, including dependency installation, canonical i18n/print-label verification, the original regression suite, TypeScript build and backend/frontend lint.
- [x] Payment-event identity assertions are included in the original payment integration suite.
- [ ] Owner approval of the proposed recognition, tax/charge, discount/rounding, wallet, cutover and accounting-date defaults.
- [ ] Runtime sale/collection/refund posting and full new acceptance matrix.
