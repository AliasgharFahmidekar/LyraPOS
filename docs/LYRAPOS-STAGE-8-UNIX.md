# LyraPOS Stage 8 — Linux/macOS Identity & Packaging

Status: Complete for configuration and CI guards.

## Linux

- executable: `lyrapos`
- StartupWMClass: `lyrapos-desktop`
- AppStream ID: `ir.lyradesgin.lyrapos`
- AppImage/deb/rpm/snap artifacts use the `lyrapos-` prefix.
- AppStream metadata is copied from `assets/ir.lyradesgin.lyrapos.metainfo.xml`.
- The metadata updater now writes to the LyraPOS AppStream file and no longer targets the removed Flo metadata filename.

## macOS

- Bundle/application ID comes from `build.appId = ir.lyradesgin.lyrapos`.
- DMG/ZIP artifacts use the `lyrapos-` prefix.
- Local-network usage text is branded LyraPOS.
- MAS signing configuration remains unchanged because Mac App Store publishing is not currently a release target. Its existing provisioning/application-group contract is therefore intentionally preserved rather than changed without a matching Apple provisioning profile.

## Validation workflow

`.github/workflows/lyrapos-unix.yml` can be manually dispatched. It:
1. validates Linux/macOS identity;
2. builds Linux packages;
3. builds macOS packaging with notarization disabled for CI packaging validation;
4. verifies generated artifact filenames.

This does not constitute notarization or Mac App Store signing validation. Those require the appropriate Apple certificates/profiles/secrets.

## Important

The application identity is now distinct from FloCafe for normal Linux/macOS desktop packaging. Store-specific Apple signing identifiers are intentionally preserved until a real MAS distribution setup exists.
