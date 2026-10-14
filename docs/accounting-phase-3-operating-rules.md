# Phase 3 — runtime posting rules, worked scenarios and acceptance contract

**Status on this PR branch:** Runtime sale, collection and refund posting has been wired in code; schema migration v105 adds the finalization snapshot, default payment mappings and the automatic cutover marker. Focused tests are added in `tests/accounting-sales.test.ts`. This is not a release sign-off: the latest-head regression workflow must finish green, and any failures must be fixed before merge.

**Purpose:** This is the authoritative, implementation-facing Phase 3 contract. Read it with [the posting source audit](accounting-phase-3-posting-contract.md), [the implementation context](accounting-implementation-context.md), and [the roadmap](accounting-foundation-roadmap.md). It deliberately resolves the Stage 2 policy questions for this implementation instead of leaving a contributor to guess.

## 1. Scope and accounting basis

LyraPOS is adding a local-first, internal management ledger to the existing POS. Bills, payments and refund rows remain the operational source of truth; accounting writes journals from those persisted records. It must not create a second source of sale totals, or alter stock quantities.

This phase includes:
- one-time recognition of a financially finalized bill;
- accounting for each newly accepted payment line;
- accounting for committed refunds;
- source identities, cutover protection, transaction atomicity, audit trail and regression tests.

It does not implement cost-of-goods-sold (COGS), inventory valuation, supplier purchases/payables, payroll, loans/check lifecycle or a complete statutory/general-purpose accounting package. It also does not claim that a generic internal tax-liability account fulfills any country's filing or remittance requirements.

**Terminology must stay precise:**
- A **bill** is the POS's persisted amount due, including the POS's applied discounts, charges, tax calculation and payable rounding.
- **Sale recognition** records the sale once. It is not the same event as receiving cash/card/wallet value.
- A **collection** settles an amount of the customer's receivable. It does not create sales revenue a second time.
- A **refund** is the committed row in `refunds`; use its amount and actual payout method, not the bill gross or the method originally used to collect.
- A **posted journal** is immutable. Correct a mistake with a linked reversal/adjustment, not a silent edit/delete.
- An **opening balance** or **owner contribution** changes assets and equity/liabilities, not income. Their everyday UI is part of the next roadmap phase, not implied to exist merely because the ledger can post a journal.

## 2. Sale finalization policy

### 2.1 Trigger
1. `POST /api/bills/generate` creates or refreshes an operational bill. It does **not** post revenue.
2. `POST /api/bills/:id/finalize` explicitly finalizes an eligible post-cutover bill and writes the sale journal.
3. If a payment is accepted first, the first accepted payment line triggers sale finalization and collection posting inside the same SQLite transaction. If a required mapping, snapshot check or ledger invariant fails, the new payment is rolled back with the accounting write.
4. A retry of a finalized bill verifies its immutable snapshot and returns the original sale journal. It must not create a second sale journal.
5. After finalization, changes to the bill's commercial amounts/snapshot are rejected. Existing bill/order paths are guarded where they can change those amounts. A future correction workflow must write an adjusting/reversal journal and retain the original source.

### 2.2 Sale journal shape for this first management-accounting release
For a persisted bill with total (T) and POS-computed tax amount (X), converted once into integer currency minor units:
- **Debit** Accounts Receivable: (T)
- **Credit** Sales Revenue: (T - X)
- **Credit** Tax Collected (internal liability): (X), when non-zero

The entry must balance exactly. A zero-total bill receives an immutable finalization marker but no zero-value journal. A bill is rejected from posting if amounts are invalid or the tax amount exceeds the persisted total.

For this deliberately small initial chart of accounts:
- discounts, delivery/packaging/service/table/takeaway charges, and payable rounding are already reflected in the final POS total; they are **not posted as separate accounting lines in Phase 3**;
- sales revenue is therefore the final customer bill total less the persisted tax amount. It is net of the applied discount and any customer charges/rounding embedded in the POS payable total;
- the internal tax amount comes from the saved POS bill snapshot; the ledger does not recalculate jurisdiction-specific tax and does not claim statutory tax compliance;
- COGS is not posted. As a result, any future P&L must be labelled “result before COGS / excluding inventory cost”, never silently presented as fully calculated net profit.

This is an intentional Phase 3 scope decision. If the owner later requires separate charge revenue, gross sales/contra-sales discount analysis, line-by-line tax account allocation or statutory tax reports, add an explicit allocation/mapping design and reconciliation tests rather than changing the meaning of historical journals.

## 3. Collections and payment-method mapping

