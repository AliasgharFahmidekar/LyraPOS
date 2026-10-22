**Status on PR #19 as of 2026-10-22:** Phases 0–6 passed their acceptance gates. Phase 7.2 recurring obligations passed the full CI workflow on exact head `ce2b0e48f066113a16459dab4277056533097bf1` in run [#39843475494](https://github.com/AliasgharFahmidekar/LyraPOS/actions/runs/39843475494). Phase 7.3 loan origination/installments is now implemented on the branch with migration v116, ledger-backed new-loan and opening-balance journals, principal/interest/fee separation, due-event processing, actual-payment confirmation, owner/manager routes, Persian/English Accounting UI, backup-restore trigger reinstatement, and focused regressions. The new Phase 7.3 code is **pending exact-head CI verification**; do not claim acceptance until the full suite/build/lint/i18n workflow passes. Do not merge this PR.

**Latest Phase 6 audit and regression work:**
- Cutover classification now follows the actual receipt/refund event timestamp, not merely the parent bill's creation date. A post-cutover payment/refund on an older bill is therefore recognized correctly without backfilling the historical bill itself. A receipt with no timestamp remains unresolved unless it has the unambiguous legacy shape (pre-cutover bill plus no event ID and no timestamp), which is visibly classified as excluded under the explicit no-backfill policy; inconsistent/newer rows remain unresolved and block close.
- Source-event reconciliation is visible in the accounting operations UI. The view is read-only; it reports source identity, timestamp, status, linked journals and review reason and never silently repairs/backfills history.
- Period close performs a trial-balance/journal-integrity check for the requested period, rejects unbalanced posted journals and still requires source-event reconciliation to have no unresolved exceptions.
- Correction tests cover refusing reversals dated inside a closed period and using a separately audited reversing journal in a later open period while preserving the original posting.
- Backup/restore regression now verifies a full backup/direct-restore round trip preserves journal source identity, event type, idempotency key and payload hash, period-close history, source-event audit metadata, period-close guards and foreign-key integrity.
- The final acceptance gate is the full regression suite, TypeScript build, backend/frontend lint, canonical i18n/print-label checks and backup/restore tests on the **exact final PR head**. Do not infer success from a historical run, weaken accounting assertions, or merge before the exact-head gate is green.

**Purpose:** Establish a safe, incremental path to basic café accounting without rebuilding capabilities LyraPOS already has.

## 1. Goals and boundaries

LyraPOS should let a café owner understand both **where money moved** and **whether the business made a profit**, using the existing POS, payment, cash-session, inventory and recipe workflows as inputs.

The accounting subsystem should ultimately support:

- An auditable chart of accounts and double-entry journal.
- Expenses and non-sales income.
- Cash/bank/clearing-account balances and transfers.
- Automatic accounting entries for actual money received/refunded through configured cash, card and custom payment methods; bill finalization alone is not revenue.
- Supplier purchases and payable balances.
- Inventory valuation and cost of goods sold (COGS).
- Management reports and, in a later phase, trial balance, balance sheet and a more complete income statement.
- Safe database migrations, backup/restore and clear audit history.

The first release should keep the staff experience simple. A café manager should be able to record a routine expense without understanding debit/credit terminology; the backend should create and validate the appropriate accounting entries.

### Non-goals for the first release

- Replacing the existing order, bill, payment-method, cash-session or inventory systems.
- Implementing payroll, fixed-asset depreciation, tax-authority submission or multi-branch consolidation before core posting and reconciliation are reliable. **Future checks and recurring payments/loan schedules are now an explicit planned accounting capability** after the current ledger, reconciliation and period-close controls pass their gates.
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

Only real-money methods are mapped:
- Cash received → cash drawer.
- Card payment → card-clearing account (not necessarily the bank balance immediately).
- Custom payment method → a manager-configured asset account; never guess from a translated display name.
- Loyalty wallet is not an accounting payment method. Its credits/redemptions are excluded, not mapped to a liability or asset.

Payment-method name, cash location and GL account are separate concepts. The implementation must also respect actual payment-line amounts/timestamps and partial/split payments rather than treating the entire bill as one payment.

### 4.5 Purchases, inventory valuation and COGS

A purchase document should connect supplier, invoice lines, quantity/unit, unit price, discount, recoverable tax if applicable, other landed costs, payment status and inventory receipt.

The current product/supply stock movements stay authoritative for quantity. An accounting valuation layer should translate those movements into value changes and cost-of-goods-sold postings without deducting stock a second time.

A simple weighted-average-cost method is a candidate for the first inventory valuation implementation, subject to explicit confirmation. Requirements include unit conversion, purchase-price changes, recipe-based consumption, wastage, stock corrections, cancellation/restoration and backdated activity policy. Previously posted costs must not silently change when today's purchase price changes.

### 4.6 Source event posting rules

The exact posting point must follow existing order/bill lifecycle semantics, confirmed during implementation. The expected accounting outcomes are:

| Business event | Expected ledger effect (conceptual) |
| --- | --- |
| Bill becomes financially final | Store an immutable bill snapshot only; no revenue/receivable/tax journal. |
| Cash/card/custom payment is recorded | Debit the mapped asset and credit Sales Revenue by the actual applied monetary amount. |
| Monetary refund is committed | Debit Sales Returns/contra-revenue and credit the actual mapped payout asset by the amount refunded. |
| Loyalty-wallet or discount changes | No accounting journal or balance change. |
| Expense is paid | Debit its configured expense account and credit the actual payment account. |
| Expense/vendor bill is incurred but unpaid | Debit the appropriate expense/asset and credit accounts payable; do not reduce cash until payment occurs. |
| Purchase is received | Increase inventory valuation and record the corresponding payable/cash and applicable tax treatment. |
| Supplier payment is made | Reduce accounts payable and the actual payment account. |
| Cash-to-bank transfer | Debit destination account and credit source account; do not create income or expense. |
| Owner contributes funds | Debit cash/bank and credit equity; do not treat it as operating income. |
| Ingredients are consumed/wasted | Reduce ingredient inventory value and record the approved COGS/waste treatment, tied to existing stock movements. |
| Opening balances are entered | Create a balanced, clearly labelled opening-balance journal with a traceable setup record. |

