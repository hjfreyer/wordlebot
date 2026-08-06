// Stage data/words.json as a static asset for the SPA.
//
// Deliberately copied rather than imported from src/: keeping it a discrete
// file means the CC BY 3.0 `_license` header stays visible to anyone who opens
// the network tab, instead of being buried inside a bundled JS chunk.

import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dest = resolve(root, 'public/words.json');

mkdirSync(dirname(dest), { recursive: true });
copyFileSync(resolve(root, 'data/words.json'), dest);
console.log('copied data/words.json -> public/words.json');
