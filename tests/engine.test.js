'use strict';
// Engine unit tests. Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { Game, targetFor, RULES } = require(path.join(__dirname, '..', 'game.js'));

const cheapestListing = (g) => g.listings().sort((a, b) => g.askingPrice(a) - g.askingPrice(b))[0];

test('same seed produces the same game', () => {
  const a = new Game({ seed: 42 }), b = new Game({ seed: 42 });
  for (let i = 0; i < 24; i++) { a.endMonth(); b.endMonth(); }
  assert.deepEqual(a.toJSON(), b.toJSON());
});

test('new game starts with the configured cash, length and target', () => {
  const g = new Game({ seed: 1, years: 25 });
  assert.equal(g.state.cash, RULES.startCash);
  assert.equal(g.maxMonths, 300);
  assert.equal(g.goal, targetFor(25));
  assert.equal(g.state.properties.length, g.mapSize.width * g.mapSize.height);
});

test('game length is clamped to 10..50 years', () => {
  assert.equal(new Game({ seed: 1, years: 3 }).state.years, 10);
  assert.equal(new Game({ seed: 1, years: 99 }).state.years, 50);
});

test('targets match the anchor table and interpolate between anchors', () => {
  assert.equal(targetFor(10), 1000000);
  assert.equal(targetFor(20), 6000000);
  assert.equal(targetFor(50), 31000000);
  assert.equal(targetFor(15), 3500000);
  for (let y = 11; y <= 50; y++) assert.ok(targetFor(y) > targetFor(y - 1), 'targets rise with length');
});

test('buying a listing spends the asking price and transfers ownership', () => {
  const g = new Game({ seed: 7 });
  const p = cheapestListing(g);
  const price = g.askingPrice(p);
  const r = g.buy(p.id);
  assert.ok(r.ok, r.message);
  assert.equal(g.state.cash, RULES.startCash - price);
  assert.ok(p.owned);
  assert.ok(!p.forSale);
  assert.equal(g.buy(p.id).ok, false, 'cannot buy twice');
});

test('cannot buy what is not listed or unaffordable', () => {
  const g = new Game({ seed: 7 });
  const unlisted = g.state.properties.find(p => !p.forSale);
  assert.equal(g.buy(unlisted.id).ok, false);
  const pricey = g.listings().find(p => g.askingPrice(p) > g.state.cash);
  if (pricey) assert.equal(g.buy(pricey.id).ok, false);
});

test('selling pays market value minus the fee', () => {
  const g = new Game({ seed: 7 });
  const p = cheapestListing(g);
  g.buy(p.id);
  const before = g.state.cash, proceeds = g.saleProceeds(p);
  assert.ok(g.sell(p.id).ok);
  assert.equal(g.state.cash, before + proceeds);
  assert.ok(!p.owned);
  assert.equal(g.sell(p.id).ok, false, 'cannot sell what you do not own');
});

test('rent is rounded to £5 and capped at 3x market', () => {
  const g = new Game({ seed: 7 });
  const p = cheapestListing(g);
  g.buy(p.id);
  g.setRent(p.id, 123);
  assert.equal(p.rent, 125);
  g.setRent(p.id, 1e9);
  assert.ok(p.rent <= g.marketRent(p) * 3);
  assert.equal(g.setRent(p.id, -5).ok, false);
});

test('higher rent means lower expected occupancy', () => {
  const g = new Game({ seed: 7 });
  const p = g.state.properties[0];
  const mr = g.marketRent(p);
  assert.ok(g.expectedOccupancy(p, mr * 0.7) >= g.expectedOccupancy(p, mr));
  assert.ok(g.expectedOccupancy(p, mr) > g.expectedOccupancy(p, mr * 1.5));
  assert.equal(g.expectedOccupancy(p, mr * 3), 0);
});

test('repairs cost money and improve condition', () => {
  const g = new Game({ seed: 7 });
  const p = cheapestListing(g);
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
  const g = new Game({ seed: 7 });
  assert.equal(g.borrow(g.creditLimit() + 1000).ok, false);
  assert.ok(g.borrow(20000).ok);
  assert.equal(g.state.loan, 20000);
  assert.ok(g.repay(5000).ok);
  assert.equal(g.state.loan, 15000);
  assert.equal(g.state.cash, RULES.startCash + 15000);
});

test('ending a month advances time and records history', () => {
  const g = new Game({ seed: 7 });
  const r = g.endMonth();
  assert.ok(r.ok);
  assert.equal(g.state.month, 1);
  assert.equal(g.state.history.length, 2);
  assert.ok(g.state.lastReport);
});

test('reaching the target wins; running out of time retires', () => {
  const g = new Game({ seed: 7 });
  g.state.cash = g.goal + 1e6;
  g.endMonth();
  assert.equal(g.state.status, 'won');
  assert.equal(g.endMonth().ok, false, 'no moves after the game ends');

  const t = new Game({ seed: 7 });
  t.state.month = t.maxMonths - 1;
  t.endMonth();
  assert.equal(t.state.status, 'retired');
});

test('debt beyond cash and credit means bankruptcy', () => {
  const g = new Game({ seed: 7 });
  g.state.loan = g.creditLimit();
  g.state.cash = -100000;
  g.endMonth();
  assert.equal(g.state.status, 'bankrupt');
});

test('save and restore continues identically', () => {
  const a = new Game({ seed: 9, years: 20 });
  for (let i = 0; i < 12; i++) a.endMonth();
  const b = Game.fromJSON(JSON.stringify(a.toJSON()));
  for (let i = 0; i < 12; i++) { a.endMonth(); b.endMonth(); }
  assert.deepEqual(a.toJSON(), b.toJSON());
});

test('version 1 saves load as 10-year games', () => {
  const s = JSON.parse(JSON.stringify(new Game({ seed: 3 }).toJSON()));
  s.version = 1;
  delete s.years; delete s.goal; delete s.maxMonths;
  const g = Game.fromJSON(s);
  assert.equal(g.state.years, 10);
  assert.equal(g.goal, targetFor(10));
  assert.equal(g.monthsLeft(), 120);
  assert.throws(() => Game.fromJSON({ version: 99 }));
});
