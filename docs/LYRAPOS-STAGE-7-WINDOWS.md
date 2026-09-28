# LyraPOS Stage 7 — Windows Packaging & Release Identity

Status: Complete

## Windows application identity
- Electron application ID: `ir.lyradesgin.lyrapos`
- Product name: `LyraPOS`
- npm package identity: `lyrapos-desktop`
- Windows installer artifact: `lyrapos-${version}-win-${arch}.${ext}`
- NSIS desktop and Start Menu shortcuts use the LyraPOS product identity.
- Windows AppX application ID: `LyraPOS`
- Windows AppX identity name: `CodifyAppsPrivateLimited.LyraPOS`
- Electron runtime explicitly sets Windows AppUserModelId to `ir.lyradesgin.lyrapos`.

These identifiers are distinct from the old FloCafe identity, so LyraPOS is packaged as a separate Windows application rather than an in-place product rename.

## Release workflow
Added `.github/workflows/lyrapos-windows.yml`.

It:
1. runs on Windows,
2. installs the pinned Node 22.12 toolchain,
3. installs dependencies with `npm ci`,
4. builds the Windows release without publishing from the build command,
5. verifies artifact filenames,
6. runs the Windows identity guard,
7. uploads LyraPOS EXE/blockmap/update-manifest artifacts.

It supports manual dispatch and version-tag pushes.

## Lockfile and packaging metadata
- npm lockfile root identity is now `lyrapos-desktop`.
- Linux AppStream destination was aligned with the LyraPOS metadata ID.
- Existing AppX publisher certificate configuration was preserved because Microsoft Store publishing is not the current target.
- Existing MAS provisioning configuration was preserved for the same reason.

## Regression guard
Added `tests/lyrapos-windows-packaging.test.ts`.

It verifies:
- package/lockfile identity,
- Electron app ID,
- Windows targets,
- NSIS shortcut settings,
- AppX identity,
- GitHub release destination,
- LyraPOS artifact naming,
- runtime AppUserModelId,
- absence of legacy Windows packaging identity strings.

## Important verification boundary
The workflow is now present, but a real Windows runner build has not been executed in this turn. Physical side-by-side installation with an already-installed FloCafe copy still needs to be performed during the release validation stage.
