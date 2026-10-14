# Phase 3 — Sales, collections and refunds posting contract

**Status:** Stage 1 (source lifecycle audit and posting matrix) complete. Stage 2 is in progress; see [accounting-phase-3-stage-2.md](accounting-phase-3-stage-2.md) for the implemented payment-event identity and policy decisions still required. This document records observed runtime behavior and the proposed accounting contract. It does **not** activate automatic sales, collection, loyalty or refund postings.

## 1. Scope and evidence boundary

Phase 3 connects the existing POS financial events to the existing SQLite double-entry ledger. The POS remains the source of truth for orders, bills, payment lines and refunds; accounting must consume those records instead of introducing another order/payment/refund engine.

This audit reviewed the current PR branch source in:

- `main/routes/bills.ts` — bill generation/splitting and the single/split payment endpoints.
- `main/routes/refunds.ts` and `main/services/refund.ts` — refund validation, persistence, authorization, refund idempotency and wallet-credit behavior.
- `main/routes/orders.ts` and `main/routes/index.ts` — order/item state transitions and operational inventory cancellation/void behavior.
- `main/db.ts` — persisted bill/refund and accounting ledger schema.
- `main/accounting/ledger.ts` and `main/accounting/expenses.ts` — journal invariants and currently available payment-to-account mappings.
- `docs/business-decisions.md` — current refund, wallet, currency and inventory decisions.

The conclusions below distinguish **observed current behavior** from **proposed accounting treatment**. Anything marked as a decision gate must be settled before runtime posting is wired in.

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

**Conclusion:** in the posting stage, assign a generated immutable `payment_event_id` to each newly accepted line (backward-compatible with old JSON lines). Use the applied `amount`, not the tendered amount, as the collection amount. This nets cash change correctly. Use the canonical custom key `custom:<payment_method_id>`, not a translated/display method name.

### 2.4 Wallet redemption and cashback are separate loyalty events

A payment line with method `wallet` reduces the bill balance and writes a debit to `loyalty_ledger`; it does not represent cash received at the till. When a bill becomes fully paid, `applyPaymentBatch` may separately write a cashback/loyalty credit if loyalty is enabled and the bill does not already have such a credit. Existing product decisions allow store-credit refunds through a `credit` row in `loyalty_ledger`.

The accounting payment mapping catalogue currently has keys `cash`, `card`, `loyalty`, and `custom:<id>`. The `loyalty` mapping is liability-typed; the bill-payment API calls redemption `wallet`. These must be normalized deliberately rather than matched by display name. Loyalty-ledger amounts are points, while payment/refund rows are store-currency minor units.

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

## 3. Proposed posting matrix

The journal line formulas below are the intended double-entry shape; exact revenue/tax split depends on the policy decisions in section 5 and must use persisted server-side currency/tax snapshots rather than UI totals.

| Source event | Proposed journal | Identity / guard |
|---|---|---|
| Sale recognized (one per final bill/check) | Debit Accounts Receivable for the finalized bill total; credit mapped sales revenue and applicable tax-liability/other charge accounts; represent discounts and rounding according to the approved bill/tax calculation contract. | `source_type=bill`, `source_id=<bill.id>`, `source_event=sale_recognized`; requires an explicit financial-finalization trigger/snapshot first. |
| Normal cash/card/custom collection line | Debit the mapped cash/bank/card-clearing/custom asset account for the line's **applied amount**; credit Accounts Receivable by the same amount. | `source_type=bill_payment`, `source_id=<bill.id>:<payment_event_id>`, `source_event=collected`; each newly saved payment line must have a unique immutable event ID. |
| Wallet/store-credit redemption | Debit the customer-credit/liability account by the currency value redeemed; credit Accounts Receivable by that currency amount. No cash/bank debit. | Same payment-line identity rule; explicit wallet-to-`loyalty` mapping and point valuation/conversion are required. |
| Cash/card/custom refund | Debit approved sales-return/contra-revenue and applicable tax adjustment accounts; credit the account used to actually pay the refund. The original collection account is not assumed to be the payout account. | `source_type=refund`, `source_id=<refund.id>`, `source_event=refund_committed`; only the committed `refunds` row is the money event. |
| Store-credit refund | Debit approved sales-return/contra-revenue and applicable tax adjustment accounts; credit customer-credit liability, not cash/bank. | Refund ID; requires a defined points/currency valuation policy. |
| Cashback/loyalty reward granted | If brought into the financial scope, debit the explicitly chosen promotion/loyalty expense or contra-revenue account and credit customer-credit liability under the approved reward valuation. | Bill/loyalty event needs stable identity and a documented monetary valuation; not automatically equivalent to the sale's collection. |
| Order cancelled/item voided, with no committed money event | No cash/collection journal solely due to the status/stock operation. If an accounting sale was already posted, issue a separate approved reversal/adjustment according to cancellation policy. | Never post from `void_adjustment` as if it were a refund; never delete/change a posted journal. |

### Source event naming

The current ledger enforces a unique source triple `(source_type, source_id, source_event)` and idempotent payload matching. Use one stable source triple per business event, not per HTTP retry:

- `bill / <bill.id> / sale_recognized`
- `bill_payment / <bill.id>:<payment_event_id> / collected`
- `refund / <refund.id> / refund_committed`

If a sale/refund needs correction, create a new reversal/adjustment journal with its own source event/reference; never reuse the original source triple with a changed amount. Persist the business-source reference in the journal's traceable description/metadata where the ledger API supports it.

## 4. Required invariants for implementation

