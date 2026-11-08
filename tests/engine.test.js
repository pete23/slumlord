'use strict';
// Engine unit tests. Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { Game, targetFor, RULES, CLASSES } = require(path.join(__dirname, '..', 'game.js'));

const CLASSIC = {};
const ALL = { bank: true, tenants: true, build: true };
const cheapestBuilding = (g) => g.listings().filter(p => p.units && p.condition >= 20)
  .sort((a, b) => g.askingPrice(a) - g.askingPrice(b))[0];
const rich = (g) => { g.state.cash = 5e6; g.state.goal = Infinity; return g; };

// --- Classic rules (all mods off) -------------------------------------------

test('same seed produces the same game', () => {
  for (const mods of [CLASSIC, ALL]) {
    const a = new Game({ seed: 42, mods }), b = new Game({ seed: 42, mods });
    for (let i = 0; i < 24; i++) { a.endMonth(); b.endMonth(); }
    assert.deepEqual(a.toJSON(), b.toJSON());
  }
});

test('new games default to all mods on', () => {
  const g = new Game({ seed: 1 });
  assert.deepEqual(g.mods, ALL);
  assert.equal(g.modSignature(), 'ABC');
});

test('new game starts with the configured cash, length and target', () => {
  const g = new Game({ seed: 1, years: 25, mods: CLASSIC });
  assert.equal(g.state.cash, RULES.startCash);
  assert.equal(g.maxMonths, 300);
  assert.equal(g.goal, targetFor(25, ''));
  assert.equal(g.state.properties.length, g.mapSize.width * g.mapSize.height);
});

test('game length is clamped to 10..50 years', () => {
  assert.equal(new Game({ seed: 1, years: 3 }).state.years, 10);
  assert.equal(new Game({ seed: 1, years: 99 }).state.years, 50);
});

test('targets exist for every rule set, rise with length and interpolate', () => {
  assert.equal(targetFor(10, ''), 1000000);
  assert.equal(targetFor(15, ''), 3500000);
  for (const sig of ['', 'A', 'B', 'C', 'AB', 'AC', 'BC', 'ABC']) {
    for (let y = 11; y <= 50; y++) assert.ok(targetFor(y, sig) >= targetFor(y - 1, sig), sig + ' rises at ' + y);
  }
  assert.equal(targetFor(20, { bank: true, tenants: true, build: true }), targetFor(20, 'ABC'));
});

test('buying a listing spends the asking price and transfers ownership', () => {
  const g = new Game({ seed: 7, mods: CLASSIC });
  const p = cheapestBuilding(g);
  const price = g.askingPrice(p);
  assert.ok(g.buy(p.id).ok);
  assert.equal(g.state.cash, RULES.startCash - price);
  assert.ok(p.owned && !p.forSale);
  assert.equal(g.buy(p.id).ok, false, 'cannot buy twice');
});

test('cannot buy what is not listed or unaffordable', () => {
  const g = new Game({ seed: 7, mods: CLASSIC });
  assert.equal(g.buy(g.state.properties.find(p => !p.forSale).id).ok, false);
  const pricey = g.listings().find(p => g.askingPrice(p) > g.state.cash);
  if (pricey) assert.equal(g.buy(pricey.id).ok, false);
});

test('selling pays market value minus the fee', () => {
  const g = new Game({ seed: 7, mods: CLASSIC });
  const p = cheapestBuilding(g);
  g.buy(p.id);
  const before = g.state.cash, proceeds = g.saleProceeds(p);
  assert.ok(g.sell(p.id).ok);
  assert.equal(g.state.cash, before + proceeds);
  assert.equal(g.sell(p.id).ok, false, 'cannot sell what you do not own');
});

test('rent is rounded to £5 and capped at 3x market', () => {
  const g = new Game({ seed: 7, mods: CLASSIC });
  const p = cheapestBuilding(g);
  g.buy(p.id);
  g.setRent(p.id, 123);
  assert.equal(p.rent, 125);
  g.setRent(p.id, 1e9);
  assert.ok(p.rent <= g.marketRent(p) * 3);
  assert.equal(g.setRent(p.id, -5).ok, false);
});

test('higher rent means lower expected occupancy', () => {
  for (const mods of [CLASSIC, ALL]) {
    const g = new Game({ seed: 7, mods });
    const p = g.state.properties.find(q => q.units && q.condition > 50);
    const mr = g.marketRent(p);
    assert.ok(g.expectedOccupancy(p, mr * 0.7) >= g.expectedOccupancy(p, mr));
    assert.ok(g.expectedOccupancy(p, mr) > g.expectedOccupancy(p, mr * 1.5));
    assert.equal(g.expectedOccupancy(p, mr * 3), 0);
  }
});

