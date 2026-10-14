# Phase 3 — resolved accounting policy for sale, collection and refund posting

**Status on PR #19:** The implementation policy below is the chosen Phase 3 contract for this PR. It supersedes the earlier proposal/checklist that left these choices open. The implementation is intentionally limited to internal management bookkeeping; it is not a jurisdiction-specific statutory accounting or tax-filing claim. Read [the complete runtime rules and worked scenarios](accounting-phase-3-operating-rules.md).

## 1. Bill finalization and recognition

**Decision:** Use cash-received accounting for POS revenue.
- Generating or finalizing a bill does not create a sale journal or Accounts Receivable balance.
- Bill finalization only freezes an audit snapshot and protects its commercial fields from silent edits.
- Each accepted actual-money payment line through cash, card or a custom payment method creates a journal for the applied amount.
- A bill with no real-money payment produces no accounting revenue, even if its loyalty wallet/discount state changes.
- The POS remains authoritative for bill totals and operational payment validation.

## 2. Revenue amount, tax and discounts

**Decision:** Account only for money actually received through a real payment method.
- Debit the mapped active asset account by the payment line's applied amount.
- Credit Sales Revenue by the same amount.
- Do not create Accounts Receivable, tax-liability, discount, cashback or loyalty journals from POS bill fields.
- Applied discounts are not posted separately. Their only indirect effect is that the POS may accept a smaller monetary payment.
- This is an internal cash-received bookkeeping policy, not a statutory tax ledger or accrual-basis financial statement.

## 3. Payment methods and loyalty boundary

**Decision:** Cash/card/custom methods are the only POS payment events that enter accounting.
- Cash -> Cash Drawer asset.
- Card -> Payment Clearing asset.
- Active custom payment method -> Payment Clearing asset by default; owner/manager may map it to another active postable asset.
- Each real-money payment line is identified by its stable `payment_event_id`; the applied amount, not tendered cash before change, is posted as Dr mapped asset / Cr Sales Revenue.
- Wallet/loyalty payment lines are skipped entirely. No mapping to a liability is needed.
- Loyalty point awards, redemptions, expiries and balance changes never create or reverse accounting entries.
- Discounts and cashback never create accounting entries. Do not read `loyalty_ledger` from the accounting posting service.

## 4. Monetary refunds

**Decision:** Only actual money refunded through cash/card/custom methods affects accounting.
- Debit Sales Discounts/contra-revenue by the actual monetary refund amount.
- Credit the actual mapped payout asset by the same amount.
- Wallet/store-credit refunds are non-monetary and are ignored by accounting.
- No proportional tax allocation or tax-liability reversal is performed.
- The committed refund row ID is the idempotency source identity. Existing POS authorization and refundable-balance rules remain authoritative.

## 5. Historical cutover

**Decision:** No automatic historical backfill.
- Migration v105 records `accounting_cutover_at` once, preserving an existing value.
- Only bills created strictly after this cutover participate in automatic posting. A bill stamped at or before the cutover timestamp—including the same timestamp second—is legacy and is not auto-posted.
- Existing bills/payment lines are not rewritten and historic revenue/collections/refunds are not fabricated.
- A payment on a pre-cutover bill may still succeed under established POS operational behavior but is recorded in the accounting audit log as `skipped_pre_cutover_payment`; explicit finalization of that bill is rejected. Unfinalized legacy refunds get a matching `skipped_pre_cutover_refund` audit exception.
- Future Phase 4 must add owner-guided opening-balance/reconciliation tools before the displayed ledger balance is relied on as the business's full real-world cash/receivable position.

## 6. Accounting date, units, identity and atomicity

- Use store currency and currency-specific fraction digits; persist integer minor units. Do not assume two decimal places.
- Derive accounting date from persisted source timestamp plus the configured regional timezone and business-day start.
- Every posted journal has at least two lines, active/postable accounts, non-negative integer amounts, exact debit = credit and source/idempotency identity.
- Bill snapshot identity: persisted `bill.id`; bill finalization creates no journal.
- Collection source: `bill_payment / <bill.id>:<payment_event_id> / collected`.
- Monetary refund source: `refund / <refund.id> / money_refunded`.
- Sale + first collection are atomic with the payment operation; refund + refund journal are atomic with the refund operation. Never catch a posting failure and commit an unjournaled post-cutover financial event.
- Posted journals are immutable. Same source and same payload replay the existing journal; same source with a different payload is a conflict.
- All new database changes are forward-only. No edit to already merged historical migrations 100–104.

## 7. Required validation before merge

The PR must pass `npm run test:accounting-sales`, all existing accounting ledger/expense/route tests, relevant payment/refund/tax/loyalty/cash-report suites, build, lint and the full regression workflow on the final PR head. The previous successful run #316 covered the earlier payment-ID slice only; it cannot be used as evidence for this runtime posting implementation. Do not merge while the final run is red, in progress or absent.

A complete list of runtime rules, journal examples, the worked pre-cutover case, the no-COGS reporting constraint, and the updated Phase 4–6 roadmap lives in [accounting-phase-3-operating-rules.md](accounting-phase-3-operating-rules.md).