1. **One source of truth:** consume committed bill/payment/refund rows; do not create duplicate order or payment models.
2. **Correct event order:** a finalized sale entry must exist before or atomically with its first collection entry, otherwise Accounts Receivable can temporarily/incorrectly go negative. The chosen finalization trigger must guarantee this.
3. **Atomicity:** the source mutation and corresponding journal posting should commit in the same SQLite transaction wherever practical. If an unavoidable later/recovery pass is used, it must have a detectable pending/failure state and be retryable without duplicates.
4. **Idempotency:** event identity stays stable across HTTP retries, application restart and recovery. Request idempotency alone is not the accounting source identity.
5. **Balance and currency:** integer minor units using the configured store currency/fraction digits; every posted journal balances exactly. Do not assume two decimal places or default a country/currency.
6. **Amounts:** collections use applied payment amount, not tendered cash before change. Refund totals use each committed refund amount, never the order gross or bill balance alone.
7. **Accounts:** inactive/non-postable accounts are rejected. Mapping is resolved by stable method key/ID; missing mappings fail closed rather than guessing.
8. **Tax/discount/charges:** preserve bill tax snapshots/breakdowns and stored amount fields; no frontend-reconstructed totals or unapproved tax assumptions.
9. **Historical data:** do not silently auto-post every pre-existing bill/refund on upgrade. Choose a cutover/opening-balance/backfill policy and reconcile it before activation.
10. **Operational regressions:** current daily-sales exports, payment behavior, refunds, shift enforcement, loyalty and inventory cancellation/void rules remain unchanged unless separately approved.

## 5. Decision gates before stage 2 can safely wire in posting

These are real gaps exposed by the source audit, not items to silently guess during implementation:

1. **Revenue recognition/finalization:** decide when a bill becomes financially final. The current `/generate` endpoint creates an unpaid bill and can update its totals; `paid_at` only describes full payment. Recommendation: define an explicit immutable bill-finalization event/snapshot and emit the sale journal before or atomically with its first collection. Do not use bill generation or order completion as an undocumented proxy.
2. **Revenue, discounts, charges and tax:** confirm how subtotal, discount, delivery/packaging/service/table/takeaway charges, round-off and country tax snapshots map to ledger accounts. The current seeded chart has sales revenue and sales discounts, but no seeded tax-payable system account/mapping. Tax posting must remain blocked for stores without an explicitly configured valid tax account/treatment; do not imply statutory compliance.
3. **Payment account normalization:** define the canonical mapping from built-in `cash`/`card`, wallet redemption, and custom payment IDs to GL accounts. The existing mappings can serve as the source for cash/card/custom methods; `wallet` must be intentionally normalized to the `loyalty` liability mapping.
4. **Refund-method normalization:** choose the allowed refund methods and a stable representation for custom methods. The current refund endpoint persists a method string without resolving it to an accounting account key.
5. **Loyalty/cashback valuation:** choose how loyalty points, wallet redemption and cashback rewards translate into currency-denominated liability/expense entries; existing loyalty amounts are point units, not store-currency minor units.
6. **Historical cutover:** confirm whether automatic posting starts from an effective date with opening balances, or whether a controlled idempotent backfill is required. No silent historic posting.

Until the decisions are recorded, the implementation must fail closed for an unsupported tax or payment/refund mapping; it must not fabricate accounts or silently skip a financial event.

## 6. Stage 2 implementation order

1. Add the smallest migration-safe representation needed for a bill finalization/snapshot and a stable ID on each newly written payment line. Keep legacy `payment_details` JSON readable; document legacy event handling and do not create historic journals automatically.
2. Implement a pure, tested sale-journal builder from a finalized persisted bill snapshot, including exact minor-unit allocation across split checks and approved tax/charge mappings.
3. Wire sale finalization and collection posting through the existing transaction boundary, with collection event IDs persisted and account mapping resolved by stable key.
4. Add refund journal posting from the committed refund row, including the actual payout method, store-credit distinction and exact retry behavior.
5. Add recovery/reconciliation assertions and preserve all existing payment/refund route behavior.

## 7. Acceptance test matrix

Focused tests must cover at least:

- New bill created unpaid does not accidentally produce cash/revenue solely because it exists; editing/re-sync before finalization does not rewrite a posted sale.
- Sale posting is emitted exactly once for a finalized bill; retry and app restart do not duplicate it.
- Full, partial and later-settled bills; a payment request containing multiple lines; cash tender/change uses applied amount.
- A custom payment method resolves through `custom:<payment_method_id>`; missing or inactive mappings fail clearly.
- Wallet-funded payment reduces the approved customer-credit liability and does not increase cash/bank.
- Split checks: sum of finalized child journals equals the approved source bill allocation; no parent/child double posting; paid split bills block later re-splitting as they do today.
- Fully paid order completion, unpaid/partial bill, cancelled-but-paid bill and repeated request with/without optional provider transaction ID.
- Full and partial refunds, item-level refund, refund method different from collection method, store-credit refund, cumulative refund ceiling, repeated idempotency key and conflicting key reuse.
- Previously issued cashback/loyalty credit follows the approved loyalty policy; no accidental cashback double-counting or unauthorized inventory restoration.
- Tax/discount/charge allocations balance to the finalized bill total exactly; unsupported tax configuration fails closed.
- Posted sale/refund journals remain immutable; corrections use new linked reversal/adjustment entries.
- Existing `test:integration-payments`, `test:integration-lifecycle`, `test:integration-reconciliation`, `test:integration-loyalty`, `test:integration-loyalty-redemption`, `test:refunds`, `test:refund-completed-orders`, `test:daily-sales-export`, `test:cash-sessions`, `test:cash-closures` and accounting-ledger/route suites run unchanged.

**Stage 1 exit:** source paths, actual persisted event semantics, posting matrix, idempotency identities, and preconditions for implementation are recorded. Runtime posting is intentionally not part of Stage 1.
