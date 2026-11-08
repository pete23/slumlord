#!/usr/bin/env node
/*
 * Balance simulator: plays many seeded games with scripted bots and reports
 * outcomes. Use it after changing numbers in game.js.
 *
 *   node tools/balance.js                       greedy vs prudent, all mods, 10..50 years
 *   node tools/balance.js --mods AB             only mods A and B ('' or 'none' = classic)
 *   node tools/balance.js --years 20 --seeds 100 --bot prudent --verbose
 *   node tools/balance.js --derive              suggest targets for the chosen mods
 *   node tools/balance.js --derive --all        suggest targets for every combination (JS to paste)
 *
 * Bots
 *   greedy   borrows up to 70% of available credit for anything cash-positive;
 *            never fixes, never sells, ignores covenants. The old dominant strategy.
 *   prudent  keeps LTV under 45% and stressed interest cover over 1.5, fixes when
 *            rates are low, sells into booms, cures covenant breaches, builds on lots.
 */
'use strict';

const path = require('path');
const { Game, targetFor, formatMoney: money, MOD_KEYS, MOD_INFO } = require(path.join(__dirname, '..', 'game.js'));

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) return true;
  return isNaN(Number(v)) ? v : Number(v);
}

function parseMods(sig) {
  if (sig === true || sig === undefined) sig = 'ABC';
  sig = String(sig).toUpperCase();
  if (sig === 'NONE') sig = '';
  const m = {};
  for (const k of MOD_KEYS) m[k] = sig.includes(MOD_INFO[k].letter);
  return m;
}

const ALL_SIGS = ['', 'A', 'B', 'C', 'AB', 'AC', 'BC', 'ABC'];

// --- Shared helpers ----------------------------------------------------------

function estNet(g, p) {
  const mr = g.marketRent(p);
  const occ = g.expectedOccupancy(p, mr * 0.95);
  return mr * 0.95 * p.units * occ - g.runningCost(p) - g.repairCostPerPoint(p);
}

/** Best of private letting and council placements (Mod B), as monthly net. */
function bestNet(g, p) {
  const priv = estNet(g, p);
  if (!g.hasMod('tenants')) return priv;
  const saved = p.policy;
  p.policy = 'council';
  const mr = g.marketRent(p);
  const occ = g.expectedOccupancy(p, mr);
  p.policy = saved;
  const council = mr * 0.8 * p.units * occ - g.runningCost(p) - g.repairCostPerPoint(p);
  return Math.max(priv, council);
}

function manage(g, patchBelow, slumAware) {
  for (const p of g.portfolio()) {
    if (!p.units || p.build) continue;
    const mr = Math.round(g.marketRent(p) * 0.95 / 5) * 5;
    if (Math.abs(mr - p.rent) >= 10) g.setRent(p.id, mr);
    // Repairs only pay where rents can support them.
    const threshold = slumAware && g.localDesirability(p) < 0.8 ? 40 : patchBelow;
    if (p.condition < threshold) {
      // Below 30 means fires and inspectors: borrow for it if needed.
      if (p.condition < 30 && g.state.cash < g.patchCost(p) + 2000 && !g.state.covenant) {
        g.borrow(Math.ceil((g.patchCost(p) + 2000 - g.state.cash) / 100) * 100);
      }
      if (g.state.cash > g.patchCost(p) + (p.condition < 30 ? 0 : 5000)) g.repair(p.id, 'patch');
    }
  }
}

function yieldOf(g, p) { return p.units ? estNet(g, p) * 12 / Math.max(1, g.value(p)) : -1; }

// --- Bots ----------------------------------------------------------------------

function greedy(g) {
  manage(g, 70);
  const L = g.listings().filter(p => p.units).map(p => {
    const price = g.askingPrice(p);
    return { p, price, net: estNet(g, p) - price * g.loanRate() / 12 };
  }).filter(x => x.net > 0).sort((a, b) => b.net / b.price - a.net / a.price);
  for (const { p, price } of L) {
    const buffer = 8000 + g.state.loan * 0.05;
    if (price + buffer <= g.state.cash + g.availableCredit() * 0.7) {
      const need = price + buffer - g.state.cash;
      if (need > 0) g.borrow(Math.ceil(need / 100) * 100);
      g.buy(p.id);
    }
  }
  if (g.state.cash > 30000 && g.state.loan > 0) g.repay(g.state.cash - 20000);
}

