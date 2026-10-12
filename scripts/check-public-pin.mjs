#!/usr/bin/env node
/**
 * CI guard for the PUBLIC repo only: the committed src/lane-host.mjs must
 * still be the placeholder. A deployment overlays that file at package
 * build time, so this script is not part of `npm test` (the overlaid copy
 * would fail it by design) and is not shipped in the package.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const file = join(fileURLToPath(new URL('..', import.meta.url)), 'src', 'lane-host.mjs');
const code = readFileSync(file, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
const origins = [...code.matchAll(/['"`](https?:\/\/[^'"`]*)['"`]/g)].map(m => m[1]);

const bad = origins.filter(o => {
  try {
    return !new URL(o).hostname.endsWith('.invalid');
  } catch {
    return true;
  }
});

if (origins.length === 0 || bad.length > 0) {
  console.error(`src/lane-host.mjs must pin only a reserved .invalid placeholder in the public repo; found: ${bad.join(', ') || '(no origin)'}`);
  process.exit(1);
}
console.log(`src/lane-host.mjs carries only the placeholder (${origins.join(', ')})`);
