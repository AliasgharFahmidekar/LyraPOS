# LyraPOS Stage 3 — WordPress Bridge Audit

Status: **Complete**

## Scope
Audited the LyraPOS WordPress Bridge runtime, HTTP routes, settings UI, persistence-facing service logic, and integration identifiers.

## Verified capabilities
- Connection configuration and enable/disable state.
- Secure API-key storage through Electron secure storage.
- Connection health test.
- Catalog snapshot synchronization with revision tracking.
- Product and category mapping persistence.
- Automatic catalog-change wake-up.
- WordPress pending-order polling, claiming, idempotency handling, local order creation, acknowledgement and failure reporting.
- Local order-status reconciliation back to WordPress.
- Heartbeat/store-state reporting.
- Manual full synchronization.
- Disconnect and pending-queue cleanup.
- Role protection on all Bridge management endpoints.

## API surface verified
- `GET /wordpress-bridge/status`
- `PUT /wordpress-bridge/config`
- `POST /wordpress-bridge/test`
- `POST /wordpress-bridge/sync`
- `POST /wordpress-bridge/disconnect`

## Important compatibility decision
The WordPress Bridge contains integration-contract identifiers such as `/wp-json/flocafe/v1`, `x-flocafe-bridge-key`, `flocafe_product_id`, `flocafe_order_id`, and related database fields. These were intentionally **not renamed**. They are protocol/storage identifiers, not product branding, and changing them would risk breaking compatibility with the existing WordPress plugin.

User-facing desktop messages that incorrectly exposed the old product name were changed to **LyraPOS**.

## Regression guard
Added `tests/wordpress-bridge-contract.test.ts` and wired it into the main test command as `test:wordpress-bridge`. It guards the Bridge route/service/UI contract and explicitly protects the legacy integration identifiers from accidental rename.

## Result
No WordPress Bridge feature was removed or redesigned as part of the rename. The Bridge remains the same integration contract while the desktop product identity is LyraPOS.
