const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const meta = fs.readFileSync(path.join(root, 'assets/ir.lyradesgin.lyrapos.metainfo.xml'), 'utf8');
const updater = fs.readFileSync(path.join(root, 'scripts/update-metainfo.js'), 'utf8');
const mas = fs.readFileSync(path.join(root, 'build/entitlements.mas.plist'), 'utf8');

assert.equal(pkg.build.productName, 'LyraPOS');
assert.equal(pkg.build.appId, 'ir.lyradesgin.lyrapos');
assert.equal(pkg.build.mac.artifactName, 'lyrapos-${version}-mac-${arch}.${ext}');
assert.deepEqual(pkg.build.mac.target.flatMap((t) => t.arch), ['x64', 'arm64', 'x64', 'arm64']);
assert.equal(pkg.build.linux.executableName, 'lyrapos');
assert.equal(pkg.build.linux.artifactName, 'lyrapos-${version}-linux.${ext}');
assert.equal(pkg.build.appImage.artifactName, 'lyrapos-${version}-linux.appimage');
assert.equal(pkg.build.linux.desktop.entry.Name, 'LyraPOS');
assert.equal(pkg.build.linux.desktop.entry.StartupWMClass, 'lyrapos-desktop');
assert.equal(pkg.build.linux.extraFiles[0].from, 'assets/ir.lyradesgin.lyrapos.metainfo.xml');
assert.equal(pkg.build.linux.extraFiles[0].to, 'usr/share/metainfo/ir.lyradesgin.lyrapos.metainfo.xml');

assert.match(meta, /<id>ir\.lyradesgin\.lyrapos<\/id>/);
assert.match(meta, /<name>LyraPOS<\/name>/);
assert.match(meta, /github\.com\/AliasgharFahmidekar\/LyraPOS/);
assert.doesNotMatch(meta, /FloCafe|Flo Cafe|FloPOS|LyraDesgin\/FloCafe|com\.flo\.desktop/);

assert.match(updater, /assets\/ir\.lyradesgin\.lyrapos\.metainfo\.xml/);
assert.match(updater, /LyraPOS \$\{version\}/);
assert.doesNotMatch(updater, /com\.flo\.desktop\.metainfo\.xml|Flo Cafe \$\{version\}/);

assert.match(mas, /BKDY677XJA\.com\.flo\.desktop/);
console.log('✅ Linux/macOS packaging identity checks passed');
