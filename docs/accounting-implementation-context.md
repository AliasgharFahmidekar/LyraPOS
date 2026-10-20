# LyraPOS accounting implementation context for AI contributors

**Status on PR #19:** Phases 0–3 and Phase 4 Stages 1–3 are implemented on the branch; final-head GitHub Actions are the verification/merge gate. Stage 1 adds manager-only other income and owner-equity activities. Stage 2 adds v106 opening-balance setup and read-only account transaction history. Stage 3 adds v107 controlled pre-cutover reconciliation, skipped legacy receipt/refund audit exceptions, cash-closure comparison and immutable evidence-backed adjustment journals. The authoritative sales/refund rules are in [accounting-phase-3-operating-rules.md](accounting-phase-3-operating-rules.md). Only actual cash/card/custom monetary receipts post Dr mapped liquid asset / Cr Sales Revenue; actual monetary refunds post Dr contra-revenue / Cr payout asset. Bill finalization itself creates no revenue journal. Loyalty-wallet activity, wallet/store-credit refunds, discounts and cashback create no accounting entries. Historical receipts/refunds are not silently backfilled. Do not call the PR release-ready until the final-head workflow passes. Inventory valuation/COGS is deliberately out of scope; reports must not claim net profit while it is missing.

## Read first

Before implementation, read:
- `/AGENTS.md` and `docs/business-decisions.md` for project-wide invariants and established product choices.
- `docs/accounting-foundation-roadmap.md` for the accounting model and phased scope.
- `docs/accounting-phase-3-operating-rules.md` for the active posting contract and worked examples; `docs/accounting-phase-3-posting-contract.md` for the underlying source audit.
- `main/db.ts` for the current migration registry and SQLite lifecycle.
- `main/accounting/ledger.ts` and `tests/accounting-ledger.test.ts` for the ledger API and behavior.
- The route/service/tests of any existing operational source being connected.

**Runtime code and automated tests define current behavior.** This document records architecture boundaries and future intent; never claim planned work is already implemented.

### Phase 4 Stage 1 implementation contract

Manual accounting activities reuse `accounting_journal_entries` and `accounting_journal_lines`; no second money ledger/table is introduced. `main/accounting/manual-activities.ts` supports three explicit event types: `other_income`, `owner_contribution`, and `owner_drawing`. Other income may credit only an active postable revenue account other than POS sales/returns/discount accounts. Owner contributions always credit `acct-owner-capital`; drawings always debit `acct-owner-drawings`. Both use an active liquid asset account on the other side. Every request requires a caller-provided idempotency key and posts the journal transactionally. Owner contributions are equity, never revenue; drawings are equity, never expense.

### Phase 4 Stage 2 implementation contract

Opening balances and account history reuse the existing ledger; the setup table is metadata for one opening balance per posting account, not a second movement ledger. Migration v106 is append-only and adds `acct-opening-balance-equity`, `accounting_opening_balances`, a unique account/source/idempotency relation, payload hash and database guards that reject updates/deletes. `main/accounting/opening-balances.ts` provides the opening-balance create/list operations and account transaction history.

- API: `POST /api/accounting/opening-balances` requires manager/owner role, valid date, positive safe integer minor units, matching store currency and `Idempotency-Key`; `GET /api/accounting/opening-balances` lists recorded setup balances; `GET /api/accounting/accounts/:accountId/transactions` returns posted account movements, current balance and running balances. These are read/write through the existing manager-only accounting route group.
- Each opening balance posts a balanced journal with the target asset/liability/equity account and the dedicated opening-balance equity offset. A retry with the same key and identical canonical payload returns the original; changed-payload retries conflict. A second opening balance for the same account is rejected; posted setup records are not editable in place.
- Source classification is required and type/system-key validated. The existing inventory system account is rejected because inventory value cannot be inferred from quantity while valuation/COGS is deferred. Historical POS cash/payment/refund records are not backfilled automatically by this stage.
- Regression coverage: fresh-install/legacy upgrade to v106, exact system account allowlist, table and immutability triggers; cash/payable/owner-equity journal sides; no income/expense from opening cash; mismatched classifications, deferred inventory, invalid accounts and duplicate requests; manager-only access; account-history filters/running balance; non-liquid asset rejection for manual activities/transfers/payment mappings.

### Phase 4 Stage 3 implementation contract

