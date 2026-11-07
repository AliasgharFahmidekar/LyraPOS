# LyraPOS Local API Diagnostics

LyraPOS records local API failures independently of the regular Electron application log.

## Files

The diagnostic logger writes JSON Lines directly to:

`%APPDATA%\LyraPOS\logs\api-errors.log`

The active file is rotated at 2 MiB, retaining `.1` and `.2` backups. It records failed API responses, HTTP status, duration, route template, request trace ID, and route-level exception details. Request bodies and payment/customer payloads are intentionally excluded.

For an authenticated owner or manager, the newest bounded log segment can also be exported from:

`GET http://127.0.0.1:3001/api/diagnostics/local-error-log`

The API adds an `X-Lyra-Request-Id` response header. Unexpected 500 responses include the same value as `request_id` in the JSON response so UI reports can be correlated with the local log.

## Existing installations / support collection

Older installed versions do not contain the new API logger. To collect a safe snapshot without updating the app, run the Windows collector:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\collect-lyrapos-diagnostics.ps1
```

The script writes a ZIP report to the current user's Desktop. It checks the local health endpoint, the process listening on port 3001, application/log/database file sizes and modification times, free disk space, and bounded tails of existing log files. It does not copy, open, repair, or modify SQLite database files.

Review the ZIP before sharing it. The script redacts common token and password patterns, but log excerpts should still be treated as potentially sensitive.