### 3.1 Collection entry
Each newly accepted payment line is persisted with a stable `payment_event_id` UUID. Its collection journal is keyed by `bill_id + payment_event_id` and must be idempotent across request retry/restart.

For amount (P), debit the mapped receiving/settlement account and credit Accounts Receivable:
- cash: debit Cash Drawer; credit Accounts Receivable;
- card: debit Payment Clearing; credit Accounts Receivable;
- custom method: debit that custom method's mapped active asset account; credit Accounts Receivable;
- wallet/loyalty redemption: debit the customer-credit liability (reduce the liability) and credit Accounts Receivable. Do not debit cash or bank for a wallet redemption.

Use the **applied payment amount** saved in the line, not cash tendered before change. Tender/change remain POS operational details. Multiple/split payments each have their own event identity and post independently, while sale recognition remains once per bill.

### 3.2 Defaults and overrides
- `cash` defaults to `acct-cash-drawer`.
- `card` defaults to `acct-payment-clearing`.
- `loyalty` defaults to `acct-customer-advances` (a liability account).
- A configured custom payment method defaults to `acct-payment-clearing` when it is created. Existing active custom methods are given the same safe initial mapping by migration v105. Owners/managers can change the mapping in Accounting Settings to a different active, postable asset account, e.g. a directly identified bank account.
- Existing mappings win during migration. The default to clearing is deliberate: a custom tender is not assumed to be a bank deposit until reconciled, and introducing a payment method must not unexpectedly break the POS. It is visible/editable in setup.
- An explicit missing, inactive, non-postable or wrong-type mapping fails closed for a post-cutover event. Never guess that a payment was cash or silently discard a committed collection.
- The POS currently uses the fixed `LOYALTY_REDEMPTION_RATE` to value points in store-currency major units. When a cashback credit is actually awarded into `loyalty_ledger`, Phase 3 posts **Debit Sales Discounts/contra-revenue; Credit Customer Advances/customer-credit liability** for the same redeemable monetary value, in the same SQLite transaction. This ensures a later wallet redemption debits a liability that was accrued rather than creating a negative/unfunded customer-credit balance. Do not invent a different points valuation. A store-credit **refund** creates/increases the same liability through the refund journal, so it must not also be posted a second time as cashback.

## 4. Refund policy

Refund posting consumes the committed `refunds` row within the refund transaction. It uses the recorded refund amount and the selected payout method, which may differ from the original collection method.

For the current endpoint, an amount-only partial refund does not identify the exact set of original tax lines. Phase 3 therefore allocates the original bill tax to partial refunds proportionally to the cumulative refunded amount, using integer minor units and cumulative rounding. This avoids per-refund rounding drift, but is an **internal management-accounting approximation** for mixed-rate/tax-behavior bills, not a statutory tax adjustment. Exact line-level tax reversal for arbitrary partial amount refunds is a future improvement; item-specific refund allocation should use its source item snapshot when that contract is extended.

For a bill total (T), persisted tax (X), and refund amount (R), the service calculates the incremental proportional tax share (X_R) against cumulative refunds and writes:
- **Debit** Sales Discounts/Returns (contra-revenue): (R - X_R)
- **Debit** Tax Collected (internal liability): (X_R), if non-zero
- **Credit** the actual payout account: (R) (cash/card/custom asset, or the customer-credit liability for a wallet refund)

The journal must balance; the cumulative tax reversal cannot exceed the remaining original tax allocation; refunds cannot exceed the existing POS refundable-balance checks. This does not alter the existing policy that refunds do not restock product/recipe inventory and do not claw back previously issued cashback.

For a pre-cutover/unfinalized legacy bill, a refund may still complete under the existing POS refund rules, but it is recorded as a visible `accounting_source_event / skipped_pre_cutover_refund` audit exception rather than being backfilled without a sale journal. For post-cutover finalized bills, an invalid payout mapping or failed ledger write rolls back the refund transaction.

## 5. Cutover and historical records

Migration v105 stores `accounting_cutover_at` once, at the migration time. It does not overwrite an existing value. Automatic accounting posting only applies to bills created strictly after that cutover; a bill timestamp equal to the cutover second is treated as legacy because SQLite timestamps have one-second precision:
- existing historical bills are not auto-finalized or backfilled; bills timestamped at or before the cutover marker are excluded;
- if a legacy bill predates cutover, its operational collection remains usable, but no sale/collection journal is fabricated; each skipped new collection line is written to the accounting audit log as `skipped_pre_cutover_payment`;
- explicit finalization of a pre-cutover bill is rejected. This is intentional, not a missing retry;
- pre-cutover refunds on bills with no accounting sale journal are similarly audited as skipped;
- records on/after cutover use the new transactionally coupled posting rules.