`main/accounting/reconciliation.ts` implements the controlled pre-cutover reconciliation boundary. `GET /api/accounting/reconciliation` reports legacy cash/card/custom payment lines and monetary refunds still tied to pre-cutover bills, malformed/unclassified payment data, and audit exceptions written when legacy receipts/refunds are skipped. It deliberately does not backfill those events into the journal or imply that the legacy summary itself is a verified balance.

Cash closure checkpoints compare counted drawer cash with the posted cash-drawer ledger balance only when a recorded opening-cash setup predates the close. A missing or late opening balance yields an explicit non-comparable status. Non-voided pay-in/pay-out/safe-drop movements in the comparison window force `requires_review_drawer_movements`; the difference is not to be blindly treated as a direct adjustment.

`POST /api/accounting/reconciliation/adjustments` requires a caller idempotency key, a verified non-negative integer balance in configured currency minor units, a valid accounting date on or before the configured cutover business date, a reason, and an optional source-evidence reference. Post-cutover differences must use a properly classified current-period transaction instead of the cutover-equity offset. The backend calculates the pre-adjustment balance from posted journal lines; it never accepts a client-supplied difference. Only active postable asset/liability accounts may be targets. Inventory and offset equity accounts are rejected. A difference posts as a balanced journal against `acct-reconciliation-adjustment-equity`, not revenue or expense. Metadata is immutable through migration-v107 SQL triggers; identical retries return the original record and changed payloads conflict.

Current CI must prove actual pre-cutover receipt/refund skips, wallet exclusion, legacy/audit summaries, cash-close comparison status, idempotent balanced adjustment posting, invalid targets, metadata immutability and manager-only access. Do not mark a cutover reconciled just because an adjustment exists; manually review evidence and visible exceptions. Inventory valuation/COGS remains deferred.

## 1. Product boundary and verified Phase 0 discoveries

LyraPOS is an offline-first Electron desktop POS backed by local SQLite. Accounting is an added financial ledger, not a new POS. Reuse the existing sources of operational truth:
- Orders, order items, bills, payment detail and refunds.
- Configurable payment methods (already present; do not create a second payment-method catalogue).
- Cash sessions, cash closures, drawer movements and cash movements.
- Product quantity movements and inventory history.
- Supplies, supply movements, recipes and order-item recipe snapshots.
- Existing regional/currency configuration, tax snapshots, business timezone rules, and daily-sales exports.

Do not mutate operational records just to make a journal view work. Do not add duplicate payment, cash, inventory or recipe engines. Routine accounting must work with no internet connection. Do not introduce a cloud requirement.

Existing sales/collection reports must retain their established meaning. Cash collected is not automatically revenue recognized, and revenue is not the same as net profit.

### Resolved Phase 3 decisions and remaining scope

Phase 3 choices are resolved for this PR in [accounting-phase-3-policy-proposal.md](accounting-phase-3-policy-proposal.md) and fully specified in [accounting-phase-3-operating-rules.md](accounting-phase-3-operating-rules.md):
1. A bill is recognized at an explicit immutable finalization or atomically with its first accepted payment; bill generation alone never posts revenue.
2. Bill finalization records an immutable snapshot only; it does not post revenue, receivables or tax.
3. Each accepted cash/card/custom payment line posts the actual applied money as debit to its mapped asset and credit to Sales Revenue; actual monetary refunds debit contra-revenue and credit the payout asset. Loyalty and discounts are completely excluded.
4. Store-specific integer minor units and source timestamps plus regional timezone/business-day rules govern amounts and dates.
5. Migration v105 marks automatic cutover; no historical monetary receipt/refund is silently backfilled.
6. Phase 4 Stage 1 implements manual other income and owner capital/drawings; Stage 2 implements opening balances and read-only account history on migration v106; Stage 3 implements controlled pre-cutover reconciliation on migration v107. Phase 5 report foundation is now in progress on PR #19: read-only summaries are built from posted journal lines, with date filters, liquid-account balances, movements and cutover exceptions. Current-head CI must pass before it is verified. COGS and inventory valuation remain out of the current report scope. After-tax revenue is not available under the current Phase 3 contract because tax snapshots are not allocated to actual payment-line journals.

Do not infer statutory compliance or claim full net profit when cost of goods has not been recorded.

## 2. Current architecture and migration rules

