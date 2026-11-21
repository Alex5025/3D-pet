import { build } from 'esbuild';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const scratch = join(tmpdir(), '3D-pet');
mkdirSync(scratch, { recursive: true });
const output = join(mkdtempSync(join(scratch, 'character-tests-')), 'tests.cjs');
await build({ entryPoints: ['src/main/characterStore.test.ts'], outfile: output, bundle: true, platform: 'node', logLevel: 'silent', plugins: [{ name: 'sqlite', setup(b) { b.onResolve({ filter: /^better-sqlite3$/ }, () => ({ path: require.resolve('better-sqlite3'), external: true })); } }] });
execFileSync(require('electron'), [output], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
