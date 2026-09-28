# LyraPOS Stage 5 — UI / UX Branding Audit

Status: **Complete**

## Scope
Audited the desktop UI shell and user-facing application chrome after the Stage 2 identity migration.

## Completed
- Fixed a real identity mismatch in the Electron title bar: the renderer was still writing legacy `data-flo-*` attributes while the LyraPOS CSS and tests expected `data-lyra-*`.
- Updated desktop title-bar platform/focus attributes to LyraPOS names.
- Renamed the toast UI CSS/DOM classes from `flo-toast-*` to `lyra-toast-*`.
- Updated the toast container to use the LyraPOS sidebar offset variable.
- Kept title-bar geometry, native window controls, RTL behavior, theme behavior, update badge, and sidebar navigation logic unchanged.
- Did not replace the logo artwork, as requested; the existing asset remains available for the future LyraPOS logo.

## Branding boundary
Visible translation strings containing legacy Flo/FloCafe names remain part of the dedicated Stage 6 localization pass. They were not mass-edited here because all 21 locale files need to be handled consistently.

Machine/runtime event names and integration contracts are also not blindly renamed unless they are UI identity rather than compatibility contracts.

## Regression guard
Added `tests/lyrapos-ui-identity.test.ts`, covering:
- Lyra title-bar data attributes
- Lyra toast classes
- Lyra sidebar offset
- absence of legacy Flo title-bar/toast UI identifiers

The test is wired into the main test command as `test:ui-identity`.

## Result
Stage 5 shell/UI identity work is complete without changing business logic, WordPress Bridge behavior, printer behavior, or the existing logo artwork.
