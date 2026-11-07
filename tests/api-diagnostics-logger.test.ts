/**
 * Local API diagnostics logger tests.
 * Usage: node tests/run-electron-node-test.cjs tests/api-diagnostics-logger.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-api-diagnostics-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { getPath: () => testDir } };
  }
  return originalLoad.apply(this, arguments as any);
};

const {
  apiDiagnosticsMiddleware,
  getApiDiagnosticLogPath,
  readApiDiagnosticLog,
  recordApiDiagnosticError,
} = require('../main/services/api-diagnostics');

async function main() {
  try {
    console.log('Local API Diagnostics Logger Tests');
    console.log('='.repeat(48));

    const request: any = {
      path: '/api/orders',
      method: 'POST',
      baseUrl: '/api/orders',
      route: { path: '/' },
    };
    const listeners: Record<string, () => void> = {};
    const response: any = {
      locals: {},
      statusCode: 500,
      setHeader: (name: string, value: string) => { response.headers[name] = value; },
      headers: {} as Record<string, string>,
      once: (event: string, listener: () => void) => { listeners[event] = listener; },
    };

    let nextCalled = false;
    apiDiagnosticsMiddleware(request, response, () => { nextCalled = true; });
    assert.equal(nextCalled, true, 'middleware continues request processing');
    assert.match(response.headers['X-Lyra-Request-Id'], /^[0-9a-f-]{36}$/i, 'API request receives a UUID trace header');
    assert.equal(response.locals.apiRequestId, response.headers['X-Lyra-Request-Id'], 'trace ID is exposed to route handlers');

    listeners.finish();
    let records = readApiDiagnosticLog().trim().split('\n').map((line: string) => JSON.parse(line));
    assert.equal(records.length, 1, 'failed API response is persisted');
    assert.equal(records[0].event, 'api.request_failed', 'generic request failure event is written');
    assert.equal(records[0].status, 500, 'HTTP status is preserved');
    assert.equal(records[0].request_id, response.locals.apiRequestId, 'request can be correlated by trace ID');
    assert.equal(records[0].route, '/api/orders/', 'route template is recorded without request payload');

    const error = Object.assign(new Error('SQLite locked; Bearer private-token'), { code: 'SQLITE_BUSY', errno: 5 });
    recordApiDiagnosticError(request, response, 'orders.create.transaction', error, { item_count: 2 });
    records = readApiDiagnosticLog().trim().split('\n').map((line: string) => JSON.parse(line));
    const detailed = records[1];
    assert.equal(detailed.event, 'api.exception', 'route-level exception is written');
    assert.equal(detailed.stage, 'orders.create.transaction', 'failure stage is recorded');
    assert.equal(detailed.error.code, 'SQLITE_BUSY', 'SQLite error code is preserved');
    assert.match(detailed.error.message, /Bearer \[REDACTED\]/, 'bearer token-like text is redacted');
    assert.equal(detailed.metadata.item_count, 2, 'safe numeric metadata is retained');
    assert.equal(detailed.request_id, response.locals.apiRequestId, 'route exception shares the request trace ID');
    assert.match(getApiDiagnosticLogPath(), /logs[\\/]api-errors\.log$/, 'log is stored under the app user-data logs directory');
    assert.equal(fs.existsSync(getApiDiagnosticLogPath()), true, 'diagnostic file exists on disk');

    console.log('PASS: failed API requests and route exceptions are persisted with trace IDs.');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* cleanup best effort */ }
    Module._load = originalLoad;
  }
}

void main();
