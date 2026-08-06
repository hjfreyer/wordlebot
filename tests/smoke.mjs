import { chromium } from 'playwright';

const URL = process.argv[2];
// CHROME_PATH lets a sandbox point at a preinstalled browser instead of one
// downloaded by `playwright install`.
const browser = await chromium.launch(
  process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {},
);
const page = await browser.newPage({ viewport: { width: 480, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('response', (r) => r.status() >= 400 && errors.push(`${r.status()} ${r.url()}`));

await page.goto(URL);
await page.waitForSelector('.keyboard .key');

const rows = () =>
  page.$$eval('.board .row', (rs) =>
    rs.map((r) => ({
      cls: r.className,
      cells: [...r.querySelectorAll('.cell')].map((c) => ({
        ch: c.textContent,
        state: ['correct', 'present', 'absent'].find((s) => c.classList.contains(s)) ?? '',
      })),
    })),
  );
const status = () => page.$eval('.status', (e) => e.textContent.trim());
const word = (r) => r.cells.map((c) => c.ch).join('');
const states = (r) => r.cells.map((c) => c.state[0] || '.').join('');

let pass = 0;
const check = (name, got, want) => {
  const ok = got === want;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n        got  ${got}\n        want ${want}`);
  if (ok) pass++;
  else process.exitCode = 1;
};

// 1. Empty board prompts for a target.
check('initial prompt', await status(), 'Type 5 more letters to set the target.');

// 2. Typing five letters sets the target.
await page.keyboard.type('hello');
check('target row filled', word((await rows())[0]), 'hello');
check('target recognised', (await status()).startsWith('Target set'), true);

// 3. Duplicate-letter scoring: guess "lolly" against target "hello".
//    Both l's in the target are consumed by the greens at index 2 and 3, so the
//    leading l must be ABSENT, not present. The o must be present.
await page.keyboard.type('lolly');
const r = await rows();
check('guess row text', word(r[1]), 'lolly');
check('duplicate-letter scoring', states(r[1]), 'apcca');

// 4. Keyboard reflects best-known state per letter.
const keyState = (k) =>
  page.$eval(`.keyboard .key:text-is("${k}")`, (e) =>
    ['correct', 'present', 'absent'].find((s) => e.classList.contains(s)) ?? '',
  );
check('keyboard l = correct (best of correct/absent)', await keyState('l'), 'correct');
check('keyboard o = present', await keyState('o'), 'present');
check('keyboard y = absent', await keyState('y'), 'absent');

// 5. Backspace runs back through a completed guess into the target row.
for (let i = 0; i < 2; i++) await page.keyboard.press('Backspace');
const back = await rows();
check('guess row rewound', word(back[1]), 'lol');
check('scoring cleared while incomplete', states(back[1]), '.....');
for (let i = 0; i < 4; i++) await page.keyboard.press('Backspace');
check('backspaced into target row', word((await rows())[0]), 'hell');
check('target incomplete again', await status(), 'Type 1 more letter to set the target.');

// 6. Solving reports the guess count.
await page.keyboard.type('o');
await page.keyboard.type('crane');
await page.keyboard.type('hello');
check('solve detected', await status(), 'Solved in 2 guesses.');

// 7. Unknown words are playable but flagged.
await page.click('.controls button:text-is("Reset")');
await page.keyboard.type('crane');
await page.keyboard.type('zzzzz');
const unk = await rows();
check('unknown guess flagged', unk[1].cls.includes('unknown'), true);
check('unknown guess still scored', states(unk[1]), 'aaaaa');

// 8. Random target hides itself.
await page.click('.controls button:text-is("Random target")');
const masked = (await rows())[0];
check('random target masked', word(masked), '•••••');
check('reveal button offered', await page.$eval('.controls button:nth-child(2)', (e) => e.textContent), 'Reveal target');
await page.click('.controls button:text-is("Reveal target")');
const revealed = word((await rows())[0]);
check('revealed target is a real word', /^[a-z]{5}$/.test(revealed), true);
console.log(`        (random target was "${revealed}")`);

await page.click('.controls button:text-is("Reset")');
await page.keyboard.type('hellolollycrane');
await page.screenshot({ path: 'tests/board.png' });

console.log(`\n${pass} checks passed`);
if (errors.length) {
  console.log('CONSOLE ERRORS:', errors);
  process.exitCode = 1;
}
await browser.close();
