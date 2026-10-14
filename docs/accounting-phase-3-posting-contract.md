# Phase 3 — Sales, collections and refunds posting contract

**Status:** Source lifecycle audit is complete. The runtime policy is now implemented on PR #19 in `main/accounting/sales.ts` and migration v105. This file preserves the observed-source audit; use [accounting-phase-3-operating-rules.md](accounting-phase-3-operating-rules.md) as the authoritative current contract. The selected policy is cash-received-only: only cash/card/custom money receipts and monetary refunds affect accounting. Loyalty, wallet credits/redemptions and discounts are explicitly excluded. Final-head CI is still required before merge.

## 1. Scope and evidence boundary

Phase 3 connects the existing POS financial events to the existing SQLite double-entry ledger. The POS remains the source of truth for orders, bills, payment lines and refunds; accounting must consume those records instead of introducing another order/payment/refund engine.

This audit reviewed the current PR branch source in:

- `main/routes/bills.ts` — bill generation/splitting and the single/split payment endpoints.
- `main/routes/refunds.ts` and `main/services/refund.ts` — refund validation, persistence, authorization, refund idempotency and wallet-credit behavior.
- `main/routes/orders.ts` and `main/routes/index.ts` — order/item state transitions and operational inventory cancellation/void behavior.
- `main/db.ts` — persisted bill/refund and accounting ledger schema.
- `main/accounting/ledger.ts` and `main/accounting/expenses.ts` — journal invariants and currently available payment-to-account mappings.
- `docs/business-decisions.md` — current refund, wallet, currency and inventory decisions.

The source audit below distinguishes operational POS behavior from accounting scope. The current selected policy is explicit: only actual money received/refunded through cash/card/custom methods is accounted for; loyalty and discounts are excluded.

## 2. Observed source lifecycle

### 2.1 Bill generation is not yet a safe sale-posting event

`POST /api/bills/generate` creates a bill with `payment_status = 'unpaid'`, `paid_amount = 0` and `balance = total`. The persisted commercial/tax fields include subtotal, tax amount/breakdown/snapshot, discount, delivery/packaging/service/table/takeaway charges, rounding and total.

When an existing bill is not marked `paid`, the generate route can re-sync its totals from the order. Therefore, bill generation is not an immutable financial-finalization boundary. The `bills` schema has payment state and `paid_at`, but no separate sale-finalized/posted timestamp or immutable accounting snapshot.

**Conclusion:** do not post revenue just because `/generate` returned a bill, and do not use `paid_at` as the revenue event by default: it is set when the bill reaches fully paid, which conflates revenue recognition with cash collection and does not describe unpaid invoices.

### 2.2 Split checks are separate bill records

`POST /api/bills/:id/split-check` only allows an unpaid bill with zero paid amount and no payment details. The first child check reuses and updates the source bill record; the other child checks receive their own bill IDs. Amounts, tax and charges are allocated across checks with currency minor-unit helpers and tax snapshot/breakdown logic.

**Conclusion:** post only the actual current child bill records, never the pre-split total plus the child totals. The split group is a grouping reference, not an additional sale.

### 2.3 Collections are stored as appended JSON payment lines

`POST /api/bills/:id/payment` and `POST /api/bills/:id/payments` call the shared `applyPaymentBatch` path inside `withTxn`. A new payment line stores method, actual applied `amount`, `requested_amount`, timestamp and cash-session ID. Cash tenders additionally store `tendered_amount` and `change_amount`; custom methods retain `payment_method_id`; transaction ID and notes are optional.

The lines are appended to `bills.payment_details` JSON. `paid_amount`, `balance` and `payment_status` are updated to `partial` or `paid`; `paid_at` is set only when the full balance is paid. On full payment, the order is set to `completed` only when no sibling bill remains unsettled and the order is not already cancelled/completed.

Request idempotency is supported when an idempotency key is provided, and optional payment transaction IDs are guarded by `payment_transaction_refs`. However, **each persisted payment line has no mandatory, stable event ID of its own**. Request-level idempotency and optional provider transaction IDs are not sufficient identities for every cash/custom/wallet collection line.

**Conclusion:** assign a generated immutable `payment_event_id` to each newly accepted line. Accounting posts only cash/card/custom lines, using the applied `amount`, not tendered cash before change. Wallet/loyalty lines are explicitly skipped and never mapped to an accounting account.

### 2.4 Wallet redemption and cashback are POS-only loyalty events

A payment line with method `wallet` reduces the bill balance and writes a debit to `loyalty_ledger`; it does not represent cash received at the till. When a bill becomes fully paid, `applyPaymentBatch` may separately write a cashback/loyalty credit if loyalty is enabled and the bill does not already have such a credit. Existing product decisions allow store-credit refunds through a `credit` row in `loyalty_ledger`.

The POS still uses `wallet` as a payment-line key for its own loyalty subsystem. Accounting excludes that line entirely. The accounting mapping UI/API exposes only cash, card and custom payment methods; any legacy loyalty mapping row is ignored. Loyalty-ledger amounts are points, while payment/refund rows are store-currency minor units.

**Decision gate:** define the value/accounting treatment of points and cashback before posting the point balance as a currency-denominated liability. Do not assume one point equals one currency unit. A wallet-funded collection should reduce the customer-credit/liability account and clear the receivable; it must not increase cash/bank.

### 2.5 Refunds are individual committed records

`POST /api/refunds` runs `createRefund` in a SQLite transaction. A committed refund gets a stable row ID in `refunds` with bill ID, optional item ID, integer minor-unit amount, method, reason, approver, creator, timestamp and cash-session ID. The service limits aggregate refunds to `paid_amount - prior refunds`, updates the bill status to `partially_refunded` or `refunded`, records an order audit event, and supports request idempotency when the request carries an idempotency key.

