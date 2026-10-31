# Phase 3 — runtime posting rules, worked scenarios and acceptance contract

**Status on this PR branch:** Runtime sale, collection and refund posting has been wired in code; schema migration v105 adds the finalization snapshot, default payment mappings and the automatic cutover marker. Focused tests are added in `tests/accounting-sales.test.ts`. This is not a release sign-off: the latest-head regression workflow must finish green, and any failures must be fixed before merge.

**Purpose:** This is the authoritative, implementation-facing Phase 3 contract. Read it with [the posting source audit](accounting-phase-3-posting-contract.md), [the implementation context](accounting-implementation-context.md), and [the roadmap](accounting-foundation-roadmap.md). It deliberately resolves the Stage 2 policy questions for this implementation instead of leaving a contributor to guess.

## 1. Scope and accounting basis

LyraPOS is adding a local-first, internal management ledger to the existing POS. Bills, payments and refund rows remain the operational source of truth; accounting writes journals from those persisted records. It must not create a second source of sale totals, or alter stock quantities.

This phase includes:
- immutable bill snapshot/finalization without a journal;
- accounting for each newly accepted cash/card/custom money receipt;
- accounting for committed monetary refunds through real payment methods;
- source identities, cutover protection, transaction atomicity, audit trail and regression tests.

It does not implement cost-of-goods-sold (COGS), inventory valuation, supplier purchases/payables, payroll, loans/check lifecycle or a complete statutory/general-purpose accounting package. It also does not claim that a generic internal tax-liability account fulfills any country's filing or remittance requirements.

**Terminology must stay precise:**
- A **bill** is the POS's persisted amount due, including the POS's applied discounts, charges, tax calculation and payable rounding.
- **Revenue recognition** occurs only when cash/card/custom money is actually received.
- A **collection** settles an amount of the customer's receivable. It does not create sales revenue a second time.
- A **refund** is the committed row in `refunds`; use its amount and actual payout method, not the bill gross or the method originally used to collect.
- A **posted journal** is immutable. Correct a mistake with a linked reversal/adjustment, not a silent edit/delete.
- An **opening balance** or **owner contribution** changes assets and equity/liabilities, not income. Their everyday UI is part of the next roadmap phase, not implied to exist merely because the ledger can post a journal.

## 2. Bill finalization and recognition policy

### 2.1 Trigger
1. `POST /api/bills/generate` creates/refreshes an operational bill; it creates no accounting journal.
2. Finalization records an immutable bill snapshot for audit/anti-mutation protection only. It does **not** recognize revenue and creates no receivable or tax journal.
3. Revenue is recognized only for a successfully accepted, actual monetary payment line using `cash`, `card`, or an active custom payment method.
4. A bill being marked paid, loyalty credit being added/spent, or a discount being applied does not itself create an accounting entry.
5. The bill snapshot remains protected from edits after accounting finalization. This protects the source used by the POS; it is not an accounting sale journal.

### 2.2 Revenue basis
This release uses a deliberately cash-received basis for POS revenue:
- Debit the active asset account mapped to the real payment method by the actual applied payment amount.
- Credit Sales Revenue by the same amount.
- Do not create Accounts Receivable, sales-tax, discount, loyalty-liability, or cashback journals from POS bill fields.
- Do not recognize tendered cash that was returned as change; use the applied amount persisted by the POS.
- Taxes, discounts, charges and rounding are not independently analyzed by this accounting integration. Discounts affect the amount the POS actually collects, but there is no separate discount journal. This is not a statutory tax ledger.


## 3. Payment methods and money received

