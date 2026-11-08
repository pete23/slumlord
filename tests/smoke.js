#!/usr/bin/env node
/*
 * Browser smoke test: loads index.html from disk at desktop and phone sizes,
 * plays a few turns through the real UI, and fails on console errors or
 * horizontal overflow.
 *
 *   npm run smoke                 run the checks
 *   npm run smoke -- --shots out  also save screenshots into ./out
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');
const { targetFor } = require(path.join(__dirname, '..', 'game.js'));
const shortMoney = (n) => n >= 1e6 ? '£' + (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : '£' + Math.round(n / 1e3) + 'k';

const ROOT = path.join(__dirname, '..');
const URL = pathToFileURL(path.join(ROOT, 'index.html')).href;
const shotsIdx = process.argv.indexOf('--shots');
const SHOTS = shotsIdx > 0 ? path.resolve(process.argv[shotsIdx + 1] || 'screenshots') : null;

// Desktop plays with all rule mods (the default); phone plays the classic game.
const VIEWPORTS = [
  ['desktop', { width: 1440, height: 1000 }, 'ABC'],
  ['phone', { width: 390, height: 844 }, ''],
];

async function priceOf(row) {
  const t = (await row.locator('td').nth(5).textContent()).replace(/[£,]/g, '');
  const n = parseFloat(t);
  return t.endsWith('M') ? n * 1e6 : t.endsWith('k') ? n * 1e3 : n;
}

async function run() {
  const browser = await chromium.launch();
  const failures = [];
  try {
    for (const [name, viewport, sig] of VIEWPORTS) {
      const page = await browser.newPage({ viewport });
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

      await page.goto(URL);
      // First run shows the new-game requester with rule toggles.
      for (const [k, letter] of [['bank', 'A'], ['tenants', 'B'], ['build', 'C']]) {
        const box = page.locator('#mod-' + k);
        if ((await box.isChecked()) !== sig.includes(letter)) await box.click();
      }
      await page.selectOption('#years-select', '20');
      await page.click('dialog button.primary');
      const goal = await page.textContent('#stats');
      const want = shortMoney(targetFor(20, sig));
      if (!goal.includes(want)) failures.push(`${name}: 20-year goal ${want} not shown`);
      if (sig.includes('A') !== goal.includes('Base rate')) failures.push(`${name}: base rate shown/hidden wrongly`);

      // Buy the cheapest listing.
      await page.click('#tab-market');
      const rows = page.locator('#list tbody tr');
      let best = 0, bestPrice = Infinity;
      for (let i = 0; i < await rows.count(); i++) {
        const cells = rows.nth(i).locator('td');
        if ((await cells.nth(2).textContent()).includes('lot') || Number(await cells.nth(4).textContent()) < 20) continue;
        const p = await priceOf(rows.nth(i));
        if (p < bestPrice) { bestPrice = p; best = i; }
      }
      await rows.nth(best).click();
      await page.click('#detail button.primary');
      if (await page.locator('#tab-portfolio').textContent() !== 'Portfolio 1') failures.push(`${name}: purchase failed`);

      // Play a few months, change rent, patch up.
      for (let i = 0; i < 4; i++) await page.click('#btn-end');
      await page.click('#tab-portfolio');
      await page.click('#list tbody tr');
      await page.fill('#rent-input', '999');
      await page.click('.rent button[type=submit]');
      const rent = await page.inputValue('#rent-input');
      if (rent === '999') failures.push(`${name}: rent not rounded by engine`);

      // Keyboard: Space ends a month when focus is on the page.
      const before = await page.textContent('.stat dd');
      await page.locator('body').click({ position: { x: 5, y: 900 } }).catch(() => {});
      await page.keyboard.press('Space');
      if (await page.textContent('.stat dd') === before) failures.push(`${name}: Space did not end the month`);

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 0) failures.push(`${name}: page scrolls horizontally by ${overflow}px`);

      if (SHOTS) {
        fs.mkdirSync(SHOTS, { recursive: true });
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true });
      }

      // Autosave survives a reload.
      const date = await page.textContent('.stat dd');
      await page.reload();
      if (await page.textContent('.stat dd') !== date) failures.push(`${name}: save not restored after reload`);

      for (const e of errors) failures.push(`${name}: console error: ${e}`);
      console.log(`${name}: done`);
      await page.close();
    }
    // Text mode: 80x32 screen, menu-driven, shares the save with the graphical UI.
    {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
      // Start a game in the graphical UI, play two months, then switch to text mode.
      await page.goto(URL);
      await page.click('dialog button.primary');
      await page.click('#btn-end');
      await page.click('#btn-end');
      const gfxDate = (await page.textContent('.stat dd')).trim();
      await page.click('a[href="text.html"]');
      await page.waitForSelector('#screen');
      const screen = () => page.evaluate(() => document.getElementById('screen').textContent);
      const lines = (await screen()).split('\n');
      if (lines.length !== 32 || lines.some(l => l.length !== 80)) failures.push('text: screen is not 80x32');
      if (!(await screen()).includes('Main menu')) failures.push('text: no main menu shown');
      if (!lines[0].includes(gfxDate)) failures.push(`text: did not resume the shared save (expected ${gfxDate})`);
      const before = (await screen()).split('\n')[0];
      await page.keyboard.press(' ');
      if ((await screen()).split('\n')[0] === before) failures.push('text: Space did not end the month');
      for (const key of ['m', 'ArrowRight', 'Enter', 'Escape', 'Escape', 'p', 'Escape', 'f', 'Escape', 'b', 'Escape', 'a', 'Escape', 'z', 'Escape', 'h', 'Escape']) {
        await page.keyboard.press(key);
      }
      if (!(await screen()).includes('Main menu')) failures.push('text: menu navigation did not return to main menu');
      // Mouse: clicking an option works.
      await page.locator('#screen [data-k="B"]').first().click();
      if (!(await screen()).includes('Bank')) failures.push('text: clicking a menu option failed');
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'text.png') });
      for (const e of errors) failures.push('text: console error: ' + e);
      console.log('text: done');
      await page.close();
    }
  } finally {
    await browser.close();
  }
  if (failures.length) {
    console.error('\nFAILED\n' + failures.map(f => '  - ' + f).join('\n'));
    process.exit(1);
  }
  console.log('All smoke checks passed' + (SHOTS ? ', screenshots in ' + SHOTS : '') + '.');
}

run().catch(e => { console.error(e); process.exit(1); });
