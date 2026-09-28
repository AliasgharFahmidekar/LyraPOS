import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const YAML = require('js-yaml') as { load: (text: string) => unknown };
const releaseVerifier = require('../scripts/verify-release-assets.cjs') as {
  assertReleaseAssetInventory: (assets: any[], manifests: string[], version: string, options?: any) => void;
  assertManifestPlatformMapping: (name: string, version: string, files: any[], selectedPath: string | null) => void;
  expectedArtifactNames: (version: string) => string[];
  expectedManifestNames: (channel: 'latest' | 'beta') => string[];
  parseManifest: (text: string, name: string) => { version: string; path: string | null; files: Array<{url: string; sha512: string}> };
};

const root = path.resolve(__dirname, '..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

function loadWorkflow(relativePath: string): any {
  const file = path.join(root, relativePath);
  assert.ok(fs.existsSync(file), relativePath + ' must exist');
  const parsed = YAML.load(fs.readFileSync(file, 'utf8')) as any;
  assert.ok(parsed && typeof parsed === 'object' && parsed.jobs, relativePath + ' must parse as a workflow');
  return parsed;
}

function fakeSha512(): string {
  return crypto.createHash('sha512').update('lyrapos-stage10-fixture').digest('base64');
}

function testPackageReleaseIdentity() {
  const pkg = JSON.parse(read('package.json'));
  const build = pkg.build;

  assert.equal(pkg.name, 'lyrapos-desktop');
  assert.equal(pkg.engines.node, '>=22.13.0');
  assert.equal(build.productName, 'LyraPOS');
  assert.equal(build.appId, 'ir.lyradesgin.lyrapos');

  assert.deepEqual(build.publish, {
    provider: 'github',
    owner: 'AliasgharFahmidekar',
    repo: 'LyraPOS',
    releaseType: 'release',
    channel: 'latest',
  });
  assert.equal(build.detectUpdateChannel, false);
  assert.equal(build.generateUpdatesFilesForAllChannels, true);

  assert.equal(build.win.artifactName, 'lyrapos-${version}-win-${arch}.${ext}');
  assert.equal(build.mac.artifactName, 'lyrapos-${version}-mac-${arch}.${ext}');
  assert.equal(build.linux.artifactName, 'lyrapos-${version}-linux.${ext}');
  assert.equal(build.appImage.artifactName, 'lyrapos-${version}-linux.appimage');
  assert.equal(build.appx.applicationId, 'LyraPOS');
  assert.equal(build.appx.identityName, 'CodifyAppsPrivateLimited.LyraPOS');
  assert.equal(build.appx.displayName, 'LyraPOS');
  assert.equal(build.linux.executableName, 'lyrapos');
  assert.equal(build.linux.desktop.entry.StartupWMClass, 'lyrapos-desktop');
  assert.equal(build.linux.extraFiles[0].from, 'assets/ir.lyradesgin.lyrapos.metainfo.xml');
}

function testCurrentWorkflows() {
  const regression = loadWorkflow('.github/workflows/lyrapos-regression.yml');
  assert.deepEqual(regression.on || regression.true, {
    push: { branches: ['main'] },
    pull_request: { branches: ['main'] },
    workflow_dispatch: null,
  });
  assert.equal(regression.jobs.test['runs-on'], 'ubuntu-latest');
  assert.equal(regression.jobs.test.steps[1].with['node-version'], '22.13.0');
  assert.equal(regression.jobs.test.steps.at(-1).run, 'npm test');

  const windows = loadWorkflow('.github/workflows/lyrapos-windows.yml');
  assert.equal(windows.jobs['build-windows'].name, 'Build LyraPOS Windows');
  const winSteps = windows.jobs['build-windows'].steps;
  assert.equal(winSteps.find((s: any) => s.name === 'Build Windows installer').run, 'npm run release:win');
  assert.equal(winSteps.find((s: any) => s.name === 'Verify release artifact names').run, 'npm run verify:release-artifacts');
  assert.equal(winSteps.find((s: any) => s.name === 'Run Windows packaging identity guard').run, 'npm run test:windows-packaging-identity');
  const winUpload = winSteps.find((s: any) => s.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(winUpload.with.name, 'lyrapos-windows');
  assert.match(winUpload.with.path, /release\/lyrapos-\*\.exe/);

  const unix = loadWorkflow('.github/workflows/lyrapos-unix.yml');
  assert.ok(unix.jobs['validate-unix-identity']);
  assert.ok(unix.jobs['build-linux']);
  assert.ok(unix.jobs['build-macos']);
  assert.equal(unix.jobs['build-linux'].steps.find((s: any) => s.name === 'Build Linux packages').run, 'npm run release:linux');
  assert.equal(unix.jobs['build-macos'].steps.find((s: any) => s.name === 'Verify artifact names').run, 'npm run verify:release-artifacts');
  for (const jobName of ['build-linux', 'build-macos']) {
    const upload = unix.jobs[jobName].steps.find((s: any) => s.uses?.startsWith('actions/upload-artifact@'));
    assert.equal(upload.with.name, jobName === 'build-linux' ? 'lyrapos-linux' : 'lyrapos-macos');
    assert.match(upload.with.path, /release\/lyrapos-/);
  }

  const workflowFiles = fs.readdirSync(path.join(root, '.github/workflows'));
  for (const stale of ['release.yml', 'publish-mas.yml', 'nightly-release.yml', 'ci.yml']) {
    assert.equal(workflowFiles.includes(stale), false, 'Stage 10 test must not depend on removed workflow ' + stale);
  }
}

function testReleaseScripts() {
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.scripts['release:win'], /--publish never$/);
  assert.match(pkg.scripts['release:mac'], /--publish never$/);
  assert.match(pkg.scripts['release:linux'], /--publish never$/);

  const artifactVerifier = read('scripts/assert-release-artifact-names.cjs');
  assert.match(artifactVerifier, /\^\[a-z0-9.-\]\+\$/);
  assert.match(artifactVerifier, /release artifact filenames passed/);

  const metaUpdater = read('scripts/update-metainfo.js');
  assert.match(metaUpdater, /assets\/ir\.lyradesgin\.lyrapos\.metainfo\.xml/);
  assert.match(metaUpdater, /LyraPOS \$\{version\}/);
  assert.match(metaUpdater, /\.replace\(\/\&\/g, '\&amp;'\)/);

  const meta = read('assets/ir.lyradesgin.lyrapos.metainfo.xml');
  assert.match(meta, /<id>ir\.lyradesgin\.lyrapos<\/id>/);
  assert.match(meta, /<name>LyraPOS<\/name>/);
  assert.doesNotMatch(meta, /<id>com\.flo\.desktop<\/id>/);
  assert.doesNotMatch(meta, /<name>FloCafe<\/name>/);
}

function testManifestContracts() {
  const version = '3.11.0';
  const expectedArtifacts = releaseVerifier.expectedArtifactNames(version);
  const expectedLatest = releaseVerifier.expectedManifestNames('latest');
  const expectedBeta = releaseVerifier.expectedManifestNames('beta');

  assert.ok(expectedArtifacts.every((name: string) => name.startsWith('lyrapos-')));
  assert.deepEqual(expectedLatest, ['latest.yml', 'latest-mac.yml', 'latest-linux.yml', 'latest-linux-arm64.yml']);
  assert.deepEqual(expectedBeta, ['beta.yml', 'beta-mac.yml', 'beta-linux.yml', 'beta-linux-arm64.yml']);

  const sha = fakeSha512();
  const windows = `version: "${version}"
files:
  - url: "lyrapos-${version}-win-x64.exe"
    sha512: "${sha}"
path: "lyrapos-${version}-win-x64.exe"
sha512: "${sha}"
`;
  const parsed = releaseVerifier.parseManifest(windows, 'latest.yml');
  assert.equal(parsed.version, version);
  assert.equal(parsed.path, `lyrapos-${version}-win-x64.exe`);
  assert.equal(parsed.files.length, 1);
  releaseVerifier.assertManifestPlatformMapping('latest.yml', version, parsed.files, parsed.path);

  const assets = [
    ...expectedLatest,
    ...releaseVerifier.expectedArtifactNames(version),
    ...['candidate-manifest.json', 'release-summary.json'],
  ].map((name: string) => ({ name, size: 1 }));
  releaseVerifier.assertReleaseAssetInventory(assets, expectedLatest, version);

  assert.throws(
    () => releaseVerifier.assertReleaseAssetInventory(
      [...assets, { name: 'flo-cafe.exe', size: 1 }],
      expectedLatest,
      version,
    ),
    /unexpected assets/
  );

  assert.throws(
    () => releaseVerifier.assertManifestPlatformMapping(
      'latest.yml',
      version,
      [{ url: `lyrapos-${version}-mac-x64.dmg`, sha512: sha }],
      `lyrapos-${version}-mac-x64.dmg`,
    ),
    /another platform or architecture/
  );

  const syntacticallyValidManifest = releaseVerifier.parseManifest(
    `version: "${version}"\nfiles:\n  - url: "bad path.exe"\n    sha512: "${sha}"\n`,
    'latest.yml',
  );
  assert.equal(syntacticallyValidManifest.files[0].url, 'bad path.exe');
}

function testNoLegacyProductIdentityInReleaseSurface() {
  const pkg = JSON.parse(read('package.json'));
  const serialized = JSON.stringify({
    name: pkg.name,
    build: pkg.build,
    releaseScripts: {
      win: pkg.scripts['release:win'],
      mac: pkg.scripts['release:mac'],
      linux: pkg.scripts['release:linux'],
    },
  });
  for (const legacy of ['FloCafe', 'FloPOS', 'flo-desktop']) {
    assert.equal(serialized.includes(legacy), false, 'legacy release identity remains: ' + legacy);
  }
}

console.log('Testing current LyraPOS release configuration + Stage 10 contracts...');
testPackageReleaseIdentity();
testCurrentWorkflows();
testReleaseScripts();
testManifestContracts();
testNoLegacyProductIdentityInReleaseSurface();
console.log('✅ Current LyraPOS release configuration + Stage 10 regression checks passed');