- Database: `main/db.ts`, using the active `better-sqlite3` connection.
- Migration registry: `MIGRATIONS` in `main/db.ts`; migrations 100–104 provide the ledger, expense lifecycle, audit and transfer foundation; migration 105 adds the sale-finalization fields/SQL guards, internal tax liability, payment-method defaults and `accounting_cutover_at`; migration 106 adds opening-balance setup and its balancing equity account; migration 107 adds reconciliation-adjustment metadata and its dedicated equity offset account. Historical/merged migrations remain immutable.
- Ledger domain service: `main/accounting/ledger.ts`. It receives the caller's database connection; do not open a second connection.
- Automated coverage: `tests/accounting-ledger.test.ts` (`npm run test:accounting-ledger`), `tests/accounting-expenses.test.ts` (`npm run test:accounting-expenses`), and manager-route authorization/idempotency coverage in `tests/accounting-routes.test.ts` (`npm run test:accounting-routes`).
- Test harness: `tests/run-electron-node-test.cjs`.
- Default suite: root `package.json` includes the focused ledger suite.
- Existing frontend: `frontend/src/`, Next.js/React, shared components/styles, localization, and RTL support.

Migrations are append-only. Never edit historical migrations, drop customer data, reset a live database, or bypass the built-in pre-migration backup. Tests must cover a fresh install, existing supported upgrade paths through v107, and populated pre-cutover databases, preserving operational records and ensuring old bills are not silently journaled. Migration 100 is additive: it does not rewrite sales, payments, stock, cash or recipe tables; migration 101 updates only the system-account identity guard; migration 103 adds idempotency columns/indexes/triggers and migration 104 adds reversal columns/indexes/triggers without rewriting old expense records.

## 3. Schema delivered by migration 100

### `accounting_accounts`
- Stable text ID and stable `system_key`, unique `account_code`, editable display name, type, normal balance, parent/group link, flags and timestamps.
- Types: `asset`, `liability`, `equity`, `revenue`, `expense`. Normal side: `debit` or `credit`.
- `is_postable=0` for group headings; these cannot appear on journal lines. `is_active=0` prevents new posting.
- System-required accounts cannot be deleted. For system accounts, `is_system`, `system_key`, account code, type, normal balance and parent links are protected by SQL triggers. A custom account cannot acquire a system flag/key through direct updates. Display names remain editable; application logic must match stable system keys/codes, never display labels.

Seed chart (English names are starter labels, not jurisdiction-specific tax advice):
| Code | System key | Account |
|---|---|---|
| 1000 | assets | Assets (group) |
| 1010 | cash_drawer | Cash drawer |
| 1020 | bank_accounts | Bank accounts |
| 1030 | payment_clearing | Payment clearing |
| 1100 | accounts_receivable | Accounts receivable |
| 1200 | inventory | Inventory |
| 2000 | liabilities | Liabilities (group) |
| 2010 | accounts_payable | Accounts payable |
| 2020 | customer_advances | Customer advances |
| 3000 | equity | Equity (group) |
| 3010 | owner_capital | Owner capital |
| 3020 | owner_drawings | Owner drawings |
| 4000 | income | Income (group) |
| 4010 | sales_revenue | Sales revenue |
| 4020 | sales_discounts | Sales discounts / contra-income |
| 4030 | other_income | Other income |
| 2040 | sales_tax_payable | Tax collected (internal liability; not jurisdiction-specific tax compliance) |
| 5000 | expenses | Expenses (group) |
| 5010 | cost_of_goods_sold | Cost of goods sold |
| 5020 | operating_expenses | Operating expenses |
| 5030 | payment_processing_fees | Payment processing fees |

Do not introduce hard-coded account names in UI or backend logic. Future UI uses translated labels through the existing localization pipeline; system keys and codes remain stable.

### `accounting_sequences`
Atomic counters used to generate journal numbers transactionally. Never generate serial numbers with an unlocked `MAX(id)+1` pattern.

### `accounting_journal_entries`
Journal header with UUID, unique sequential `entry_number`, `YYYY-MM-DD` accounting date, description, uppercase three-letter currency code, `draft|posted` status, source triple, unique optional idempotency key, SHA-256 payload hash, actor IDs, timestamps and optional metadata JSON. Source fields must be either all empty or all supplied. A partial unique source index prevents multiple entries for the same event.

