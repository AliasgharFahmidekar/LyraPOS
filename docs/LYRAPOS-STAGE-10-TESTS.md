# LyraPOS Stage 10 — Tests & Regression Guard

Status: **Complete (test architecture and guards updated)**

## What was audited

- Main npm test chain and test-script coverage.
- Application identity guards.
- Desktop UI identity guards.
- 21-language branding guard.
- WordPress Bridge API and machine-readable compatibility contracts.
- Printer/receipt branding and compatibility keys.
- Windows packaging identity.
- Linux/macOS packaging identity.
- Updater/release-channel identity.
- Release configuration and GitHub Actions workflows.

## Changes made

### 1. Fixed stale release-config regression test

`tests/release-config.test.ts` was still asserting the old upstream release workflows and repository. Those workflows are not present in the current LyraPOS repository, so the test could not represent the current project.

It was replaced with a current guard for:

- LyraPOS package/app identity.
- GitHub publish destination.
- `--publish never` on local release scripts.
- Windows workflow and required steps.
- Linux/macOS workflow and required jobs.

### 2. Added full regression guard

Added:

`tests/lyrapos-full-regression.test.ts`

It checks, in one place, that:

- package and lockfile identity stay LyraPOS;
- all major identity tests remain reachable from `npm test`;
- WordPress Bridge endpoints/contracts remain present;
- receipt branding remains Lyra-branded;
- all 21 locale files remain present and free of legacy visible branding;
- key visible UI files remain free of old Flo branding;
- required compatibility identifiers are preserved;
- packaging configuration does not regress to old release identity.

### 3. Added dedicated regression workflow

Added:

`.github/workflows/lyrapos-regression.yml`

It runs `npm test` on:

- pushes to `main`;
- pull requests targeting `main`;
- manual workflow dispatch.

### 4. Preserved compatibility boundaries

The audit does **not** blindly rename machine-readable contracts. In particular, WordPress Bridge identifiers such as:

- `/wp-json/flocafe/v1`
- `x-flocafe-bridge-key`
- `flocafe_product_id`

and legacy printer compatibility keys remain protected.

## Verification boundary

The code and CI guards have been updated, but this turn did **not** execute the GitHub Actions runner. Therefore the full `npm test` suite is **not claimed green yet**.

The next real verification is to run **LyraPOS Regression** from GitHub Actions and inspect the first failure, if any. Windows/Linux/macOS packaging workflows also still require their real runner builds before those platform packages can be considered verified.
