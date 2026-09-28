import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Import kill-ports functions
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isFloProcess, FLO_PATTERNS } = require('../kill-ports.js');
const YAML = require('js-yaml') as { load: (text: string) => unknown };

const rootDir = path.resolve(__dirname, '..');
const resetScript = path.join(rootDir, 'scripts/dev/nuclear-reset.sh');
const i18nAddScript = path.join(rootDir, 'scripts/i18n-add.cjs');

function mkdirp(target: string) {
  fs.mkdirSync(target, { recursive: true });
}

function runReset(platform: string, env: NodeJS.ProcessEnv) {
  return spawnSync('bash', [resetScript, '--electron-cache-only'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      FORCE: '',
      CI: '',
      FLO_RESET_PLATFORM: platform,
      ...env,
    },
  });
}

function runTest() {
  console.log('Testing i18n:add scaffolding validation...');
  const existingLanguage = spawnSync(process.execPath, [i18nAddScript, 'en'], {
    encoding: 'utf8',
    cwd: rootDir,
  });
  assert.strictEqual(existingLanguage.status, 1, 'i18n:add must refuse to overwrite an existing language file');
  assert.match(
    existingLanguage.stderr,
    /Refusing to overwrite existing messages file/,
    'i18n:add must explain why an existing language file was not overwritten',
  );

  const regionalLanguage = spawnSync(process.execPath, [i18nAddScript, 'zh-tw'], {
    encoding: 'utf8',
    cwd: rootDir,
  });
  assert.strictEqual(regionalLanguage.status, 1, 'i18n:add must accept a regional key before refusing an existing file');
  assert.doesNotMatch(regionalLanguage.stderr, /Invalid language code/, 'i18n:add must accept a canonical lowercase regional key');

  const invalidLanguage = spawnSync(process.execPath, [i18nAddScript, 'EN'], {
    encoding: 'utf8',
    cwd: rootDir,
  });
  assert.strictEqual(invalidLanguage.status, 1, 'i18n:add must reject non-canonical language codes');
  assert.match(invalidLanguage.stderr, /Invalid language code/);

  const extensionLanguage = spawnSync(process.execPath, [i18nAddScript, 'en-u-nu-latn'], {
    encoding: 'utf8',
    cwd: rootDir,
  });
  assert.strictEqual(extensionLanguage.status, 1, 'i18n:add must reject Unicode-extension locale keys');
  assert.match(extensionLanguage.stderr, /Invalid language code/);
  console.log('✓ i18n:add validation, regional keys, and no-overwrite guard verified');

  console.log('Testing kill-ports.js process identity matching...');

  // Positive cases (should match as Flo processes)
  const positiveCases = [
    'node /Users/dev/FloCafe/dist/index.js',
    'node /Users/dev/FloCafe/dist/main/index.js',
    'node C:\\FloCafe\\dist\\main\\index.js',
    '/Applications/Flo Cafe.app/Contents/MacOS/Flo Cafe',
    '/usr/bin/flocafe --no-sandbox',
    'electron . --appName=flo-desktop',
    'node /path/to/FloCafe/dev-server.js',
    'node /path/to/FloCafe/dist/index.js',
    'com.flo.desktop.helper',
    'flo-pos-service',
  ];

  for (const cmd of positiveCases) {
    assert.strictEqual(
      isFloProcess(cmd),
      true,
      `Expected "${cmd}" to match Flo process patterns`,
    );
  }

  // Negative cases (should NOT match as Flo processes)
  const negativeCases = [
    'node /Users/dev/other-project/index.js',
    'node /Users/other-project/dist/index.js',
    'node /Users/other-project/dev-server.js',
    'node /home/user/app/dev-server.js',
    'node /Users/dev/FloCafe/other-server.js',
    'node /Users/dev/FloCafe-tools/dev-server.js',
    'python3 -m http.server 3000',
    'nginx: master process',
    'postgres -D /data',
    'redis-server *:6379',
  ];

  for (const cmd of negativeCases) {
    assert.strictEqual(
      isFloProcess(cmd),
      false,
      `Expected "${cmd}" to NOT match Flo process patterns`,
    );
  }

  console.log('✓ kill-ports.js pattern matching verified');

  console.log('Testing scripts/dev/nuclear-reset.sh confirmation guard...');

  // Running the reset script in non-interactive mode without -y should fail.
  const nonInteractiveResult = spawnSync('bash', [resetScript], {
    encoding: 'utf8',
    env: { ...process.env, FORCE: '', CI: '' },
  });

  assert.strictEqual(
    nonInteractiveResult.status,
    1,
    'Expected non-interactive reset without -y flag to fail with exit code 1',
  );
  assert.match(
    nonInteractiveResult.stdout + nonInteractiveResult.stderr,
    /Non-interactive shell detected/i,
    'Expected output to warn about non-interactive shell',
  );

  console.log('✓ development reset non-interactive confirmation guard verified');

  console.log('Testing nuclear-reset.sh Electron cache paths...');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-reset-cache-test-'));
  try {
    const darwinHome = path.join(tmpDir, 'darwin-home');
    const darwinPaths = [
      path.join(darwinHome, 'Library/Application Support/flo-desktop/Cache'),
      path.join(darwinHome, 'Library/Application Support/flo-desktop/Code Cache'),
      path.join(darwinHome, 'Library/Caches/flo-desktop'),
    ];
    darwinPaths.forEach(mkdirp);
    const darwinResult = runReset('Darwin', { HOME: darwinHome });
    assert.strictEqual(darwinResult.status, 0, `Expected Darwin cache cleanup to pass: ${darwinResult.stderr}`);
    darwinPaths.forEach((cachePath) => {
      assert.strictEqual(fs.existsSync(cachePath), false, `Expected Darwin cache path to be removed: ${cachePath}`);
    });
    assert.match(darwinResult.stdout, /Cleared: Electron app cache/, 'Expected Darwin app cache removal message');
    assert.match(darwinResult.stdout, /Cleared: Electron code cache/, 'Expected Darwin code cache removal message');
    assert.match(darwinResult.stdout, /Cleared: Electron system cache/, 'Expected Darwin system cache removal message');

    const linuxHome = path.join(tmpDir, 'linux-home');
    const linuxConfigHome = path.join(tmpDir, 'linux-config');
    const linuxCacheHome = path.join(tmpDir, 'linux-cache');
    const linuxPaths = [
      path.join(linuxConfigHome, 'flo-desktop/Cache'),
      path.join(linuxConfigHome, 'flo-desktop/Code Cache'),
      path.join(linuxCacheHome, 'flo-desktop'),
    ];
    linuxPaths.forEach(mkdirp);
    const linuxResult = runReset('Linux', {
      HOME: linuxHome,
      XDG_CONFIG_HOME: linuxConfigHome,
      XDG_CACHE_HOME: linuxCacheHome,
    });
    assert.strictEqual(linuxResult.status, 0, `Expected Linux cache cleanup to pass: ${linuxResult.stderr}`);
    linuxPaths.forEach((cachePath) => {
      assert.strictEqual(fs.existsSync(cachePath), false, `Expected Linux cache path to be removed: ${cachePath}`);
    });

    const windowsAppData = path.join(tmpDir, 'windows-appdata');
    const windowsLocalAppData = path.join(tmpDir, 'windows-localappdata');
    const windowsPaths = [
      path.join(windowsAppData, 'flo-desktop/Cache'),
      path.join(windowsAppData, 'flo-desktop/Code Cache'),
      path.join(windowsLocalAppData, 'flo-desktop'),
    ];
    windowsPaths.forEach(mkdirp);
    const windowsResult = runReset('Windows_NT', {
      APPDATA: windowsAppData,
      LOCALAPPDATA: windowsLocalAppData,
    });
    assert.strictEqual(windowsResult.status, 0, `Expected Windows cache cleanup to pass: ${windowsResult.stderr}`);
    windowsPaths.forEach((cachePath) => {
      assert.strictEqual(fs.existsSync(cachePath), false, `Expected Windows cache path to be removed: ${cachePath}`);
    });

    const missingWindowsResult = runReset('Windows_NT', {
      APPDATA: '',
      LOCALAPPDATA: '',
    });
    assert.strictEqual(missingWindowsResult.status, 0, 'Expected missing Windows cache roots to be reported without failing');
    assert.match(
      missingWindowsResult.stdout,
      /Skipped: Electron app\/code cache unavailable \(APPDATA is not set\)/,
      'Expected missing APPDATA diagnostic',
    );
    assert.match(
      missingWindowsResult.stdout,
      /Skipped: Electron system cache unavailable \(LOCALAPPDATA is not set\)/,
      'Expected missing LOCALAPPDATA diagnostic',
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('✓ nuclear reset Electron cache paths verified');

  console.log('Testing scripts/ci/run-test-shard.cjs parameter validation and sharding behavior...');

  const shardScript = path.join(rootDir, 'scripts/ci/run-test-shard.cjs');

  // Parameter validation checks
  const invalidCases = [
    { env: { SHARD_TOTAL: '0', SHARD_INDEX: '0' }, expectedErr: /Invalid SHARD_TOTAL=0: expected an integer >= 1/ },
    { env: { SHARD_TOTAL: '-2', SHARD_INDEX: '0' }, expectedErr: /Invalid SHARD_TOTAL=-2: expected an integer >= 1/ },
    { env: { SHARD_TOTAL: 'abc', SHARD_INDEX: '0' }, expectedErr: /Invalid SHARD_TOTAL=abc: expected an integer >= 1/ },
    { env: { SHARD_TOTAL: '2.5', SHARD_INDEX: '0' }, expectedErr: /Invalid SHARD_TOTAL=2.5: expected an integer >= 1/ },
    { env: { SHARD_TOTAL: '2', SHARD_INDEX: '-1' }, expectedErr: /Invalid SHARD_INDEX=-1: expected an integer >= 0/ },
    { env: { SHARD_TOTAL: '2', SHARD_INDEX: '2' }, expectedErr: /Invalid SHARD_INDEX=2: must be < SHARD_TOTAL=2/ },
    { env: { SHARD_TOTAL: '2', SHARD_INDEX: '5' }, expectedErr: /Invalid SHARD_INDEX=5: must be < SHARD_TOTAL=2/ },
  ];

  for (const tc of invalidCases) {
    const res = spawnSync('node', [shardScript], {
      encoding: 'utf8',
      cwd: rootDir,
      env: { ...process.env, ...tc.env },
    });
    assert.strictEqual(res.status, 2, `Expected exit status 2 for env ${JSON.stringify(tc.env)}`);
    assert.match(res.stderr, tc.expectedErr, `Expected stderr to match ${tc.expectedErr}`);
  }

  console.log('✓ run-test-shard.cjs parameter validation verified');

  // Execution and partition behavior using temporary fixture
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-shard-test-'));
  try {
    fs.mkdirSync(path.join(fixtureDir, 'scripts/ci'), { recursive: true });
    fs.mkdirSync(path.join(fixtureDir, 'tests'), { recursive: true });

    // Copy run-test-shard.cjs
    fs.copyFileSync(shardScript, path.join(fixtureDir, 'scripts/ci/run-test-shard.cjs'));

    // Create mock tests/run-test.sh
    const runTestSh = `#!/usr/bin/env bash
shift # skip 'npm'
shift # skip 'run'
suite="$1"
echo "RUNNING_MOCK_SUITE:$suite"
if [[ "$suite" == "test:failing-suite" ]]; then
  exit 1
fi
exit 0
`;
    fs.writeFileSync(path.join(fixtureDir, 'tests/run-test.sh'), runTestSh, { mode: 0o755 });

    // Create fixture package.json
    const fixturePkg = {
      name: 'fixture-app',
      scripts: {
        'test:suite-1': 'node -e ""',
        'test:suite-2': 'node -e ""',
        'test:suite-3': 'node -e ""',
        'test:suite-4': 'node -e ""',
        'test:suite-5': 'node -e ""',
        'test:failing-suite': 'node -e ""',
        test: 'bash tests/run-test.sh npm run test:suite-1 && bash tests/run-test.sh npm run test:suite-2 && bash tests/run-test.sh npm run test:suite-3 && bash tests/run-test.sh npm run test:suite-4 && bash tests/run-test.sh npm run test:suite-5',
        'test-with-fail': 'bash tests/run-test.sh npm run test:suite-1 && bash tests/run-test.sh npm run test:failing-suite && bash tests/run-test.sh npm run test:suite-3',
      },
    };
    fs.writeFileSync(path.join(fixtureDir, 'package.json'), JSON.stringify(fixturePkg, null, 2));

    // Test Shard 0 execution (suites 1, 3, 5)
    const shard0 = spawnSync('node', ['scripts/ci/run-test-shard.cjs'], {
      encoding: 'utf8',
      cwd: fixtureDir,
      env: { ...process.env, SHARD_TOTAL: '2', SHARD_INDEX: '0' },
    });
    assert.strictEqual(shard0.status, 0, `Expected shard 0 to pass: ${shard0.stderr}`);
    assert.match(shard0.stdout, /RUNNING_MOCK_SUITE:test:suite-1/);
    assert.match(shard0.stdout, /RUNNING_MOCK_SUITE:test:suite-3/);
    assert.match(shard0.stdout, /RUNNING_MOCK_SUITE:test:suite-5/);
    assert.doesNotMatch(shard0.stdout, /RUNNING_MOCK_SUITE:test:suite-2/);
    assert.doesNotMatch(shard0.stdout, /RUNNING_MOCK_SUITE:test:suite-4/);

    // Test Shard 1 execution (suites 2, 4)
    const shard1 = spawnSync('node', ['scripts/ci/run-test-shard.cjs'], {
      encoding: 'utf8',
      cwd: fixtureDir,
      env: { ...process.env, SHARD_TOTAL: '2', SHARD_INDEX: '1' },
    });
    assert.strictEqual(shard1.status, 0, `Expected shard 1 to pass: ${shard1.stderr}`);
    assert.match(shard1.stdout, /RUNNING_MOCK_SUITE:test:suite-2/);
    assert.match(shard1.stdout, /RUNNING_MOCK_SUITE:test:suite-4/);
    assert.doesNotMatch(shard1.stdout, /RUNNING_MOCK_SUITE:test:suite-1/);
    assert.doesNotMatch(shard1.stdout, /RUNNING_MOCK_SUITE:test:suite-3/);
    assert.doesNotMatch(shard1.stdout, /RUNNING_MOCK_SUITE:test:suite-5/);

    // Test Fail-fast on failing suite
    fixturePkg.scripts.test = fixturePkg.scripts['test-with-fail'];
    fs.writeFileSync(path.join(fixtureDir, 'package.json'), JSON.stringify(fixturePkg, null, 2));

    const failingShard = spawnSync('node', ['scripts/ci/run-test-shard.cjs'], {
      encoding: 'utf8',
      cwd: fixtureDir,
      env: { ...process.env, SHARD_TOTAL: '2', SHARD_INDEX: '1' }, // failing-suite is at index 1
    });
    assert.strictEqual(failingShard.status, 1, 'Expected failing suite to exit with code 1');
    assert.match(failingShard.stdout, /RUNNING_MOCK_SUITE:test:failing-suite/);
    assert.match(failingShard.stderr, /\[shard 1\] FAILED: test:failing-suite/);
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }

  console.log('✓ run-test-shard.cjs round-robin execution and fail-fast verified');

  // Real package.json test suite partition & coverage invariance
  const realPkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const testScript = realPkg.scripts?.test;
  assert.ok(typeof testScript === 'string' && testScript.length > 0, 'package.json must define a "test" script');

  const pretestScript = realPkg.scripts?.pretest;
  const releaseRegressionScript = realPkg.scripts?.['test:release-regressions'];
  assert.ok(
    typeof pretestScript === 'string' && pretestScript.includes('npm run test:release-regressions'),
    'npm pretest must run the release regression aggregate before the canonical suite',
  );
  assert.ok(
    typeof releaseRegressionScript === 'string' && releaseRegressionScript.length > 0,
    'package.json must define the release regression aggregate',
  );
  for (const requiredSuite of [
    'test:browser-receipts',
    'test:decoupled-ui-locale',
    'test:i18n-audit-remediations',
    'test:i18n-ssr-timezone',
    'test:issue-241-localized-errors',
    'test:payment-modal-currency-adapter',
    'test:printer-fallback-and-popup-verification',
  ]) {
    assert.ok(
      releaseRegressionScript.includes(`npm run ${requiredSuite}`),
      `release regression aggregate must include ${requiredSuite}`,
    );
  }

  const suitePattern = /(?:bash\s+tests\/run-test\.sh\s+)?npm\s+run\s+(test:[\w-]+)/g;
  const allSuites: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = suitePattern.exec(testScript)) !== null) {
    if (!allSuites.includes(match[1])) allSuites.push(match[1]);
  }

  assert.ok(allSuites.length >= 90, `Expected at least 90 test suites in "test" script, got ${allSuites.length}`);

  for (const suiteName of allSuites) {
    assert.ok(
      suiteName in realPkg.scripts,
      `Suite "${suiteName}" extracted from "test" script must exist in package.json scripts`,
    );
  }

  const shard0Suites = allSuites.filter((_, i) => i % 2 === 0);
  const shard1Suites = allSuites.filter((_, i) => i % 2 === 1);
  const expectedShard0 = Math.ceil(allSuites.length / 2);
  const expectedShard1 = Math.floor(allSuites.length / 2);
  assert.strictEqual(shard0Suites.length, expectedShard0, `Shard 0 must have exactly ${expectedShard0} suites`);
  assert.strictEqual(shard1Suites.length, expectedShard1, `Shard 1 must have exactly ${expectedShard1} suites`);

  // Ensure 0 overlap and 100% union coverage
  const intersection = shard0Suites.filter((s) => shard1Suites.includes(s));
  assert.strictEqual(intersection.length, 0, 'Shards must not share any duplicate suites');

  const reconstructed = [];
  for (let i = 0; i < allSuites.length; i++) {
    reconstructed.push(i % 2 === 0 ? shard0Suites[i / 2] : shard1Suites[(i - 1) / 2]);
  }
  assert.deepStrictEqual(reconstructed, allSuites, 'Round-robin shards must reconstruct the exact original suite list in order');

  console.log(`✓ package.json test suite sharding coverage invariance (${allSuites.length} suites, ${shard0Suites.length}/${shard1Suites.length} per shard) verified`);

  // Current GitHub Actions workflow contracts. Keep these assertions tied to the
  // workflows that actually exist in LyraPOS; the former generic ci.yml/nightly
  // workflow was removed during the LyraPOS packaging split.
  const workflowDir = path.join(rootDir, '.github/workflows');
  const readWorkflow = (name: string): any => YAML.load(
    fs.readFileSync(path.join(workflowDir, name), 'utf8'),
  ) as any;

  const workflowFiles = fs.readdirSync(workflowDir).filter((name) => name.endsWith('.yml')).sort();
  assert.deepStrictEqual(
    workflowFiles,
    ['bootstrap-extract.yml', 'lyrapos-regression.yml', 'lyrapos-unix.yml', 'lyrapos-windows.yml'],
    'current workflow inventory must match the LyraPOS packaging/test split',
  );

  const regression = readWorkflow('lyrapos-regression.yml');
  const regressionJob = regression.jobs?.test;
  assert.ok(regressionJob, 'lyrapos-regression.yml must define the test job');
  assert.strictEqual(regressionJob['runs-on'], 'ubuntu-latest');
  assert.strictEqual(regressionJob['timeout-minutes'], 45);
  assert.ok(
    regressionJob.steps.some((step: any) => step.name === 'Verify canonical i18n and generated print labels' && step.run === 'npm run i18n:check'),
    'regression workflow must run the canonical i18n/print-label gate',
  );
  assert.ok(
    regressionJob.steps.some((step: any) => step.name === 'Run original test suite unchanged under virtual display' && step.run === 'xvfb-run -a npm test'),
    'regression workflow must run the original suite under a virtual display',
  );

  const windows = readWorkflow('lyrapos-windows.yml');
  const windowsJob = windows.jobs?.['build-windows'];
  assert.ok(windowsJob, 'lyrapos-windows.yml must define build-windows');
  assert.strictEqual(windowsJob['runs-on'], 'windows-latest');
  assert.ok(windowsJob.steps.some((step: any) => step.run === 'npm run release:win'), 'Windows workflow must build the Windows installer');
  assert.ok(windowsJob.steps.some((step: any) => step.run === 'npm run verify:release-artifacts'), 'Windows workflow must verify release artifacts');
  assert.ok(windowsJob.steps.some((step: any) => step.run === 'npm run test:windows-packaging-identity'), 'Windows workflow must run the Windows identity guard');

  const unix = readWorkflow('lyrapos-unix.yml');
  assert.ok(unix.jobs?.['validate-unix-identity'], 'lyrapos-unix.yml must define validate-unix-identity');
  assert.ok(unix.jobs?.['build-linux'], 'lyrapos-unix.yml must define build-linux');
  assert.ok(unix.jobs?.['build-macos'], 'lyrapos-unix.yml must define build-macos');
  assert.ok(
    unix.jobs['build-linux'].steps.some((step: any) => step.run === 'npm run release:linux'),
    'Linux workflow must invoke release:linux',
  );
  assert.ok(
    unix.jobs['build-macos'].steps.some((step: any) => typeof step.run === 'string' && step.run.includes('npx electron-builder --mac')),
    'macOS workflow must invoke electron-builder for the macOS validation package',
  );
  assert.ok(
    unix.jobs['build-linux'].steps.some((step: any) => step.run === 'npm run verify:release-artifacts')
      && unix.jobs['build-macos'].steps.some((step: any) => step.run === 'npm run verify:release-artifacts'),
    'Unix packaging jobs must verify release artifact names',
  );

  const bootstrap = readWorkflow('bootstrap-extract.yml');
  assert.ok(bootstrap.jobs?.extract, 'bootstrap-extract.yml must define extract');
  assert.ok(
    bootstrap.jobs.extract.steps.some((step: any) => step.name === 'Extract uploaded source ZIP'),
    'bootstrap workflow must keep its source extraction boundary',
  );

  console.log('All dev tooling script tests passed cleanly!');
}

runTest();