### `accounting_journal_lines`
Lines with unique positive line number per entry, account reference and integer `debit_minor` / `credit_minor`. Each line must have one strictly positive side and one zero side. Totals are balanced using integer arithmetic; do not use JS floating point to decide whether an entry balances.

Convert from operational currency values only at a single documented service boundary using existing currency fraction-digit helpers and a tested rounding rule. This Phase 1 API accepts already-converted integer minor units.

### `accounting_audit_log`
Append-only action records with entity/action, actor ID and before/after JSON snapshots. Actor references are historical text values, not cascading foreign keys; deleting a staff record must not erase accountability.

### Database guards

- Entries must be inserted as drafts; posting requires at least two lines, non-zero total, equal debits and credits, active accounts, and postable accounts.
- Posted headers are immutable and cannot be deleted.
- Posted lines cannot be inserted, updated or deleted.
- System accounts cannot be deleted or have critical identity/parent fields changed.
- Audit records cannot be updated or deleted.

The service also validates inputs; SQL guards provide defense in depth. Use the service instead of direct SQL updates.



## 3.1 Phase 2 stage 1 foundation currently implemented (schema v103)

- `accounting_expense_categories` maps manager-defined categories to active, postable expense accounts. Categories are deactivated rather than deleted once used.
- `accounting_payment_method_mappings` is used only for real-money methods (`cash`, `card`, custom `custom:<id>`). Any legacy `loyalty` row is ignored and not shown in the accounting mapping UI; loyalty-wallet activity never posts.
- `accounting_expenses` stores auditable draft expenses using integer `amount_minor`, the configured store currency, expense date, category, payee/reference, and paid/unpaid state. Service validation and migration-103 SQL triggers reject unsafe/fractional amounts, impossible calendar dates and currency mismatches. A paid expense requires an existing payment-method mapping and payment date. Category, expense and mapping mutations append records to `accounting_audit_log` in the same transaction; expense before/after snapshots include all business fields.
- Manager-only endpoints are mounted at `/api/accounting`: `GET /accounts`, `GET/POST/PUT /expense-categories`, `GET/PUT /payment-account-mappings`, and `GET/POST/PUT /expenses` (including `GET /expenses/:id`). `POST /expenses` accepts the standard `Idempotency-Key` header; the same key and normalized request returns the original expense, while reusing the key with a different payload returns HTTP 409. Key/hash pairs are stored immutably and indexed uniquely.
- This increment does not yet post expense journals, implement transfers, or add UI. Those remain Phase 2 stages 2 and 3. Request idempotency prevents duplicate expense drafts; journal-posting idempotency and audit-safe correction entries are still required in stage 2. Posted/reversed expenses are not editable through the draft API.



## 3.2 Phase 2 stage 2 — expense posting and reversals (schema v104)

- `POST /api/accounting/expenses/:id/post` posts only an expense already marked `paid`. Within one SQLite transaction it creates a balanced journal, posts the journal, links it to the expense and appends the expense audit event. The journal uses the expense's snapshotted expense account and payment account, integer amount, store currency and actual payment date. Debit = expense account; credit = mapped cash/bank asset account. It never re-resolves a historical payment-account mapping at posting time.
- Posting uses a stable journal source triple (`expense`, expense ID, `expense_paid`) and a deterministic idempotency key. Repeated posting returns the existing journal; changed data cannot create a second event. An existing posted expense with a missing/unposted linked journal fails closed instead of claiming success.
- An expense whose `payment_status` is `unpaid` remains a draft and has no journal or cash credit. This stage intentionally does **not** book an expense against accounts payable; unpaid supplier bills/payables are a later workflow and must not be described as a paid cash expense.
- `POST /api/accounting/expenses/:id/reverse` requires a reason and a valid accounting date. It posts a separate journal with each original line's debit/credit sides swapped, links the reversal to the expense and preserves the original posted journal. A retry with the same reason/date returns the same reversal; conflicting retry inputs return HTTP 409. It does not erase the original posting or rewrite the original lines.
- Migration 104 adds `reversal_journal_entry_id` and `reversal_reason` plus SQL guards for valid state transitions, linked posted journal identities, immutable details after posting/reversal, and preventing deletion of posted/reversed expenses. The backup/restore trigger path drops and recreates these new guards with the existing accounting trigger set.
- Authorization remains owner/manager only. Route coverage verifies cashier/server/chef denial as well as successful posting, idempotent retries, unpaid rejection, and reversal conflicts.