### 3.1 Only actual money enters accounting
- Built-in `cash` maps by default to Cash Drawer (asset).
- Built-in `card` maps by default to Payment Clearing (asset).
- Any active custom payment method maps by default to Payment Clearing (asset), and can be mapped to another active postable asset in Accounting Settings.
- When automatic sales posting is enabled in Accounting Settings, each accepted cash/card/custom payment line is a separate source event and creates **Dr mapped asset / Cr Sales Revenue** for its applied amount. A payment event ID makes retries idempotent.
- `wallet`/`loyalty` payment lines are intentionally ignored by accounting. They must not be mapped to a liability, cash, bank or revenue account and must not create journals.
- Loyalty point accrual, redemption, expiry and balance changes remain entirely in the POS loyalty subsystem. Accounting must not read or post the loyalty ledger.
- Discounts and cashback are outside the accounting subsystem. No separate discount/cashback journal is allowed. Only the actual money that the POS accepts through a real payment method is recorded.
- Missing, inactive, wrong-type or unmapped real payment methods fail closed; they must never be silently routed to another account.

### 3.2 Defaults and overrides
Payment methods are channels, not necessarily bank accounts. Keep the existing POS payment-method manager as the source of truth. The accounting mapping UI only chooses the destination asset account for real money received; it does not manage loyalty or discount behavior.

### 3.3 Optional automatic sales posting
- Owner/manager can enable or disable automatic sales posting from Accounting Settings. The persisted setting is `accounting_auto_post_sales`; a missing setting on an existing or new installation is treated as **disabled**.
- Disabled is the default. POS sales, payments and refunds remain saved in their operational records, but new monetary receipts do not create accounting journals while the switch is off. Collection must not fail because an accounting mapping or cutover validation is unavailable in this mode.
- Disabled receipt events are retained in the accounting audit log and shown in source-event reconciliation as intentionally skipped, not as missing journals. They do not block period close.
- Enabling the switch affects future receipt events only. It does not backfill sales collected while automatic posting was disabled.
- If a sale receipt was already posted before the switch was disabled, its later monetary refund still posts as the linked contra-revenue/payout movement. A refund for a sale that was never posted must not create a standalone negative-revenue journal.

## 4. Refund policy

- Only a refund that actually pays money out through cash, card or an active custom payment method affects accounting.
- When the original sale receipt exists in the ledger, such a refund debits Sales Returns/contra-revenue and credits the mapped payout asset account for the actual refunded amount. The stored legacy `refunds.amount_cents` uses the POS currency fraction factor; convert it to the accounting ledger factor before posting. In IRR, the legacy x100 amount is normalized to whole-rial ledger units. If automatic sales posting was off and the original sale was never posted, do not create a standalone refund journal; retain an audit skip instead.
- A wallet/store-credit refund is non-monetary and is intentionally ignored by accounting. Loyalty crediting/debiting never creates an accounting journal.
- No tax allocation or tax-liability reversal is performed by this integration.
- Refunds use their persisted refund-row ID as the idempotent source identity. A retry cannot duplicate the journal.
- Existing POS refund authorization and refundable-balance checks remain authoritative.


## 5. Cutover and historical records

Migration v105 stores `accounting_cutover_at` once, at the migration time. It does not overwrite an existing value. Automatic accounting posting only applies to bills created strictly after that cutover; a bill timestamp equal to the cutover second is treated as legacy because SQLite timestamps have one-second precision:
- existing historical bills are not auto-finalized or backfilled; bills timestamped at or before the cutover marker are excluded;
- if a legacy bill predates cutover, its operational collection remains usable, but no sale/collection journal is fabricated; each skipped new collection line is written to the accounting audit log as `skipped_pre_cutover_payment`;
- explicit finalization of a pre-cutover bill is rejected. This is intentional, not a missing retry;
- pre-cutover monetary refunds are audited as skipped;
- records on/after cutover use the new transactionally coupled posting rules.

This avoids manufacturing historical income on upgrade. Accounting balances may still differ from real cash/bank/open receivable positions until opening balances and reconciliation evidence are entered. Phase 4's opening-balance and cutover-reconciliation workflow provides that controlled setup path. Legacy cash-closure counts and refund amounts also use the POS fraction factor and must be normalized to the accounting factor before comparison; for IRR, that means converting legacy x100 values to whole-rial ledger units. Do not “solve” historical gaps by treating the first day's cash float or an owner's new money as sales income.

## 6. Date, currency, audit and integrity rules

