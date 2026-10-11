# Accounting foundation: architecture and implementation roadmap

**Status:** ACTIVE DESIGN. Phase 0 discovery and Phase 1 ledger foundation are implemented (migrations 100–101 and `main/accounting/ledger.ts`). Phase 2 stage 1 now adds the expense data model and manager-only APIs in migration 102. Expense journal posting, transfers and UI remain to be implemented. See [accounting-implementation-context.md](accounting-implementation-context.md) for the current implementation contract.

**Purpose:** Establish a safe, incremental path to basic café accounting without rebuilding capabilities LyraPOS already has.

## 1. Goals and boundaries

LyraPOS should let a café owner understand both **where money moved** and **whether the business made a profit**, using the existing POS, payment, cash-session, inventory and recipe workflows as inputs.

The accounting subsystem should ultimately support:

- An auditable chart of accounts and double-entry journal.
- Expenses and non-sales income.
- Cash/bank/clearing-account balances and transfers.
- Automatic accounting entries for finalized bills, collections, refunds and other financial events.
- Supplier purchases and payable balances.
- Inventory valuation and cost of goods sold (COGS).
- Management reports and, in a later phase, trial balance, balance sheet and a more complete income statement.
- Safe database migrations, backup/restore and clear audit history.

The first release should keep the staff experience simple. A café manager should be able to record a routine expense without understanding debit/credit terminology; the backend should create and validate the appropriate accounting entries.

### Non-goals for the first release

- Replacing the existing order, bill, payment-method, cash-session or inventory systems.
- Implementing payroll, fixed-asset depreciation, loans/installments, check lifecycle management, tax-authority submission or multi-branch consolidation before core posting and reconciliation are reliable.
- Claiming statutory or tax compliance based only on internal sales/tax snapshots.
- Introducing a cloud dependency; routine accounting must work offline with LyraPOS's local-first architecture.

## 2. Existing capabilities to reuse

This is a design inventory based on the current repository. During implementation, verify exact transaction timing and schemas against current code and tests before choosing posting hooks.

| Existing subsystem | Reuse boundary | Accounting work still needed |
| --- | --- | --- |
| Configurable payment methods (main/routes/payment-methods.ts, payment-method settings/UI) | Keep existing methods and their IDs/names; do not build a second payment-method manager. | Map each payment method to the correct cash, bank, wallet-liability or clearing account. A payment method is a channel, not automatically a bank account. |
| Orders, bills, bill items, payment details and refunds (main/routes/orders.ts, main/routes/bills.ts, main/routes/refunds.ts, refund service) | Existing records remain the operational source of truth for POS sales, collections and refunds. | Define when a bill is financially finalized and post each source event once. Distinguish sale recognition from later collections. |
| Cash sessions, cash closures and drawer movements (main/routes/cash-sessions.ts, main/routes/cash-closures.ts) | Preserve opening float, pay-in/pay-out, safe-drop, counted cash and variance behavior. | Reconcile operational cash totals with the accounting cash account without treating transfers or opening float as income. |
| Product stock and product inventory movements (main/services/inventory.ts, product routes) | Keep current quantity changes and movement ledger authoritative. | Add financial valuation and posting rules; do not apply a second quantity deduction from the accounting layer. |
| Supplies/materials, supply movements and recipes (main/services/supplies.ts, main/services/recipes.ts, inventory UI) | Reuse existing ingredient quantities, recipe definitions, recipe snapshots, consumption/restoration events and units. | Price stock movements and derive material cost/COGS consistently. |
| Existing sales reports and daily XLSX/CSV export (main/routes/reports.ts, main/services/daily-sales-export.ts, docs/daily-sales-export.md) | Preserve existing definitions and exports unless a separately reviewed change is approved. | Add accounting reports and reconciliation checks. Clearly label cash/collection reports separately from accrual-style profit reports. |
| Regional settings and tax snapshots | Reuse existing currency precision, business timezone/day boundaries and stored tax snapshots. | Define account mapping and posting treatment; do not silently change tax calculations or imply tax compliance. |

Important distinction: quantity inventory already exists, and payment methods already exist. This project adds the **financial layer** around them; it must not duplicate either operational subsystem.

## 3. Core design principles

