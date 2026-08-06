// Bundle the app into one self-contained HTML file with no external requests.
//
// Emits page content only -- no <html>/<head>/<body> wrapper -- so the output
// can be dropped straight into a host that supplies its own document shell.
//
// Run `npm run build` first; this consumes dist/.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assets = resolve(root, 'dist/assets');

const pick = (ext) => {
  const found = readdirSync(assets).filter((f) => f.endsWith(ext));
  if (found.length !== 1) {
    throw new Error(`expected exactly one ${ext} in dist/assets, found ${found.length}`);
  }
  return readFileSync(resolve(assets, found[0]), 'utf8');
};

// A literal `</script` inside a string would close the tag early; `<` is escaped
// in the JSON for the same reason.
const safe = (js) => js.replaceAll('</script', String.raw`<\/script`);
const json = readFileSync(resolve(root, 'data/words.json'), 'utf8');

const html = `<title>wordlebot</title>
<style>
${pick('.css')}
</style>
<div id="root"></div>
<script>window.__WORDS_BUNDLE__ = ${json.trim().replaceAll('<', '\\u003c')};</script>
<script type="module">
${safe(pick('.js'))}
</script>
`;

const out = resolve(root, 'dist/wordlebot.html');
writeFileSync(out, html);
console.log(`wrote dist/wordlebot.html (${(html.length / 1024).toFixed(0)} KB)`);