test('repairs cost money and improve condition', () => {
  const g = new Game({ seed: 7, mods: CLASSIC });
  const p = cheapestBuilding(g);
  g.buy(p.id);
  p.condition = 40;
  const cash = g.state.cash, cost = g.patchCost(p);
  assert.ok(g.repair(p.id, 'patch').ok);
  assert.equal(p.condition, 40 + RULES.patchPoints);
  assert.equal(g.state.cash, cash - cost);
  g.state.cash += g.refurbCost(p);
  assert.ok(g.repair(p.id, 'refurb').ok);
  assert.equal(p.condition, 100);
  assert.equal(g.repair(p.id, 'patch').ok, false, 'nothing to fix');
});

test('borrowing is limited by the credit line; repaying reduces the loan', () => {
  const g = new Game({ seed: 7, mods: CLASSIC });
  assert.equal(g.borrow(g.creditLimit() + 1000).ok, false);
  assert.ok(g.borrow(20000).ok);
  assert.ok(g.repay(5000).ok);
  assert.equal(g.state.loan, 15000);
  assert.equal(g.state.cash, RULES.startCash + 15000);
});

test('ending a month advances time and records history', () => {
  const g = new Game({ seed: 7 });
  assert.ok(g.endMonth().ok);
  assert.equal(g.state.month, 1);
  assert.equal(g.state.history.length, 2);
  assert.equal(g.state.rateHistory.length, 2);
  assert.ok(g.state.lastReport);
});

test('classic: reaching the target wins at once; running out of time retires', () => {
  const g = new Game({ seed: 7, mods: CLASSIC });
  g.state.cash = g.goal + 1e6;
  g.endMonth();
  assert.equal(g.state.status, 'won');
  assert.equal(g.endMonth().ok, false, 'no moves after the game ends');
  const t = new Game({ seed: 7, mods: CLASSIC });
  t.state.month = t.maxMonths - 1;
  t.endMonth();
  assert.equal(t.state.status, 'retired');
});

test('debt beyond cash and credit means bankruptcy', () => {
  const g = new Game({ seed: 7, mods: CLASSIC });
  g.state.loan = g.creditLimit();
  g.state.cash = -100000;
  g.endMonth();
  assert.equal(g.state.status, 'bankrupt');
});

test('save and restore continues identically', () => {
  for (const mods of [CLASSIC, ALL]) {
    const a = new Game({ seed: 9, years: 20, mods });
    for (let i = 0; i < 12; i++) a.endMonth();
    const b = Game.fromJSON(JSON.stringify(a.toJSON()));
    for (let i = 0; i < 12; i++) { a.endMonth(); b.endMonth(); }
    assert.deepEqual(a.toJSON(), b.toJSON());
  }
});

test('old saves migrate: v1 as a 10-year classic game, v2 as classic', () => {
  const s1 = JSON.parse(JSON.stringify(new Game({ seed: 3, mods: CLASSIC }).toJSON()));
  s1.version = 1;
  delete s1.years; delete s1.goal; delete s1.maxMonths; delete s1.mods;
  const g1 = Game.fromJSON(s1);
  assert.equal(g1.state.years, 10);
  assert.equal(g1.goal, targetFor(10, ''));
  assert.deepEqual(g1.mods, { bank: false, tenants: false, build: false });
  const s2 = JSON.parse(JSON.stringify(new Game({ seed: 3, years: 20, mods: CLASSIC }).toJSON()));
  s2.version = 2; delete s2.mods;
  const g2 = Game.fromJSON(s2);
  assert.equal(g2.state.version, 3);
  assert.equal(g2.modSignature(), '');
  g2.endMonth();
  assert.throws(() => Game.fromJSON({ version: 99 }));
});

test('actions for a disabled mod are refused', () => {
  const g = new Game({ seed: 7, mods: CLASSIC });
  assert.equal(g.fixRate(2).ok, false);
  assert.equal(g.setPolicy(0, 'any').ok, false);
  assert.equal(g.demolish(0).ok, false);
  assert.equal(g.donate(5000).ok, false);
});

// --- Mod A: bank moods ---------------------------------------------------------

test('A: base rate moves within bounds and cycles', () => {
  const g = new Game({ seed: 3, years: 30, mods: { bank: true } });
  g.state.goal = Infinity;
  while (!g.isOver()) g.endMonth();
  const r = g.state.rateHistory;
  assert.ok(Math.min(...r) >= RULES.minBaseRate && Math.max(...r) <= RULES.maxBaseRate);
  assert.ok(Math.max(...r) - Math.min(...r) > 0.04, 'rates swing over 30 years');
  assert.ok(g.priceLevel() > 1.5, 'inflation accumulates');
});