1. **One operational source of truth.** Bills, payment lines, refunds, stock movements and cash movements are created by their existing services. Accounting consumes their committed events; the accounting UI must not invent parallel copies of sales or stock.
2. **Double-entry ledger.** Every posted journal must balance: total debits equal total credits in the tenant's accounting currency. Use account types to group assets, liabilities, equity, income, contra-income, expenses and contra-expenses.
3. **Server-authoritative posting.** The frontend submits business intent; the backend validates it, calculates amounts and creates journal entries.
4. **Idempotency.** A retry, repeated request, app restart or background reconciliation must not post the same source event twice. Define a unique source-event/posting-purpose key.
5. **Atomicity.** A source operation and its required accounting posting should either commit together, or leave a recoverable, explicitly detectable state. Do not silently swallow a failed posting.
6. **Posted entries are not silently edited/deleted.** Corrections should use a reversal or adjusting entry with an audit trail. Drafts may be edited under role controls; posted-period corrections need explicit rules.
7. **Local-first and migration-safe.** Keep SQLite and offline operation. Add forward migrations only; never reset a customer's database to implement accounting. Protect upgrades with verified backups and migration tests.
8. **Currency and time consistency.** Reuse LyraPOS currency fraction-digit helpers and canonical timestamp/business-day rules. Do not use floating-point arithmetic for ledger balancing. Convert at a single documented boundary to integer minor units appropriate for the configured currency.
9. **Auditability and least privilege.** Store creator, timestamps, source references and reasons. Apply explicit role permissions for creating, posting, reversing, exporting and viewing financial data.
10. **Operational and accounting reports have different meanings.** A paid-bill report answers how much was collected; a profit report must also account for expenses and COGS. Never label cash collected as net profit.

## 4. Proposed accounting domain model

The Phase 1 implementation now uses the table names and invariants documented in [accounting-implementation-context.md](accounting-implementation-context.md). Later additions must use new append-only migrations; never edit historical migrations. The entities below describe the target responsibilities beyond the current foundation.

### 4.1 Chart of accounts

Each account should have a stable code, name, type, optional parent/group, active flag, system-managed flag and whether direct posting is allowed.

Seed a small, understandable chart suitable for a single café, with accounts such as:

- Cash drawer and bank/clearing accounts.
- Accounts receivable and accounts payable.
- Ingredient/product inventory.
- Tax payable/recoverable accounts when applicable and properly configured.
- Owner's equity/opening balance.
- Sales revenue, sales returns/discounts and service/other revenue.
- Cost of goods sold.
- Rent, payroll, utilities, repairs, delivery, marketing, bank charges and other operating expenses.

Avoid hard-coding account labels throughout business logic. Use stable account codes/IDs and a mapping/settings layer. Protect system-required accounts from accidental deletion and validate parent/type relationships.

### 4.2 Journal entries and lines

A journal header should record a unique document number, accounting date, description, status, source type/source ID, posting purpose, creator and timestamps. Suggested statuses are draft, posted and reversed; the implementation should define whether a reversal is a linked new entry or a status plus a linked reversing entry.

Each journal line should reference an account and store either a debit or a credit amount, never both and never a negative amount. Optional dimensions include counterparty, payment-method/source reference, product/category and line memo. A posted journal must:

- Have at least two lines.
- Balance exactly in the configured currency precision.
- Reference active/postable accounts.
- Have a valid source or an explicitly permitted manual-entry reason.
- Be protected from duplicate source posting.
- Retain links to the originating business record and to any reversal.

Do not derive reports from editable frontend totals. Reports should query posted ledger lines and separately expose unposted/draft items where appropriate.

### 4.3 Expenses and expense categories

Provide manager-friendly entry screens, using configurable categories that map to expense accounts. An expense should capture date, category, amount, description, payee/vendor (optional in the first UI), reference/receipt number, account paid from, existing payment method, payment date/status, creator and timestamps.

The implementation must distinguish an expense already paid from a bill still payable. Do not record an unpaid supplier bill as a cash payment. The detailed purchase/payables workflow may follow the first expense screen, but the model must not make that future workflow impossible.

Expense edits, cancellation and deletion must follow posting state: unposted drafts can be changed; posted financial activity is corrected through reversal/adjustment and retained in the audit trail.

### 4.4 Mapping existing payment methods

Keep the existing payment-method catalogue. Add accounting configuration that maps each configured method to a ledger destination/clearing account and, where necessary, defines settlement behavior.

Examples that require explicit mappings:
- Cash collected → cash drawer.
- Card payment → bank or card-clearing account (not necessarily the bank balance immediately).
- Store-credit/wallet redemption → the appropriate liability/customer-credit account, if the current feature is enabled.
- Custom payment method → a manager-configured account; never guess from a translated display name.

Payment-method name, cash location and GL account are separate concepts. The implementation must also respect actual payment-line amounts/timestamps and partial/split payments rather than treating the entire bill as one payment.

### 4.5 Purchases, inventory valuation and COGS

A purchase document should connect supplier, invoice lines, quantity/unit, unit price, discount, recoverable tax if applicable, other landed costs, payment status and inventory receipt.

