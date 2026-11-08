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

const ROOT = path.join(__dirname, '..');
const URL = pathToFileURL(path.join(ROOT, 'index.html')).href;
const shotsIdx = process.argv.indexOf('--shots');
const SHOTS = shotsIdx > 0 ? path.resolve(process.argv[shotsIdx + 1] || 'screenshots') : null;

const VIEWPORTS = [['desktop', { width: 1440, height: 1000 }], ['phone', { width: 390, height: 844 }]];

async function priceOf(row) {
  const t = (await row.locator('td').nth(5).textContent()).replace(/[£,]/g, '');
  const n = parseFloat(t);
  return t.endsWith('M') ? n * 1e6 : t.endsWith('k') ? n * 1e3 : n;
}

async function run() {
  const browser = await chromium.launch();
  const failures = [];
  try {
    for (const [name, viewport] of VIEWPORTS) {
      const page = await browser.newPage({ viewport });
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

      await page.goto(URL);
      // First run shows the new-game requester.
      await page.selectOption('#years-select', '20');
      await page.click('dialog button.primary');
      const goal = await page.textContent('#stats');
      if (!goal.includes('£6.0M')) failures.push(`${name}: 20-year goal not shown`);

      // Buy the cheapest listing.
      await page.click('#tab-market');
      const rows = page.locator('#list tbody tr');
      let best = 0, bestPrice = Infinity;
      for (let i = 0; i < await rows.count(); i++) {
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