This avoids manufacturing historical income on upgrade. It also means the accounting balances may not yet equal the store's real cash/bank/open receivable position at launch. Before relying on balances or reports, the next phase must provide a controlled opening-balance/reconciliation workflow. Do not “solve” that gap by treating the first day's cash float or an owner's new money as sales income.

## 6. Date, currency, audit and integrity rules

- The store's configured currency and fraction digits are authoritative. Never assume two decimal places; store journal values as safe integer minor units.
- Accounting date is derived from the source timestamp in the configured regional timezone and configured business-day start; don't use the computer's timezone or a new wall-clock date when the source timestamp exists.
- Every posted journal has at least two valid lines, uses active/postable accounts, has no negative line values, and satisfies exact debit = credit.
- A sale's snapshot records the bill number/order, currency, subtotal, tax amount and snapshots, discount fields, charges, round-off, payable total and split-check identity. Once posted, that commercial snapshot cannot be rewritten.
- Collection identity is tied to `payment_event_id`; refund identity is the persisted refund row ID; sale identity is the persisted bill ID. A repeated identical source event resolves to the original journal. The same source identity with different amounts is a conflict and must never rewrite the posted row.
- Audit exceptions for the cutover are intentional and must remain visible. A future reconciliation screen should surface them; the log is not permission to ignore them.
- Payment/accounting posting occurs within the existing source transaction. Never “catch and log” a ledger error while committing a post-cutover payment/refund as though accounting succeeded.
- Backups/restore and all old schema migrations must remain compatible. Migration v105 is forward-only; do not edit existing migrations 100–104.

## 7. Worked scenarios

All amounts below are illustrative major currency units; real journals store integer minor units in the configured currency.

### Scenario A — sale, partly paid, then settled
A finalized bill totals 100, including tax of 10:
- Sale recognition: Dr Accounts Receivable 100; Cr Sales Revenue 90; Cr Tax Collected 10.
- Customer pays 40 cash: Dr Cash Drawer 40; Cr Accounts Receivable 40.
- Customer later pays 60 by card: Dr Payment Clearing 60; Cr Accounts Receivable 60.
- Result: Sales Revenue remains 90 once; the receivable clears to zero; cash/bank/clearing reflect actual methods. Two collections do not create two sales.

### Scenario B — full cash sale with no tax
Bill total 70, tax 0:
- Sale: Dr Accounts Receivable 70; Cr Sales Revenue 70.
- Cash collection: Dr Cash Drawer 70; Cr Accounts Receivable 70.
- Revenue is 70, not 140.

### Scenario C — cashback accrual followed by wallet-funded payment
A customer earns 25 redeemable points from a prior fully paid sale, under the current POS redemption rate of one point per one major currency unit:
- when the POS awards the cashback: Dr Sales Discounts/contra-revenue 25; Cr Customer Advances/Credit Liability 25;
- when those points are spent against a later finalized bill: Dr Customer Advances/Credit Liability 25; Cr Accounts Receivable 25.
- Cash/bank does not increase from a wallet redemption. Across the earning and spending entries, the liability moves up when the reward is granted and down when it is spent.

### Scenario D — partial cash refund
Original bill: total 100, tax 10. Refund: 25 back in cash.
- Proportional tax reversal: 10 × 25/100 = 2.5. For this example we assume a currency with zero fraction digits, so half-up rounding yields 3 whole units; in a two-decimal currency the same proportion would remain 2.50.
- refund journal in the zero-fraction example: Dr Sales Returns 22; Dr Tax Collected 3; Cr Cash Drawer 25.
- Production calculations use the configured currency's actual minor-unit factor and cumulative rounding; this simplified example is not a substitute for country-specific tax handling.
- If the customer is refunded to wallet instead, credit customer-credit liability rather than the cash drawer.

### Scenario E — cost of goods is deliberately excluded
Sales Revenue after tax = 90; recorded rent/utilities/payroll expense = 35; ingredient consumption cost is unknown/not computed.
- Current management result before COGS: 55.
- Do **not** label 55 “net profit” or imply inventory cost has been recognized. When a report is added, the exclusion must be visible in the report title/help text.

### Scenario F — owner contributes new cash
Owner puts 20,000 into the business bank:
- Dr Bank 20,000; Cr Owner Capital 20,000.
- Sales Revenue, Other Income and profit remain unchanged. This UI/workflow is scheduled after Phase 3.

