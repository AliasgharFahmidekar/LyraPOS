# Phase 3 — Accounting policy proposal for Stage 2

**Status: proposed defaults, not yet owner-approved.** This document turns the source audit into a concrete, conservative decision set so runtime posting can proceed without silently inventing financial treatment. Until these decisions are approved, automatic sale/collection/refund journals remain disabled.

## Recommended decisions

### 1. Recognition basis and bill finalization

**Recommendation: accrual-style sale recognition with an explicit, immutable bill-finalization snapshot.**

- Generating a bill remains a preview/working operation; it is not itself a posted sale because the current route can resynchronize unpaid bill totals.
- Add an explicit finalize/issue action that snapshots the persisted server-side bill totals, currency, tax breakdown/snapshot, discount, each charge, rounding, and split-check identity.
- Finalization creates the sale journal exactly once. Later collection lines clear accounts receivable; they do not recognize revenue again.
- If a payment is attempted on a bill not yet finalized, the server may finalize it and post the sale in the same transaction before applying the payment, or reject it with a clear instruction. Prefer same-transaction finalization to preserve current cashier flow, but do not accept a collection if sale finalization/posting fails.
- A finalized bill cannot be re-synced or silently edited. Changes require an explicit adjustment/reversal flow.

### 2. Discounts, tax and additional charges

- Use persisted bill fields and tax snapshots only; do not reconstruct totals from frontend values.
- Post the approved discount amount to the existing sales-discounts/contra-income account (or net it into revenue only if the final implementation explicitly documents and tests that policy).
- **Fail closed** for a non-zero tax amount until a valid active, postable tax-liability account and an approved tax treatment are configured. Do not seed a universal tax-payable account and do not claim statutory compliance.
- **Fail closed** for non-zero delivery, packaging, service, table or takeaway charges until each charge is explicitly mapped to an appropriate income account or an approved net-revenue treatment. Do not silently fold charges into sales revenue.
- Rounding must be represented by an explicit rounding account or a deterministic allocation rule approved and tested before posting. Each finalized bill journal must balance exactly in currency minor units.

### 3. Collections, payment mappings and wallet

- Record each persisted payment line separately using its immutable `payment_event_id` and the persisted applied `amount`; never use tendered/requested amount.
- Resolve built-in cash/card and custom methods using stable payment keys, including `custom:<payment_method_id>`. Missing, inactive or non-postable mappings reject the transaction; no display-name matching.
- A wallet redemption is not cash. Debit the configured customer-credit/loyalty liability by the currency amount actually redeemed and credit accounts receivable by the same amount. Require an explicit valid liability mapping.
- Do not post cashback/points earned as a currency liability until the configured point valuation, earning basis, rounding, and expense-versus-contra-revenue treatment are explicitly approved. Existing points are not silently revalued.

### 4. Refunds and store credit

- Post only from the committed `refunds.id` row, in the same SQLite transaction as refund creation.
- Debit an explicitly configured sales-returns/contra-revenue account and any approved tax adjustment; credit the account corresponding to the actual payout method, which may differ from the collection method.
- Store-credit refunds credit the customer-credit liability, not cash/bank. Require the mapping and currency valuation to be valid.
- The negative order-item adjustment is operational/audit data, not a second refund. Do not restore inventory as part of accounting posting.
- If refund-method normalization, return account, tax adjustment or payout mapping is missing, reject/roll back the refund rather than persisting an unjournaled financial event once posting is enabled.

### 5. Cutover and historic records

- Recommended default: activate automatic posting only after an owner-controlled cutover timestamp/date is recorded.
- Do not backfill historical bills, payment lines, refunds, cashback or wallet rows automatically.
- Opening balances and historical reconciliation must be entered/reconciled separately before cutover. A future backfill requires its own idempotent plan and reconciliation report.
- Existing legacy payment JSON without `payment_event_id` remains readable but is not automatically journaled.

### 6. Accounting date and periods

- Derive accounting date from the source event timestamp using the store's configured timezone and business-day start rule, not the workstation's local timezone.
- No closed-period subsystem is currently part of the delivered accounting foundation. Until one exists, use the source business date and immutable posted journals; corrections use new linked reversal/adjustment journals. Do not introduce an untested period-locking model in this stage.

## Required acceptance tests before enabling posting

1. Bill generation/resync alone creates no journal; finalization snapshots amounts once and cannot rewrite a posted sale.
2. Sale finalization and first collection are atomic; injected failure rolls both back.
3. Full/partial/multiple payment lines, cash tender/change, stable event IDs, idempotent retries and app restart never duplicate collections.
4. Split checks post only the actual finalized child bills and reconcile exactly to their allocated total.
5. Tax-bearing bills and non-zero unmapped charges fail closed; configured mappings produce exact balanced entries.
6. Missing/inactive/non-postable cash/card/custom/wallet mappings fail closed.
7. Wallet redemption changes liability and receivable only; cashback is not posted until the valuation policy is enabled.
8. Full/partial/store-credit refunds use committed refund rows, actual payout methods, refund ceilings and stable refund IDs; failure rolls back refund and journal together.
9. Item voids, order cancellation, cash drawer movements and inventory adjustments do not masquerade as collections/refunds.
10. Existing payment, refund, loyalty, cash-session, daily-sales and lifecycle tests remain unchanged and pass.
11. Upgrade from a populated v104 database preserves all data and creates no historic journals.
12. Every posted entry is balanced in integer minor units, references active/postable accounts and remains immutable; corrections use linked reversals.

## Approval checklist

- [ ] Approve accrual-style recognition and explicit finalization (including same-transaction finalization on first payment if needed).
- [ ] Approve fail-closed tax and charge mapping policy.
- [ ] Approve discount and rounding treatment.
- [ ] Approve wallet liability mapping and defer cashback journal until point valuation is configured.
- [ ] Approve no-automatic-historical-backfill cutover.
- [ ] Approve store-local business date and no closed-period subsystem in this stage.

**Safety boundary:** these recommendations are implementation defaults, not a claim of jurisdiction-specific accounting/tax compliance. Runtime posting must not be enabled until the product owner approves the checklist and the corresponding test suite is green.
