# LyraPOS Stage 6 — Localization & Branding

Status: Complete

## Scope
- Audited the 21 supported locale files under `frontend/src/lib/i18n/messages/`.
- Updated user-facing legacy Flo branding to LyraPOS.
- Preserved translated wording and locale structure; this stage changes product identity, not translation quality.
- Preserved machine-readable integration contracts and internal event identifiers.

## Locales
`ar, bn, de, en, es, fa, fil, fr, hi, id, it, ja, ko, nl, pt, sq, tr, ur, vi, zh, zh-tw`

## Branding changes
- `Flo Cafe` → `LyraPOS`
- `FloPOS` → `LyraPOS`
- `FloCafe` → `LyraPOS`
- `Powered by Flo` → `Powered by Lyra`
- `via Flo` → `via Lyra`
- standalone localized app title value `Flo` → `LyraPOS`

## Guardrail
Added `tests/lyrapos-localization-identity.test.ts` and wired it into the main test chain as `test:localization-identity`.

The guard verifies:
- exactly 21 expected locale files exist
- the legacy user-facing branding tokens above are absent

## Deliberate compatibility
This stage does not rename WordPress Bridge protocol identifiers, database fields, API paths, or other machine-readable compatibility contracts.

## Next
Stage 7 — Windows packaging and release identity.
