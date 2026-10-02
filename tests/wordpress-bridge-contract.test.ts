import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const route = read('main/routes/wordpress-bridge.ts');
const service = read('main/services/wordpress-bridge.ts');
const settings = read('frontend/src/components/settings/WordPressBridgeSettings.tsx');

for (const endpoint of [
  "router.get('/status'",
  "router.put('/config'",
  "router.post('/test'",
  "router.post('/sync'",
  "router.post('/disconnect'",
]) assert(route.includes(endpoint), `missing WordPress Bridge endpoint: ${endpoint}`);

for (const method of [
  'getStatus()',
  'configure(',
  'testConnection(',
  'syncNow(',
  'disconnect(',
  'syncCatalog(',
  'pollOrders(',
  'pollOrderStatuses(',
  'sendHeartbeat(',
]) assert(service.includes(method), `missing WordPress Bridge service capability: ${method}`);

for (const contract of [
  '/wp-json/flocafe/v1',
  'x-flocafe-bridge-key',
  'x-cafeflo-bridge-id',
  'flocafe_product_id',
  'flocafe_order_id',
  'flocafe_category_id',
]) assert(service.includes(contract), `WordPress Bridge integration contract was unexpectedly renamed or removed: ${contract}`);

for (const uiContract of [
  '/wordpress-bridge/status',
  '/wordpress-bridge/config',
  '/wordpress-bridge/test',
  '/wordpress-bridge/sync',
  '/wordpress-bridge/disconnect',
]) assert(settings.includes(uiContract), `WordPress Bridge UI lost API call: ${uiContract}`);

console.log('WordPress Bridge contract regression checks passed.');

const incrementalContract = [
  'buildIncrementalCatalogPayload',
  'integration_catalog_changes',
  "action === 'deleted'",
  'full_snapshot: false',
  'syncCatalog(signal?: AbortSignal, options: { forceFull?: boolean }',
  'syncCatalog(signal, { forceFull: true })',
  'firstRevision > afterRevision + 1',
  'currentRevision < afterRevision',
];
for (const contract of incrementalContract) {
  assert(service.includes(contract), `WordPress Bridge lost incremental catalog sync contract: ${contract}`);
}
