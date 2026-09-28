import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

assert.equal(pkg.name, 'lyrapos-desktop');
assert.equal(pkg.build.appId, 'ir.lyradesgin.lyrapos');
assert.equal(pkg.build.productName, 'LyraPOS');
assert.deepEqual(pkg.build.publish, {
  provider: 'github',
  owner: 'AliasgharFahmidekar',
  repo: 'LyraPOS',
  releaseType: 'release',
  channel: 'latest',
});
assert.match(pkg.build.win.artifactName, /^lyrapos-/);
assert.equal(pkg.build.appx.applicationId, 'LyraPOS');
assert.equal(pkg.build.appx.identityName, 'CodifyAppsPrivateLimited.LyraPOS');
assert.equal(pkg.build.appx.displayName, 'LyraPOS');
assert.equal(pkg.build.linux.executableName, 'lyrapos');
assert.equal(pkg.build.linux.desktop.entry.StartupWMClass, 'lyrapos-desktop');
assert.match(pkg.build.mac.artifactName, /^lyrapos-/);
assert.equal(pkg.build.appImage.artifactName, 'lyrapos-${version}-linux.appimage');
assert.equal(pkg.build.linux.extraFiles[0].from, 'assets/ir.lyradesgin.lyrapos.metainfo.xml');

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'frontend', 'public', 'manifest.json'), 'utf8'));
assert.equal(manifest.name, 'LyraPOS');
assert.equal(manifest.short_name, 'LyraPOS');

const meta = fs.readFileSync(path.join(root, 'assets', 'ir.lyradesgin.lyrapos.metainfo.xml'), 'utf8');
assert.match(meta, /<id>ir\.lyradesgin\.lyrapos<\/id>/);
assert.match(meta, /<name>LyraPOS<\/name>/);

console.log('LyraPOS application identity configuration is consistent.');
