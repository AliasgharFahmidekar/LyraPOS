# LyraPOS accounting implementation context for AI contributors

**Status:** ACTIVE DESIGN. This document describes the accounting implementation added in Phase 0/1 and the constraints for future phases. Read it before changing accounting code.

## Read first

Before implementation, read:
- `/AGENTS.md` and `docs/business-decisions.md` for project-wide invariants and established product choices.
- `docs/accounting-foundation-roadmap.md` for the accounting model and phased scope.
- `main/db.ts` for the current migration registry and SQLite lifecycle.
- `main/accounting/ledger.ts` and `tests/accounting-ledger.test.ts` for the ledger API and behavior.
- The route/service/tests of any existing operational source being connected.

**Runtime code and automated tests define current behavior.** This document records architecture boundaries and future intent; never claim planned work is already implemented.

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

### Business decisions still required before Phase 3 posting

The code must not guess:
1. Accounting basis and the exact event that recognizes a sale (for example, bill finalized versus payment captured).
2. Whether collection creates a separate accounts-receivable/cash event, and how unpaid, partial and split payments behave.
3. Refund posting timing and how refunds, voids, cancellations, chargebacks and discounts are classified.
4. Tax liability/account mapping for the selected jurisdiction and whether tax-inclusive prices affect revenue lines.
5. Opening balances, owner contributions/drawings and who can approve them.
6. Currency minor-unit conversion and rounding at all posting boundaries.
7. Business accounting date, store timezone, close-period policy and whether posted periods can be reopened.

Resolve these through documented product decisions before implementing automated accounting entries from bills/payments/refunds. Do not infer statutory compliance.

## 2. Current architecture and migration rules

- Database: `main/db.ts`, using the active `better-sqlite3` connection.
- Migration registry: `MIGRATIONS` in `main/db.ts`; migration 100 introduced the ledger, migration 101 hardens system-account identity, and migration 102 adds expense categories, expense drafts, and payment-method account mappings. Historical migrations remain immutable.
- Ledger domain service: `main/accounting/ledger.ts`. It receives the caller's database connection; do not open a second connection.
- Automated coverage: `tests/accounting-ledger.test.ts` (`npm run test:accounting-ledger`) and `tests/accounting-expenses.test.ts` (`npm run test:accounting-expenses`).
- Test harness: `tests/run-electron-node-test.cjs`.
- Default suite: root `package.json` includes the focused ledger suite.
- Existing frontend: `frontend/src/`, Next.js/React, shared components/styles, localization, and RTL support.

Migrations are append-only. Never edit historical migrations, drop customer data, reset a live database, or bypass the built-in pre-migration backup. Tests must cover a fresh install, an upgrade from v99, and an upgrade from an existing v100 database while preserving existing data. Migration 100 is additive: it does not rewrite sales, payments, stock, cash or recipe tables; migration 101 updates only the system-account identity guard.

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



## 3.1 Phase 2 foundation currently implemented (schema v102)

- `accounting_expense_categories` maps manager-defined categories to active, postable expense accounts. Categories are deactivated rather than deleted once used.
- `accounting_payment_method_mappings` maps the existing built-in (`cash`, `card`, `loyalty`) and custom (`custom:<id>`) payment-method keys to existing GL accounts; it does not create a second payment-method catalogue.
- `accounting_expenses` stores auditable draft expenses using integer `amount_minor`, currency code, expense date, category, payee/reference, and paid/unpaid state. A paid expense requires an existing payment-method mapping and payment date. Category, expense and mapping mutations also append records to `accounting_audit_log` in the same transaction.
- Manager-only endpoints are mounted at `/api/accounting`: `GET /accounts`, `GET/POST/PUT /expense-categories`, `GET/PUT /payment-account-mappings`, and `GET/POST/PUT /expenses` (including `GET /expenses/:id`).
- This increment does not yet post expense journals, implement transfers, or add UI. Those remain Phase 2 stages 2 and 3. Posted expenses are not editable through the draft API.

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

0. **Discovery/design — done in this PR:** verified existing operational systems, boundaries, migration route, tests and unresolved accounting-policy decisions.
1. **Ledger core — done in this PR:** migrations 100–101; seeded starter chart; journal headers/lines; integer minor-unit validation; source/idempotency uniqueness; atomic draft creation and posting; audit events; immutable posted records and system-account identity guards; focused fresh-install, v99-to-v101, v100-to-v101 and service tests.
2. **Account/expense setup — next PR:** routine expense entry/categories, non-sales income, mappings of existing payment methods to GL accounts, defaults for cash/bank and transfers; Settings subsection inside existing Settings screen. Add end-to-end tests.
3. **Operational posting — following PR:** committed bill/sale recognition, actual collections including unpaid/partial/split cases, refunds, and reconciliation against existing cash sessions/drawer movements. Resolve the business gates in section 1 first. Add idempotency, retry/order/reconciliation and POS regression tests.
4. **Supplier purchases/payables:** supplier records and purchase bills/payments linked to the existing stock/supply movements.
5. **Inventory valuation/COGS:** attach values to current stock and recipe consumption without running another quantity stock engine; explicit costing method and waste/restoration tests.
6. **Financial reports and close controls:** account ledger, trial balance, reconciled P&L, balance sheet only when supported by complete postings, export and period control.
7. **Optional advanced work:** checks, loans/installments, payroll, fixed assets/depreciation, tax-specific functionality and multi-branch reporting as separate scopes.

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
npm run build
npm run lint
npm run test:script-coverage
```

Migration changes require a fresh database and upgrade-from-v99 test. Native `better-sqlite3` ABI mismatch may be signaled by exit code 77; it is a skip/blocked environment, not a passing test. Check actual GitHub Actions results after pushing; never assume CI passed because the code or tests were added.


## Regression fix — data-only backup restore with accounting enabled

Data-only restore is a privileged database replacement operation. The accounting ledger's normal-write triggers (posted-entry immutability, protected system accounts and append-only audit records) must not block replacing rows from a validated backup. Restore now drops the accounting trigger set inside the restore transaction, replaces the rows, recreates the shared trigger definitions before integrity validation/commit, and relies on SQLite transaction rollback to recover the original trigger set on failure. The migration uses the same trigger SQL constant to avoid restore/migration drift. Regression coverage includes restoring over a posted journal while preserving the seeded system chart of accounts.