The current product/supply stock movements stay authoritative for quantity. An accounting valuation layer should translate those movements into value changes and cost-of-goods-sold postings without deducting stock a second time.

A simple weighted-average-cost method is a candidate for the first inventory valuation implementation, subject to explicit confirmation. Requirements include unit conversion, purchase-price changes, recipe-based consumption, wastage, stock corrections, cancellation/restoration and backdated activity policy. Previously posted costs must not silently change when today's purchase price changes.

### 4.6 Source event posting rules

The exact posting point must follow existing order/bill lifecycle semantics, confirmed during implementation. The expected accounting outcomes are:

| Business event | Expected ledger effect (conceptual) |
| --- | --- |
| Bill becomes financially final | Recognize the sale and any applicable tax liability, with the corresponding receivable/settlement structure. |
| Payment or partial payment is recorded | Increase the mapped cash/bank/clearing asset and reduce the customer receivable by the amount actually collected. |
| Refund is approved/committed | Record the refund/return and relevant tax reversal where applicable; credit the actual payout account or the applicable customer-credit liability. |
| Expense is paid | Debit its configured expense account and credit the actual payment account. |
| Expense/vendor bill is incurred but unpaid | Debit the appropriate expense/asset and credit accounts payable; do not reduce cash until payment occurs. |
| Purchase is received | Increase inventory valuation and record the corresponding payable/cash and applicable tax treatment. |
| Supplier payment is made | Reduce accounts payable and the actual payment account. |
| Cash-to-bank transfer | Debit destination account and credit source account; do not create income or expense. |
| Owner contributes funds | Debit cash/bank and credit equity; do not treat it as operating income. |
| Ingredients are consumed/wasted | Reduce ingredient inventory value and record the approved COGS/waste treatment, tied to existing stock movements. |
| Opening balances are entered | Create a balanced, clearly labelled opening-balance journal with a traceable setup record. |

These are accounting outcomes to implement and test, not claims about existing postings. Tax account selection and the recognition point must be documented, not inferred from UI labels.

## 5. Report plan

### First usable release
- Expense list with date/category filters and totals.
- Income/expense summary that distinguishes sales, other income, expenses and cash movement.
- Cash drawer and bank/clearing account balance plus ledger.
- Transfer history.
- Reconciliation view comparing existing cash-closure expected/count figures with the relevant accounting cash activity.
- CSV/XLSX export for financial lists where supported by existing export conventions.

### Subsequent accounting release
- Supplier purchase and payable reports.
- Inventory value and COGS report by period/product/category.
- Gross profit by product and category, with method and data completeness clearly disclosed.
- Accrual-style profit-and-loss statement.
- General ledger/account activity and trial balance.
- Balance sheet and period closing after opening balances and all required account mappings are supported.

The first version must not show a "net profit" KPI until COGS and relevant expense treatment are sufficiently complete. If data is missing, display "not available/incomplete" with a reason rather than a misleading zero.

## 6. Phased roadmap and acceptance criteria

### Phase 0 — Discovery and accounting contract
- Re-read active database initialization/migration code and current tests for bills, payments, refunds, cash sessions/closures, product inventory and supply/recipe lifecycle.
- Document exact bill-finalization, partial payment, split bill, cancellation and refund semantics.
- Agree the accounting basis and inventory valuation method, tax boundaries, opening balances, accounts and role permissions.
- Produce a posting matrix for every source event before implementation.
- Acceptance: no unresolved decision can cause one event to be posted twice or sales, cash and profit to be conflated.

### Phase 1 — Ledger foundation
- Introduce chart of accounts, journal headers/lines, posting service, validation helpers, source idempotency and audit data using a migration-safe schema.
- Add seed/system account handling and opening-balance design.
- Verify the Phase 1 ledger through service/SQL tests; defer the read-only account ledger view/API to Phase 6 (reports and close controls), consistent with the Phase 1 implementation contract.
- Acceptance: balance/precision/account/source invariants are enforced in backend transactions; old databases upgrade without data loss; core POS workflows still work offline.

### Phase 2 — Expenses and financial accounts

**Stage 1 — data model and API (implemented in migration 102):** expense categories mapped to expense accounts, draft expense create/list/detail/update, paid/unpaid metadata, and mapping of existing payment-method keys to GL accounts. Manager-only endpoints are available under `/api/accounting`; no second payment-method catalogue is created. Coverage: `npm run test:accounting-expenses` plus ledger upgrade tests.

**Stage 2 — posting and payment-state workflow (next):** post paid expenses to the mapped payment account and expense account, keep unpaid expenses from reducing cash, and enforce idempotency/audit-safe corrections.

