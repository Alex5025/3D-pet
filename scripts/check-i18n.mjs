import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const i18nDir = join(dirname(fileURLToPath(import.meta.url)), '../src/shared/i18n');
const locales = [
  ['zh-Hant', 'zh-Hant.ts'],
  ['en', 'en.ts'],
  ['ja', 'ja.ts'],
  ['ko', 'ko.ts'],
];

function parseDict(path) {
  const text = readFileSync(path, 'utf8');
  const keys = [];
  const values = new Map();
  const duplicates = [];
  const empty = [];
  const placeholders = new Map();
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const match = line.match(/^\s*'([^']+)':\s*'((?:\\'|[^'])*)'/);
    if (!match) continue;
    const [, key, raw] = match;
    if (values.has(key)) duplicates.push({ key, line: index + 1 });
    keys.push(key);
    const value = raw.replace(/\\'/g, "'");
    values.set(key, value);
    if (!value.trim()) empty.push(key);
    placeholders.set(key, [...value.matchAll(/\{(\w+)\}/g)].map((item) => item[1]).sort().join(','));
  }
  return { keys, values, duplicates, empty, placeholders };
}

const parsed = Object.fromEntries(locales.map(([name, file]) => [name, parseDict(join(i18nDir, file))]));
const errors = [];
const baseName = 'zh-Hant';
const base = parsed[baseName];

if (base.keys.length === 0) {
  errors.push(`${baseName} 沒有解析到任何字串鍵`);
}

for (const [name, data] of Object.entries(parsed)) {
  if (data.duplicates.length > 0) {
    errors.push(`${name} 有重複鍵：${data.duplicates.map((item) => `${item.key}(#${item.line})`).join(', ')}`);
  }
  if (data.empty.length > 0) {
    errors.push(`${name} 有空白字串：${data.empty.join(', ')}`);
  }
}

for (const [name, data] of Object.entries(parsed)) {
  if (name === baseName) continue;
  const missing = base.keys.filter((key) => !data.values.has(key));
  const extra = data.keys.filter((key) => !base.values.has(key));
  const placeholderMismatch = base.keys.filter((key) => (
    data.values.has(key) && base.placeholders.get(key) !== data.placeholders.get(key)
  ));
  if (missing.length > 0) errors.push(`${name} 缺少鍵：${missing.join(', ')}`);
  if (extra.length > 0) errors.push(`${name} 多出鍵：${extra.join(', ')}`);
  for (const key of placeholderMismatch) {
    errors.push(`${name} 的 ${key} 插值與 ${baseName} 不一致（${baseName}: {${base.placeholders.get(key)}} / ${name}: {${data.placeholders.get(key)}}）`);
  }
}

if (errors.length > 0) {
  console.error('語系字典不一致：');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`語系鍵一致：${locales.map(([name]) => `${name} ${parsed[name].keys.length}`).join('、')}。`);