test('A: max LTV tightens as rates rise', () => {
  const g = new Game({ seed: 3, mods: { bank: true } });
  g.state.baseRate = 0.05; const loose = g.maxLtv();
  g.state.baseRate = 0.15; const tight = g.maxLtv();
  assert.equal(loose, RULES.ltvLoose);
  assert.equal(tight, RULES.ltvTight);
});

test('A: fixing locks the balance at base + margin; breaking costs a fee', () => {
  const g = new Game({ seed: 3, mods: { bank: true } });
  g.borrow(30000);
  const offer = g.fixedRateOffer();
  assert.ok(g.fixRate(5).ok);
  assert.equal(g.state.fixed.balance, 30000);
  assert.equal(g.state.fixed.rate, offer);
  assert.equal(g.fixRate(2).ok, false, 'one fix at a time');
  g.state.baseRate = 0.16;
  assert.equal(g.monthlyInterest(), Math.round(30000 * offer / 12), 'fixed tranche ignores base moves');
  const cash = g.state.cash;
  assert.ok(g.breakFix().ok);
  assert.equal(g.state.cash, cash - Math.round(30000 * RULES.breakFee));
  assert.equal(g.state.fixed, null);
});

test('A: repaying into the fixed tranche charges an early-repayment fee', () => {
  const g = new Game({ seed: 3, mods: { bank: true } });
  g.borrow(30000);
  g.fixRate(2);
  g.borrow(10000);           // variable part
  const cash = g.state.cash;
  assert.ok(g.repay(20000).ok);
  assert.equal(g.state.loan, 20000);
  assert.equal(g.state.fixed.balance, 20000);
  assert.equal(g.state.cash, cash - 20000 - Math.round(10000 * RULES.breakFee));
});

test('A: covenant breach gives notice, blocks borrowing, then the bank sells', () => {
  const g = rich(new Game({ seed: 5, mods: { bank: true } }));
  for (const p of g.listings().filter(q => q.units).slice(0, 4)) g.buy(p.id);
  g.state.cash = 0;
  g.state.loan = Math.round(g.portfolioValue() * 0.9);
  const owned = g.portfolio().length;
  g.endMonth();
  assert.ok(g.state.covenant, 'notice served');
  assert.equal(g.borrow(1000).ok, false, 'no new lending in breach');
  for (let i = 0; i < RULES.covenantMonths + 1 && g.state.status === 'playing'; i++) g.endMonth();
  assert.ok(g.portfolio().length < owned, 'bank seized property');
});

test('A: the target must be held for 12 months', () => {
  const g = new Game({ seed: 7, mods: { bank: true } });
  g.state.cash = g.goal * 3;
  for (let i = 0; i < RULES.holdMonths - 1; i++) g.endMonth();
  assert.equal(g.state.status, 'playing');
  assert.equal(g.holdProgress(), RULES.holdMonths - 1);
  g.endMonth();
  assert.equal(g.state.status, 'won');
});

// --- Mod B: tenants ------------------------------------------------------------

test('B: every unit is a let or empty, and tenants is the occupied count', () => {
  const g = new Game({ seed: 4, mods: { tenants: true } });
  for (let i = 0; i < 24; i++) g.endMonth();
  for (const p of g.state.properties) {
    assert.equal(p.lets.length, p.units);
    assert.equal(p.tenants, g.occupied(p));
    for (const l of p.lets) if (l && l.cls) assert.ok(CLASSES[l.cls]);
  }
});

test('B: asking rent changes only reach sitting tenants at review', () => {
  const g = rich(new Game({ seed: 4, mods: { tenants: true } }));
  const p = g.listings().find(q => q.units && q.tenants > 0 && q.lets.some(l => l && l.cls && l.cls !== 'council'));
  g.buy(p.id);
  const l = p.lets.find(x => x && x.cls && x.cls !== 'council');
  const before = l.rent;
  g.setRent(p.id, before * 0.5);
  assert.equal(l.rent, before, 'unchanged until review');
  l.review = g.state.month;
  g.endMonth();
  if (p.lets.includes(l)) assert.equal(l.rent, p.rent, 'moved to asking rent at review');
});

test('B: letting policy restricts who moves in', () => {
  const g = rich(new Game({ seed: 4, mods: { tenants: true } }));
  const p = g.listings().find(q => q.units >= 6 && q.condition >= 40 && g.district(q.district).desirability < 1);
  g.buy(p.id);
  p.lets = p.lets.map(() => null);
  g.setPolicy(p.id, 'council');
  for (let i = 0; i < 24; i++) g.endMonth();
  const moved = p.lets.filter(l => l && l.cls && l.since > 0);
  assert.ok(moved.length > 0, 'someone moved in');
  assert.ok(moved.every(l => l.cls === 'council'), 'only council placements');
});

