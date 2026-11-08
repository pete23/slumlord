#!/usr/bin/env node
/*
 * Balance simulator: plays many seeded games with a simple rule-following bot
 * and reports outcomes. Use it after changing numbers in game.js.
 *
 *   node tools/balance.js                 win rate for each game length vs current targets
 *   node tools/balance.js --derive        suggest targets (median bot net worth per decade)
 *   node tools/balance.js --years 20 --seeds 100 --verbose
 */
'use strict';

const path = require('path');
const { Game, targetFor, formatMoney: money } = require(path.join(__dirname, '..', 'game.js'));

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : Number(v);
}

/** One month of decisions: price rents, patch tired buildings, buy cash-positive listings. */
function bot(g) {
  for (const p of g.portfolio()) {
    g.setRent(p.id, g.marketRent(p) * 0.95);
    if (p.condition < 70 && g.state.cash > g.patchCost(p) + 5000) g.repair(p.id, 'patch');
  }
  const candidates = g.listings().map(p => {
    const price = g.askingPrice(p);
    const net = g.marketRent(p) * p.units * 0.85 - g.runningCost(p) -
      price * g.rules.interestRate / 12 - g.repairCostPerPoint(p);
    return { p, price, net };
  }).filter(x => x.net > 0).sort((a, b) => b.net / b.price - a.net / a.price);
  for (const { p, price } of candidates) {
    const buffer = 8000 + g.state.loan * 0.05;
    if (price + buffer <= g.state.cash + g.availableCredit() * 0.7) {
      const need = price + buffer - g.state.cash;
      if (need > 0) g.borrow(Math.ceil(need / 100) * 100);
      g.buy(p.id);
    }
  }
  if (g.state.cash > 30000 && g.state.loan > 0) g.repay(g.state.cash - 20000);
}

const quantile = (arr, q) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(q * (s.length - 1))];
};

function winRates(seeds, onlyYears) {
  const lengths = onlyYears ? [onlyYears] : [10, 20, 30, 40, 50];
  for (const years of lengths) {
    const results = [];
    for (let seed = 1; seed <= seeds; seed++) {
      const g = new Game({ seed, years });
      while (!g.isOver()) { bot(g); g.endMonth(); }
      results.push({ seed, status: g.state.status, month: g.state.month, worth: Math.round(g.netWorth()), owned: g.portfolio().length });
    }
    const wins = results.filter(r => r.status === 'won').length;
    const bust = results.filter(r => r.status === 'bankrupt').length;
    console.log(`${String(years).padStart(2)}y  target ${money(targetFor(years)).padStart(12)}  ` +
      `won ${pct(wins / seeds)}  bankrupt ${pct(bust / seeds)}  median worth ${money(quantile(results.map(r => r.worth), 0.5))}`);
    if (arg('verbose', false)) console.table(results);
  }
}

function derive(seeds) {
  const marks = { 10: [], 20: [], 30: [], 40: [], 50: [] };
  for (let seed = 1; seed <= seeds; seed++) {
    const g = new Game({ seed, years: 50 });
    g.state.goal = Infinity; // never win early; we want the whole curve
    while (!g.isOver()) {
      bot(g);
      g.endMonth();
      const y = g.state.month / 12;
      if (marks[y]) marks[y].push(g.netWorth());
    }
    for (const y in marks) if (marks[y].length < seed) marks[y].push(g.netWorth());
  }
  console.log('Bot net worth by decade (' + seeds + ' seeds). Targets sit near the median.');
  for (const y in marks) {
    const m = marks[y];
    console.log(`${String(y).padStart(2)}y  p25 ${money(quantile(m, 0.25)).padStart(12)}  median ${money(quantile(m, 0.5)).padStart(12)}  ` +
      `p75 ${money(quantile(m, 0.75)).padStart(12)}  current target ${money(targetFor(Number(y))).padStart(12)}`);
  }
}

const pct = (x) => (Math.round(x * 100) + '%').padStart(4);
const seeds = arg('seeds', 40);
if (arg('derive', false)) derive(seeds);
else winRates(seeds, arg('years', null));
