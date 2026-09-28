import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import YAML from 'js-yaml';

const root = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const pkg = JSON.parse(read('package.json'));

function workflow(p: string): any {
  const parsed = YAML.load(read(p)) as any;
  assert.ok(parsed && parsed.jobs, `${p} must contain GitHub Actions jobs`);
  return parsed;
}

assert.equal(pkg.name, 'lyrapos-desktop');
assert.equal(pkg.build.productName, 'LyraPOS');
assert.equal(pkg.build.appId, 'ir.lyradesgin.lyrapos');
assert.equal(pkg.build.publish.provider, 'github');
assert.equal(pkg.build.publish.owner, 'AliasgharFahmidekar');
assert.equal(pkg.build.publish.repo, 'LyraPOS');

assert.equal(pkg.scripts['release:win'].endsWith('--publish never'), true);
assert.equal(pkg.scripts['release:linux'].endsWith('--publish never'), true);
assert.equal(pkg.scripts['release:mac'].endsWith('--publish never'), true);
assert.equal(pkg.scripts['verify:release-artifacts'], 'node scripts/assert-release-artifact-names.cjs');

const win = workflow('.github/workflows/lyrapos-windows.yml');
assert.ok(win.on.workflow_dispatch, 'Windows packaging must support manual dispatch');
assert.deepEqual(win.on.push.tags, ['v*']);
assert.equal(win.jobs['build-windows'].runs-on, 'windows-latest');

const winSteps = new Set(win.jobs['build-windows'].steps.map((s: any) => s.name));
for (const name of ['Install dependencies','Build Windows installer','Verify release artifact names','Run Windows packaging identity guard','Upload Windows artifacts']) {
  assert.ok(winSteps.has(name), `Windows workflow missing: ${name}`);
}

const unix = workflow('.github/workflows/lyrapos-unix.yml');
assert.ok(unix.on.workflow_dispatch, 'Unix packaging must support manual dispatch');
for (const jobName of ['validate-unix-identity','build-linux','build-macos']) {
  assert.ok(unix.jobs[jobName], `Unix workflow missing job: ${jobName}`);
}
assert.equal(unix.jobs['build-linux'].runs-on, 'ubuntu-latest');
assert.equal(unix.jobs['build-macos'].runs-on, 'macos-latest');

console.log('LyraPOS release configuration and workflow integrity checks passed.');
