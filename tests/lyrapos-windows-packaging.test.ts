import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const build = pkg.build;

assert.equal(pkg.name, 'lyrapos-desktop');
assert.equal(lock.name, 'lyrapos-desktop');
assert.equal(lock.packages[''].name, 'lyrapos-desktop');
assert.equal(build.appId, 'ir.lyradesgin.lyrapos');
assert.equal(build.productName, 'LyraPOS');
assert.ok(Array.isArray(build.win.target));
assert.ok(build.win.target.some((t: any) => t.target === 'nsis'));
assert.ok(build.win.target.some((t: any) => t.target === 'appx'));
assert.equal(build.win.artifactName, 'lyrapos-' + '${version}' + '-win-' + '${arch}' + '.' + '${ext}');
assert.equal(build.nsis.createDesktopShortcut, true);
assert.equal(build.nsis.createStartMenuShortcut, true);
assert.equal(build.appx.applicationId, 'LyraPOS');
assert.equal(build.appx.identityName, 'CodifyAppsPrivateLimited.LyraPOS');
assert.equal(build.appx.displayName, 'LyraPOS');
assert.equal(build.publish.provider, 'github');
assert.equal(build.publish.owner, 'AliasgharFahmidekar');
assert.equal(build.publish.repo, 'LyraPOS');

const oldNames = ['FloCafe', 'FloPOS', 'flo-desktop', 'flocafe-'];
const serialized = JSON.stringify({build, scripts: pkg.scripts});
for (const oldName of oldNames) assert.equal(serialized.includes(oldName), false, 'Legacy Windows release identity: ' + oldName);

console.log('LyraPOS Windows packaging identity guard passed.');