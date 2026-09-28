# LyraPOS Stage 4 — Printing Audit

Status: **Complete**

## Scope
Audited the main thermal-printer renderers, IPP printing path, Windows RAW print job name, frontend receipt branding, and existing printer regression assertions.

## Changes completed
- Receipt footer branding changed to:
  `Powered by Lyra (Lyradesgin.ir)`
- Frontend receipt branding constant and URL updated to Lyra.
- Linux/CUPS IPP requesting-user identity changed from `flocafe` to `lyrapos`.
- IPP print job name changed from `FloCafe receipt` to `LyraPOS receipt`.
- Windows RAW print job name changed from `FloCafe Receipt` to `LyraPOS Receipt`.
- Existing printer tests that asserted the old footer were updated to assert the Lyra footer.

## Compatibility preserved
Printer template/protocol identifiers such as `flocafe-thermal-receipt-template` and the legacy payload property `includePoweredByFloPOS` were **not renamed**. They are machine-readable plugin/template contracts; changing them would be a compatibility break rather than a branding cleanup.

## Result
No print layout, ESC/POS encoding, thermal capability logic, currency handling, or printer transport behavior was intentionally changed. Only product-visible printer identity was updated, with compatibility identifiers retained.
