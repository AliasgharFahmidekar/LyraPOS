# Persian (Jalali / Solar Hijri) Calendar Roadmap

**Status:** Planned — audit complete; implementation has not started.  
**Scope:** Iran tenant date handling across the LyraPOS desktop app, accounting, reports, history, and printing.  
**Product decision:** For an Iran tenant, **Jalali is the calendar users see and enter**. Gregorian dates remain the machine/storage representation, not a competing user-facing calendar mode. Other country profiles keep their own calendar policy.

## 1. Goal

Implement one accurate, deterministic Jalali calendar experience end-to-end. Every date must mean the same day in date pickers, list rows, filters, accounting periods, cash-close screens, reports, and printed receipts. It must not depend accidentally on the Windows display language, browser date-input rendering, or whichever formatter a screen happens to use.

This is a calendar feature, not a change to accounting business-day rules or persisted records.

## 2. Non-negotiable rules

1. **Jalali for Iran:** all user-facing Iran-tenant dates use the Iranian Solar Hijri/Jalali calendar. There is no per-screen Gregorian fallback or duplicate “Auto (Shamsi)” versus “Jalali” behavior. UI language and numeral style are independent of the calendar.
2. **One conversion engine:** use one reviewed, deterministic Jalali conversion implementation for parsing, validation, arithmetic, month boundaries, and conversion. Do not hand-write separate algorithms in forms and reports. `Intl.DateTimeFormat` may format labels, but it is not the conversion or date-validation engine.
3. **Canonical storage stays Gregorian:** do not migrate existing rows or write Jalali strings into database date columns. Date-only API/storage values remain canonical Gregorian `YYYY-MM-DD`; instants remain UTC timestamps. Convert at the user-interface boundary.
4. **Keep date-only values and timestamps distinct:**
   - A date-only value (for example an expense date) is a calendar date, not an instant. Parse its numeric components without timezone shifting.
   - A timestamp is an instant. Parse it correctly, apply the tenant timezone, then render its date/time in Jalali.
   - Accounting business-date and business-day-start calculations remain owned by the existing backend resolver. The calendar layer must not recalculate or bypass them.
5. **Invalid dates must fail closed:** never normalize invalid dates silently. For example, an invalid Esfand 30 must be rejected rather than rolling into Farvardin.
6. **No silent contract changes:** machine-readable API and import/export contracts keep explicit Gregorian ISO values unless a separately versioned export contract says otherwise. Human-facing screens, reports, and printouts show Jalali dates.
7. **No hidden locale fallback:** a missing or invalid date must be visible as a validation/data error or a documented empty value, not rendered as a misleading date.

## 3. Current baseline and known gaps

The audit found an existing partial foundation, but not a complete calendar implementation:

- Iran already has a `fa-IR` country locale, calendar preferences, and a shared `formatDateForTenant` formatter.
- `frontend/src/hooks/useFormatDate.ts` consumes the tenant calendar/timezone preferences on some screens.
- Several accounting forms and cash-close flows still use native `input type="date"`; its visible calendar is browser/OS-dependent and does not guarantee Jalali selection.
- Some accounting tables and report values render raw ISO dates instead of going through a shared formatter.
- The accounting reports' default month start is derived from the Gregorian month, not the current Jalali month.
- Web printing uses tenant-aware date formatting, while classic/compact thermal print paths have separate date-formatting logic and do not consistently apply the same tenant calendar preference.
- Existing settings expose overlapping “locale/auto”, Persian, and Gregorian behavior; this is inconsistent with the product decision above for Iran.

These are inventory findings, not claims that every app surface has already been fixed. Phase 0 must confirm the full list from the current source tree before implementation begins.

## 4. Target architecture

### A. Shared Jalali date domain module

Provide a single typed module, usable by every applicable app layer, with operations equivalent to:

- Gregorian ISO date → Jalali year/month/day.
- Jalali year/month/day → Gregorian ISO date.
- Strict Jalali date validation and month length.
- Jalali leap-year detection.
- Jalali month start/end and month navigation.
- Stable date-only parsing/serialization without local-time or UTC off-by-one errors.
- Formatting helpers for date, month/year, and date-time, with explicit tenant timezone for timestamps.

The module must define supported input range, invalid-input behavior, and algorithm/version. The dependency review should evaluate a maintained conversion library (with `jalaali-js` as a candidate), verify its license and Electron/Node/runtime compatibility, and test it against frozen, independently checked Iranian calendar vectors. The chosen algorithm and its supported range must be documented. Do not mix conversion algorithms silently between `Intl`, frontend, backend, or printer paths.

### B. Jalali date picker

Replace browser-native date fields for Iran-tenant user input with one reusable Jalali date picker:

- Jalali year/month heading and Jalali month navigation.
- Correct 31/30/29-day months, leap-year handling, and Esfand 29/30 validation.
- Saturday-first calendar grid for Iran.
- Keyboard navigation, focus management, RTL layout, accessible labels, clearable values when the field is optional, and existing min/max constraints.
- A clearly labelled “today” action based on the tenant's current business-local date where the screen represents a business date.
- On selection, submit the corresponding canonical Gregorian ISO date to existing APIs. Never submit a formatted Persian string as a database/API date.

