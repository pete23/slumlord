/*
 * Rent Baron — game engine.
 *
 * Pure game state and rules. No DOM access, no rendering, no storage.
 * Everything the UI needs is exposed through the Game class; state is a
 * plain JSON-serialisable object so it can be saved and restored.
 *
 * Works in the browser (exposes window.RentBaron) and in Node (module.exports).
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Static data
  // ---------------------------------------------------------------------------

  const TYPES = {
    terrace: { label: 'Terrace',      units: 2,  baseValue: 48000,  baseRent: 520, upkeep: 20 },
    bedsit:  { label: 'Bedsit house', units: 6,  baseValue: 72000,  baseRent: 290, upkeep: 16 },
    flats:   { label: 'Flats',        units: 12, baseValue: 190000, baseRent: 460, upkeep: 15 },
    tower:   { label: 'Tower block',  units: 30, baseValue: 470000, baseRent: 390, upkeep: 13 },
  };

  // District letters used in MAP below.
  const DISTRICTS = {
    G: { name: 'Gasworks',    desirability: 0.60, crime: 0.07, types: { tower: 4, bedsit: 4, flats: 1 },
         streets: ['Cinder Row', 'Coke Lane', 'Furnace St', 'Slag Yard', 'Retort Rd'] },
    O: { name: 'Old Quarter', desirability: 0.85, crime: 0.04, types: { bedsit: 4, terrace: 3, flats: 1 },
         streets: ['Tanner St', 'Cobble Way', 'Chapel Walk', 'Mill Lane', 'Weaver Ct'] },
    M: { name: 'Market Hill', desirability: 1.00, crime: 0.03, types: { flats: 3, terrace: 3, bedsit: 1 },
         streets: ['Corn Exchange', 'Butter Row', 'Fair St', 'Guild Rd', 'Hay Market'] },
    R: { name: 'Riverside',   desirability: 0.90, crime: 0.035, types: { flats: 3, tower: 2, terrace: 1 },
         streets: ['Wharf Rd', 'Lock St', 'Quay Side', 'Barge Walk', 'Ferry Lane'] },
    P: { name: 'Parkview',    desirability: 1.35, crime: 0.01, types: { terrace: 4, flats: 2 },
         streets: ['Elm Avenue', 'Lime Grove', 'Bandstand Rd', 'Rose Crescent', 'Oak Mews'] },
  };

  const MAP = [
    'GGGOOOMM',
    'GGGOOMMM',
    'GGOOOMMP',
    'RRROMMPP',
    'RRRRPPPP',
    'RRRRPPPP',
  ];

  const RULES = {
    startCash: 50000,
    startRep: 50,
    minYears: 10,
    maxYears: 50,
    defaultYears: 10,
    interestRate: 0.075,      // annual, on the bank loan
    creditBase: 40000,
    creditLtv: 0.75,          // share of portfolio value the bank will lend against
    sellFee: 0.05,
    propertyTax: 0.0008,     // monthly, share of value
    repairCostRate: 0.0025,  // cost per condition point = baseValue * rate * market index
    patchPoints: 15,
    patchPremium: 1.15,
    startYear: 1987,
  };

  // Net-worth target per game length, from simulated play by a competent
  // rule-following bot (roughly half of its games reach the target).
  // Lengths in between are interpolated.
  const TARGETS = [
    [10, 1000000],
    [20, 6000000],
    [30, 15000000],
    [40, 23000000],
    [50, 31000000],
  ];

  function targetFor(years) {
    const y = clamp(Math.round(years), RULES.minYears, RULES.maxYears);
    for (let i = 1; i < TARGETS.length; i++) {
      const [y0, t0] = TARGETS[i - 1], [y1, t1] = TARGETS[i];
      if (y <= y1) return round(t0 + (t1 - t0) * (y - y0) / (y1 - y0), 50000);
    }
    return TARGETS[TARGETS.length - 1][1];
  }

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const round = (v, step) => Math.round(v / step) * step;

  function ok(message, data) { return { ok: true, message: message || '', data: data }; }
  function fail(message) { return { ok: false, message: message }; }

  // ---------------------------------------------------------------------------
  // Game
  // ---------------------------------------------------------------------------

  class Game {
    /**
     * @param {object} [opts]
     * @param {number} [opts.seed]   RNG seed for reproducible games
     * @param {number} [opts.years]  game length, 10..50 years
     * @param {object} [opts.state]  restore from a previously serialised state
     */
    constructor(opts) {
      opts = opts || {};
      if (opts.state) {
        this.s = JSON.parse(JSON.stringify(opts.state));
      } else {
        const seed = (opts.seed != null ? opts.seed : Math.floor(Math.random() * 2 ** 31)) | 0;
        const years = clamp(Math.round(opts.years || RULES.defaultYears), RULES.minYears, RULES.maxYears);
        this.s = this._newState(seed, years);
      }
    }

    static fromJSON(json) {
      const state = typeof json === 'string' ? JSON.parse(json) : json;
      if (!state || (state.version !== 1 && state.version !== 2)) throw new Error('Unrecognised save data');
      if (state.version === 1) {
        // v1 saves were always 10-year games.
        state.version = 2;
        state.years = 10;
        state.maxMonths = 120;
        state.goal = targetFor(10);
      }
      return new Game({ state });
    }

    toJSON() { return this.s; }

    // --- RNG (mulberry32, state kept in this.s so saves are deterministic) ---
    _rand() {
      let t = (this.s.rng = (this.s.rng + 0x6D2B79F5) | 0);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    _range(lo, hi) { return lo + (hi - lo) * this._rand(); }
    _int(lo, hi) { return Math.floor(this._range(lo, hi + 1)); }
    _pick(arr) { return arr[Math.floor(this._rand() * arr.length)]; }
    _chance(p) { return this._rand() < p; }
    _weighted(weights) {
      const entries = Object.entries(weights);
      let total = 0;
      for (const [, w] of entries) total += w;
      let r = this._rand() * total;
      for (const [k, w] of entries) { if ((r -= w) < 0) return k; }
      return entries[entries.length - 1][0];
    }

    // --- Setup ---------------------------------------------------------------
    _newState(seed, years) {
      this.s = {
        version: 2,
        seed,
        years,
        maxMonths: years * 12,
        goal: targetFor(years),
        rng: seed,
        month: 0,
        cash: RULES.startCash,
        loan: 0,
        reputation: RULES.startRep,
        marketIndex: 1,
        status: 'playing',       // playing | won | bankrupt | retired
        districts: {},
        properties: [],
        log: [],
        history: [],
        lastReport: null,
      };
      const s = this.s;

      for (const [key, d] of Object.entries(DISTRICTS)) {
        s.districts[key] = { key, name: d.name, desirability: d.desirability, trend: 0 };
      }

      const usedAddr = new Set();
      let id = 0;
      MAP.forEach((row, y) => {
        [...row].forEach((dk, x) => {
          const d = DISTRICTS[dk];
          const type = this._weighted(d.types);
          const t = TYPES[type];
          let address;
          do { address = this._int(1, 99) + ' ' + this._pick(d.streets); } while (usedAddr.has(address));
          usedAddr.add(address);
          const p = {
            id: id++, x, y, district: dk, type, address,
            units: t.units,
            condition: Math.round(clamp(this._range(25, 92) + (d.desirability - 1) * 25, 10, 98)),
            owned: false,
            forSale: this._chance(0.3),
            askMult: this._range(0.95, 1.15),
            cooldown: 0,
            rent: 0,
            tenants: 0,
            boughtFor: 0,
            boughtMonth: 0,
          };
          p.rent = round(this.marketRent(p) * this._range(0.85, 1.05), 5);
          p.tenants = Math.round(p.units * this._range(0.4, 0.95));
          s.properties.push(p);
        });
      });

      this._log('You arrive in town with ' + fmt(s.cash) + ' and big ideas.', 'info');
      this._log('Goal: a net worth of ' + fmt(s.goal) + ' within ' + years + ' years.', 'info');
      s.history.push(this.netWorth());
      return s;
    }

    _log(text, kind) {
      this.s.log.push({ month: this.s.month, text, kind: kind || 'info' });
      if (this.s.log.length > 300) this.s.log.splice(0, this.s.log.length - 300);
    }

    // --- Read-only queries ---------------------------------------------------
    get state() { return this.s; }
    get rules() { return RULES; }
    get types() { return TYPES; }
    get goal() { return this.s.goal; }
    get maxMonths() { return this.s.maxMonths; }
    get mapSize() { return { width: MAP[0].length, height: MAP.length }; }

    dateLabel(month) {
      const m = month == null ? this.s.month : month;
      return MONTHS[m % 12] + ' ' + (RULES.startYear + Math.floor(m / 12));
    }
    monthsLeft() { return this.s.maxMonths - this.s.month; }
    isOver() { return this.s.status !== 'playing'; }

    property(id) { return this.s.properties[id] || null; }
    district(key) { return this.s.districts[key]; }
    portfolio() { return this.s.properties.filter(p => p.owned); }
    listings() { return this.s.properties.filter(p => !p.owned && p.forSale); }

    /** Fair monthly rent per unit given district, condition and type. */
    marketRent(p) {
      const t = TYPES[p.type];
      const d = this.s.districts[p.district];
      // Rent is less sensitive to district than value is: rough areas yield more.
      const r = t.baseRent * Math.pow(d.desirability, 0.55) * (0.5 + p.condition / 200) *
        (0.85 + 0.15 * this.s.marketIndex);
      return Math.max(5, round(r, 5));
    }

    /** Market value of the property right now. */
    value(p) {
      const t = TYPES[p.type];
      const d = this.s.districts[p.district];
      const v = t.baseValue * d.desirability * (0.55 + 0.45 * p.condition / 100) * this.s.marketIndex;
      return round(v, 100);
    }

    askingPrice(p) { return round(this.value(p) * p.askMult, 100); }
    saleProceeds(p) { return round(this.value(p) * (1 - RULES.sellFee), 100); }

    repairCostPerPoint(p) {
      return TYPES[p.type].baseValue * RULES.repairCostRate * this.s.marketIndex;
    }
    patchCost(p) {
      const pts = Math.min(RULES.patchPoints, 100 - p.condition);
      return round(pts * this.repairCostPerPoint(p) * RULES.patchPremium, 10);
    }
    refurbCost(p) {
      return round((100 - p.condition) * this.repairCostPerPoint(p), 10);
    }

    /** Monthly running costs for an owned property (excluding random events). */
    runningCost(p) {
      return Math.round(TYPES[p.type].upkeep * p.units + this.value(p) * RULES.propertyTax);
    }

    /**
     * Long-run share of units (0..1) tenants will fill at a given rent
     * (defaults to the current rent), given condition and your reputation.
     */
    expectedOccupancy(p, rent) {
      const r = rent == null ? p.rent : rent;
      const ratio = r / this.marketRent(p);
      return clamp(clamp(1.55 - 0.75 * ratio, 0, 1) * (0.8 + 0.4 * this.s.reputation / 100), 0, 1);
    }

    /** Projected monthly net income at current occupancy. */
    projectedNet(p) { return p.tenants * p.rent - this.runningCost(p); }

    portfolioValue() {
      let v = 0;
      for (const p of this.s.properties) if (p.owned) v += this.value(p);
      return v;
    }
    netWorth() { return this.s.cash + this.portfolioValue() - this.s.loan; }
    creditLimit() { return round(RULES.creditBase + RULES.creditLtv * this.portfolioValue(), 100); }
    availableCredit() { return Math.max(0, this.creditLimit() - this.s.loan); }
    monthlyInterest() { return Math.round(this.s.loan * RULES.interestRate / 12); }

    // --- Player actions ------------------------------------------------------
    _guard(id, mustOwn) {
      if (this.isOver()) return { err: fail('The game is over.') };
      const p = this.property(id);
      if (!p) return { err: fail('No such property.') };
      if (mustOwn && !p.owned) return { err: fail('You do not own ' + p.address + '.') };
      return { p };
    }

    buy(id) {
      const { p, err } = this._guard(id, false);
      if (err) return err;
      if (p.owned) return fail('You already own ' + p.address + '.');
      if (!p.forSale) return fail(p.address + ' is not on the market.');
      const price = this.askingPrice(p);
      if (price > this.s.cash) return fail('You need ' + fmt(price) + ' but have ' + fmt(this.s.cash) + '. Try the bank.');
      this.s.cash -= price;
      p.owned = true;
      p.forSale = false;
      p.boughtFor = price;
      p.boughtMonth = this.s.month;
      this._log('Bought ' + p.address + ' (' + TYPES[p.type].label + ') for ' + fmt(price) + '.', 'buy');
      return ok('Bought ' + p.address + '.');
    }

    sell(id) {
      const { p, err } = this._guard(id, true);
      if (err) return err;
      const proceeds = this.saleProceeds(p);
      this.s.cash += proceeds;
      p.owned = false;
      p.forSale = false;
      p.cooldown = 6;
      const gain = proceeds - p.boughtFor;
      this._log('Sold ' + p.address + ' for ' + fmt(proceeds) + ' (' + (gain >= 0 ? 'profit ' : 'loss ') + fmt(Math.abs(gain)) + ').', 'sell');
      return ok('Sold ' + p.address + '.');
    }

    setRent(id, amount) {
      const { p, err } = this._guard(id, true);
      if (err) return err;
      const n = Number(amount);
      if (!Number.isFinite(n) || n < 0) return fail('Rent must be a positive number.');
      const max = this.marketRent(p) * 3;
      const rent = round(clamp(n, 0, max), 5);
      if (rent === p.rent) return ok('Rent unchanged.');
      const old = p.rent;
      p.rent = rent;
      this._log('Rent at ' + p.address + ' ' + (rent > old ? 'raised' : 'cut') + ' to ' + fmt(rent) + '/unit.', 'info');
      return ok('Rent set to ' + fmt(rent) + '.');
    }

    repair(id, kind) {
      const { p, err } = this._guard(id, true);
      if (err) return err;
      if (p.condition >= 100) return fail(p.address + ' is already in perfect condition.');
      if (kind !== 'patch' && kind !== 'refurb') return fail('Unknown repair type.');
      const cost = kind === 'patch' ? this.patchCost(p) : this.refurbCost(p);
      if (cost > this.s.cash) return fail('That costs ' + fmt(cost) + '; you have ' + fmt(this.s.cash) + '.');
      this.s.cash -= cost;
      if (kind === 'patch') {
        p.condition = Math.min(100, p.condition + RULES.patchPoints);
        this._log('Patched up ' + p.address + ' for ' + fmt(cost) + '.', 'repair');
      } else {
        p.condition = 100;
        // Building works drive some tenants out.
        const leaving = Math.floor(p.tenants * 0.4);
        p.tenants -= leaving;
        this._log('Full refurbishment of ' + p.address + ' for ' + fmt(cost) +
          (leaving ? '; ' + leaving + ' tenant' + (leaving > 1 ? 's' : '') + ' moved out during the works.' : '.'), 'repair');
      }
      return ok('Repairs done.');
    }

    borrow(amount) {
      if (this.isOver()) return fail('The game is over.');
      const n = round(Number(amount), 100);
      if (!Number.isFinite(n) || n <= 0) return fail('Enter an amount to borrow.');
      const avail = this.availableCredit();
      if (n > avail) return fail('The bank will only lend you another ' + fmt(avail) + '.');
      this.s.loan += n;
      this.s.cash += n;
      this._log('Borrowed ' + fmt(n) + ' from the bank.', 'bank');
      return ok('Borrowed ' + fmt(n) + '.');
    }

    repay(amount) {
      if (this.isOver()) return fail('The game is over.');
      let n = Number(amount);
      if (!Number.isFinite(n) || n <= 0) return fail('Enter an amount to repay.');
      n = Math.min(Math.round(n), this.s.loan, Math.floor(this.s.cash));
      if (n <= 0) return fail(this.s.loan ? 'You have no cash to repay with.' : 'You have no loan.');
      this.s.loan -= n;
      this.s.cash -= n;
      this._log('Repaid ' + fmt(n) + ' to the bank.', 'bank');
      return ok('Repaid ' + fmt(n) + '.');
    }

    /** Cash out and end the game early. */
    retire() {
      if (this.isOver()) return fail('The game is over.');
      this.s.status = 'retired';
      this._log('You retire with a net worth of ' + fmt(this.netWorth()) + '.', 'end');
      return ok('Retired.');
    }

    // --- Turn ----------------------------------------------------------------
    endMonth() {
      if (this.isOver()) return fail('The game is over.');
      const s = this.s;
      const report = { rent: 0, upkeep: 0, tax: 0, incidents: 0, interest: 0, net: 0, moveIns: 0, moveOuts: 0 };

      this._tickMarket();
      this._tickDistricts();

      for (const p of s.properties) {
        if (p.owned) this._tickOwned(p, report);
        else this._tickUnowned(p);
      }

      report.interest = this.monthlyInterest();
      s.cash -= report.interest;
      report.net = report.rent - report.upkeep - report.tax - report.incidents - report.interest;

      this._tickReputation();
      this._settleCash();

      s.month += 1;
      s.lastReport = report;
      s.history.push(this.netWorth());

      if (s.status === 'playing') {
        const nw = this.netWorth();
        if (nw >= s.goal) {
          s.status = 'won';
          this._log('You are a Rent Baron! Net worth ' + fmt(nw) + ' in ' + s.month + ' months.', 'end');
        } else if (s.month >= s.maxMonths) {
          s.status = 'retired';
          this._log('Time is up. You finish with a net worth of ' + fmt(nw) + '.', 'end');
        }
      }
      return ok('Month ended.', report);
    }

    _tickMarket() {
      const s = this.s;
      let drift = this._range(-0.011, 0.019);
      if (this._chance(0.015)) {
        drift = -this._range(0.08, 0.15);
        this._log('Property crash! House prices tumble across town.', 'bad');
      } else if (this._chance(0.02)) {
        drift = this._range(0.04, 0.08);
        this._log('Property boom: buyers are queueing round the block.', 'good');
      }
      // Gentle pull towards a long-run level keeps 50-year games from pinning at the cap.
      drift += (1.15 - s.marketIndex) * 0.006;
      s.marketIndex = clamp(s.marketIndex * (1 + drift), 0.6, 1.9);
    }

    _tickDistricts() {
      for (const d of Object.values(this.s.districts)) {
        const base = DISTRICTS[d.key].desirability;
        d.trend = clamp(d.trend * 0.9 + this._range(-0.004, 0.004), -0.02, 0.02);
        // Mean-revert gently towards the district's natural level.
        d.desirability += d.trend + (base - d.desirability) * 0.01;
        if (this._chance(0.006)) {
          d.desirability += 0.15;
          this._log(d.name + ' is suddenly fashionable. Coffee shops are opening.', 'good');
        } else if (this._chance(0.006)) {
          d.desirability -= 0.12;
          this._log('A factory closes in ' + d.name + '. The area takes a hit.', 'bad');
        }
        d.desirability = clamp(d.desirability, 0.4, 1.9);
      }
    }

    _tickUnowned(p) {
      p.condition = clamp(p.condition - this._range(0.2, 0.9), 5, 100);
      // Other landlords occasionally fix their places up.
      if (p.condition < 35 && this._chance(0.06)) p.condition = clamp(p.condition + this._range(25, 50), 0, 100);
      if (p.cooldown > 0) { p.cooldown--; return; }
      if (p.forSale) {
        if (this._chance(0.07)) p.forSale = false;
      } else if (this._chance(0.045)) {
        p.forSale = true;
        p.askMult = this._range(0.93, 1.15);
      }
      // Keep unowned buildings' tenancy roughly realistic so purchases inherit tenants.
      p.rent = round(this.marketRent(p) * this._range(0.85, 1.05), 5);
      const target = Math.round(p.units * this._range(0.5, 0.95));
      p.tenants += Math.sign(target - p.tenants);
    }

    _tickOwned(p, r) {
      const s = this.s;
      const d = s.districts[p.district];
      const t = TYPES[p.type];
      const label = p.address;

      // Tenancy: tenants respond to price relative to market and to your reputation.
      const ratio = p.rent / this.marketRent(p);
      const desired = this.expectedOccupancy(p) * p.units;
      let moveIn = 0, moveOut = 0;
      if (desired > p.tenants) {
        const gap = desired - p.tenants;
        moveIn = Math.round(gap * this._range(0.3, 0.8));
        if (moveIn === 0 && gap >= 0.5 && this._chance(0.6)) moveIn = 1;
      } else if (desired < p.tenants) {
        const gap = p.tenants - desired;
        moveOut = Math.round(gap * this._range(0.2, 0.6));
        if (moveOut === 0 && gap >= 1 && this._chance(0.5)) moveOut = 1;
      }
      // Natural churn.
      for (let i = 0; i < p.tenants - moveOut; i++) if (this._chance(0.012)) moveOut++;
      p.tenants = clamp(p.tenants + moveIn - moveOut, 0, p.units);
      r.moveIns += moveIn;
      r.moveOuts += moveOut;

      // Income and fixed costs.
      let rent = p.tenants * p.rent;
      const upkeep = t.upkeep * p.units;
      const tax = Math.round(this.value(p) * RULES.propertyTax);
      let incident = 0;

      // Wear and tear.
      const occ = p.units ? p.tenants / p.units : 0;
      p.condition = clamp(p.condition - (0.2 + 0.5 * occ + this._range(0, 0.3)), 0, 100);

      // Random events.
      const wear = (100 - p.condition) / 100;
      if (p.tenants > 0 && ratio > 1.25 && this._chance(0.12)) {
        rent = 0;
        s.reputation -= 3;
        this._log('Rent strike at ' + label + '! Tenants refuse to pay this month.', 'bad');
      }
      if (this._chance(0.015 + wear * 0.04)) {
        const c = Math.round(p.units * this._range(60, 180));
        incident += c;
        p.condition = clamp(p.condition - 4, 0, 100);
        this._log('Burst pipes at ' + label + '. Plumber\'s bill: ' + fmt(c) + '.', 'bad');
      }
      if (this._chance(p.condition < 30 ? 0.02 : 0.002)) {
        const c = Math.round(this.value(p) * 0.04);
        incident += c;
        p.condition = clamp(p.condition - 30, 0, 100);
        const fled = Math.ceil(p.tenants / 2);
        p.tenants -= fled;
        s.reputation -= 6;
        this._log('Fire at ' + label + '! ' + fled + ' tenant' + (fled === 1 ? '' : 's') + ' left; damage costs ' + fmt(c) + '.', 'bad');
      }
      if (p.condition < 25 && this._chance(0.12)) {
        const c = 600 * p.units;
        incident += c;
        s.reputation -= 4;
        this._log('Council inspectors condemn conditions at ' + label + '. Fined ' + fmt(c) + '.', 'bad');
      }
      if (this._chance(DISTRICTS[p.district].crime * (d.desirability < 0.8 ? 1.3 : 1))) {
        const c = Math.round(this._range(300, 1500));
        incident += c;
        p.condition = clamp(p.condition - 6, 0, 100);
        this._log('Vandals hit ' + label + '. Clean-up costs ' + fmt(c) + '.', 'bad');
      }
      if (p.tenants === 0 && this._chance(0.06)) {
        const c = 1500;
        incident += c;
        p.condition = clamp(p.condition - 8, 0, 100);
        this._log('Squatters moved into empty ' + label + '. Evicting them costs ' + fmt(c) + '.', 'bad');
      }
      if (p.condition > 85 && p.tenants === p.units && this._chance(0.03)) {
        s.reputation += 2;
        this._log('The local paper praises ' + label + ' as a model rental.', 'good');
      }

      s.cash += rent - upkeep - tax - incident;
      r.rent += rent;
      r.upkeep += upkeep;
      r.tax += tax;
      r.incidents += incident;
    }

    _tickReputation() {
      const s = this.s;
      const owned = this.portfolio();
      if (owned.length) {
        let units = 0, cond = 0, ratio = 0;
        for (const p of owned) {
          units += p.units;
          cond += p.condition * p.units;
          ratio += (p.rent / this.marketRent(p)) * p.units;
        }
        cond /= units;
        ratio /= units;
        s.reputation += (cond - 50) / 100;
        if (ratio > 1.15) s.reputation -= (ratio - 1.15) * 3;
        if (ratio < 0.9) s.reputation += 0.3;
      }
      s.reputation += (50 - s.reputation) * 0.01;
      s.reputation = clamp(s.reputation, 0, 100);
    }

    _settleCash() {
      const s = this.s;
      if (s.cash >= 0) return;
      const need = round(-s.cash + 50, 100);
      if (need <= this.availableCredit()) {
        s.loan += need;
        s.cash += need;
        this._log('Overdrawn: the bank added ' + fmt(need) + ' to your loan.', 'bank');
        return;
      }
      // Fire-sale properties, cheapest first, until solvent.
      const owned = this.portfolio().sort((a, b) => this.value(a) - this.value(b));
      for (const p of owned) {
        if (s.cash >= 0) break;
        const proceeds = round(this.value(p) * 0.75, 100);
        s.cash += proceeds;
        p.owned = false;
        p.forSale = false;
        p.cooldown = 6;
        this._log('Bailiffs seize ' + p.address + ' and sell it for ' + fmt(proceeds) + '.', 'bad');
      }
      if (s.cash < 0 && -s.cash <= this.availableCredit()) {
        const n = round(-s.cash + 50, 100);
        s.loan += n;
        s.cash += n;
      }
      if (s.cash < 0 || (this.portfolio().length === 0 && this.netWorth() < 0)) {
        s.status = 'bankrupt';
        this._log('You are bankrupt. The bank takes everything.', 'end');
      }
    }
  }

  function fmt(n) {
    const sign = n < 0 ? '-' : '';
    return sign + '£' + Math.round(Math.abs(n)).toLocaleString('en-GB');
  }

  const api = { Game, TYPES, DISTRICTS, RULES, MAP, targetFor, formatMoney: fmt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RentBaron = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
