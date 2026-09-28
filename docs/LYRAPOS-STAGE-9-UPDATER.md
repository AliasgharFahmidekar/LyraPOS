# LyraPOS Stage 9 — Updater & Release Channel Identity

Status: Complete for updater configuration and identity guards.

## Stable feed

electron-builder is configured for GitHub Releases at `AliasgharFahmidekar/LyraPOS`, with the default channel `latest`. Update manifests are generated for all configured channels.

## Beta feed

LyraPOS retains the existing explicit beta-channel model:
- stable builds stay on stable unless the user opts into beta;
- beta builds use the beta channel;
- unsupported prerelease labels fall back to stable;
- stable beta opt-in does not permit downgrades.

No nightly channel was introduced.

## Development/runtime boundary

The unpacked-artifact marker is now consistently named `lyrapos-unpacked-dev.marker`. This fixes the mismatch where the runtime looked for the LyraPOS marker while the helper still wrote the old FloCafe marker.

## Release verification

The release asset verifier now expects `lyrapos-${version}` artifact names rather than `flocafe-${version}`.

A dedicated regression guard verifies:
- GitHub owner/repository;
- stable/beta channel configuration;
- updater channel assignment;
- LyraPOS development marker;
- LyraPOS release artifact prefix.

## Important validation boundary

The repository currently has the dedicated LyraPOS Windows and Unix packaging workflows, but this turn does not claim a real release was published or that an update was installed from GitHub Releases. That requires an actual signed/tagged release and runner validation.