/** Leverage the prudent bot is comfortable with, given where rates are. */
function targetLtv(g) {
  if (!g.hasMod('bank')) return 0.55;
  const r = g.baseRate();
  const hist = g.state.rateHistory;
  const rising = hist.length > 6 && r > hist[hist.length - 7];
  if (r <= 0.07) return rising ? 0.6 : 0.7;
  if (r <= 0.10) return rising ? 0.4 : 0.6;
  return rising ? 0.3 : 0.5;
}

function prudent(g, mem) {
  const s = g.state;
  const LTV = targetLtv(g);
  const base = g.rules.creditBase * g.priceLevel();
  manage(g, 65, true);

  if (g.hasMod('tenants')) {
    for (const p of g.portfolio()) {
      if (!p.units) continue;
      // Pick whichever policy pays better here.
      const saved = p.policy;
      p.policy = 'any';
      const priv = estNet(g, p);
      p.policy = saved;
      const want = bestNet(g, p) > priv + 1 ? 'council' : 'any';
      if (p.policy !== want) g.setPolicy(p.id, want);
    }
  }

  const sellWorst = () => {
    const owned = g.portfolio().filter(p => !p.build).sort((a, b) => yieldOf(g, a) - yieldOf(g, b));
    if (!owned.length) return false;
    g.sell(owned[0].id);
    if (s.loan > 0 && s.cash > 5000) g.repay(s.cash - 5000);
    return true;
  };

  // Cure a covenant breach.
  if (s.covenant) {
    if (s.cash > 5000 && s.loan > 0) g.repay(s.cash - 5000);
    let guard = 10;
    while ((s.loan > g.creditLimit() * 0.9 || g.interestCover() < 1.5) && guard-- && sellWorst());
  }

  // Fix when money is cheap.
  if (g.hasMod('bank') && !s.fixed && s.loan > 50000 && g.baseRate() <= 0.065) g.fixRate(5);

  // De-lever towards the comfortable LTV, selling the weakest building every few months.
  if (s.loan > (LTV + 0.1) * g.portfolioValue() + base && s.month - (mem.lastSale || -99) >= 3) {
    if (sellWorst()) mem.lastSale = s.month;
  }

  // Stressed interest cover: can we survive base rate +4%?
  const stressedCover = (extraLoan, extraNet) => {
    let net = extraNet;
    for (const p of g.portfolio()) net += g.projectedNet(p);
    const interest = (s.loan + extraLoan) * (g.loanRate() + 0.04) / 12;
    return interest ? net / interest : Infinity;
  };

  // Buy.
  const hurdle = g.loanRate() + 0.02;
  const L = g.listings().filter(p => p.units && p.condition >= 35).map(p => {
    const price = g.askingPrice(p);
    const net = bestNet(g, p);
    return { p, price, net, y: net * 12 / price };
  }).filter(x => x.y > hurdle).sort((a, b) => b.y - a.y);
  for (const { p, price, net } of L) {
    if (s.covenant) break;
    const buffer = 10000 + s.loan * 0.05 + g.patchCost(p);
    const need = Math.max(0, price + buffer - s.cash);
    const pv = g.portfolioValue() + price;
    if (s.loan + need > LTV * pv + base) continue;
    if (need > g.availableCredit()) continue;
    if (stressedCover(need, net) < 1.5) continue;
    if (need > 0) g.borrow(Math.ceil(need / 100) * 100);
    g.buy(p.id);
  }

  // Build on lots (Mod C).
  if (g.hasMod('build')) {
    if (s.marketIndex < 1.2 && !s.covenant) {
      const worthBuilding = (p) => ['terrace', 'bedsit', 'flats', 'tower'].some(t => g.planningChance(p, t) >= 0.4 &&
        g.types[t].baseValue * g.localDesirability(p) * s.marketIndex * g.priceLevel() > g.buildCost(p, t) * 1.1);
      for (const p of g.listings().filter(q => q.type === 'lot' && worthBuilding(q))) {
        const price = g.askingPrice(p);
        const need = Math.max(0, price + 10000 - s.cash);
        if (s.loan + need > LTV * (g.portfolioValue() + price) + base || need > g.availableCredit()) continue;
        if (need > 0) g.borrow(Math.ceil(need / 100) * 100);
        g.buy(p.id);
      }
    }
    for (const p of g.portfolio().filter(q => q.type === 'lot' && !g.isBusy(q) && q.blockedUntil <= s.month)) {
      if (s.covenant) continue;
      // Best expected margin (finished value - cost), weighted by planning odds.
      let type = null, best = 0, cost = 0, value = 0;
      for (const t of ['terrace', 'bedsit', 'flats', 'tower']) {
        const ch = g.planningChance(p, t);
        if (ch < 0.4) continue;
        const c = g.buildCost(p, t);
        const v = g.types[t].baseValue * g.localDesirability(p) * s.marketIndex * g.priceLevel();
        const score = (v - c * 1.1) * ch;
        if (score > best) { best = score; type = t; cost = c; value = v; }
      }
      if (!type) continue;
      if (s.loan + cost > LTV * (g.portfolioValue() + value) + base) continue;
      if (cost > (s.cash + g.availableCredit()) * 0.8) continue;
      g.build(p.id, type);
    }
  }

  if (s.cash > 40000 && s.loan > 0) g.repay(s.cash - 25000);
}

