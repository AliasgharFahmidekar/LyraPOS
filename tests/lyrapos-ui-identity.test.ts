import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const assert = (ok: unknown, msg: string) => { if (!ok) throw new Error(msg); };

const titleBar = read('frontend/src/components/layout/TitleBar.tsx');
const css = read('frontend/src/app/globals.css');
const toaster = read('frontend/src/components/layout/DirectionalToaster.tsx');

assert(titleBar.includes('dataset.lyraDesktopTitlebar'), 'TitleBar must use Lyra desktop data identity');
assert(titleBar.includes('dataset.lyraPlatform'), 'TitleBar must use Lyra platform data identity');
assert(titleBar.includes('dataset.lyraWindowFocused'), 'TitleBar must use Lyra focus data identity');
assert(!titleBar.includes('dataset.flo'), 'TitleBar still contains legacy Flo data identity');

assert(css.includes('.lyra-title-bar'), 'Lyra title bar styles are missing');
assert(css.includes('.lyra-toast-card'), 'Lyra toast styles are missing');
assert(css.includes('--lyra-sidebar-block-start'), 'Lyra sidebar offset variable is missing');
assert(!css.includes('.flo-toast'), 'Legacy Flo toast CSS classes remain');

assert(toaster.includes('lyra-toast-card'), 'Toast host must use Lyra toast class');
assert(toaster.includes('lyra-toast-drain'), 'Toast drain must use Lyra toast class');
assert(toaster.includes('lyra-sidebar-block-start'), 'Toast host must use Lyra sidebar offset');

console.log('LyraPOS UI identity regression checks passed.');
