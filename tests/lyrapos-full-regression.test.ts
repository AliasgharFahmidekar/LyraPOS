import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));

assert.equal(pkg.name, 'lyrapos-desktop');
assert.equal(lock.name, 'lyrapos-desktop');
assert.equal(lock.packages[''].name, 'lyrapos-desktop');
assert.equal(pkg.build.productName, 'LyraPOS');
assert.equal(pkg.build.appId, 'ir.lyradesgin.lyrapos');
assert.equal(pkg.build.publish.owner, 'AliasgharFahmidekar');
assert.equal(pkg.build.publish.repo, 'LyraPOS');

const requiredTests = [
  'test:identity',
  'test:ui-identity',
  'test:wordpress-bridge',
  'test:localization-identity',
  'test:windows-packaging-identity',
  'test:unix-packaging-identity',
  'test:updater-identity',
  'test:full-regression',
];
for (const name of requiredTests) {
  assert.equal(typeof pkg.scripts[name], 'string', `missing regression script: ${name}`);
}
assert.match(pkg.scripts.test, /test:identity/);
assert.match(pkg.scripts.test, /test:wordpress-bridge/);
assert.match(pkg.scripts.test, /test:localization-identity/);
assert.match(pkg.scripts.test, /test:full-regression/);

const bridge = read('main/services/wordpress-bridge.ts');
const bridgeRoute = read('main/routes/wordpress-bridge.ts');
for (const token of ['/wp-json/flocafe/v1','x-flocafe-bridge-key','x-cafeflo-bridge-id','flocafe_product_id','flocafe_order_id','flocafe_category_id']) {
  assert.ok(bridge.includes(token), `WordPress integration contract missing: ${token}`);
}
for (const route of ["router.get('/status'","router.put('/config'","router.post('/test'","router.post('/sync'","router.post('/disconnect'"]) {
  assert.ok(bridgeRoute.includes(route), `WordPress Bridge route missing: ${route}`);
}

const printerFiles = [
  'main/printers/document-classic.ts',
  'main/printers/formatting-helpers.ts',
  'frontend/src/lib/printer/branding.ts',
];
for (const file of printerFiles) {
  assert.ok(fs.existsSync(path.join(root,file)), `printer file missing: ${file}`);
}
assert.ok(printerFiles.some((file) => /Powered by Lyra \(Lyradesgin\.ir\)/.test(read(file))), 'Lyra receipt branding must remain present');

const localesDir = path.join(root, 'frontend/src/lib/i18n/messages');
const locales = fs.readdirSync(localesDir).filter(f => f.endsWith('.json')).map(f => f.slice(0,-5)).sort();
assert.equal(locales.length, 21, 'the supported locale set must remain 21 languages');
for (const locale of locales) {
  const content = read(`frontend/src/lib/i18n/messages/${locale}.json`);
  assert.doesNotMatch(content, /Flo Cafe|FloPOS|FloCafe|Powered by Flo|via Flo/, `legacy visible branding remains in ${locale}`);
}

const legacyVisibleFiles = [
  'frontend/src/app/layout.tsx',
  'frontend/src/components/layout/TitleBar.tsx',
  'frontend/src/components/layout/DirectionalToaster.tsx',
  'frontend/public/manifest.json',
];
for (const file of legacyVisibleFiles) {
  const content = read(file);
  assert.doesNotMatch(content, /Flo Cafe|FloPOS|FloCafe/, `legacy visible branding remains in ${file}`);
}

const contracts = [
  'flocafe-thermal-receipt-template',
  'includePoweredByFloPOS',
  '/wp-json/flocafe/v1',
  'x-flocafe-bridge-key',
  'flocafe_product_id',
];
const source = [
  read('main/services/wordpress-bridge.ts'),
  read('main/routes/wordpress-bridge.ts'),
  read('main/printers/document-classic.ts'),
  read('main/printers/formatting-helpers.ts'),
].join('\n');
for (const contract of contracts) assert.ok(source.includes(contract), `compatibility contract disappeared: ${contract}`);

assert.doesNotMatch(JSON.stringify(pkg.build), /flocafe-|flo-desktop|FloCafe|FloPOS/);

console.log('LyraPOS full regression guard passed: identity, test chain, Bridge contracts, printing, locales, and visible branding.');