### Scenario G — opening float
The books start with 5,000 physically in the till:
- Dr Cash Drawer 5,000; Cr Opening Equity/Opening Balance 5,000, if it represents the owner's net opening capital.
- If the 5,000 is actually a loan or other payable, credit the correct liability instead. Source classification must be explicit; the cash amount itself is never sales income.
- Opening-balance screen and validation are future scope; don't book opening cash as a sale.

### Scenario H — transfer between accounts
Move 3,000 from Cash Drawer to Bank:
- Dr Bank 3,000; Cr Cash Drawer 3,000.
- No income, expense or profit effect. Use the transfer operation, not a sales/expense category.

### Scenario I — old bill already present at upgrade
An unpaid bill created before migration v105 is paid after upgrade:
- POS accepts the payment under existing operational rules;
- Phase 3 does not invent a historic sale journal; the new payment event is recorded as a cutover audit exception;
- reconcile the opening receivable/cash position before relying on accounting balances. Do not manually backdate the bill to force posting.

### Scenario J — duplicate request/restart
A payment request is retried with the same idempotency/source identity:
- the POS returns its original idempotent result;
- the accounting source identity resolves to the same journal;
- debit/credit totals and reported sales do not increase again.

## 8. Reconciliation/acceptance matrix

| Case | Expected assertion |
|---|---|
| Finalize bill once / retry | One sale source journal; immutable snapshot |
| Bill generated but not finalized | No sale or collection journal solely from generation |
| Full or partial cash payment | Collection debits cash and credits A/R by applied amount |
| Card/custom payment | Debit configured asset/clearing account, not income; credit A/R |
| Multiple payment lines | Distinct event IDs; each line posts once; sale posts once |
| Wallet redemption / earned cashback | Cashback award: debit contra-revenue and credit customer-credit liability. Redemption: debit that accrued liability and credit receivables, with no cash/bank debit. |
| Missing/inactive/wrong-type mapping after cutover | Posting fails and source transaction rolls back |
| Full/partial cash or card refund | One refund journal from committed refund ID; actual payout account credited |
| Store-credit refund | Customer-credit liability credited instead of cash |
| Duplicate refund replay | No duplicate refund journal |
| Pre-cutover bill payment/refund | No historic journals; explicit audit exception remains |
| Tax amount > bill total / invalid minor amount | Refuse finalization; don't fabricate an unbalanced journal |
| Attempt to edit posted bill total/snapshot | Database guard rejects it |
| Owner contribution/opening funds/transfer | Not sales income; future workflows use equity/liability and asset-to-asset accounts |
| Expenses and stock costs | Paid expenses are Phase 2; COGS remains out of scope and must not be invented |

Focused test command: `npm run test:accounting-sales`.
Core accounting tests: `npm run test:accounting-ledger`, `npm run test:accounting-expenses`, `npm run test:accounting-routes`.
Relevant regressions include `test:integration-payments`, `test:integration-reconciliation`, `test:refunds`, `test:refund-completed-orders`, `test:integration-tax`, `test:integration-loyalty`, `test:integration-loyalty-redemption`, `test:daily-sales-export`, `test:cash-sessions`, and `test:cash-closures`.

**Phase 3 is accepted only when all focused scenarios and the full required regression workflow pass on the final PR head.** A previous green run is not evidence for a later code head.

## 9. New roadmap after Phase 3

1. **Phase 4 — Manual financial movements and opening position:** manual other-income entry (separate from POS sales), owner contributions and drawings, validated opening balances for cash/bank/receivable/liability/equity accounts, account transaction history and a controlled cutover/reconciliation screen for pre-cutover exceptions. Every operation posts a balanced ledger journal. Opening balances/contributions never use income accounts by default.
2. **Phase 5 — Basic management reports:** sales net of the POS tax amount, other income, paid/unpaid recorded expenses, net result before COGS, account balances and movement history, transfers excluded from income/expense, refunds reducing the relevant net revenue/payout position, filters by date/business day, and explicit warnings for cutover gaps and omitted COGS. Do not call the result fully calculated net profit.
3. **Phase 6 — Reliability and close controls:** reconciliation view for POS source events vs posted journals, explicit unposted/skipped/failed exception handling, period lock/adjustment workflow, audit export and backup/restore validation with accounting data.
4. **Optional later scope, only when the owner elects it:** supplier purchases/payables, inventory valuation and COGS. It is intentionally not required to satisfy the current lightweight bookkeeping goal.

The next useful deliverable is a basic, trustworthy ledger for sales, recorded expenses, manual income and owner/opening movements—not a full ERP. Keep the app offline-first and do not introduce a cloud dependency to complete this roadmap.
