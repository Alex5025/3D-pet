import { build } from 'esbuild';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const scratch = join(tmpdir(), '3D-pet');
mkdirSync(scratch, { recursive: true });
const output = join(mkdtempSync(join(scratch, 'character-tests-')), 'tests.cjs');
await build({ entryPoints: ['src/main/characterStore.test.ts'], outfile: output, bundle: true, platform: 'node', logLevel: 'silent' });
execFileSync(process.execPath, [output], { stdio: 'inherit' });
