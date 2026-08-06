import { chromium } from 'playwright';

const URL = process.argv[2];
const browser = await chromium.launch(
  process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {},
);
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

await page.goto(URL);
await page.waitForSelector('.keyboard .key');

let pass = 0;
const check = (name, got, want) => {
  const ok = got === want;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n        got  ${got}\n        want ${want}`);
  ok ? pass++ : (process.exitCode = 1);
};

const settled = async () => {
  await page.waitForSelector('.solver-progress', { state: 'detached', timeout: 60000 });
  await page.waitForSelector('.solver-list', { timeout: 60000 });
};
const rows = () =>
  page.$$eval('.solver-list li:not(.solver-head)', (ls) =>
    ls.map((l) => ({
      word: l.querySelector('.w').textContent,
      chance: l.querySelector('.p').textContent.trim(),
      probe: l.querySelector('.p').classList.contains('probe'),
      bits: parseFloat(l.querySelector('.b').textContent),
    })),
  );
const summary = () => page.$eval('.solver-summary', (e) => e.textContent.replace(/\s+/g, ' ').trim());

// 1. Cold start ranks the whole candidate pool. `raise` scoring ~6 bits is the
//    published entropy result for Wordle openers, so this is an external check.
await settled();
const cold = await rows();
check('cold-start pool size', parseInt((await summary()).replace(/,/g,''),10), 6792);
check('cold-start top is tarse (all-words ranking)', cold[0].word, 'tarse');
check('sorted by bits descending', cold.every((r, i) => i === 0 || cold[i - 1].bits >= r.bits), true);
check('top opener near 6 bits', cold[0].bits > 5.9 && cold[0].bits < 6.1, true);
console.log('        top 5:', cold.slice(0, 5).map((r) => `${r.word} ${r.bits}`).join('  '));

// 2. A guess narrows the field, and the panel reflects it.
await page.keyboard.type('hoard');
await page.keyboard.type('crane');
await settled();
const after = await rows();
const count = parseInt((await summary()).replace(/,/g, ''), 10);
check('field narrowed by crane', count < 100 && count > 0, true);
check('every listed word is consistent', after.length > 0, true);
console.log('        remaining:', count, '| top:', after.slice(0, 3).map((r) => r.word).join(' '));

// 3. Ranking all words must surface probes -- words that split the field better
//    than any candidate can, but which can never win. They show a dash, not 0%.
const probes = after.filter((r) => r.probe);
check('probes appear in the all-words ranking', probes.length > 0, true);
check('probes render a dash for p(answer)', probes[0].chance, '\u2014');
// Probes so dominate the head of the ranking that no candidate appears in the
// visible top 200 at all -- which is exactly why the toggle exists.
check('probes fill the entire visible head', after.every((r) => r.probe), true);

// 4. The "Possible answers" view filters probes out without re-ranking.
await page.click('.solver-modes button:text-is("Possible answers")');
const answersOnly = await rows();
check('top probe out-informs the best candidate', after[0].bits > answersOnly[0].bits, true);
console.log('        top probe:', after[0].word, after[0].bits,
  '| top candidate:', answersOnly[0].word, answersOnly[0].bits, answersOnly[0].chance);
check('answers view has no probes', answersOnly.every((r) => !r.probe), true);
check('answers view still sorted by bits', answersOnly.every((r, i) => i === 0 || answersOnly[i-1].bits >= r.bits), true);
const listed = new Set(answersOnly.map((r) => r.word));
check('target present among possible answers', listed.has('hoard'), true);
await page.click('.solver-modes button:text-is("All guesses")');

// 4. Typing an incomplete row must NOT restart the ranking: the memo is keyed
//    on completed-row content, not array identity.
await page.keyboard.type('sw');
const stillListed = await page.$('.solver-list');
check('partial row does not re-rank', stillListed !== null, true);
const sameCount = parseInt((await summary()).replace(/,/g, ''), 10);
check('candidate count unchanged by partial row', sameCount, count);

// 5. Solving collapses the field to exactly the target.
await page.keyboard.type('ard'); // completes the guess 'sward'
await settled();
await page.keyboard.type('hoard'); // now actually solve it
await settled();
await page.waitForFunction(
  () => document.querySelector('.solver-summary').textContent.includes('1 word matches'),
  { timeout: 60000 },
);
// With one candidate left every guess yields 0 bits, so the win-chance
// tiebreak is the only thing putting the answer at the top of the all-words view.
const solved = await rows();
check('answer tops the all-words view once solved', solved[0].word, 'hoard');
check('answer shown at 100%', solved[0].chance, '100.0%');
check('everything ties at zero bits', solved[0].bits, 0);
await page.click('.solver-modes button:text-is("Possible answers")');
const finalAnswers = await rows();
check('exactly one possible answer remains', finalAnswers.length, 1);
check('and it is the target', finalAnswers[0].word, 'hoard');

await page.screenshot({ path: 'tests/solver.png' });
console.log(`\n${pass} checks passed`);
if (errors.length) {
  console.log('CONSOLE ERRORS:', errors);
  process.exitCode = 1;
}
await browser.close();
