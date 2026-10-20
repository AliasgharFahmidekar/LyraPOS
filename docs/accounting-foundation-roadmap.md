**Status on PR #19:** Phases 0–4 are implemented. Phase 5 management reports and the owner-confirmed cash-received/tax-as-paid-expense policy are implemented and verified on the latest head by CI run #508 (head `366eadb9ab641b2e52335129365edacd5f8871f7`). Phase 6 is now in progress and will be delivered in small, test-gated increments. The existing Phase 4 cutover reconciliation remains intact; Phase 6 extends this into ongoing source-event reconciliation, account/trial-balance checks, controlled period close, audit export, and backup/restore verification. No phase is considered complete until the exact PR head passes focused tests, full regression, build, and lint.

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


### Phase 6 — Reconciliation, backup and close controls (in progress on PR #19)

This phase must be implemented in separate increments so that reconciliation never silently repairs or rewrites the ledger.

#### Stage 6.1 — reconciliation contracts and source-event audit
- Inventory every post-cutover source event currently eligible for accounting: real-money POS receipts, monetary refunds, and paid expenses; preserve the strict exclusion of loyalty wallet activity, discounts/cashback, bill finalization, unpaid expense drafts, owner equity, opening balances, and transfers from sales-income totals.
- Add a manager-only source-event reconciliation view/API that pairs operational source IDs with their journal source triple and reports exactly one of: posted once, missing journal, duplicate/mismatched journal, or intentionally skipped pre-cutover/unclassified event.
- Treat source records as read-only evidence. Do not auto-post historical/pre-cutover events, silently repair ledger rows, or turn a failed/missing posting into a success status. Any supported repair must be an explicit, idempotent, audited action with a reason.
- Add focused tests for one-to-one source/journal matching, missing and duplicate source journals, excluded event types, manager-only access, date filters, and stable pagination.

#### Stage 6.2 — account reconciliation and trial-balance integrity
- Provide account-level opening, period debit/credit, and closing balances from posted journal lines; verify total debits equal total credits in integer minor units for the selected currency and date boundary.
- Clearly distinguish ledger-to-ledger integrity checks from reconciliation to an external bank/card statement or counted cash. Never imply an external statement was reconciled when no statement data was supplied.
- Reuse the existing Phase 4 cash-closure/cutover reconciliation; do not duplicate its adjustment workflow or use reconciliation offsets as income/expense.

#### Stage 6.3 — controlled period close
- Add a persisted, auditable period-close record and manager/owner-only close/reopen rules. A close must reject or explicitly enumerate unresolved source-event exceptions and unposted/invalid accounting items for the period.
- Block backdated posting/editing into a closed period at the backend service boundary, not only in the UI. Corrections to closed periods must use a separately authorized, reasoned adjustment/reversal workflow and preserve original journals.
- Use the existing business-date/timezone policy and validate calendar dates; do not infer a date from the user's machine timezone.
- Migration must be additive and safe for populated customer databases. Test closed-period enforcement against every relevant posting path.

#### Stage 6.4 — audit export and backup/restore verification
- Export filtered journal headers/lines and audit events in a stable, documented UTF-8 format, with role checks and CSV-formula-injection protection. Export is read-only and must not alter posting state.
- Verify backup/restore preserves posted journals, source/idempotency keys, audit history, reconciliation metadata, period-close records and database guards. A restore is not considered verified solely because the file exists; run integrity checks and compare key counts/balances before accepting it.
- Keep all backup operations local/offline. Never transmit accounting data to a cloud service or silently overwrite the only backup.

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

- Migrations 100–104 provide the ledger, expense lifecycle, audit records, reversals and transfers. Migration 105 adds immutable bill accounting snapshots, legacy account seeds, default payment account mappings and a no-backfill cutover timestamp. Migration 106 adds the opening-equity account and opening-balance metadata/immutability guards; migration 107 adds the reconciliation offset equity account, auditable adjustment table and immutability guards. The POS receipt/refund posting policy does not use the tax-liability or loyalty mapping.
- `main/accounting/ledger.ts`, `main/accounting/expenses.ts`, `main/accounting/transfers.ts`, `main/accounting/sales.ts`, `main/accounting/opening-balances.ts` and `main/accounting/reconciliation.ts` cover ledger operations, expenses/transfers, Phase 3 actual-money receipt/refund sources, opening balances, account history, legacy exception reporting and controlled reconciliation adjustments.
- Focused tests include `tests/accounting-ledger.test.ts`, `tests/accounting-expenses.test.ts`, `tests/accounting-routes.test.ts` and the new `tests/accounting-sales.test.ts`.
- Phase 4 Stage 1 covers manual other income and owner contributions/drawings; Stage 2 covers validated opening balances and read-only account history/running balances; Stage 3 covers pre-cutover payment/refund exceptions, cash-close checkpoints and evidenced adjustments. Phase 5 report foundation and cash-received/tax-as-expense treatment are implemented on this branch; the exact current-head workflow must pass before they are considered verified. Inventory valuation/COGS and other future features remain out of this slice.

**CI evidence:** The older run [#316](https://github.com/AliasgharFahmidekar/LyraPOS/actions/runs/38548162343) validated the earlier payment-event identity slice only. It does not validate this PR's subsequent runtime changes. The latest branch head must have its own green full regression/build/lint result; do not infer success from an older run. Full coverage across all 21 configured locales and an actual Windows installer validation remain separate release gates.