For POS events, the selected cash-received-only treatment above is the active implementation contract. Expense, payable, purchase, transfer, owner-capital and opening-balance entries remain separate flows. This POS integration does not calculate tax liability or statutory tax.

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

**Stage 1 — data model and API (implemented in migrations 102–103):** expense categories mapped to expense accounts, draft expense create/list/detail/update, paid/unpaid metadata, and mapping of existing payment-method keys to GL accounts. Manager-only endpoints are available under `/api/accounting`; no second payment-method catalogue is created. Expense currency must match the store's configured currency. `POST /expenses` accepts `Idempotency-Key` and safely returns the existing record for a repeated identical request, while conflicting reuse returns HTTP 409. Audit snapshots capture all expense business fields. Migration 103 adds append-only schema changes, a unique idempotency index and SQL guards for amount, date, currency and idempotency metadata. Coverage: `npm run test:accounting-expenses`, `npm run test:accounting-routes`, plus ledger upgrade tests including v102 expense preservation.

**Stage 2 — posting and payment-state workflow (implemented in migration 104):** `POST /expenses/:id/post` writes and finalizes one balanced journal for a paid expense (debit the snapshotted expense account, credit its snapshotted mapped payment account) in the same SQLite transaction that marks the expense posted. The journal uses the actual payment date and stable source/idempotency keys. An unpaid expense remains a draft with no journal, so it cannot reduce cash; recognizing unpaid bills against accounts payable is intentionally deferred to the purchase/payables workflow. `POST /expenses/:id/reverse` requires a reason and accounting date and creates a separate posted journal with exact debit/credit sides reversed; original posted journals are never edited. Request-level idempotency from stage 1 remains distinct from posting/reversal idempotency. Schema v104 adds reversal linkage and SQL guards against editing/deleting posted expense records or invalid state transitions.

**Stage 3 — transfers and UI (implemented):** cash/bank transfers, expense/category screens and payment-account mapping use the existing ledger and payment-method catalogue. The transfer service posts idempotent, balanced asset-to-asset journals and exposes history. Transfers are restricted to the configured cash-drawer, bank and payment-clearing accounts; inventory, receivables and unclassified custom assets are not accepted as money accounts. Operational expense workflows (create/list/post/reverse) and transfer creation/history are available from the dedicated `/accounting` page. Setup-only category management and payment-method-to-ledger mappings remain under Settings. Persian RTL and English labels are provided; full translation coverage across all 21 configured locales remains a release follow-up.

