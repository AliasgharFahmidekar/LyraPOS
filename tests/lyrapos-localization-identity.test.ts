import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..', 'frontend', 'src', 'lib', 'i18n', 'messages');
const expectedLocales = ['ar','bn','de','en','es','fa','fil','fr','hi','id','it','ja','ko','nl','pt','sq','tr','ur','vi','zh','zh-tw'];
const files = fs.readdirSync(root).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)).sort();

if (JSON.stringify(files) !== JSON.stringify([...expectedLocales].sort())) {
  throw new Error(`Expected 21 locale files, found: ${files.join(', ')}`);
}

const forbidden = ['Flo Cafe', 'FloPOS', 'FloCafe', 'Powered by Flo', 'via Flo', '"Flo"'];
const failures: string[] = [];

for (const locale of expectedLocales) {
  const file = path.join(root, `${locale}.json`);
  const content = fs.readFileSync(file, 'utf8');
  for (const token of forbidden) {
    if (content.includes(token)) failures.push(`${locale}.json contains forbidden branding: ${token}`);
  }
}

if (failures.length) throw new Error(failures.join('\n'));
console.log(`LyraPOS localization identity OK: ${expectedLocales.length} locales audited.`);