const BOTS = { greedy, prudent };

function play(seed, years, mods, botName, noGoal) {
  const g = new Game({ seed, years, mods });
  if (noGoal) g.state.goal = Infinity;
  const mem = {};
  const marks = {};
  while (!g.isOver()) {
    BOTS[botName](g, mem);
    g.endMonth();
    if (g.state.month % 120 === 0) marks[g.state.month / 12] = g.netWorth();
  }
  for (let y = 10; y <= years; y += 10) if (marks[y] == null) marks[y] = g.netWorth();
  return {
    seed, status: g.state.status, month: g.state.month, worth: Math.round(g.netWorth()),
    owned: g.portfolio().length, maxBase: Math.max(...g.state.rateHistory), marks,
  };
}

const quantile = (arr, q) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(q * (s.length - 1))];
};
const pct = (x) => (Math.round(x * 100) + '%').padStart(4);

function winRates(seeds, sig, onlyYears, onlyBot) {
  const mods = parseMods(sig);
  const lengths = onlyYears ? [onlyYears] : [10, 20, 30, 40, 50];
  const bots = onlyBot ? [onlyBot] : ['greedy', 'prudent'];
  console.log('Mods: ' + (sig || 'classic') + '  (' + seeds + ' seeds)');
  for (const years of lengths) {
    for (const bot of bots) {
      const results = [];
      for (let seed = 1; seed <= seeds; seed++) results.push(play(seed, years, mods, bot));
      const wins = results.filter(r => r.status === 'won').length;
      const bust = results.filter(r => r.status === 'bankrupt').length;
      console.log(`${String(years).padStart(2)}y ${bot.padEnd(8)} target ${money(targetFor(years, sig)).padStart(12)}  ` +
        `won ${pct(wins / seeds)}  bankrupt ${pct(bust / seeds)}  median worth ${money(quantile(results.map(r => r.worth), 0.5)).padStart(12)}`);
      if (arg('verbose', false)) console.table(results.map(({ marks, ...r }) => r));
    }
  }
}

/**
 * Targets for a rule set: at each length, the median net worth of whichever
 * bot does better under those rules (greedy without Mod A, prudent with it),
 * rounded to nice numbers and forced to rise with game length.
 */
function deriveTable(seeds, sig) {
  const mods = parseMods(sig);
  const medians = {};
  for (const bot of ['greedy', 'prudent']) {
    const marks = { 10: [], 20: [], 30: [], 40: [], 50: [] };
    for (let seed = 1; seed <= seeds; seed++) {
      const r = play(seed, 50, mods, bot, true);
      for (const y in marks) marks[y].push(r.marks[y]);
    }
    for (const y in marks) medians[y] = Math.max(medians[y] || -Infinity, quantile(marks[y], 0.5));
  }
  const nice = (v) => {
    const step = v >= 1e7 ? 1e6 : v >= 2e6 ? 5e5 : v >= 5e5 ? 1e5 : 5e4;
    return Math.max(step, Math.round(v / step) * step);
  };
  let prev = 0;
  return Object.keys(medians).map(y => {
    const v = Math.max(nice(medians[y]), Math.round(prev * 1.25 / 50000) * 50000);
    prev = v;
    return [Number(y), v];
  });
}

module.exports = { BOTS, play, parseMods, main };
if (require.main === module) main();

function main() {
  const seeds = arg('seeds', 40);
  const sig = arg('mods', 'ABC');
  const sigStr = sig === true ? 'ABC' : String(sig).toUpperCase() === 'NONE' ? '' : String(sig).toUpperCase();
  if (arg('derive', false)) {
    const sigs = arg('all', false) ? ALL_SIGS : [sigStr];
    console.log('  const TARGETS = {');
    for (const s of sigs) {
      const t = deriveTable(seeds, s);
      console.log(`    ${JSON.stringify(s).padEnd(6)}: [${t.map(([y, v]) => `[${y}, ${v}]`).join(', ')}],`);
    }
    console.log('  };');
  } else {
    winRates(seeds, sigStr, arg('years', null), arg('bot', null));
  }
}