**Phase 2.5 — operational navigation and setup separation (implemented and CI-verified):** the main sidebar exposes `/accounting` to owners/managers. The page has its own owner/manager access guard, while server/API authorization remains the security boundary. The shared accounting component supports operations and settings modes without duplicating posting/validation logic; Settings mode loads only account/category/mapping data and skips expense/transfer history calls. The existing KDS navigation and unrelated Settings components are preserved. The full regression workflow passed on commit `703e76fb120fe2fbbd5ae5b618aaecccaa557abd` in run [#305](https://github.com/AliasgharFahmidekar/LyraPOS/actions/runs/38218846361); documentation changes in this PR will run through CI again.

- Reuse existing payment methods and map them to GL accounts; do not create a second payment-method screen.
- Add cash/bank transfers and expense journal posting.
- Acceptance verified by focused and full CI tests: a paid expense creates exactly one balanced posted journal against its stored expense/payment-account snapshots; retrying a post does not duplicate it; unpaid drafts create no cash movement; reversals create exactly one opposite journal and retain the original; posted expense details cannot be edited/deleted directly. Transfers post one balanced asset-to-asset journal, are idempotent, reject invalid/non-liquid accounts and same-account transfers, and create no revenue/expense lines. Manager-only transfer routes are covered; cashier/server/chef and unauthenticated access are denied.

### Phase 3 — Real-money receipts and refunds

**Policy: cash-received-only POS accounting.** Only actual money accepted or paid out through the configured cash, card and custom payment methods affects the ledger.

Acceptance criteria:
- Generating/finalizing a bill creates an immutable audit snapshot only; it does not create revenue, receivables or tax journals.
- Each accepted cash/card/custom payment line posts Dr mapped active asset / Cr Sales Revenue for the persisted applied amount (not tendered cash before change).
- Cash maps to Cash Drawer; card maps to Payment Clearing; custom methods default to Payment Clearing and may be mapped only to a configured cash-drawer, bank or payment-clearing account.
- A payment line's stable event identity prevents duplicate posting on retry.
- Only a monetary cash/card/custom refund posts Dr Sales Returns/contra-revenue / Cr the actual mapped payout asset.
- Loyalty wallet credits, redemptions, expiries, balance changes and wallet/store-credit refunds create no accounting entries and require no account mapping.
- Discounts and cashback create no separate journal. Their only indirect effect is that the POS may accept a different amount of actual money.
- No Accounts Receivable, tax liability, tax allocation, or accrual-style sale journal is generated from POS bill fields. This is an internal cash-received bookkeeping model, not statutory tax accounting.
- Historical records at/before cutover are not backfilled. Migration/restore and all regression tests must pass.
- The default suite must cover cash, card, custom method, wallet-only payment, mixed wallet plus real payment, discounts, refunds, idempotency and pre-cutover exceptions.

### Phase 4 — Manual activities, opening balances and account history

**Stage 1 — manual income and owner equity (implemented):**
- Manager-only manual other income uses an eligible revenue account distinct from POS sales revenue/returns/discounts.
- Owner contributions credit the Owner Capital equity account; owner drawings debit Owner Drawings equity. Neither is income or operating expense.
- All activities post immediately through the existing double-entry ledger, with valid dates, configured currency, idempotency, immutable posted journals and audit history.

**Stage 2 — opening balances and account transaction history (implemented; current-head CI gate pending):**
- Add opening balances for active postable asset, liability and equity accounts using integer currency-minor units and the store's configured currency. Source classification must match the account; one opening record is allowed per account and an identical idempotency retry returns the original record.
- Post each opening record as a balanced journal on its opening date, offset through a dedicated Opening balance equity account. This is a setup/balancing account, not sales income or owner contributions. Existing historical events are not backfilled.
- Do not derive inventory value from quantity: opening inventory valuation remains deferred until a costing policy is chosen.
- Expose the opening-balance list and a read-only account transaction history with posted movements, date filters, account balance and running balance. Reuse existing journal headers/lines; do not create a parallel transaction ledger.
- Migration v106 adds the opening-equity account, the opening-balance setup table, unique/idempotency constraints and update/delete guards. Tests cover fresh/legacy migration upgrades, balanced opening journals, non-income treatment, source/account validation, idempotency, duplicate prevention, role authorization, and running balances.

**Stage 3 — pre-cutover reconciliation (implemented; current-head CI gate pending):**
- `GET /api/accounting/reconciliation` summarizes actual monetary payment lines attached to pre-cutover bills, pre-cutover monetary refunds, unclassified/malformed payment details, and audit entries created when legacy payments/refunds are intentionally skipped. Wallet/store-credit is not counted as real money.
- Legacy payment/refund samples stay visible as unbackfilled exceptions; a summary is not proof that every historical event has been independently verified.
- Cash closure checkpoints compare counted drawer cash with posted `acct-cash-drawer` balance only if an opening-cash record predates the close. Missing/late opening balances and invalid comparisons are labelled. Pay-in/pay-out/safe-drop activity in the comparison window forces a manual-review status instead of implying a clean or directly adjustable difference.
- `POST /api/accounting/reconciliation/adjustments` requires an idempotency key, verified balance, and reason (plus optional evidence reference). The backend recomputes the posted ledger balance and creates a balanced journal through the dedicated `reconciliation_adjustment_equity` account; inventory and offset-equity accounts are rejected. Adjustment metadata is immutable at the database level; identical retries return the original and changed payloads conflict.
- Adjustments never create income/expense or backfill historical sales. Inventory value and COGS remain deferred. Migration v107 is additive and must pass fresh-install and supported-upgrade checks.

**Phase 4 acceptance:** every recorded activity, opening balance or reconciliation adjustment creates one balanced posted journal; rejected requests leave the ledger unchanged; opening cash, owner capital and adjustments never count as sales or profit; account balances reconcile to posted movements; unresolved operational/cutover exceptions remain visible; corrections use reasoned, traceable, immutable adjustment records, never silent edits.

### Phase 5 — Basic management reports (without COGS)

**Stage 1 — ledger-backed report foundation (in progress on PR #19):**
- Add a manager/owner-only read-only report endpoint and an Accounting → Financial reports view; do not create a second accounting ledger or derive totals from frontend state.
- Report POS sales revenue from posted actual monetary receipts, monetary refunds, manually posted other income and posted expense-account movements by accounting business date.
- Show tax payments as a separately visible expense; migration v108 seeds a dedicated “Taxes paid” expense account/category so a tax payment is recorded when paid, not deducted retroactively from sales revenue.
- Show cash-drawer, bank and payment-clearing balances through the selected end date, their period debit/credit movements, and posted journal-line movements for the selected period.
- Surface recorded pre-cutover monetary receipt/refund exceptions so the report does not imply historical completeness.
- Owner contributions/drawings, opening balances and cash/bank transfers do not contribute to income. Refunds are shown separately and reduce sales revenue after refunds; wallet/store-credit activity, discounts and cashback remain outside accounting.
- Label the result “result before COGS / excluding inventory cost”, not “net profit”. Inventory cost is not currently calculated.
- Acceptance: report totals reconcile to posted ledger accounts and persisted post-cutover source events; date/currency precision follows the store's accounting currency and business-date settings.

**Resolved reporting policy — cash received is sales income; tax is an expense when paid:** the report uses the actual monetary receipts already posted by the POS as sales revenue. It does not subtract stored bill-tax snapshots from that income. When the business later pays tax, the owner records that payment as a paid expense using the seeded “Taxes paid” category, which posts to the dedicated tax-expense account and reduces the report's result for the payment's accounting date. This is the requested internal cash-received bookkeeping model, not a statutory tax-liability calculation or tax-compliance claim.


### Phase 6 — Reconciliation, backup and close controls (complete on PR #19)

This phase must be implemented in separate increments so that reconciliation never silently repairs or rewrites the ledger.

#### Stage 6.1 — reconciliation contracts and source-event audit (implemented; CI run #517 passed)
- Implemented read-only `GET /api/accounting/source-events` with validated `from`/`to`/`limit` filters, status summary and source/journal links for monetary receipt lines, monetary refunds and paid expenses. It flags missing source identities, missing/unposted/duplicate journals, expense-link mismatches, and pre-cutover skips; it excludes wallet/store-credit activity and never writes to the ledger. Verification passed on PR head `1b782d2bd6074d4ac09805f5fcc58f2f1918e2df` (CI run #517).
- Source-event date filtering shares `accountingDate()` with journal posting, including tenant timezone and configured business-day start. Invalid/unmappable timestamps remain unresolved exceptions and cannot disappear from period-close reconciliation. Regression coverage exercises a receipt whose UTC date differs from its tenant business date and confirms close is blocked until the matching journal exists.
- Inventory every post-cutover source event currently eligible for accounting: real-money POS receipts, monetary refunds, and paid expenses; preserve the strict exclusion of loyalty wallet activity, discounts/cashback, bill finalization, unpaid expense drafts, owner equity, opening balances, and transfers from sales-income totals.
- Add a manager-only source-event reconciliation view/API that pairs operational source IDs with their journal source triple and reports exactly one of: posted once, missing journal, duplicate/mismatched journal, or intentionally skipped pre-cutover/unclassified event.
- Treat source records as read-only evidence. Do not auto-post historical/pre-cutover events, silently repair ledger rows, or turn a failed/missing posting into a success status. Any supported repair must be an explicit, idempotent, audited action with a reason.
- Add focused tests for one-to-one source/journal matching, missing and duplicate source journals, excluded event types, manager-only access, date filters, and stable pagination.

#### Stage 6.2 — account reconciliation and trial-balance integrity (implemented; latest PR-head CI passed)
- Implemented manager-only, read-only `GET /api/accounting/trial-balance` with account-level opening balances, period debit/credit movements, closing balances, debit/credit totals, and per-posted-journal integrity checks; supports validated date boundaries and configured currency precision. Route-level tests cover authorization, balanced totals, journal integrity status, currency, invalid calendar dates and reversed ranges. The first run exposed an incorrect sign inversion for credit-normal accounts; fixed the calculation to use conventional debit-minus-credit balances. CI run #523 failed before the fix; the corrected code passed at [run 39511074284](https://github.com/AliasgharFahmidekar/LyraPOS/actions/runs/39511074284), and the subsequent documentation-only PR head passed the full workflow at [run 39512531663](https://github.com/AliasgharFahmidekar/LyraPOS/actions/runs/39512531663).
- Provide account-level opening, period debit/credit, and closing balances from posted journal lines; verify total debits equal total credits in integer minor units for the selected currency and date boundary.
- Clearly distinguish ledger-to-ledger integrity checks from reconciliation to an external bank/card statement or counted cash. Never imply an external statement was reconciled when no statement data was supplied.
- Reuse the existing Phase 4 cash-closure/cutover reconciliation; do not duplicate its adjustment workflow or use reconciliation offsets as income/expense.

#### Stage 6.3 — controlled period close (integrity gate and correction tests added; exact-head acceptance pending)
- Migrations v109–v111 persist close/reopen history and enforce period-close rules in SQLite, including direct-SQL protection for posted journal headers/lines and close-record identity/range. Only close → reopen → reclose transitions are allowed, overlaps are blocked by the database, and SQLite triggers create audit records for every accepted period-close insert/update. Close requires a reason and rejects draft journals, draft expenses, and unresolved source-event exceptions. Reopen requires a reason; close records cannot be deleted.
- Expense corrections use a separate reversing journal with a mandatory reason. A reversal cannot be dated before its original posted journal, and its date must be in an open period. To correct a closed period, use a reversal/adjustment in a later open period; reopening is a separately audited exception, not the default path. The original posted journal is never rewritten.
- A restore-path audit found that the data-only restore process dropped accounting guards but did not reinstall period-close triggers. The restore path now drops and recreates the v109/v110 journal guards plus v111 close-record transition, overlap and audit triggers; regression tests verify the guards and audit recording after restore.
- The new reversal-date regression test checks that a backdated reversal is rejected without changing the posted expense. The exact-head workflow is the gate for the current changes; alternate posting/reversal paths and the controlled correction workflow still need audit before this stage is complete.

#### Stage 6.4 — audit export and backup/restore verification (full accounting round-trip regression added; exact-head acceptance pending)
- Adds manager/owner-only GET /api/accounting/export. It returns a JSON audit snapshot containing all accounting_* tables, installed accounting triggers, database schema version, SQLite integrity-check results and foreign-key violations. The endpoint is read-only and does not post, edit or repair ledger records.
- This accounting export is a portable audit snapshot, not a full database backup and not a restore file. Existing local backup/restore remains the operational backup path; accounting data is not sent to a cloud service by this export.
- Restore regression tests now check that period-close trigger names are present after a data-only restore and that direct edits to posted journal headers/lines and deletion of close history are rejected.
- The exact-head workflow must pass focused accounting tests, the full regression suite, build and lint for the current changes. If CI exposes further restore/data-integrity issues, fix those before marking this stage complete.
**Phase 6 completion record — CI run #605 passed on 2026-10-22 at PR head `c4a41d09e2bbf0067255061fac0fe76590f1ad31`.** The unchanged full regression suite, TypeScript build, backend/frontend lint, canonical i18n verification and generated print-label verification all passed on that exact head. This closes Phase 6; future Phase 7 changes must pass their own exact-head CI gates and must not be inferred from this run.

#### Phase 6 acceptance gate
- Every eligible post-cutover source event is posted exactly once or appears as a visible, actionable exception; excluded events remain excluded.
- Posted journal totals balance, account balances and trial balance reconcile exactly in integer minor units, and no report claims external reconciliation without external evidence.
- Closed periods cannot receive ordinary backdated postings; authorized corrections retain a reason and immutable history.
- Export is deterministic and safe; backup/restore tests verify accounting data, invariants and triggers.
- Focused accounting tests, full regression, TypeScript build, lint and migration upgrade tests pass on the exact PR head before any stage is marked complete.

### Optional later scope — Purchases/payables and inventory valuation/COGS
- Supplier purchases, payable balances, stock valuation, recipe-backed COGS, wastage and stock-count variance are deferred until explicitly selected by the owner.
- If added, reuse existing stock/recipe ledgers and immutable snapshots; do not create a second stock engine or rewrite posted historical results.
- Checks, instalments/loans, payroll, fixed assets, depreciation, tax-authority integrations and multi-branch consolidation are separate future increments, not blockers for the requested lightweight bookkeeping system.

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


### Phase 4 — Stage 1: manual other income and owner equity movements

This stage adds manager-only, idempotent manual activity posting on the existing ledger; it does not add a parallel financial transaction store. Each activity is posted as a balanced journal and appears in activity history.

- **Other income:** debit a selected active configured cash, bank or payment-clearing account and credit an eligible revenue account. POS Sales Revenue, Sales Returns and Sales Discounts are not eligible targets.
- **Owner contribution:** debit the selected liquid-asset account and credit the dedicated Owner Capital equity account. This is not revenue and must not affect profit.
- **Owner drawing:** debit the dedicated Owner Drawings equity account and credit the selected liquid-asset account. This is not an operating expense.
- Activity dates must be valid ISO calendar dates; amounts are positive safe integer currency-minor units; currency comes from store configuration. An idempotency key is mandatory, and a changed payload for the same key is a conflict. Posting is immediate and audited through the existing ledger.
- **Not included in this stage:** opening balances, account-level running balance history, pre-cutover reconciliation UI, COGS or profit reports.

Acceptance: all three activity types create exactly one posted balanced journal; invalid account types/inactive accounts/invalid amounts/dates are rejected; owner contribution never credits revenue; owner drawing never debits an expense account; retries are idempotent and changed-payload retries are rejected; owner/manager authorization is covered.

## Implementation status and next gates

As of this PR branch, Phase 0 discovery, Phase 1 ledger, Phase 2 expenses/transfers and Phase 2.5 operations/setup UI are implemented. Phase 3 implements cash-received-only money receipt/refund posting plus migration v105. Phase 4 Stages 1–3 are implemented on the branch: manual activities, opening balances/account history, and controlled pre-cutover reconciliation with reviewed adjustments. Read [accounting-phase-3-operating-rules.md](accounting-phase-3-operating-rules.md) for the money-posting contract. These new changes are not considered release-ready until the exact current-head workflow passes.

- Migrations 100–104 provide the ledger, expense lifecycle, audit records, reversals and transfers. Migration 105 adds immutable bill accounting snapshots, legacy account seeds, default payment account mappings and a no-backfill cutover timestamp. Migration 106 adds the opening-equity account and opening-balance metadata/immutability guards; migration 107 adds the reconciliation offset equity account, auditable adjustment table and immutability guards; migration 108 seeds the tax-payment expense account; migration 109 adds period-close records and closed-period posting guards. The POS receipt/refund posting policy does not use the tax-liability or loyalty mapping.
- `main/accounting/ledger.ts`, `main/accounting/expenses.ts`, `main/accounting/transfers.ts`, `main/accounting/sales.ts`, `main/accounting/opening-balances.ts` and `main/accounting/reconciliation.ts` cover ledger operations, expenses/transfers, Phase 3 actual-money receipt/refund sources, opening balances, account history, legacy exception reporting and controlled reconciliation adjustments.
- Focused tests include `tests/accounting-ledger.test.ts`, `tests/accounting-expenses.test.ts`, `tests/accounting-routes.test.ts` and the new `tests/accounting-sales.test.ts`.
- Phase 4 Stage 1 covers manual other income and owner contributions/drawings; Stage 2 covers validated opening balances and read-only account history/running balances; Stage 3 covers pre-cutover payment/refund exceptions, cash-close checkpoints and evidenced adjustments. Phase 5 report foundation and cash-received/tax-as-expense treatment are implemented on this branch; the exact current-head workflow must pass before they are considered verified. Inventory valuation/COGS and other future features remain out of this slice.

**CI evidence:** The older run [#316](https://github.com/AliasgharFahmidekar/LyraPOS/actions/runs/38548162343) validated the earlier payment-event identity slice only. It does not validate this PR's subsequent runtime changes. The latest branch head must have its own green full regression/build/lint result; do not infer success from an older run. Full coverage across all 21 configured locales and an actual Windows installer validation remain separate release gates.


## 11. Planned Phase 7 — Future receipts/cheques, recurring obligations, and loans

**Owner requirement and recommended design decision updated 2026-10-22.** **Phase 6 passed CI run #605** on head `c4a41d09e2bbf0067255061fac0fe76590f1ad31`. Phase 7.0 backend/model and 7.1 one-off UI are implemented on the same unmerged PR branch; the exact final head still requires a green full workflow. This is a planned capability on top of the existing ledger, not a parallel accounting system. Build three distinct accounting workflows over one shared due-date/occurrence engine.

### 7.0 — Shared data model and posting contract (implemented; re-verify on exact final head)

The base one-off model and posting semantics are implemented on this branch. The new `accounting_future_items` table is migration **v112**; migrations **v113–v114** add dedicated, audited-by-ledger clearing accounts for future receipts and future payments. Phase 7.0's focused route tests already exercise creation without premature journals, identical and changed-payload retries, impossible dates, invalid account classifications, automatic due processing, no early revenue/cash/expense recognition, settlement on the actual date, idempotent settlement, manual confirmation, cancellation reason, immutable payload/deletion, failed closed-period posting and no partial journal. The full suite must pass again on the exact final head after the Phase 7.1 UI changes.

- **Definition row:** immutable record purpose/type, direction, integer minor-unit amount, canonical Gregorian ISO due date, configured currency, classification account, automatic-registration choice, source idempotency key, payload hash, counterparty/reference, and creator/time metadata.
- **Lifecycle:** `scheduled` → `awaiting_confirmation` (manual mode) or `registered` (automatic/confirmed); transient posting failures remain visible as `failed` and can be explicitly retried; `registered` → `settled` only after actual settlement; `cancelled` is terminal and only allowed before registration. Posted journals are immutable.
- **Incoming receipt/cheque accounting:** due registration debits accounts receivable and credits the dedicated `acct-future-receipt-clearing` liability. This is a balanced due-date record but **does not credit a revenue account or count as income**. On confirmed actual settlement, a single balanced journal debits the selected cash/bank/payment-clearing account and the receipt-clearing liability, and credits receivables and the configured revenue account. Reported other income therefore appears on the actual settlement date, not merely because the due date arrived.
- **Outgoing payment/cheque accounting:** due registration debits the dedicated `acct-future-payment-clearing` asset and credits accounts payable. It does not debit an expense account or claim the expense has been paid. On confirmed actual settlement, a single balanced journal debits payables and the configured expense account, and credits the selected cash/bank/payment-clearing account and the payment-clearing asset. The paid expense and cash outflow are recorded on the actual settlement date. This keeps the existing paid-expense reporting contract and avoids duplicate expense posting.
- **Automatic mode:** when the due date is reached, only items with automatic registration enabled post the due-date clearing journal; manual-mode items wait for an authorized confirmation. Startup catch-up handles eligible overdue items after the app was closed; retries must be idempotent. A due date alone never claims that a cheque cleared or that money moved.
- **Validation:** incoming items require an active, postable, credit-normal non-POS revenue account; POS Sales Revenue, Sales Returns, and Sales Discounts cannot be used to bypass their dedicated workflows, and contra-revenue accounts with a debit normal balance are rejected. Outgoing items require an active, postable, debit-normal expense account; settlement must use an active, postable cash, bank or payment-clearing asset account with a debit normal balance. An actual settlement date must be on or before the current business date; future dates remain forecast items and cannot be recorded as money already received/paid. Amounts are positive safe integers in the configured store currency. The service rejects impossible Gregorian dates and currency mismatches.
- **Storage and safety:** writes reuse the existing balanced journal engine, account type checks, closed-period guards, source tuple, audit log and idempotency/payload-conflict contract. Clearing accounts are non-liquid system accounts: they are not available settlement accounts and must not be presented as spendable cash. Failed/blocked posting remains visible and does not bypass a closed period.
- **Reporting boundary:** unregistered items are projections only. Registered-but-unsettled items have balancing clearing/receivable/payable entries but contribute neither income nor paid expense; they do not change cash/bank. Actual settlement clears those transitional balances, changes the selected liquid account, and recognizes the configured income/expense exactly once. The richer forecast and status breakdown remains Phase 7.4; this phase does not claim that forecast UI exists.
- **Regression coverage:** fresh install, supported older-schema upgrades, direct v112→current migration, exact system-account allowlist and account-code uniqueness, due-versus-settlement journal lines, no early income/expense recognition, settlement date reporting, idempotent retries and existing audit/closed-period constraints.

This phase establishes the shared data/posting contract and the one-off future-item foundation. The dedicated future-items UI is now implemented in the main Accounting page by the Phase 7.1 slice below. It does **not** yet implement recurring schedules, loan origination/repayment splitting, Jalali date-entry UI, external bank verification, or payment-provider integration. The shared future-item foundation initially targeted v114; Phase 7.2 extends it to v115 and Phase 7.3 extends the schema to v116.

### Product decision: three separate workflows, one shared scheduler

The accounting sidebar/page should expose three distinct sections:

1. **Future receipts / cheques** — Persian: **«رسیدهای آینده/چک»**. One-off expected receipts/payments and cheque records with a specific due date.
2. **Recurring obligations** — Persian: **«تعهدات دوره‌ای»**. Repeating rent, payroll, subscriptions, service bills, and similar predictable income/expense obligations.
3. **Loans** — Persian: **«وام‌ها»**. Loans received by the business, the remaining principal liability, repayment schedule, and the principal/interest/fee split.

These are separate user workflows because their accounting meaning differs. They should share infrastructure for calendar calculations, due occurrences, automatic/manual mode, retry/idempotency, status history, and forecasts. Do not implement loans as generic recurring expenses, and do not make rent/payroll require a fake loan record.

### 7.1 — Future receipts / cheques (UI implemented; exact-head CI pending)

Implemented in this slice: a new owner/manager-only section in the existing Accounting page, with Persian/English labels, record creation, receipt/cheque direction, due date, amount, counterparty, reference, account classification, automatic/manual due registration, status/history and journal numbers. Authorized users can register due items, cancel eligible unregistered items with a reason, and confirm actual settlement using an explicit settlement date and a selectable cash/bank/clearing account. The UI explains that a due date is not proof of actual receipt/payment and that actual income/expense/cash movement is posted only at settlement. Backend posting rules remain authoritative; no new ledger or payment system was added. CI has not yet verified these UI changes on the exact latest head.

Each record captures at least:
- Direction and purpose: expected receipt/incoming cheque, or expected payment/issued cheque.
- Counterparty, reference/cheque number where applicable, amount in configured currency minor units, due date, and notes/evidence.
- Selected active postable account(s) and posting treatment. Before saving, the UI explains in plain language which account is debited and which is credited, and whether the item affects projected income/expense, cash flow, receivables, or payables.
- **Automatic accounting registration enabled/disabled.** Creating a future record must not immediately post its future event.

When automatic registration is enabled, the due handler processes the configured accounting event at maturity; when disabled, the due item waits for an authorized user to confirm/register it. If LyraPOS was closed at the due time, it processes overdue eligible items after restart and never creates a duplicate on retries. The UI shows upcoming, due-awaiting-confirmation, registered/posted, settled, cancelled, and failed/retry-needed states, with due and settlement journal numbers when present. Registration actions are disabled until the due date. The settlement date and eligible settlement account are selected explicitly in the UI.

Important: calendar maturity is not proof that money actually entered or left the bank. Due registration must not silently pretend that a cheque cleared or that a payment was made. For the current cash-received/paid-expense contract, due registration uses clearing accounts and receivable/payable balances; it does not recognize income or paid expense. The configured revenue/expense account and actual cash/bank movement are posted only when settlement is confirmed by the user, unless an explicit, verified payment/bank integration is added in a separate scope. Do not count an expected cheque as already collected merely because its date arrived.

### 7.2 — Recurring obligations (rent, salaries, subscriptions, etc.)

Each schedule captures at least:
- Name/category and description; optional counterparty or reference.
- Amount per occurrence, configured currency, selected account/category and posting treatment.
- First due date.
- Recurrence: **monthly** or **custom interval**.
- For custom interval: positive integer interval, with the unit explicitly **days** (every N days).
- Total number of occurrences. Generate exactly that many, then end the schedule; do not silently create an infinite schedule.
- **Automatic accounting registration enabled/disabled**, separate from any claim that money has physically been paid.

The intended accounting distinction is:
- At a due date, an automatic recurring-expense event records that the obligation is due without claiming cash moved or that an expense was paid. Under the existing paid-expense contract, use a dedicated clearing account and payable balance; do not put the occurrence into reported expenses at this stage.
- When the user confirms actual payment, clear the payable and due-date clearing balance, debit the configured expense account and credit the actual cash/bank account in one balanced settlement journal. Report the expense and cash outflow on settlement only, exactly once.
- With automatic registration disabled, the due occurrence waits for authorized confirmation before the configured accounting event is registered.
- Expected future occurrences appear in forecasts before they become due. Once recognized/registered, they move from projected to recorded values without double counting.

Recurring-obligation implementation must preserve this payable-versus-paid separation in its own schedule/occurrence model and Phase 7.4 reports. Registered-but-unpaid obligations and actual paid expenses/cash payments must remain separate measures; never silently redefine historical report totals or force an expense-only journal that misstates bank cash.

For an Iran tenant, monthly recurrence uses the tenant's Jalali month sequence while stored dates remain canonical Gregorian ISO. Anchor month navigation to the original first due date and handle shorter months deterministically (for example, a 31st-day schedule falls on the last valid day of a shorter month, then returns to the original day-of-month in subsequent longer months; no permanent drift). The custom N-days interval advances by exactly N calendar days under the documented date-only contract. Each occurrence has a stable ID, due date, amount, status, and posting/settlement references.

### 7.2 — Recurring obligations (implementation started; CI verification pending)

- Migration v115 introduces immutable recurring schedule identity and occurrence history. A finite schedule creates stable, numbered occurrences linked to the existing one-off future-item engine; no parallel ledger or payment table is introduced.
- Supports monthly and every-N-calendar-days schedules, 1–120 occurrences, active expense account validation, store currency, owner/manager routes, payload-bound idempotency, occurrence listing, and cancellation with a reason.
- Each occurrence is represented by the existing future cheque/payable workflow. Due processing can register a payable, but actual cash/bank movement and expense recognition still require confirmed settlement. Cancelling a schedule cancels only unregistered occurrences; registered/settled entries and journals remain untouched.
- Monthly dates are anchored to the original due date; shorter months clamp to their last day without permanent day-of-month drift. Iran uses the Persian calendar month sequence; stored due dates remain Gregorian ISO.
- Focused tests cover exact N-day arithmetic, month-end/no-drift behavior, finite count, idempotent retry and changed-payload conflict, no journals at schedule creation, cancellation, and invalid account classification.
- The main Accounting page now has a bilingual RTL-compatible Recurring obligations tab with schedule creation, occurrence history/status, and schedule cancellation. Each occurrence can be settled through the existing Future receipts & cheques workflow. Remaining before acceptance: exact-head CI, cancellation/partial-posting regression, startup catch-up/restart behavior, and Windows offline verification.

### 7.3 — Loans (separate loan record and repayment workflow)

**Implementation status on 2026-10-22: implemented on PR #19; exact-head CI pending.** Migration v116 adds immutable loan identity records, installment batches, and auditable installment occurrences. The Accounting page now has a dedicated **«وام‌ها» / “Loans”** tab.

- New borrowing posts the actual cash/bank increase against a liability account; it never credits revenue.
- An existing loan can be opened at the remaining principal only. Its opening journal uses Opening Balance Equity as the offset and creates no new cash/bank movement.
- The owner enters/imports the lender's actual principal, interest, fee and due-date schedule. The app does not invent an amortization formula or interest split. Combined scheduled principal is bounded by the outstanding liability, and settled principal is reconciled against the loan subledger.
- Due processing runs at startup and every 60 seconds with the shared accounting scheduler. Automatic mode moves a due installment to **registered**; manual mode moves it to **awaiting confirmation**. Neither mode records a cash payment or marks the loan paid.
- Actual settlement is an explicit owner/manager action. One balanced journal debits principal against the loan liability, debits interest/fees to their selected expense accounts, and credits the actual cash/bank/clearing account. A settled retry is idempotent; another payment cannot be posted for the same installment.
- Schema guards protect loan identity, installment identity/state, cancellation, settled records, and audit history. Loan triggers are reinstated after data-only restore. Focused regressions cover new vs opening loans, no revenue/cash fabrication, split posting, due vs paid state, balance limits, cancellation, idempotency, and SQLite integrity.
- Scope intentionally deferred: automatic amortization calculation, external bank/payment-provider integration, and Phase 7.4 forecast/report integration. A due event is not an automatic bank payment.


The first scope is **loans received by the business**. A loan is borrowing, not sales revenue.

#### Registering a new loan

Capture lender, original principal, date funds were received, destination cash/bank account, reference, and available terms such as installment count, maturity, interest/fees, and schedule. Receiving principal creates the correct cash/bank increase and loan-liability increase. It creates **no income and no profit**.

#### Registering a loan that existed before LyraPOS accounting

Offer a specific opening-loan workflow. At the accounting cutover date, record the **remaining principal still owed**, not a new receipt of the historical original principal. This must not increase current cash/bank or revenue again. Preserve original amount/date as informational history if provided; opening liability and current outstanding principal are the figures used by the live ledger/report. Historical expenses may be entered with their real dates only under the existing period-open/reopen and audit rules; the system must never silently inject old cash or double-count an expense. If the business elects only to start reliable books from the current date, historical spend can remain informational rather than changing current-period profit.

#### Record spending funded by a loan

Expenses paid using the loan proceeds are entered as normal expenses against the real account that paid them, with the correct expense category and payment date. Provide an optional informational link to the loan for the owner's “where was this borrowing spent?” review, but that link must not itself post another journal or force an expense category. Cash is fungible, so the report must not claim a precise allocation of borrowed money unless the user supplies an explicit allocation. If the lender paid a supplier directly, record the actual direct-to-supplier event using the appropriate accounts rather than inventing a cash deposit.

#### Record instalments correctly

Every instalment must separate:
- **Principal** — reduces the loan liability; not a profit-and-loss expense.
- **Interest** — financial expense.
- **Fees/charges** — use an explicitly selected suitable expense/account treatment.

The repayment terms or lender's schedule should provide this split. For the first implementation, allow the user to enter/import the amounts from the real loan repayment schedule; do not invent interest or claim a mathematically exact amortization schedule if the actual rate, fee rules, rounding, or lender method is unknown. Automated amortization calculation can be a later, separately tested enhancement.

A loan schedule can generate due instalment occurrences automatically, but a due date alone must not reduce cash or mark a loan paid. Unless LyraPOS has an explicitly integrated and verified payment provider, a user must confirm the actual payment. On confirmation, post principal reduction, interest/fees expense, and the actual cash/bank outflow as one balanced journal. If auto mode is enabled for due processing, it may automatically create/record the due instalment and any well-defined accrued-interest event, but it must not falsely mark the cash payment as completed. The UI labels must say **automatic due registration**, not automatic bank payment.

A loan record must show original principal, principal repaid, current remaining principal, next due date, missed/overdue instalments, and remaining scheduled principal/interest/fees. Principal outstanding is a liability and never income. Forecast views show principal repayments as future cash outflows/liability reduction and interest/fees as projected expenses; never subtract the entire loan instalment from projected net profit.

### 7.4 — Forecast and report semantics

Forecasts must include scheduled occurrences within the selected date range, while keeping these groups distinguishable:
- Actual posted income/expenses from the existing ledger.
- Recognized but unpaid obligations/receivables.
- Future projected income/expenses not yet recognized.
- Expected cash inflows/outflows.
- Loan principal liability and principal repayments.
- Interest and loan fees.

As an occurrence is recognized or settled, move it between the appropriate forecast/recorded/settled categories; never count it simultaneously as a future projection and an actual ledger event. Classification follows configured account type and debit/credit side. Do not treat every debit as an expense or every credit as income.

Illustration: the owner's supplied future items might contain 10 million debit-side obligations, 20 million of debit-side scheduled items, and a 5 million credit-side item. The app may show a 25 million net debit exposure for those specific mapped entries, **but may call it projected net loss only if the relevant accounts truly are profit-and-loss expense/income accounts**. If some part is loan principal, show it in forecast cash flow/liability instead of profit and loss. Make the distinction understandable in Persian without requiring the user to know debit/credit terminology.

### 7.5 — Shared due engine, states, audit, and safety controls

- Use explicit schedule records plus individual occurrence records (or an equivalent fully auditable model). Each occurrence has a stable identity, due date, amount, status, optional linked journal, and settlement reference.
- Reuse the existing balanced ledger, source identity, idempotency, currency precision, authorization, audit and closed-period controls. Do not create parallel journal or payment tables that bypass the ledger.
- Automatic processing must be restart-safe, repeatable and transactionally idempotent. A retry must not duplicate journals, cash movements, or occurrence state transitions.
- A failed automatic event remains visible and retryable; it must not silently appear posted or paid.
- Manual confirmation is an authorized, attributed, auditable action.
- Changes/cancellation cannot mutate or erase posted journals. Already-posted corrections use the existing reversal/correction workflow and reason/audit history.
- Never post into a closed accounting period by bypassing schema v111 guards. Retry must validate due date, account active/postable state, period status, schedule version and posting integrity.
- A schedule has a finite occurrence count and a clearly defined end state. Editing future occurrences must not alter already-posted occurrences.
- Migration(s) must be forward-only and tested from a populated prior-version database; backup/restore and accounting export must retain schedules, occurrence status, references, journals, and audit history.

### 7.6 — Delivery order and acceptance gates

1. **Accounting design/data model:** document loan-liability setup, old-loan opening balance, payable-versus-paid recurring obligations, check/receipt settlement, schedule/occurrence states, and report classifications before schema changes.
2. **Future receipts/cheques:** one-off due dates, direction, due/settled statuses, auto/manual due registration, auditable settlement, and idempotent posting.
3. **Recurring obligations:** monthly/every-N-days schedules, fixed occurrence count, auto/manual registration, payable versus paid flow, and nonduplicating settlement.
4. **Loans:** new loan origination, old-loan opening principal, outstanding balance, principal/interest/fee breakup, repayment occurrences, payment confirmation, and correct journal/report treatment.
5. **Accounting UI:** the three exact Persian section names, user-friendly guidance, account selection, visible meaning of the selected accounts, remaining loan balance, due/overdue states, and history.
6. **Forecast integration:** actual vs recognized-unpaid vs future projection vs cash-flow obligations, correct date-range calculations, exclusion from forecasts after registration/settlement, and principal excluded from projected profit/loss.
7. **Verification:** strict focused tests, full regression suite, type-check/build, backend/frontend lint, i18n/print-label checks on the exact final head, and Windows restart/offline verification.

Required regressions include: new loan proceeds never counted as revenue; old-loan setup does not create cash/revenue; principal repayment never hits P&L expense; interest/fees affect P&L only with the correct amount/date; loan paid/remaining-principal reconciliation; historical expense/date and closed-period protections; rent/payroll recurring obligations vs actual payment; check due vs cleared/settled; due-on-startup catch-up; auto/manual mode; retry/restart with no duplicate; changed-payload conflict; monthly occurrences at 29th/30th/31st and Jalali Esfand; every-N-days arithmetic; finite schedule exhaustion; cancellation/edit after partial posting; invalid/inactive accounts; role checks; balanced journals; and transition between forecast, recognized, posted, and settled views without double counting.