## 4. Ledger service contract

`main/accounting/ledger.ts` exposes:
- `createDraftJournalEntry(db, input)`
- `postJournalEntry(db, entryId, postedBy?)`
- `AccountingLedgerError` (stable machine-readable `code`).

Creation validates real calendar dates, nonempty description, three-letter uppercase currency, >=2 lines, safe integer amounts, one positive side per line, equal debit/credit totals greater than zero, complete source triples, active/postable accounts and idempotency key bounds.

Idempotency rules:
- Same source event or idempotency key + same normalized payload returns the existing journal.
- Same source key/event + different payload fails with `idempotency_conflict`.
- The SHA-256 payload hash excludes the idempotency key itself so the same stable source event may be retried using a regenerated request key without creating a second entry.
- New journal sequence, header, lines and initial audit record are written in one SQLite transaction.
- Posting revalidates lines/accounts, updates the header and appends an audit event in a single transaction.
- Reposting an already-posted entry returns a duplicate result instead of posting twice.

Posted entries are immutable. Future corrections need explicit reversing/adjusting entries with their own references and audit records; do not add an edit/delete path for posted entries.

Phase 1 is a foundation only. It does not create HTTP/IPC endpoints, a sidebar page, a Settings panel, expense forms, automatic sales/refund posting, supplier purchases, inventory valuation or reports.

## 5. UI/UX contract for future work

For the first usable accounting workflow (Phase 2/3):
- Add one Accounting / حسابداری item to the existing sidebar. Reuse the current sidebar, spacing, typography, icons, theme, active states, forms, tables, dialogs, empty/loading/error states and toast patterns. Do not create a different-looking sub-application.
- Put accounting-specific preferences in the current app Settings page under an Accounting section; do not add a second settings system.
- Mapping existing payment methods to cash/bank/clearing accounts belongs in Accounting Settings. Do not duplicate payment method creation/editing.
- Use existing authorization at backend/API level and existing translation/RTL/i18n pipeline for every visible string. Add required translation keys following the repository's translation checker conventions.
- Reuse account codes/system keys for logic; do not bind system behavior to English labels.
- Make routine staff workflows understandable without requiring cashiers to understand debits and credits. UI role gates are not a substitute for backend authorization.
- Do not add a blank placeholder page or unused navigation item in Phase 1. Add the item when an actual workflow is available.

## 6. Phased implementation and Windows test gate

0. **Discovery/design — complete:** verified the existing POS source-of-truth boundaries, schema migration route, test conventions, and the original accounting roadmap.
1. **Ledger core — implemented:** migrations 100–101; seeded chart of accounts; journal headers/lines; integer minor-unit validation; source/idempotency uniqueness; atomic draft/post; audit events; immutable posted records and system-account identity guards.
2. **Expenses/transfers/UI — implemented on the PR branch:** migrations 102–104; manager-only expense draft/post/reversal APIs; payment-account/category setup; idempotent asset-to-asset transfers; `/accounting` operations page and sidebar entry. Unpaid expense drafts do not create cash outflows or payables journals.
3. **Sales, collections and refunds — runtime implementation on this PR branch:** migration 105 adds the immutable bill snapshot/finalization reference, internal tax-liability account, safe payment mappings and `accounting_cutover_at`. `main/accounting/sales.ts` posts sale recognition once, collections by `payment_event_id`, and committed refunds by refund ID/payout method; legacy bill/payment/refund data is not auto-backfilled. See [accounting-phase-3-operating-rules.md](accounting-phase-3-operating-rules.md) for all rules, formulas, examples and limitations. The PR is not done until focused accounting tests plus full regression/build/lint are green on the final head.
4. **Manual income, owner capital and opening balances — next:** manager-friendly other-income entries, owner contributions/drawings, opening asset/liability/equity balances, account history, and controlled reconciliation of pre-cutover exceptions. These flows must use equity/liability accounts when appropriate; never label opening funds or owner capital as revenue.
5. **Basic management reports — next:** net sales after saved POS tax, manual other income, recorded expenses, account balances and movements, refunds, and date/business-day filters. Explicitly label the result as **before COGS / excluding inventory cost**. Do not report fully calculated net profit until COGS exists.
6. **Reconciliation and close controls — later:** source-event-versus-journal view, skipped/failed event handling, account reconciliation, safe period-close/adjustment controls, export, and backup/restore verification for accounting.
7. **Optional future scope:** supplier purchases/payables, inventory valuation/COGS, checks, loans/installments, payroll, fixed assets/depreciation, tax-authority integrations and multi-branch consolidation. These are not blockers for the requested lightweight bookkeeping scope.

