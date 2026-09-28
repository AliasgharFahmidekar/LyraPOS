#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const electronPath = require('electron');
const testFile = path.resolve(__dirname, '../tests/raster-renderer-electron.test.cjs');

const useXvfb = process.platform === 'linux' && !process.env.DISPLAY;
const command = useXvfb ? 'xvfb-run' : electronPath;
const args = useXvfb
  ? ['-a', electronPath, '--no-sandbox', testFile]
  : ['--no-sandbox', testFile];

if (useXvfb) {
  console.log('[raster-test] No DISPLAY detected; starting Electron under Xvfb.');
}

const result = spawnSync(command, args, {
  stdio: 'inherit',
  env: process.env,
});

if (result.error) {
  console.error('[raster-test] Failed to start Electron raster test:', result.error);
  process.exit(1);
}

if (result.signal) {
  console.error('[raster-test] Electron raster test terminated by ' + result.signal + '.');
  process.exit(1);
}

process.exit(result.status ?? 1);