**Stage 3 — transfers and UI:** cash/bank transfers, expense/category screens and payment-account mapping in the existing Settings UI, with end-to-end tests.

- Reuse existing payment methods and map them to GL accounts; do not create a second payment-method screen.
- Add cash/bank transfers and expense journal posting.
- Acceptance: paid expenses update the correct account and expense report once; transfers change account balances but do not affect income or expenses; drafts/posted corrections follow audit rules.

### Phase 3 — Sales, collections and refunds posting
- Post from existing bills, payment lines and committed refunds after confirming source lifecycle semantics.
- Support unpaid/partial/fully paid bills, mixed payment lines, split checks, custom payment methods and wallet/store-credit behavior where enabled.
- Ensure cancellations and refunds follow actual payment history; never count a cancelled-but-paid bill as if its cash did not move.
- Acceptance: all postings are idempotent and balanced; ledger collection totals reconcile with the current payment/refund rules; existing daily sales exports remain stable.

### Phase 4 — Purchases and counterparties
- Add supplier records, purchase documents, receipt quantities, partial payments, payables and purchase returns.
- Integrate receipt with existing product/supply stock services using their current stock-movement APIs.
- Acceptance: purchase quantity changes occur exactly once; supplier balances equal purchase liabilities minus recorded payments/returns; cash changes only when payment happens.

### Phase 5 — Valuation and COGS
- Implement the approved costing method for product stock and recipe-backed supplies.
- Tie cost postings to immutable order/recipe snapshots and committed stock movements; define wastage and stock-count variance treatment.
- Acceptance: sample transactions reconcile quantities and values; price changes do not rewrite posted historical profit; cancellation/restoration cannot duplicate COGS or stock.

### Phase 6 — Reports and close controls
- Add P&L, account ledger, trial balance and balance sheet only when the corresponding ledger coverage is complete.
- Add period controls, reversal workflows and exports.
- Acceptance: trial balance always balances; P&L components reconcile to posted journal accounts; period/date filters respect tenant timezone/business-day policy and currency precision.

### Phase 7 — Optional advanced features
- Checks, instalments/loans, payroll, fixed assets, depreciation, tax authority integrations and multi-branch consolidation are separate scoped increments, not blockers for the basic accounting foundation.

## 7. Future test matrix

Tests should follow the existing Node/TypeScript backend test conventions and run in CI. Keep unit tests for pure posting/validation logic and integration tests against a temporary SQLite database. Add UI/E2E tests for manager flows after the API and data contract stabilise.

### Ledger invariants
- Equal debit/credit totals at configured currency precision.
- Reject zero-line, one-line, unbalanced, negative, non-finite, over-precision and inactive-account postings.
- Reject lines with both debit and credit set.
- Reject a duplicate source-event/posting-purpose key; permit valid independent postings from the same source where the contract allows them.
- Verify transaction rollback leaves no partial journal after an injected failure.
- Verify posted entries are immutable and reversals are linked and balanced.

### Sales, payments and refunds
- Cash, card, configured custom method and multiple payment lines for one bill.
- Fully unpaid, partially paid, fully paid and subsequently settled bills.
- Split checks; repeated/idempotent payment request; retry after restart.
- Cancelled but paid order; refund after payment; partial/item-level refund if supported; refund method differs from original payment method.
- Wallet/store-credit flow when enabled.
- Posting timestamp/business date differs from payment timestamp; local business-day boundary.
- Verify no double revenue, double collection or double refund.

### Expenses and transfers
- Expense paid in cash vs bank; different expense categories; invalid/inactive category.
- Unpaid payable does not reduce cash; later supplier/payment settlement does.
- Cash-to-bank transfer preserves total cash-equivalent assets and creates no income/expense.
- Invalid date, wrong precision, duplicate submission, permissions and audit metadata.
- Posted expense correction creates a traceable reversal/adjustment, not a silent delete.

### Inventory, purchases and costing
- Purchase in different units; unit conversion and fractional ingredients.
- Multiple purchase prices and weighted-average recalculation.
- Recipe-backed sale uses the persisted recipe snapshot; current recipe edit does not rewrite that order's cost inputs.
- Waste, stock count, manual adjustment, sale consumption, cancellation/restore and duplicate event.
- Out-of-stock or failed stock mutation does not leave a journal-only inventory posting.
- Historical COGS is stable according to the chosen costing/date policy.

