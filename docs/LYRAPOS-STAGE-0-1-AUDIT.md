# LyraPOS — Stage 0 / Stage 1 Audit

Date: 2026-09-28

## Stage 0 — Protection

- [x] Repository: `AliasgharFahmidekar/LyraPOS`
- [x] Default branch: `main`
- [x] Extracted source committed successfully.
- [x] Pre-rename protection branch created: `protection/stage-0-pre-rename`
- [x] The original uploaded ZIP remains recoverable from Git history.
- [ ] Original source GitHub Actions were not extracted into the working tree because the bootstrap workflow intentionally excludes `.github/workflows/` (GitHub App workflow-permission limitation). Only `bootstrap-extract.yml` is currently present.

Protected commit:
`9a020fa66a4cb36a49b007f7d79fd554c123ad32`

## Stage 1 — Structure audit

### Application architecture

- Electron desktop shell.
- Main process in TypeScript under `main/`.
- Next.js/React frontend under `frontend/`.
- SQLite database logic in `main/db.ts`.
- Thermal/receipt printing under `main/printers/` and frontend printer helpers.
- WordPress Bridge is present as a separate service/route layer.
- Shared code under `shared/`.
- Extensive automated tests under `tests/` plus Electron/Playwright E2E tests.

### WordPress Bridge — critical

Confirmed present:
- `main/services/wordpress-bridge.ts`
- `main/routes/wordpress-bridge.ts`
- WordPress Bridge settings UI under frontend settings.

The service contains catalog/product/category mappings, order synchronization, connection configuration, health checks, internal integration calls, and persistence. This must be preserved during the rename. The audit found legacy internal identifiers such as `flocafe_*` and `FloCafe` in the Bridge implementation; these are not to be blindly renamed because they may be part of the existing integration contract.

### Printer

Printing is implemented and has dedicated tests. However, current source still contains legacy receipt branding:
- `frontend/src/lib/printer/branding.ts` → `Powered by FloPOS (flopos.com)`

Therefore the previously completed Lyra branding change from the separate FloCafe-Bridge review branch is not present in this extracted LyraPOS snapshot and must be reapplied deliberately in the product rename stage.

### Branding / identity findings

Current package identity is still Flo:
- package name: `flo-desktop`
- Electron appId: `com.flo.desktop`
- productName: `Flo Cafe`
- Windows artifacts: `flocafe-...`
- AppX application/identity: `FloCafe` / `CodifyAppsPrivateLimited.FloCafe`
- Linux executable: `flocafe`
- Linux desktop StartupWMClass: `flo-desktop`
- Linux metadata file: `assets/com.flo.desktop.metainfo.xml`
- macOS artifact names still use `flocafe`
- GitHub publishing configuration still points to `FreeOpenSourcePOS/FloCafe`

Runtime/UI legacy branding is also present, including:
- `main/index.ts` app name/user-data path/tray/about/title strings
- `frontend/src/app/layout.tsx` title and Flo theme storage key
- `frontend/src/components/layout/TitleBar.tsx` Flo-specific DOM data/class identifiers

These are Stage 2+ changes, not to be mixed into the audit.

### Platforms

Windows, Linux and macOS build configurations are present. AppX and Mac App Store configuration are present in the source. The requested product goal is not Microsoft Store publishing, so those configurations should be audited for identity contamination rather than treated as a publishing target.

### Languages

21 locale files are present under `frontend/src/lib/i18n/messages/`:
ar, bn, de, en, es, fa, fil, fr, hi, id, it, ja, ko, nl, pt, sq, tr, ur, vi, zh, zh-tw.

Translation files should receive branding-only changes later without altering translated content unnecessarily.

### Tests

The repository contains a large regression suite covering:
- title bar/window behavior
- updates/channels
- release configuration
- printers/receipts/thermal capabilities
- translations/i18n/RTL
- database/migrations
- auth/authorization
- KDS
- Windows-specific behavior
- E2E desktop flows
- upgrade paths

Important audit finding: `tests/release-config.test.ts` currently references release workflows and the old repository `FreeOpenSourcePOS/FloCafe`. Since the extracted working tree currently contains only `bootstrap-extract.yml` under `.github/workflows/`, release workflow files are a known preservation/repair item before release tests can be considered valid.

## Stage 1 conclusion

Stage 0 is protected and Stage 1 audit is complete enough to begin the controlled rename.

No product functionality has been intentionally removed.

Next stage: Stage 2 — establish the new LyraPOS application identity consistently across Electron, Windows, Linux, macOS, updater/release configuration, artifact names, title bar and runtime storage, while preserving the WordPress Bridge contract and current features.