A store-credit refund writes a loyalty-ledger credit. An item-level refund also inserts a negative `void_adjustment` order-item row and marks the original item `refunded`; the existing business decision explicitly says refunds do **not** restore product or supply stock.

The refund route currently accepts `method` as a string; it does not resolve every possible refund-method string to a canonical payment-method ID/account mapping.

**Conclusion:** use the committed `refunds.id` as the stable accounting source identity. The accounting payout account follows the **actual refund method**, which may differ from the original collection method. Before posting, normalize or validate refund methods (including custom methods) to an explicit account key. For store-credit refunds, credit the customer-credit liability instead of cash/bank. An item-level negative adjustment is not a second money refund; create the financial posting from the committed refund row only.

### 2.6 Order cancellation, item voids and drawer movements are not sales payments

Order/item status changes and the inventory/service stock effects are operational events. Pending-item/order cancellations may restore the exact stock recorded in the item's inventory/recipe snapshot; voids after preparation are physical waste and do not restore stock. Refunds likewise do not restore stock by current product decision.

The cash-drawer movement and cash-session/closure subsystem also tracks events such as opening float, pay-ins/pay-outs and safe drops. These are not interchangeable with bill-payment lines and must not be summed as sales revenue. Reconciliation of the cash drawer against accounting balances is a separate control.

**Conclusion:** don't infer a money refund from an item `void_adjustment`, don't infer revenue from order status alone, and never erase a real collection because the order was later cancelled. If a previously posted sale is cancelled, an explicit reversing/adjustment event is required; a cash payout is posted only when a committed refund/payout event exists.

## 3. Runtime posting matrix implemented on PR #19

| POS event | Accounting treatment |
|---|---|
| Bill generated or finalized | Snapshot/audit guard only; no sale journal, receivable or tax journal. |
| Cash receipt | Dr Cash Drawer / Cr Sales Revenue for the persisted applied amount. |
| Card receipt | Dr Payment Clearing / Cr Sales Revenue for the persisted applied amount. |
| Custom payment method receipt | Dr its mapped active asset account / Cr Sales Revenue. Defaults to Payment Clearing. |
| Loyalty wallet award, redemption, expiry or balance change | Ignored completely; no journal, account mapping or accounting dependency. |
| Discount/cashback | No separate accounting entry. Only the actual amount accepted by a real payment method matters. |
| Cash/card/custom monetary refund | Dr Sales Returns (contra-revenue) / Cr actual mapped payout asset for the monetary amount. |
| Wallet/store-credit refund | Ignored completely. |
| Pre-cutover bill/payment/refund | No automatic historical journal; monetary events are audited as cutover exceptions where applicable. |

The sale finalization fields are an immutable bill snapshot only; the sale-journal link remains null under this policy. The accounting service must not read the loyalty ledger or depend on cashback settings.

## 4. Invariants enforced

1. **One source of truth:** source rows are bills, appended persisted payment lines and committed refund rows; accounting must not copy operational totals from the frontend.
2. **Recognition before collection:** sale finalization and its first collection are posted inside the payment transaction.
3. **Atomicity:** for post-cutover events, a mapping/ledger failure rolls back the originating payment/refund operation; never swallow posting failure while reporting financial success.
4. **Idempotency:** sale is unique per bill; collection uses a stable `payment_event_id`; refund uses the committed refund ID. Replays cannot increase totals twice.
5. **Balances and currency:** integer minor units using the configured currency fraction digits; every posted entry must balance exactly and use active/postable accounts.
6. **Applied amounts:** a collection uses the amount applied to the bill, not tendered cash before change.
7. **Mapping:** cash/card and custom methods resolve to active, postable asset accounts. Custom methods default to clearing and are editable in Settings. Wallet/loyalty is not an accounting mapping and is ignored.
8. **Refund payout:** credit the account actually used to pay/store-credit the refund; never assume it is the original collection method.
9. **Posted history:** finalized bill amounts and sale snapshot are immutable; future corrections require a separate reversal/adjustment.
10. **Historical safety:** the v105 cutover is not a backfill. Legacy skips are audit events; a future opening-balance workflow must reconcile the gap.
11. **No fabricated profit:** this phase does not value stock or post COGS; sales less recorded expenses is only a result before COGS, not fully calculated net profit.
12. **No statutory claim:** tax is sourced from the existing POS snapshot and posted to an internal liability for bookkeeping; no jurisdiction-specific tax treatment is certified here.

## 5. Test and merge gates

Focused tests cover:
- bill finalization exactly once and financial-field immutability;
- partial cash collection with A/R settlement and duplicate-event retry;
- committed partial refund with proportional tax allocation, actual payout account and duplicate replay;
- pre-cutover bill rejection for finalization, no historic sale/collection journal and a visible audit exception;
- migration v105 columns, guards, cutover and payment mapping defaults.

Run `npm run test:accounting-sales`, `npm run test:accounting-ledger`, `npm run test:accounting-expenses`, `npm run test:accounting-routes` plus existing payment/refund/tax/loyalty/cash/export tests, build, lint and the full workflow. The earlier run #316 only validates the previous payment-event identity slice; it does not certify the current runtime changes. The current PR must not be described as complete or merged until the final-head workflow passes.

## 6. Still explicitly deferred

- Opening balances, owner contributions/drawings and manual other income.
- A reconciliation UI for skipped pre-cutover/failed source events.
- Basic income/expense/account balance reports.
- Charge/discount/rounding analysis, tax-accounting and statutory tax handling are out of scope for this cash-received integration.
- Inventory valuation, recipe/product COGS, suppliers/payables, checks, loans/installments, payroll, fixed assets and statutory tax integrations.

See [accounting-foundation-roadmap.md](accounting-foundation-roadmap.md) for the revised next phases.