### Reconciliation and reports
- General ledger totals reconcile to posted journal lines and account balances.
- Trial balance debits equal credits.
- P&L reconciles to mapped posted income/contra-income/expense/COGS accounts.
- Daily collection report reconciles to the established bill/payment/refund definitions in docs/daily-sales-export.md.
- Cash accounting reconciles to cash session/day-close figures, with opening float, pay-in, pay-out, safe-drop, and cash refunds treated correctly.
- Transfers do not appear as revenue/expense; owner capital and loans are not operating income.
- Empty periods show accurate zeros; incomplete costing is clearly signalled, not reported as false profit.

### Locale, migration, permissions and recovery
- Rial/currency fraction digits; rounding boundary tests; no floating-point imbalance.
- Tenant timezone and configured business-day start; Shamsi display where supported, with stable stored dates/timestamps.
- Owner/manager/cashier/server authorization checks on both API and UI; unauthorised posting/reversal/export is rejected.
- Fresh install, each supported previous-schema upgrade, existing populated database, backup/restore, restart and interrupted migration.
- Run relevant existing payment, refund, cash-closure, inventory-ledger, recipe lifecycle, daily-sales-export, migration-integrity and regression suites unchanged.

## 8. Definition of done for accounting milestones

A milestone is not done merely because its page opens. Before it can be enabled in a customer build:

- Database migrations are forward-only and tested against an existing populated database.
- Every posting event has a documented rule and source reference.
- Amounts use the documented currency precision and all posted journals balance.
- Idempotency and rollback are tested, including retries and failure injection.
- Role permissions and audit attribution are in place.
- Existing payment-method, stock movement, recipe, cash-closure and export behaviour stays intact.
- Financial totals have reconciliation tests and clear labels.
- Backup/restore and Windows installer upgrade paths are covered where affected.
- User-facing translations, RTL layout, date/number formatting and export headers are reviewed.

## 9. Decisions to settle before production posting

The following choices require explicit confirmation in the implementation PR or a focused issue. Do not quietly hard-code them:

1. **Accounting basis and revenue-recognition point:** exact existing lifecycle event that makes a bill final and creates receivable/revenue.
2. **Inventory valuation:** weighted average vs another agreed method, including backdated purchases and historical corrections.
3. **Tax treatment:** which tax snapshots post to liability/recoverable accounts and what is explicitly out of scope for statutory compliance.
4. **Payment-method mapping:** default accounts for cash, card terminals, custom methods and store credit/wallet; card-clearing settlement timing.
5. **Permissions:** who may create, approve, post, reverse, export and close a financial period.
6. **Expense/purchase workflow:** which record states are available in v1 and how unpaid items become payable.
7. **Opening balances:** how initial cash, bank, inventory, receivables, payables, capital and balancing differences are entered and approved.
8. **Historical data:** whether old transactions are backfilled, from what date, and how opening balances reconcile if old journal details are unavailable.
9. **Posted-period policy:** whether old periods may be adjusted and which roles may approve it.

Until these decisions are resolved, reports should state the coverage boundary clearly and must not imply a fully compliant general ledger or exact net profit.

## 10. Suggested implementation sequence for the first coding PR

The first implementation PR after this design should be narrowly scoped to **Phase 1 only**: schema/migration, account seeds, posting engine, journal validation, source idempotency and focused automated tests. It should not simultaneously ship every expense, purchase, COGS and report screen.

Suggested initial tests/files (final paths follow repository conventions):

- A posting-engine unit test suite for balancing, precision, account validity and reversal rules.
- A migration-integrity test for a fresh database and a populated prior-version fixture.
- A database transaction/rollback test for partial posting failure.
- A source-idempotency test proving retries cannot create duplicate journals.
- A permission test for read/post/reverse endpoints once exposed.
- A baseline regression run of the existing payment, refunds, cash sessions/closures, inventory-ledger, recipe lifecycle and daily-sales-export suites.

This sequencing establishes a tested foundation before business events are connected to automatic posting.


## Implementation status and next gates

As of this change, Phase 0 discovery and Phase 1 ledger foundation are implemented in code:
- SQLite migration 100 adds the starter chart, journal header/lines, idempotency/source constraints, audit log and initial database guards; migration 101 hardens system-account identity without rewriting migration 100.
- `main/accounting/ledger.ts` validates and transactionally creates/posts draft journals.
- `tests/accounting-ledger.test.ts` covers fresh installation, upgrades from v99 and v100, system-account identity guards, balance rules, idempotency, atomic rollback and posted-entry immutability.

This does **not** yet enable expense UI, expense journal posting, account transfers, UI, automatic posting from sales/collections/refunds, inventory valuation or accounting reports. The next scoped PR should implement Phase 2, followed by Phase 3. Per product direction, a Windows installer is built for hands-on testing only after Phase 3 and its required CI/regression checks are green.