### C. Shared display policy

- All Iran-tenant user-facing date renderers call the shared date module or a wrapper around it.
- Calendar stays Jalali even if the UI language is English; language may localize wording/month labels, but cannot switch the underlying calendar.
- Persian versus Latin digits remains an independent preference.
- Date-only fields are never timezone-shifted. Timestamps always use the tenant timezone before Jalali conversion.
- The browser receipt and classic/compact thermal printing use the same calendar rules. Printer glyph/digit compatibility may be handled separately, without changing which day is printed.

## 5. Implementation phases and gates

Each phase is a small, reviewable PR or commit series on a dedicated calendar branch. A phase is complete only when its acceptance criteria and tests pass on that exact head. Do not merge unrelated accounting features into this work.

### Phase 0 — Full date-surface inventory

**Work**
- Search the entire repository for date inputs, date parsing, raw ISO display, month-start/end arithmetic, timezone conversion, and print/export formatting.
- Record each field as either date-only, timestamp/instant, or business-date.
- Inventory UI lists/details, order and inventory history, accounting settings and reports, cash-close/movement flows, receipts, thermal tickets, report exports, CSVs, and backups/imports.
- Identify all existing consumers of the stored `calendar` preference and the native date-input values.

**Gate**
- The inventory is checked into this document or a linked checklist, with every discovered surface assigned to a phase.
- No date field is classified by guessing from its visual format; its API/database semantics are inspected.

### Phase 1 — Calendar algorithm and reference vectors

**Work**
- Review the candidate library against the packaged Electron, Node, and browser targets; verify package license, maintained status, types, and offline operation.
- Select and document one deterministic Iranian Jalali conversion algorithm and supported range.
- Freeze reference vectors from independently checked calendar references, including Nowruz boundaries and leap/non-leap Esfand examples.
- Decide behavior for unsupported years and invalid user input. Do not create a second in-house algorithm as a fallback.

**Gate**
- Tests prove both conversion directions, leap years, month lengths, and round trips against the frozen reference vectors.
- Tests include at least `1399/01/01 → 2020-03-20`, `1400/01/01 → 2021-03-21`, `1403/01/01 → 2024-03-20`, and `1404/01/01 → 2025-03-21`; verify these values against the selected reference source before they are committed as fixtures.
- Invalid dates, including `1400/12/30`, are rejected; valid leap-year Esfand 30 dates are accepted.
- `Intl` is a comparison/formatting aid only, never the engine that decides whether a Jalali date exists.

### Phase 2 — Shared conversion, parsing, and formatting APIs

**Work**
- Implement the shared typed module and make date-only parsing independent of machine-local timezone.
- Route existing `formatDateForTenant`/date wrapper behavior through the selected policy, avoiding two competing algorithms.
- Separate formatters for date-only values and instants; retain tenant-timezone conversion only for instants.
- Define migration/compatibility behavior for old stored calendar preferences: Iran resolves to Jalali even if an old setting says Gregorian/locale; do not rewrite unrelated settings or add a database migration without a demonstrated need.

**Gate**
- Unit tests cover timezone boundaries, malformed strings, leap dates, round trips, unsupported ranges, and Persian/Latin digits independently.
- Tests demonstrate that one stored ISO date produces the same Jalali date on different machine locales/timezones.
- Existing stored data and API response shapes remain unchanged.

### Phase 3 — Reusable Jalali date picker

**Work**
- Build the shared picker with month navigation, year navigation, validation, keyboard accessibility, RTL, and optional/min/max handling.
- Define the component contract so its outward value is canonical Gregorian ISO `YYYY-MM-DD`, while its visible/editable value is Jalali.
- Do not keep native `type="date"` for Iran-tenant inputs as a silent fallback.

**Gate**
- Component tests cover every month length, leap/non-leap Esfand, navigation across Esfand/Farvardin, min/max, empty values, keyboard interaction, and ISO submit values.
- Manual UI check on Windows confirms Jalali dates are displayed and selected regardless of Windows/browser region.
- Existing forms continue to submit values expected by current APIs.

### Phase 4 — Accounting and business-date workflows

**First surfaces**
- `frontend/src/components/settings/AccountingSettings.tsx`: expense, payment, activity, opening balance, reconciliation adjustment, and transfer dates.
- `frontend/src/components/settings/AccountingReports.tsx`: from/to filters, journal movement dates, exceptions, and report date labels.
- `frontend/src/components/dashboard/CashCloseModal.tsx`: business date and period boundaries.
- `frontend/src/components/dashboard/CashDrawerMovementModal.tsx`: business date.
- Any other date controls or values found by Phase 0.

