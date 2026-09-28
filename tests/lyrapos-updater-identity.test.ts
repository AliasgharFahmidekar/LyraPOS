import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const updater = fs.readFileSync(path.join(root, 'main/index.ts'), 'utf8');
const channel = fs.readFileSync(path.join(root, 'main/update-channel.ts'), 'utf8');
const verifier = fs.readFileSync(path.join(root, 'scripts/verify-release-assets.cjs'), 'utf8');
const marker = fs.readFileSync(path.join(root, 'scripts/mark-unpacked-artifact.cjs'), 'utf8');

assert.equal(pkg.build.publish.provider, 'github');
assert.equal(pkg.build.publish.owner, 'AliasgharFahmidekar');
assert.equal(pkg.build.publish.repo, 'LyraPOS');
assert.equal(pkg.build.publish.channel, 'latest');
assert.equal(pkg.build.detectUpdateChannel, false);
assert.equal(pkg.build.generateUpdatesFilesForAllChannels, true);

assert.match(updater, /import \{ autoUpdater \} from 'electron-updater'/);
assert.match(updater, /autoUpdater\.channel = resolved\.channel/);
assert.match(updater, /autoUpdater\.allowPrerelease = resolved\.allowPrerelease/);
assert.match(updater, /UNPACKED_DEV_MARKER = 'lyrapos-unpacked-dev\.marker'/);
assert.doesNotMatch(updater, /flo-unpacked-dev\.marker/);

assert.match(channel, /BETA_CHANNEL_SETTING_KEY = 'updates\.beta_channel_enabled'/);
assert.match(channel, /channel: 'beta'/);
assert.doesNotMatch(channel, /FloCafe/);

assert.match(verifier, /lyrapos-\$\{version\}/);
assert.doesNotMatch(verifier, /flocafe-\$\{version\}/);
assert.match(marker, /lyrapos-unpacked-dev\.marker/);
assert.doesNotMatch(marker, /flo-unpacked-dev\.marker/);

console.log('✅ LyraPOS updater and release-channel identity checks passed');
