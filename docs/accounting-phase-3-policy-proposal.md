# Phase 3 — resolved accounting policy for sale, collection and refund posting

**Status on PR #19:** The implementation policy below is the chosen Phase 3 contract for this PR. It supersedes the earlier proposal/checklist that left these choices open. The implementation is intentionally limited to internal management bookkeeping; it is not a jurisdiction-specific statutory accounting or tax-filing claim. Read [the complete runtime rules and worked scenarios](accounting-phase-3-operating-rules.md).

## 1. Recognition basis and finalization

**Decision:** Use accrual-style sale recognition from a persisted, immutable bill snapshot.
- Generating a bill is still a mutable operational action and creates no revenue journal by itself.
- The explicit `POST /api/bills/:id/finalize` endpoint can finalize an eligible post-cutover bill.
- If a first payment arrives before explicit finalization, finalize the bill and post the sale within the same SQLite transaction as the accepted collection.
- A finalized bill has one source identity, `bill / <bill.id> / sale_recognized`. Repeated calls validate the existing snapshot and return the original journal; they never create a second sale.
- The financial fields/snapshot of a finalized bill are guarded against mutation. Do not edit a posted journal or silently resynchronize the amount; implement a linked accounting adjustment/reversal if corrections are later added.

## 2. Sales total, tax, discount, charges and rounding

**Decision for this first management-accounting release:** Let the persisted POS bill remain authoritative. For bill total (T) and its stored POS-computed tax amount (X):
- Debit Accounts Receivable by (T).
- Credit Sales Revenue by (T - X).
- Credit a generic **Tax Collected (internal liability)** account by (X), when non-zero.

The final POS total already reflects discounts, delivery/packaging/service/table/takeaway charges and payable rounding. Phase 3 does not post those values as separate journal lines; sales revenue therefore represents the final bill total after the saved POS tax is excluded. This is a deliberate simple-chart choice, not a claim that charge-specific and gross/contra-revenue reporting is complete. A future dedicated analysis must change the design with explicit allocation rules and reconciliation tests; never silently reinterpret existing posted journals.

The tax amount is taken from the saved POS bill/tax snapshot. The ledger does not recalculate tax. The generic internal liability is not a country-specific legal tax account and must not be presented as proof of tax compliance. Invalid amounts and tax exceeding total are refused.

## 3. Payment methods, collection and customer credit

**Decision:** Collection settles receivables; it never recognizes revenue a second time.
- Cash -> Cash Drawer asset.
- Card -> Payment Clearing asset.
- Existing/new custom payment method -> initially Payment Clearing asset; owner/manager can re-map it to another active postable asset in Accounting Settings.
- Wallet/loyalty redemption -> Customer Advances/Credit liability.
- Each newly persisted payment line uses its stable `payment_event_id`; the event's applied amount is posted, not cash tender before change.
- New custom methods default to clearing via migration/SQLite trigger so the existing POS remains usable. An explicit missing/invalid/inactive/wrong-type mapping fails closed; never guess another account.
- Use the existing POS `LOYALTY_REDEMPTION_RATE` to translate an actually awarded cashback credit into store-currency major units. In the same SQLite transaction as the `loyalty_ledger` credit, debit Sales Discounts/contra-revenue and credit Customer Advances/customer-credit liability. Wallet redemption later debits that accrued liability and credits Accounts Receivable; do not fabricate a cash/bank movement. Store-credit refunds already credit the liability through their refund journal and must not be accrued twice.

## 4. Refunds, payout method and tax allocation

**Decision:** Source the journal from each committed `refunds.id` row, once. The actual payout method determines the credited account and may differ from the original payment.
- Cash/card/custom payout: debit Sales Returns/contra-revenue for the refund net of its tax allocation, debit the internal tax liability for the allocated tax portion, and credit the actual payout account for the full refund.
- Wallet/store-credit payout: credit Customer Advances/Credit liability instead of cash/bank.
- The current refund API stores a refund amount but does not always identify the exact original tax lines for an arbitrary partial amount. Until a line-allocation contract is added, allocate bill tax proportionally across cumulative refunds using integer minor units. This is a documented management-accounting approximation for mixed-rate bills, not a statutory tax reversal.
- Existing POS refund checks remain authoritative for approval and refundable balance. Refunds do not restock inventory or claw back already-issued cashback.
- A pre-cutover or unfinalized legacy bill's refund may complete operationally but is audibly marked as skipped in accounting rather than being inserted into a new ledger without a matching sale. A post-cutover refund on a finalized bill rolls back if its mapped payout account or journal cannot be posted.

## 5. Historical cutover

**Decision:** No automatic historical backfill.
- Migration v105 records `accounting_cutover_at` once, preserving an existing value.
- Only bills created at or after this cutover participate in automatic posting.
- Existing bills/payment lines are not rewritten and historic revenue/collections/refunds are not fabricated.
- A payment on a pre-cutover bill may still succeed under established POS operational behavior but is recorded in the accounting audit log as `skipped_pre_cutover_payment`; explicit finalization of that bill is rejected. Unfinalized legacy refunds get a matching `skipped_pre_cutover_refund` audit exception.
- Future Phase 4 must add owner-guided opening-balance/reconciliation tools before the displayed ledger balance is relied on as the business's full real-world cash/receivable position.

## 6. Accounting date, units, identity and atomicity

- Use store currency and currency-specific fraction digits; persist integer minor units. Do not assume two decimal places.
- Derive accounting date from persisted source timestamp plus the configured regional timezone and business-day start.
- Every posted journal has at least two lines, active/postable accounts, non-negative integer amounts, exact debit = credit and source/idempotency identity.
- Sale source: `bill / <bill.id> / sale_recognized`.
- Collection source: `bill_payment / <bill.id>:<payment_event_id> / collected`.
- Refund source: `refund / <refund.id> / refund_committed`.
- Sale + first collection are atomic with the payment operation; refund + refund journal are atomic with the refund operation. Never catch a posting failure and commit an unjournaled post-cutover financial event.
- Posted journals are immutable. Same source and same payload replay the existing journal; same source with a different payload is a conflict.
- All new database changes are forward-only. No edit to already merged historical migrations 100–104.

## 7. Required validation before merge

The PR must pass `npm run test:accounting-sales`, all existing accounting ledger/expense/route tests, relevant payment/refund/tax/loyalty/cash-report suites, build, lint and the full regression workflow on the final PR head. The previous successful run #316 covered the earlier payment-ID slice only; it cannot be used as evidence for this runtime posting implementation. Do not merge while the final run is red, in progress or absent.

A complete list of runtime rules, journal examples, the worked pre-cutover case, the no-COGS reporting constraint, and the updated Phase 4–6 roadmap lives in [accounting-phase-3-operating-rules.md](accounting-phase-3-operating-rules.md).