**Work**
- Replace native date inputs with the shared picker.
- Remove raw ISO display from user-facing rows and convert form selections to Gregorian ISO before API submission.
- Derive report default ranges from the current Jalali month. Convert Jalali month start/end to canonical Gregorian boundaries before sending filters; preserve the API's inclusive/exclusive boundary contract.
- Display cash-close and period boundaries consistently without changing the backend's tenant timezone or business-day-start rules.

**Gate**
- Regression tests verify a new expense/payment/transfer/report filter sends the correct Gregorian date for the selected Jalali day.
- Report range tests cover an ordinary month, Esfand, leap-year Esfand, and a range crossing Nowruz.
- Cash-close dates match the backend's resolved business date at tenant timezone/day-start boundaries.
- Existing accounting integrity and posting tests remain unchanged and pass.

### Phase 5 — App-wide display and printing consistency

**Work**
- Migrate all remaining user-facing dates in orders, inventory movements, activity/history lists, dashboards, detail views, reports, and notifications to the shared display policy.
- Align browser receipts and classic/compact thermal printing to the same calendar conversion and tenant-timezone behavior.
- Audit any date in generated documents, export previews, and print headers/footers.
- Preserve machine-readable data contracts. Where a human-readable CSV/report is intended for Persian users, label Jalali columns clearly; do not silently reinterpret an existing Gregorian import field.

**Gate**
- Given the same known timestamp and tenant settings, all UI and print paths show the same Jalali calendar day (time-zone-appropriate for an instant).
- Date-only values do not shift by one day between UI, API, report, and print.
- Tests cover web print plus classic/compact thermal formatting, English/Persian UI labels, and Persian/Latin digits.
- A repository-wide search shows no unreviewed raw date display or native date input for Iran-tenant dates.

### Phase 6 — Settings cleanup, compatibility, and release verification

**Work**
- Simplify Iran's calendar setting so it no longer offers conflicting Gregorian/“Auto” options, unless an explicit later product decision reopens that requirement.
- Keep numeral preference separate. Preserve non-Iran country behavior.
- Document API/storage values, chosen algorithm, supported years, and date-only-versus-instant semantics.
- Add the full date/calendar regression suite to the standard CI workflow and update relevant developer documentation.

**Gate**
- Fresh install and upgrade from a store with each legacy calendar preference resolve to Jalali for Iran without corrupting unrelated locale preferences.
- Non-Iran country tests still pass.
- Full regression suite, type-check/build, lint, i18n validation, and print-label validation pass on the exact final head.
- CI and manual Windows verification both pass before the implementation PR is eligible for review/merge.

## 6. Required regression matrix

| Area | Required cases |
| --- | --- |
| Conversion | Gregorian→Jalali→Gregorian and Jalali→Gregorian→Jalali round trips |
| New Year | Dates on the day before, day of, and day after Nowruz across multiple years |
| Leap years | Esfand 30 accepted only when valid; Esfand length and month navigation correct |
| Date-only values | Exact ISO date preserved without timezone conversion |
| Timestamps | UTC instant rendered after applying tenant timezone, including midnight boundary cases |
| Language and digits | Jalali under Persian and English UI; Persian and Latin digits independent |
| Date picker | Keyboard, RTL, Saturday-first grid, min/max, blank optional date, invalid date rejection |
| Accounting | Expense/payment/transfer dates, report filters, Jalali month start/end, cash close |
| Print | Browser/web receipt and classic/compact thermal output agree on calendar day |
| Compatibility | Iran legacy setting values, other-country calendar defaults, existing data/API contracts |
| CI | Focused calendar tests plus the full regression/build/lint/i18n/print checks |

## 7. Definition of done

The calendar work is not complete merely because a screen displays Persian numerals. It is complete only when:

- Iran users can enter and read dates as Jalali throughout the app.
- The chosen algorithm correctly validates leap years and month lengths across the documented supported range.
- Jalali selections convert to the exact intended Gregorian ISO values and round-trip without a one-day error.
- Accounting and cash-close filters use the correct Jalali period boundaries while keeping existing accounting business-date rules intact.
- UI, browser print, and thermal print agree.
- Machine-readable storage/API contracts remain stable.
- Tests prove the above on the exact implementation PR head.

## 8. Technical references

- [Jalaali JavaScript conversion library](https://github.com/jalaali/jalaali-js) — candidate for review, not an automatic choice; its documented algorithm range and comparison with `Intl` must be considered.
- [MDN: JavaScript internationalization and date/time formatting](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Internationalization) — formatting and time-zone behavior; not a replacement for strict Jalali date validation/conversion.
- Existing project entry points to audit: `main/countries.ts`, `frontend/src/hooks/useFormatDate.ts`, `frontend/src/components/settings/AccountingSettings.tsx`, `frontend/src/components/settings/AccountingReports.tsx`, `frontend/src/components/dashboard/CashCloseModal.tsx`, `frontend/src/components/dashboard/CashDrawerMovementModal.tsx`, and `frontend/src/lib/printer/web-print.ts` plus classic/compact thermal formatters.