test('B: evicting tenants in arrears voids the unit and costs reputation for families', () => {
  const g = rich(new Game({ seed: 4, mods: { tenants: true } }));
  const p = g.listings().find(q => q.units);
  g.buy(p.id);
  p.lets[0] = { cls: 'family', rent: 300, since: 0, review: 99, arrears: 1, owed: 300 };
  g.setArrearsPolicy(p.id, 'evict');
  const rep = g.state.reputation;
  g.endMonth();
  assert.equal(p.lets[0].cls, null, 'void after eviction');
  assert.ok(g.state.reputation < rep + 1, 'reputation hit');
  assert.ok(g.state.lastReport.evictions >= 1);
});

// --- Mod C: bricks and permission ------------------------------------------------

test('C: the town starts with vacant lots', () => {
  const g = new Game({ seed: 4, mods: { build: true } });
  assert.ok(g.state.properties.some(p => p.type === 'lot'));
});

test('C: demolish, apply, build and complete', () => {
  const g = rich(new Game({ seed: 4, mods: { build: true } }));
  const p = g.listings().find(q => q.units);
  g.buy(p.id);
  assert.ok(g.demolish(p.id).ok);
  assert.equal(p.type, 'lot');
  assert.equal(g.build(p.id, 'flats').ok, false, 'plot not ready the same month');
  g.endMonth();
  assert.ok(g.build(p.id, 'flats').ok);
  p.app.chance = 1;
  for (let i = 0; i < RULES.planningMonths; i++) g.endMonth();
  assert.ok(p.build, 'works started');
  assert.ok(g.state.lastReport.construction > 0, 'paying for works');
  // The first stage is paid in the approval month, so 11 more months finish it.
  for (let i = 0; i < 11; i++) g.endMonth();
  assert.equal(p.type, 'flats');
  assert.equal(p.units, 12);
  assert.equal(p.condition, 100);
});

test('C: refusal blocks the plot and an appeal can overturn it', () => {
  const g = rich(new Game({ seed: 4, mods: { build: true } }));
  const p = g.state.properties.find(q => q.type === 'lot');
  p.forSale = true;
  g.buy(p.id);
  g.build(p.id, 'tower');
  p.app.chance = 0;
  for (let i = 0; i < RULES.planningMonths; i++) g.endMonth();
  assert.ok(p.refused);
  assert.equal(g.build(p.id, 'terrace').ok, false, 'blocked after refusal');
  assert.ok(g.appeal(p.id).ok);
  p.app.chance = 1;
  for (let i = 0; i < RULES.appealMonths; i++) g.endMonth();
  assert.ok(p.build && p.build.to === 'tower');
});

test('C: conversion swaps terrace and bedsit', () => {
  const g = rich(new Game({ seed: 4, mods: { build: true } }));
  const p = g.state.properties.find(q => q.type === 'terrace');
  p.forSale = true;
  g.buy(p.id);
  assert.ok(g.convert(p.id).ok);
  p.app.chance = 1;
  for (let i = 0; i < RULES.planningMonths + 2; i++) g.endMonth();
  assert.equal(p.type, 'bedsit');
  assert.equal(p.units, 6);
});

test('C: neighbours affect local desirability', () => {
  const g = new Game({ seed: 4, mods: { build: true } });
  const p = g.state.properties[g.mapSize.width + 1];
  const around = g.state.properties.filter(q => Math.abs(q.x - p.x) <= 1 && Math.abs(q.y - p.y) <= 1 && q !== p);
  around.forEach(q => { if (q.type !== 'lot') q.condition = 100; });
  const good = g.localDesirability(p);
  around.forEach(q => { if (q.type !== 'lot') q.condition = 5; });
  const bad = g.localDesirability(p);
  assert.ok(good > bad);
});

test('C: donations improve relations; planning odds respond', () => {
  const g = rich(new Game({ seed: 4, mods: { build: true } }));
  const lot = g.state.properties.find(q => q.type === 'lot');
  const before = g.planningChance(lot, 'flats');
  assert.ok(g.donate(30000).ok);
  assert.ok(g.state.councilRelations > 50);
  assert.ok(g.planningChance(lot, 'flats') >= before);
});

test('all mods: a long game runs without errors and stays consistent', () => {
  for (let seed = 1; seed <= 3; seed++) {
    const g = new Game({ seed, years: 30, mods: ALL });
    g.state.goal = Infinity;
    while (!g.isOver()) g.endMonth();
    assert.ok(Number.isFinite(g.netWorth()));
    for (const p of g.state.properties) {
      assert.equal(p.units, g.types[p.type].units);
      if (p.lets) assert.equal(p.lets.length, p.units);
    }
  }
});
