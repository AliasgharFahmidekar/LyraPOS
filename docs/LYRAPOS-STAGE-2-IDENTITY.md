# LyraPOS — Stage 2 Identity

Date: 2026-09-28

Stage 2 is implemented.

## New application identity

- npm/package name: `lyrapos-desktop`
- Electron application ID: `ir.lyradesgin.lyrapos`
- product name: `LyraPOS`
- Windows App User Model ID: `ir.lyradesgin.lyrapos`
- Windows NSIS artifact prefix: `lyrapos-`
- AppX application ID: `LyraPOS`
- AppX identity name: `CodifyAppsPrivateLimited.LyraPOS`
- Linux executable: `lyrapos`
- Linux StartupWMClass: `lyrapos-desktop`
- macOS artifact prefix: `lyrapos-`
- AppImage artifact: `lyrapos-${version}-linux.appimage`
- Linux AppStream ID: `ir.lyradesgin.lyrapos`
- frontend web manifest name/short name: `LyraPOS`
- GitHub update/release target: `AliasgharFahmidekar/LyraPOS`

## Isolation behavior

LyraPOS now uses a distinct product/package/app identity and a distinct Linux user-data directory (`.config/lyrapos-desktop`). Windows also receives an explicit LyraPOS App User Model ID.

This is intended to prevent a LyraPOS install from being identified as the FloCafe application or as an update to the old FloCafe identity.

## Important compatibility boundary

The WordPress Bridge was not structurally renamed. Existing Bridge identifiers/contracts are intentionally preserved so the integration does not break.

The existing local-network mDNS hostname was changed from `flo.local` to `lyrapos.local` because it is exposed as the product's LAN service identity. Any external configuration that explicitly hard-coded `flo.local` will need migration/documentation in the later integration audit.

## Not changed yet

- Logo/icon artwork — intentionally preserved until the new logo is supplied.
- Full source-wide legacy-string cleanup — handled across later UI/i18n/printing/documentation stages.
- Release workflows — the original workflow files were not extracted because of the GitHub App workflow permission limitation; new LyraPOS workflows are part of the Windows/release stages.
- AppX signing/publisher certificate — Store publishing is not the target. The AppX identity itself is now distinct.
- macOS App Store provisioning profile — Store publishing is not the target.

## Guardrail

Added `tests/lyrapos-identity.test.ts` and wired it into the main test command so core application identity cannot silently regress to Flo identifiers.