- The store's configured currency and fraction digits are authoritative. Never assume two decimal places; store journal values as safe integer minor units.
- Accounting date is derived from the source timestamp in the configured regional timezone and configured business-day start; don't use the computer's timezone or a new wall-clock date when the source timestamp exists.
- Every posted journal has at least two valid lines, uses active/postable accounts, has no negative line values, and satisfies exact debit = credit.
- A sale's snapshot records the bill number/order, currency, subtotal, tax amount and snapshots, discount fields, charges, round-off, payable total and split-check identity. Once finalized, that commercial snapshot cannot be rewritten; it is not a posted revenue journal.
- Monetary receipt identity is tied to `payment_event_id`; monetary refund identity is the persisted refund row ID. Bill snapshot identity is the persisted bill ID but it creates no journal. A repeated identical money event resolves to the original journal. The same source identity with different amounts is a conflict and must never rewrite the posted row.
- Audit exceptions for the cutover are intentional and must remain visible. A future reconciliation screen should surface them; the log is not permission to ignore them.
- Payment/accounting posting occurs within the existing source transaction. Never “catch and log” a ledger error while committing a post-cutover payment/refund as though accounting succeeded.
- Backups/restore and all old schema migrations must remain compatible. Migration v105 is forward-only; do not edit existing migrations 100–104.

## 7. Worked scenarios

All amounts below are illustrative major currency units; real journals store integer minor units in the configured currency.

### Scenario A — partial payment then settlement
A POS bill may total 100, but accounting only records money actually received. A customer pays 40 cash and later 60 by card:
- First receipt: Dr Cash Drawer 40; Cr Sales Revenue 40.
- Second receipt: Dr Payment Clearing 60; Cr Sales Revenue 60.
- Result: recognized revenue is 100, with no Accounts Receivable or separate sale-finalization journal.

### Scenario B — full cash payment
The POS accepts 70 in cash:
- Dr Cash Drawer 70; Cr Sales Revenue 70.
- Bill creation/finalization creates no additional journal, so revenue is not double-counted.

### Scenario C — loyalty credit and wallet redemption
The POS awards 25 points, then a customer redeems them on a later bill:
- No accounting journal is created when points are awarded.
- No accounting journal is created when points are redeemed.
- Loyalty balances and their changes remain exclusively in the POS. If the customer also pays 75 by card, only that 75 creates Dr Payment Clearing 75 / Cr Sales Revenue 75.

### Scenario D — partial monetary refund
After 25 is actually refunded in cash:
- Dr Sales Returns/contra-revenue 25; Cr Cash Drawer 25.
- No tax allocation is generated by this integration. A refund to loyalty wallet/store credit is ignored by accounting.

### Scenario E — cost of goods is deliberately excluded
Actual money received through cash/card/custom methods = 100; recorded rent/utilities/payroll expense = 35; ingredient consumption cost is unknown/not computed.
- Current management result before COGS: 65. The POS tax amount is not separated or analyzed by this integration.
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
| Finalize bill once / retry | No journal; immutable snapshot only |
| Bill generated/finalized without real-money payment | No accounting journal |
| Full or partial cash payment | Debit cash and credit Sales Revenue by applied amount |
| Card/custom payment | Debit configured asset/clearing account and credit Sales Revenue by applied amount |
| Multiple payment lines | Distinct event IDs; each actual-money line posts once |
| Loyalty credit / wallet redemption / discount | No accounting journal, no account mapping and no effect on accounting balances. |
| Missing/inactive/wrong-type mapping after cutover | Posting fails and source transaction rolls back |
| Full/partial cash or card/custom monetary refund | One refund journal from committed refund ID; debit contra-revenue and credit actual payout asset. |
| Wallet/store-credit refund | Ignored by accounting; no journal. |
| Duplicate refund replay | No duplicate refund journal |
| Pre-cutover bill payment/refund | No historic journals; explicit audit exception remains |
| Invalid monetary amount / invalid minor unit | Refuse the monetary journal; don't fabricate an unbalanced entry |
| Attempt to edit finalized bill snapshot | Database guard rejects it |
| Attempt to cancel an order after money has been journaled | HTTP 409 until a refund/reconciliation or approved adjustment exists |
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