Full UI translation coverage across all 21 configured locales and a real Windows installer/upgrade gate remain separate release activities.

### Installer/release gate

Follow the requested delivery plan: **do not build or publish a Windows installer during Phase 1**. Only after Phases 1–3 are implemented and the complete required checks are green:
- Run automated regression, migration, build and relevant UI/RTL checks.
- Create a Windows installer from the reviewed PR/release commit.
- Install fresh on a clean Windows environment and test first-run/setup.
- Upgrade an existing installation using a copy of a real-like database; make and verify a backup first.
- Verify schema reaches current version, pre-existing bills/payments/stocks/settings survive, and application restart/update does not lose data.
- Test cash sale, unpaid/partial/split payment, refund, expense, and cash reconciliation workflows end-to-end with deterministic expected journal entries.
- Confirm offline operation, Persian/RTL if enabled, sidebar/settings consistency, and existing printer/receipt regressions.

Do not claim installer validation complete until the Windows artifact has actually been built and tested on Windows. Keep all release evidence with the PR.

## 7. Required verification commands

At minimum for this implementation series:
```sh
npm run test:accounting-ledger
npm run test:accounting-expenses
npm run test:accounting-routes
npm run build
npm run lint
npm run test:script-coverage
```

Migration changes require a fresh database and upgrade-from-v99 test. Native `better-sqlite3` ABI mismatch may be signaled by exit code 77; it is a skip/blocked environment, not a passing test. Check actual GitHub Actions results after pushing; never assume CI passed because the code or tests were added.


## Regression fix — data-only backup restore with accounting enabled

Data-only restore is a privileged database replacement operation. The accounting ledger's normal-write triggers (posted-entry immutability, protected system accounts and append-only audit records) must not block replacing rows from a validated backup. Restore now drops the accounting trigger set inside the restore transaction, replaces the rows, recreates the shared trigger definitions before integrity validation/commit, and relies on SQLite transaction rollback to recover the original trigger set on failure. The migration uses the same trigger SQL constant to avoid restore/migration drift. Regression coverage includes restoring over a posted journal while preserving the seeded system chart of accounts.

## Phase 5 management-report implementation contract (PR #19, in progress)

- Use posted `accounting_journal_entries` and `accounting_journal_lines` as the only source for financial report totals. Do not calculate accounting reports from editable UI totals or unposted operational drafts.
- The current report summarizes `acct-sales-revenue` credits net of debits, `acct-sales-returns` debits net of credits, manual `other_income` journal lines, and posted expense-account movements. It also exposes cash-drawer, bank and payment-clearing balances through the selected end date, period debit/credit movements, posted journal-line detail, and recorded legacy receipt/refund exceptions.
- Owner contributions/drawings, opening-balance journals and asset-to-asset transfers must not increase income or operating expense. Unpaid/unposted expense drafts must not reduce cash or appear as posted expenses. Wallet/store-credit activity, discounts and cashback remain outside accounting.
- Label the calculated result as before COGS / excluding inventory cost and explicitly not net profit. Inventory value and COGS cannot be inferred from stock quantities.
- **Tax payment policy (owner-confirmed):** sales revenue equals actual monetary receipts posted by the POS. Do not deduct bill-level tax snapshots from those receipts. When tax is actually paid, record it as a paid expense using the seeded “Taxes paid” category and dedicated `acct-tax-expenses` account. That expense reduces the report result on the tax payment's accounting date. This is an internal cash-received bookkeeping model, not a statutory tax-liability calculation or tax-compliance claim.
- API access remains restricted to owners/managers. The report endpoint is read-only, validates calendar dates and date-range order, uses configured store currency ledger units (IRR whole rials, not fractional rials), and caps movement listing size.
- Acceptance checks must cover real sales, monetary refunds, posted expenses and reversals, manual other income, owner equity, transfers, date filtering, manager-only access, currency precision, and the absence of a false net-profit claim. Reports must show the cash-received sales basis and tax payments as expenses when paid.
