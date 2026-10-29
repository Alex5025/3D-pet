import { build } from 'esbuild';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = '/tmp/3D-pet';
mkdirSync(root, { recursive: true });
const output = join(mkdtempSync(join(root, 'character-tests-')), 'tests.cjs');
await build({ entryPoints: ['src/main/characterStore.test.ts'], outfile: output, bundle: true, platform: 'node', logLevel: 'silent' });
execFileSync(process.execPath, [output], { stdio: 'inherit' });
