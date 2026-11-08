/*
 * Rent Baron — game engine.
 *
 * Pure game state and rules. No DOM access, no rendering, no storage.
 * Everything the UI needs is exposed through the Game class; state is a
 * plain JSON-serialisable object so it can be saved and restored.
 *
 * Three optional rule modules (see docs/design/mods.md), chosen per game:
 *   A  bank     — base-rate cycle, variable/fixed loans, monthly LTV covenant
 *   B  tenants  — discrete lets by tenant class, reviews, arrears, policies
 *   C  build    — plots, demolition, construction, planning, neighbour effects
 * With all three off the rules are the original "classic" game.
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
    lot:     { label: 'Vacant lot',   units: 0,  baseValue: 0,      baseRent: 0,   upkeep: 0 },
  };
  const BUILDABLE = ['terrace', 'bedsit', 'flats', 'tower'];

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
    interestRate: 0.075,      // classic: annual, on the bank loan
    creditBase: 40000,
    creditLtv: 0.75,          // classic: share of portfolio value the bank will lend against
    sellFee: 0.05,
    propertyTax: 0.0008,     // monthly, share of value
    repairCostRate: 0.0025,  // cost per condition point = baseValue * rate * market index
    patchPoints: 15,
    patchPremium: 1.15,
    startYear: 1987,
    // Mod A: bank
    startBaseRate: 0.07,
    minBaseRate: 0.04,
    maxBaseRate: 0.16,
    variableMargin: 0.025,
    fixedMargin: 0.035,
    breakFee: 0.03,
    fixYears: [2, 5],
    covenantMonths: 6,
    ltvLoose: 0.75,          // max LTV at base rate <= 6%
    ltvTight: 0.50,          // max LTV at base rate >= 14%
    seizeDiscount: 0.70,
    holdMonths: 12,
    minCover: 1.25,          // Mod A: interest-cover covenant          // Mod A: the target must be held this long to win
    rateTarget: 0.08,        // long-run base rate
    cycleYears: [6, 10],     // credit-cycle length range
    cycleAmp: [0.035, 0.065], // credit-cycle amplitude range
    rateFollow: 0.08,        // monthly pull of the base rate towards the cycle target
    rateBoomPressure: 0.02,  // extra target per unit of (fast - slow average market index)
    rateLag: 0.05,           // EMA weight, fast average (~20 months)
    rateTrendLag: 0.01,      // EMA weight, slow average (~8 years)
    rateShock: 0.006,        // monthly chance of a surprise move
    rateCoupling: 0.30,      // market drift per unit of (rateTarget - base rate)
    // Mod B: tenants
    emptyCharge: 15,         // per empty unit per month
    chaseFee: 150,
    evictFee: 800,
    evictVoidMonths: 2,
    // Mod C: build
    demolishRate: 0.05,      // of base value
    buildRate: 0.85,         // of base value, paid over the build
    landValue: 24000,
    applicationFee: 1000,
    planningMonths: 2,
    appealFee: 5000,
    appealMonths: 6,
    refusalBlock: 12,
  };

  const MOD_KEYS = ['bank', 'tenants', 'build'];
  const MOD_INFO = {
    bank:    { letter: 'A', label: 'Bank moods',    blurb: 'Base rate cycles; covenant tested monthly; fix your rate.' },
    tenants: { letter: 'B', label: 'Tenant faces',  blurb: 'Tenant classes, rent reviews, arrears and evictions.' },
    build:   { letter: 'C', label: 'Bricks & permission', blurb: 'Demolish, build, convert; planning; neighbours matter.' },
  };

  const CLASSES = {
    student:   { label: 'Students',       ceiling: 1.15, wear: 1.8, arrears: 0.020, churn: 0.008, summer: 0.55, raiseSens: 0.5, evictRep: 0 },
    family:    { label: 'Families',       ceiling: 1.10, wear: 1.0, arrears: 0.008, churn: 0.005, raiseSens: 1.5, evictRep: -4, minCond: 40 },
    pro:       { label: 'Professionals',  ceiling: 1.45, wear: 0.7, arrears: 0.003, churn: 0.012, raiseSens: 1.0, evictRep: -1, minCond: 70, minDes: 0.9 },
    pensioner: { label: 'Pensioners',     ceiling: 0.90, wear: 0.5, arrears: 0.002, churn: 0.003, raiseSens: 3.0, evictRep: -10 },
    council:   { label: 'Council-placed', ceiling: Infinity, wear: 1.3, arrears: 0, churn: 0.005, raiseSens: 0, evictRep: -3, council: true },
  };
  const CLASS_KEYS = Object.keys(CLASSES);

  // Applicant mix by district, then scaled by building type.
  const CLASS_MIX = {
    G: { student: 1,   family: 2, pro: 0.2, pensioner: 1,   council: 3 },
    O: { student: 3,   family: 2, pro: 0.6, pensioner: 1.5, council: 1 },
    M: { student: 1.5, family: 2, pro: 2,   pensioner: 1,   council: 0.5 },
    R: { student: 1,   family: 2, pro: 2,   pensioner: 1,   council: 1 },
    P: { student: 0.3, family: 3, pro: 2.5, pensioner: 2,   council: 0.1 },
  };
  const TYPE_MIX = {
    terrace: { family: 2, student: 0.8, council: 0.3 },
    bedsit:  { student: 2.5, family: 0.4, pensioner: 0.6 },
    flats:   { pro: 1.6 },
    tower:   { council: 2, pro: 0.4, family: 0.8 },
  };

  const POLICIES = {
    any:        { label: 'Anyone (private)', allows: c => c !== 'council' },
    nostudents: { label: 'No students',      allows: c => c !== 'council' && c !== 'student' },
    pros:       { label: 'Professionals only', allows: c => c === 'pro' },
    council:    { label: 'Council placements', allows: c => c === 'council' },
  };
  const ARREARS_POLICIES = {
    tolerate: 'Tolerate',
    chase:    'Chase',
    evict:    'Evict',
  };

  // Planning approval odds by district and building type (before reputation/relations).
  const PLANNING = {
    G: { terrace: 0.90, bedsit: 0.90, flats: 0.90, tower: 0.85 },
    O: { terrace: 0.80, bedsit: 0.75, flats: 0.60, tower: 0.25 },
    M: { terrace: 0.85, bedsit: 0.60, flats: 0.75, tower: 0.30 },
    R: { terrace: 0.85, bedsit: 0.70, flats: 0.85, tower: 0.60 },
    P: { terrace: 0.90, bedsit: 0.25, flats: 0.55, tower: 0.03 },
  };
  const BUILD_MONTHS = { terrace: 6, bedsit: 6, flats: 12, tower: 18 };
  const CONVERSIONS = {
    terrace: { to: 'bedsit',  months: 2, rate: 0.15 },  // HMO conversion
    bedsit:  { to: 'terrace', months: 2, rate: 0.20 },  // the gentrifier's reverse
  };

  // Net-worth target per game length and rule set, from simulated play by a
  // competent ("prudent") bot: roughly half its games reach the target.
  // Keyed by mod letters, e.g. 'ABC'. Lengths in between are interpolated.
  // Regenerate with: npm run balance -- --derive --all
  const TARGETS = {
    '':    [[10, 1000000], [20, 6000000], [30, 15000000], [40, 23000000], [50, 31000000]],
    A:     [[10, 700000], [20, 5500000], [30, 20000000], [40, 52000000], [50, 80000000]],
    B:     [[10, 250000], [20, 900000], [30, 3000000], [40, 10000000], [50, 20000000]],
    C:     [[10, 700000], [20, 6500000], [30, 18000000], [40, 29000000], [50, 42000000]],
    AB:    [[10, 400000], [20, 1900000], [30, 6500000], [40, 19000000], [50, 48000000]],
    AC:    [[10, 800000], [20, 4500000], [30, 25000000], [40, 59000000], [50, 106000000]],
    BC:    [[10, 300000], [20, 1100000], [30, 4500000], [40, 12000000], [50, 22000000]],
    ABC:   [[10, 300000], [20, 1000000], [30, 3000000], [40, 6500000], [50, 23000000]],
  };

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const round = (v, step) => Math.round(v / step) * step;
  const bp = (r) => Math.round(r * 400) / 400; // quarter-point rounding for rates

  function ok(message, data) { return { ok: true, message: message || '', data: data }; }
  function fail(message) { return { ok: false, message: message }; }

  function normMods(m) {
    const o = {};
    for (const k of MOD_KEYS) o[k] = !!(m && m[k]);
    return o;
  }
  function modSig(m) { return MOD_KEYS.filter(k => m[k]).map(k => MOD_INFO[k].letter).join(''); }

  function targetFor(years, mods) {
    const sig = mods == null ? 'ABC' : (typeof mods === 'string' ? mods : modSig(normMods(mods)));
    const table = TARGETS[sig] || TARGETS[''];
    const y = clamp(Math.round(years), RULES.minYears, RULES.maxYears);
    for (let i = 1; i < table.length; i++) {
      const [y0, t0] = table[i - 1], [y1, t1] = table[i];
      if (y <= y1) return round(t0 + (t1 - t0) * (y - y0) / (y1 - y0), 50000);
    }
    return table[table.length - 1][1];
  }

  // ---------------------------------------------------------------------------
  // Game
  // ---------------------------------------------------------------------------

  class Game {
    /**
     * @param {object} [opts]
     * @param {number} [opts.seed]   RNG seed for reproducible games
     * @param {number} [opts.years]  game length, 10..50 years
     * @param {object} [opts.mods]   {bank, tenants, build}; default all on
     * @param {object} [opts.state]  restore from a previously serialised state
     */
    constructor(opts) {
      opts = opts || {};
      if (opts.state) {
        this.s = JSON.parse(JSON.stringify(opts.state));
      } else {
        const seed = (opts.seed != null ? opts.seed : Math.floor(Math.random() * 2 ** 31)) | 0;
        const years = clamp(Math.round(opts.years || RULES.defaultYears), RULES.minYears, RULES.maxYears);
        const mods = opts.mods ? normMods(opts.mods) : normMods({ bank: true, tenants: true, build: true });
        this.s = this._newState(seed, years, mods);
      }
    }

    static fromJSON(json) {
      const state = typeof json === 'string' ? JSON.parse(json) : json;
      if (!state || ![1, 2, 3].includes(state.version)) throw new Error('Unrecognised save data');
      if (state.version === 1) {
        // v1 saves were always 10-year games.
        state.version = 2;
        state.years = 10;
        state.maxMonths = 120;
        state.goal = targetFor(10, '');
      }
      if (state.version === 2) {
        // v2 saves predate the rule mods: they continue as classic games.
        state.version = 3;
        state.mods = normMods({});
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
      const entries = Object.entries(weights).filter(([, w]) => w > 0);
      let total = 0;
      for (const [, w] of entries) total += w;
      if (!total) return null;
      let r = this._rand() * total;
      for (const [k, w] of entries) { if ((r -= w) < 0) return k; }
      return entries[entries.length - 1][0];
    }

    // --- Setup ---------------------------------------------------------------
    _newState(seed, years, mods) {
      this.s = {
        version: 3,
        seed,
        years,
        mods,
        maxMonths: years * 12,
        goal: targetFor(years, mods),
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
        // Mod A
        baseRate: RULES.startBaseRate,
        baseRateRaw: RULES.startBaseRate,
        smoothIndex: 1,
        trendIndex: 1,
        priceLevel: 1,
        fixed: null,             // {balance, rate, until}
        covenant: null,          // {since, deadline}
        rateHistory: [],
        indexHistory: [],
        // Mod C
        councilRelations: 50,
        slush: 0,
        schemes: [],
      };
      const s = this.s;
      if (mods.bank) {
        // Start anywhere in the credit cycle: some games open in a squeeze.
        s.cycle = Object.assign(this._newCycle(), { phase: this._range(0, Math.PI * 2) });
        s.baseRateRaw = clamp(RULES.rateTarget + s.cycle.amp * Math.sin(s.cycle.phase), RULES.minBaseRate, RULES.maxBaseRate);
        s.baseRate = bp(s.baseRateRaw);
      }

      for (const [key, d] of Object.entries(DISTRICTS)) {
        s.districts[key] = { key, name: d.name, desirability: d.desirability, base: d.desirability, trend: 0 };
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

      if (mods.build) {
        for (const p of s.properties) { p.localMod = 1; p.build = null; p.app = null; p.refused = null; p.blockedUntil = 0; }
        // A few vacant lots and derelicts so there is something to build from month one.
        const pool = s.properties.slice();
        for (let i = 0; i < 6; i++) {
          const p = pool.splice(Math.floor(this._rand() * pool.length), 1)[0];
          if (i < 3) this._makeLot(p);
          else { p.condition = this._int(5, 14); p.tenants = 0; }
          p.forSale = true;
          p.askMult = this._range(0.9, 1.05);
        }
      }
      if (mods.tenants) {
        for (const p of s.properties) {
          p.policy = 'any';
          p.arrearsPolicy = 'chase';
          p.lets = new Array(p.units).fill(null);
          for (let i = 0; i < p.tenants; i++) {
            const cls = this._weighted(this._mix(p, null));
            const rent = cls === 'council' ? this._councilRent(p) : round(p.rent * this._range(0.8, 1.02), 5);
            p.lets[i] = this._newLet(cls, rent, 0 - this._int(0, 60), this._int(1, 12));
          }
          this._sync(p);
        }
      }

      this._log('You arrive in town with ' + fmt(s.cash) + ' and big ideas.', 'info');
      this._log('Goal: a net worth of ' + fmt(s.goal) + ' within ' + years + ' years.', 'info');
      s.history.push(this.netWorth());
      s.rateHistory.push(s.baseRate);
      s.indexHistory.push(s.marketIndex);
      return s;
    }

    _makeLot(p) {
      p.type = 'lot';
      p.units = 0;
      p.tenants = 0;
      p.rent = 0;
      p.condition = 50;
      if (p.lets) p.lets = [];
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
    get mods() { return this.s.mods; }
    hasMod(k) { return !!this.s.mods[k]; }
    modSignature() { return modSig(this.s.mods); }

    dateLabel(month) {
      const m = month == null ? this.s.month : month;
      return MONTHS[m % 12] + ' ' + (RULES.startYear + Math.floor(m / 12));
    }
    monthsLeft() { return this.s.maxMonths - this.s.month; }
    /** Months the target must be held to win (0 = instant win). */
    holdRequired() { return this.hasMod('bank') ? RULES.holdMonths : 0; }
    holdProgress() { return this.s.holding || 0; }
    isOver() { return this.s.status !== 'playing'; }

    property(id) { return this.s.properties[id] || null; }
    district(key) { return this.s.districts[key]; }
    portfolio() { return this.s.properties.filter(p => p.owned); }
    listings() { return this.s.properties.filter(p => !p.owned && p.forSale); }
    isLot(p) { return p.type === 'lot'; }
    isBusy(p) { return !!(p.build || p.app); }

    /** Price level (inflation since the start); 1 unless the bank mod is on. */
    priceLevel() { return this.s.priceLevel || 1; }

    /** Desirability this building actually sees: district, neighbours and schemes. */
    localDesirability(p) {
      const d = this.s.districts[p.district].desirability;
      if (!this.hasMod('build')) return d;
      const { width, height } = this.mapSize;
      let sum = 0, w = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const x = p.x + dx, y = p.y + dy;
          if (x < 0 || y < 0 || x >= width || y >= height) continue;
          const q = this.s.properties[y * width + x];
          if (!q) continue; // not generated yet
          const wt = dx && dy ? 0.5 : 1;
          sum += this.streetScore(q) * wt;
          w += wt;
        }
      }
      return d * clamp(1 + 0.12 * (w ? sum / w : 0), 0.8, 1.2) * (p.localMod || 1);
    }

    /** How a building affects its street: roughly -1 (blight) to +1 (asset). */
    streetScore(p) {
      if (p.type === 'lot') return p.build ? -0.1 : -0.3;
      let s = (p.condition - 55) / 45;
      if (p.type === 'tower') {
        const base = DISTRICTS[p.district].desirability;
        s += base >= 1.0 ? -0.5 : base < 0.8 ? 0.3 : 0;
      }
      if (p.lets && p.units) {
        let st = 0, pr = 0;
        for (const l of p.lets) if (l && l.cls) { if (l.cls === 'student') st++; else if (l.cls === 'pro') pr++; }
        s += (pr * 0.3 - st * 0.2) / p.units;
      }
      return s;
    }

    /** Fair monthly rent per unit given area, condition and type. */
    marketRent(p) {
      const t = TYPES[p.type];
      if (!t.units) return 0;
      // Rent is less sensitive to area than value is: rough areas yield more.
      const r = t.baseRent * Math.pow(this.localDesirability(p), 0.55) * (0.5 + p.condition / 200) *
        (0.85 + 0.15 * this.s.marketIndex) * this.priceLevel();
      return Math.max(5, round(r, 5));
    }

    /** Market value of the property right now. */
    value(p) {
      const mi = this.s.marketIndex * this.priceLevel();
      const des = this.localDesirability(p);
      if (p.type === 'lot') {
        const wip = p.build ? p.build.paid * 0.6 : 0;
        return round(RULES.landValue * des * mi + wip, 100);
      }
      let v = TYPES[p.type].baseValue * des * (0.55 + 0.45 * p.condition / 100) * mi;
      if (p.build) v = v * 0.7 + p.build.paid * 0.6; // mid-conversion
      return round(v, 100);
    }

    askingPrice(p) { return round(this.value(p) * p.askMult, 100); }
    saleProceeds(p) { return round(this.value(p) * (1 - RULES.sellFee), 100); }

    repairCostPerPoint(p) {
      return TYPES[p.type].baseValue * RULES.repairCostRate * this.s.marketIndex * this.priceLevel();
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
      let c = TYPES[p.type].upkeep * p.units * this.priceLevel() + this.value(p) * RULES.propertyTax;
      if (this.hasMod('tenants') && p.lets) c += (p.units - this.occupied(p)) * RULES.emptyCharge * this.priceLevel();
      return Math.round(c);
    }

    /**
     * Long-run share of units (0..1) tenants will fill at a given asking rent
     * (defaults to the current rent), given condition and your reputation.
     */
    expectedOccupancy(p, rent) {
      if (!p.units) return 0;
      const r = rent == null ? p.rent : rent;
      const mr = this.marketRent(p);
      if (!this.hasMod('tenants')) {
        const ratio = r / mr;
        return clamp(clamp(1.55 - 0.75 * ratio, 0, 1) * (0.8 + 0.4 * this.s.reputation / 100), 0, 1);
      }
      if (p.condition < 15) return 0;
      const mix = this._mix(p, null);
      let total = 0, fill = 0, churn = 0;
      for (const c of CLASS_KEYS) total += mix[c] || 0;
      for (const c of CLASS_KEYS) {
        const share = (mix[c] || 0) / total;
        if (!share) continue;
        const acc = this._acceptance(p, c, r, mr);
        fill += share * acc;
        churn += share * acc * (CLASSES[c].churn + (CLASSES[c].summer || 0) / 12);
      }
      const f = this._applicantRate() * fill;
      const ch = fill ? churn / fill : 0.01;
      return f + ch ? f / (f + ch) : 0;
    }

    /** Projected monthly net income at current occupancy. */
    projectedNet(p) {
      let income = p.tenants * p.rent;
      if (this.hasMod('tenants') && p.lets) {
        income = 0;
        for (const l of p.lets) if (l && l.cls && !l.arrears) income += l.rent;
      }
      if (p.build) income = 0;
      return income - this.runningCost(p);
    }

    portfolioValue() {
      let v = 0;
      for (const p of this.s.properties) if (p.owned) v += this.value(p);
      return v;
    }
    netWorth() { return this.s.cash + this.portfolioValue() - this.s.loan; }

    // --- Bank queries (Mod A aware) ------------------------------------------
    baseRate() { return this.hasMod('bank') ? this.s.baseRate : RULES.interestRate - RULES.variableMargin; }
    loanRate() { return this.hasMod('bank') ? this.s.baseRate + RULES.variableMargin : RULES.interestRate; }
    fixedRateOffer() { return this.s.baseRate + RULES.fixedMargin; }
    maxLtv() {
      if (!this.hasMod('bank')) return RULES.creditLtv;
      const t = clamp((this.s.baseRate - 0.06) / 0.08, 0, 1);
      return RULES.ltvLoose + (RULES.ltvTight - RULES.ltvLoose) * t;
    }
    creditLimit() {
      return round(RULES.creditBase * this.priceLevel() + this.maxLtv() * this.portfolioValue(), 100);
    }
    availableCredit() { return Math.max(0, this.creditLimit() - this.s.loan); }
    ltv() { const v = this.portfolioValue(); return v ? this.s.loan / v : (this.s.loan ? Infinity : 0); }
    fixedBalance() { return this.s.fixed ? this.s.fixed.balance : 0; }
    monthlyInterest() {
      if (!this.hasMod('bank')) return Math.round(this.s.loan * RULES.interestRate / 12);
      const fixed = this.fixedBalance();
      const variable = Math.max(0, this.s.loan - fixed);
      return Math.round(variable * this.loanRate() / 12 + (fixed ? fixed * this.s.fixed.rate / 12 : 0));
    }
    /** Monthly net rent across the portfolio divided by monthly interest. */
    interestCover() {
      const interest = this.monthlyInterest();
      let net = 0;
      for (const p of this.portfolio()) net += this.projectedNet(p);
      return interest ? net / interest : Infinity;
    }
    covenant() { return this.s.covenant; }

    // --- Tenant queries (Mod B) ----------------------------------------------
    occupied(p) {
      if (!p.lets) return p.tenants;
      let n = 0;
      for (const l of p.lets) if (l && l.cls) n++;
      return n;
    }
    tenantSummary(id) {
      const p = this.property(id);
      if (!p || !p.lets) return null;
      const out = { classes: {}, arrears: 0, owed: 0, voids: 0, empty: 0, nextReview: null, stale: 0 };
      for (const c of CLASS_KEYS) out.classes[c] = 0;
      const mr = this.marketRent(p);
      for (const l of p.lets) {
        if (!l) { out.empty++; continue; }
        if (!l.cls) { out.voids++; continue; }
        out.classes[l.cls]++;
        if (l.arrears) { out.arrears++; out.owed += l.owed; }
        if (out.nextReview == null || l.review < out.nextReview) out.nextReview = l.review;
        if (!CLASSES[l.cls].council && l.rent < mr * 0.85) out.stale++;
      }
      return out;
    }
    /** Share of each class among likely applicants (after policy), and per-applicant acceptance. */
    applicantMix(id) {
      const p = this.property(id);
      if (!p || !p.units) return [];
      const mix = this._mix(p, null);
      const mr = this.marketRent(p);
      let total = 0;
      for (const c of CLASS_KEYS) total += mix[c] || 0;
      return CLASS_KEYS.map(c => ({
        cls: c,
        share: (mix[c] || 0) / total,
        eligible: POLICIES[p.policy || 'any'].allows(c) && this._eligible(p, c),
        accept: this._acceptance(p, c, p.rent, mr),
      })).filter(x => x.share > 0);
    }

    _mix(p, policy) {
      const base = CLASS_MIX[p.district];
      const tm = TYPE_MIX[p.type] || {};
      const out = {};
      for (const c of CLASS_KEYS) {
        let w = base[c] * (tm[c] || 1);
        if (policy && !POLICIES[policy].allows(c)) w = 0;
        out[c] = w;
      }
      return out;
    }
    _eligible(p, c) {
      const k = CLASSES[c];
      if (p.condition < 15) return false;
      if (k.minCond && p.condition < k.minCond) return false;
      if (k.minDes && this.localDesirability(p) < k.minDes) return false;
      if (k.council && this.s.districts[p.district].desirability >= 1.1) return false;
      return true;
    }
    _acceptance(p, c, rent, mr) {
      const k = CLASSES[c];
      if (!POLICIES[p.policy || 'any'].allows(c) || !this._eligible(p, c)) return 0;
      if (k.council) return 1;
      let a = clamp((k.ceiling - rent / mr) / 0.25, 0, 1);
      if (c === 'pro') a *= clamp(this.s.reputation / 60, 0.2, 1);
      return a;
    }
    _applicantRate() { return 0.4 * (0.6 + 0.8 * this.s.reputation / 100); }
    _councilRent(p) { return round(this.marketRent(p) * 0.8, 5); }
    _newLet(cls, rent, since, reviewIn) {
      return { cls, rent, since: since == null ? this.s.month : since, review: this.s.month + (reviewIn || 12), arrears: 0, owed: 0 };
    }
    _sync(p) { if (p.lets) p.tenants = this.occupied(p); }

    // --- Build queries (Mod C) -----------------------------------------------
    buildCost(p, type) { return round(TYPES[type].baseValue * RULES.buildRate * this.s.marketIndex * this.priceLevel(), 100); }
    buildMonths(type) { return BUILD_MONTHS[type]; }
    conversionFor(p) { return CONVERSIONS[p.type] || null; }
    conversionCost(p) {
      const c = CONVERSIONS[p.type];
      return c ? round(TYPES[c.to].baseValue * c.rate * this.s.marketIndex * this.priceLevel(), 100) : 0;
    }
    demolishCost(p) { return round(TYPES[p.type].baseValue * RULES.demolishRate * this.s.marketIndex * this.priceLevel(), 100); }
    applicationFee() { return round(RULES.applicationFee * this.priceLevel(), 10); }
    appealFee() { return round(RULES.appealFee * this.priceLevel(), 10); }
    planningChance(p, to) {
      let base;
      if (p.type !== 'lot') {
        if (p.type === 'terrace' && to === 'bedsit') base = Math.min(0.95, PLANNING[p.district].bedsit * 1.1);
        else if (p.type === 'bedsit' && to === 'terrace') base = 0.9;
        else return 0;
      } else base = PLANNING[p.district][to];
      const repF = 0.6 + 0.8 * this.s.reputation / 100;
      const relF = 0.5 + this.s.councilRelations / 100;
      return clamp(base * repF * relF, 0.02, 0.97);
    }

    // --- Player actions ------------------------------------------------------
    _guard(id, mustOwn) {
      if (this.isOver()) return { err: fail('The game is over.') };
      const p = this.property(id);
      if (!p) return { err: fail('No such property.') };
      if (mustOwn && !p.owned) return { err: fail('You do not own ' + p.address + '.') };
      return { p };
    }
    _needMod(k) { return this.hasMod(k) ? null : fail(MOD_INFO[k].label + ' is not enabled in this game.'); }

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
      if (p.build) return fail('You cannot sell a building site mid-works.');
      const proceeds = this.saleProceeds(p);
      this.s.cash += proceeds;
      p.owned = false;
      p.forSale = false;
      p.cooldown = 6;
      p.app = null;
      const gain = proceeds - p.boughtFor;
      this._log('Sold ' + p.address + ' for ' + fmt(proceeds) + ' (' + (gain >= 0 ? 'profit ' : 'loss ') + fmt(Math.abs(gain)) + ').', 'sell');
      return ok('Sold ' + p.address + '.');
    }

    setRent(id, amount) {
      const { p, err } = this._guard(id, true);
      if (err) return err;
      if (!p.units) return fail('There is nothing to let here.');
      const n = Number(amount);
      if (!Number.isFinite(n) || n < 0) return fail('Rent must be a positive number.');
      const max = this.marketRent(p) * 3;
      const rent = round(clamp(n, 0, max), 5);
      if (rent === p.rent) return ok('Rent unchanged.');
      const old = p.rent;
      p.rent = rent;
      if (this.hasMod('tenants')) {
        this._log('Asking rent at ' + p.address + ' ' + (rent > old ? 'raised' : 'cut') + ' to ' + fmt(rent) + '/unit (sitting tenants at review).', 'info');
        return ok('Asking rent ' + fmt(rent) + '. Sitting tenants move to it at their annual review.');
      }
      this._log('Rent at ' + p.address + ' ' + (rent > old ? 'raised' : 'cut') + ' to ' + fmt(rent) + '/unit.', 'info');
      return ok('Rent set to ' + fmt(rent) + '.');
    }

    repair(id, kind) {
      const { p, err } = this._guard(id, true);
      if (err) return err;
      if (!p.units || p.build) return fail('Nothing to repair here.');
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
        let leaving;
        if (p.lets) {
          const occ = p.lets.map((l, i) => (l && l.cls ? i : -1)).filter(i => i >= 0);
          leaving = Math.floor(occ.length * 0.4);
          for (let k = 0; k < leaving; k++) p.lets[occ.splice(Math.floor(this._rand() * occ.length), 1)[0]] = null;
          this._sync(p);
        } else {
          leaving = Math.floor(p.tenants * 0.4);
          p.tenants -= leaving;
        }
        this._log('Full refurbishment of ' + p.address + ' for ' + fmt(cost) +
          (leaving ? '; ' + leaving + ' tenant' + (leaving > 1 ? 's' : '') + ' moved out during the works.' : '.'), 'repair');
      }
      return ok('Repairs done.');
    }

    borrow(amount) {
      if (this.isOver()) return fail('The game is over.');
      const n = round(Number(amount), 100);
      if (!Number.isFinite(n) || n <= 0) return fail('Enter an amount to borrow.');
      if (this.s.covenant) return fail('The bank will not lend while you are in breach of covenant.');
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
      let fee = 0;
      if (this.s.fixed) {
        const variable = this.s.loan - this.s.fixed.balance;
        if (n > variable) {
          // Repaying into the fixed tranche costs an early-repayment charge.
          let over = n - variable;
          fee = Math.round(over * RULES.breakFee);
          if (n + fee > this.s.cash) {
            over = Math.max(0, Math.floor((this.s.cash - variable) / (1 + RULES.breakFee)));
            n = variable + over;
            fee = Math.round(over * RULES.breakFee);
          }
          this.s.fixed.balance -= over;
          if (this.s.fixed.balance <= 0) this.s.fixed = null;
        }
      }
      if (n <= 0) return fail('You have no cash to repay with.');
      this.s.loan -= n;
      this.s.cash -= n + fee;
      this._log('Repaid ' + fmt(n) + ' to the bank' + (fee ? ' (early-repayment charge ' + fmt(fee) + ')' : '') + '.', 'bank');
      return ok('Repaid ' + fmt(n) + '.');
    }

    /** Pay down the loan without fees (forced sales); variable first. */
    _paydown(n) {
      n = Math.min(n, this.s.loan);
      this.s.loan -= n;
      if (this.s.fixed && this.s.fixed.balance > this.s.loan) {
        this.s.fixed.balance = this.s.loan;
        if (this.s.fixed.balance <= 0) this.s.fixed = null;
      }
      return n;
    }

    fixRate(years) {
      const e = this._needMod('bank'); if (e) return e;
      if (this.isOver()) return fail('The game is over.');
      years = Number(years);
      if (!RULES.fixYears.includes(years)) return fail('Fixes are for ' + RULES.fixYears.join(' or ') + ' years.');
      if (this.s.fixed) return fail('You already have a fixed-rate deal until ' + this.dateLabel(this.s.fixed.until) + '.');
      if (this.s.loan <= 0) return fail('You have no loan to fix.');
      const rate = this.fixedRateOffer();
      this.s.fixed = { balance: this.s.loan, rate, until: this.s.month + years * 12 };
      this._log('Fixed ' + fmt(this.s.loan) + ' at ' + pctStr(rate) + ' until ' + this.dateLabel(this.s.fixed.until) + '.', 'bank');
      return ok('Fixed at ' + pctStr(rate) + ' for ' + years + ' years.');
    }

    breakFix() {
      const e = this._needMod('bank'); if (e) return e;
      if (this.isOver()) return fail('The game is over.');
      if (!this.s.fixed) return fail('You have no fixed-rate deal.');
      const fee = Math.round(this.s.fixed.balance * RULES.breakFee);
      if (fee > this.s.cash) return fail('Breaking the fix costs ' + fmt(fee) + '.');
      this.s.cash -= fee;
      this.s.fixed = null;
      this._log('Broke the fixed-rate deal; charge ' + fmt(fee) + '.', 'bank');
      return ok('Fix broken for ' + fmt(fee) + '.');
    }

    setPolicy(id, policy) {
      const e = this._needMod('tenants'); if (e) return e;
      const { p, err } = this._guard(id, true);
      if (err) return err;
      if (!POLICIES[policy]) return fail('Unknown letting policy.');
      p.policy = policy;
      return ok('Letting policy: ' + POLICIES[policy].label + '. Applies to new lets.');
    }

    setArrearsPolicy(id, policy) {
      const e = this._needMod('tenants'); if (e) return e;
      const { p, err } = this._guard(id, true);
      if (err) return err;
      if (!ARREARS_POLICIES[policy]) return fail('Unknown arrears policy.');
      p.arrearsPolicy = policy;
      return ok('Arrears policy: ' + ARREARS_POLICIES[policy] + '.');
    }

    demolish(id) {
      const e = this._needMod('build'); if (e) return e;
      const { p, err } = this._guard(id, true);
      if (err) return err;
      if (p.type === 'lot') return fail('There is nothing left to knock down.');
      if (this.isBusy(p)) return fail('Wait for the current works or application to finish.');
      const cost = this.demolishCost(p);
      if (cost > this.s.cash) return fail('Demolition costs ' + fmt(cost) + '.');
      this.s.cash -= cost;
      const displaced = this._displaceAll(p, 'demolition');
      const label = TYPES[p.type].label;
      this._makeLot(p);
      p.blockedUntil = this.s.month + 1;
      this._log('Demolished ' + label + ' at ' + p.address + ' for ' + fmt(cost) + (displaced ? '; ' + displaced + ' households displaced.' : '.'), 'build');
      return ok('Demolished. The plot is clear next month.');
    }

    /** Apply for planning to build on a lot you own. */
    build(id, type) {
      const e = this._needMod('build'); if (e) return e;
      const { p, err } = this._guard(id, true);
      if (err) return err;
      if (p.type !== 'lot') return fail('Demolish the building first.');
      if (!BUILDABLE.includes(type)) return fail('Unknown building type.');
      return this._apply(p, type, 'build');
    }

    /** Apply to convert terrace <-> bedsit house. */
    convert(id) {
      const e = this._needMod('build'); if (e) return e;
      const { p, err } = this._guard(id, true);
      if (err) return err;
      const c = CONVERSIONS[p.type];
      if (!c) return fail('Only terraces and bedsit houses can be converted.');
      return this._apply(p, c.to, 'convert');
    }

    _apply(p, to, kind) {
      if (this.isBusy(p)) return fail('There is already an application or works in progress.');
      if (p.blockedUntil > this.s.month) {
        return fail(p.refused ? 'Planning was refused; you can appeal or wait until ' + this.dateLabel(p.blockedUntil) + '.' : 'The plot is not ready yet.');
      }
      const fee = this.applicationFee();
      if (fee > this.s.cash) return fail('The application fee is ' + fmt(fee) + '.');
      this.s.cash -= fee;
      const chance = this.planningChance(p, to);
      p.app = { to, kind, chance, decideAt: this.s.month + RULES.planningMonths, appeal: false };
      p.refused = null;
      this._log('Planning application at ' + p.address + ': ' + (kind === 'convert' ? 'convert to ' : 'build ') +
        TYPES[to].label.toLowerCase() + ' (' + Math.round(chance * 100) + '% likely). Decision ' + this.dateLabel(p.app.decideAt) + '.', 'build');
      return ok('Application lodged. Decision in ' + RULES.planningMonths + ' months.');
    }

    appeal(id) {
      const e = this._needMod('build'); if (e) return e;
      const { p, err } = this._guard(id, true);
      if (err) return err;
      if (!p.refused || this.isBusy(p)) return fail('There is no refusal to appeal.');
      const fee = this.appealFee();
      if (fee > this.s.cash) return fail('An appeal costs ' + fmt(fee) + '.');
      this.s.cash -= fee;
      const chance = Math.min(0.9, this.planningChance(p, p.refused.to) * 1.5);
      p.app = { to: p.refused.to, kind: p.refused.kind, chance, decideAt: this.s.month + RULES.appealMonths, appeal: true };
      p.refused = null;
      this._log('Appeal lodged for ' + p.address + ' (' + Math.round(chance * 100) + '% likely). Decision ' + this.dateLabel(p.app.decideAt) + '.', 'build');
      return ok('Appeal lodged.');
    }

    /** A contribution to the mayor's fund: better planning odds, risk of scandal. */
    donate(amount) {
      const e = this._needMod('build'); if (e) return e;
      if (this.isOver()) return fail('The game is over.');
      const n = round(Number(amount), 100);
      if (!Number.isFinite(n) || n < 1000) return fail('The mayor does not get out of bed for less than £1,000.');
      if (n > this.s.cash) return fail('You do not have ' + fmt(n) + '.');
      this.s.cash -= n;
      this.s.slush += n;
      this.s.councilRelations = clamp(this.s.councilRelations + n / (1500 * this.priceLevel()), 0, 100);
      this._log('A discreet ' + fmt(n) + ' for the mayor\'s fund.', 'build');
      return ok('Council relations ' + Math.round(this.s.councilRelations) + '/100.');
    }

    /** Cash out and end the game early. */
    retire() {
      if (this.isOver()) return fail('The game is over.');
      this.s.status = 'retired';
      this._log('You retire with a net worth of ' + fmt(this.netWorth()) + '.', 'end');
      return ok('Retired.');
    }

    /** Remove every let (demolition/conversion). Returns households displaced. */
    _displaceAll(p, why) {
      let n = 0;
      if (p.lets) {
        for (let i = 0; i < p.lets.length; i++) {
          const l = p.lets[i];
          if (l && l.cls) { n++; this._evictionFallout(p, l.cls, why, 0.5); }
          p.lets[i] = null;
        }
      } else {
        n = p.tenants;
      }
      p.tenants = 0;
      return n;
    }

    _evictionFallout(p, cls, why, scale) {
      const k = CLASSES[cls];
      this.s.reputation = clamp(this.s.reputation + k.evictRep * (scale || 1), 0, 100);
      if (cls === 'pensioner') {
        if (this.hasMod('build')) this.s.councilRelations = clamp(this.s.councilRelations - 10 * (scale || 1), 0, 100);
        this._log('Scandal: pensioner turned out of ' + p.address + (why ? ' for ' + why : '') + '. The council takes note.', 'bad');
      } else if (cls === 'family') {
        this._log('Local paper: family evicted from ' + p.address + (why ? ' for ' + why : '') + '.', 'bad');
      }
    }

    // --- Turn ----------------------------------------------------------------
    endMonth() {
      if (this.isOver()) return fail('The game is over.');
      const s = this.s;
      const report = {
        rent: 0, upkeep: 0, tax: 0, incidents: 0, interest: 0, net: 0, moveIns: 0, moveOuts: 0,
        arrears: 0, evictions: 0, voids: 0, construction: 0, rateMove: 0,
      };

      if (this.hasMod('bank')) this._tickRates(report);
      this._tickMarket();
      this._tickDistricts();
      if (this.hasMod('build')) { this._tickCouncil(); this._tickSchemes(); }

      for (const p of s.properties) {
        if (p.owned) this._tickOwned(p, report);
        else this._tickUnowned(p);
      }

      if (s.fixed && s.month + 1 >= s.fixed.until) {
        this._log('Your fixed-rate deal ends; the loan reverts to ' + pctStr(this.loanRate()) + ' variable.', 'bank');
        s.fixed = null;
      }

      report.interest = this.monthlyInterest();
      s.cash -= report.interest;
      report.net = report.rent - report.upkeep - report.tax - report.incidents - report.interest - report.construction;

      this._tickReputation();
      this._settleCash();
      if (this.hasMod('bank') && s.status === 'playing') this._checkCovenant();

      s.month += 1;
      s.lastReport = report;
      s.history.push(this.netWorth());
      s.rateHistory.push(s.baseRate);
      s.indexHistory.push(s.marketIndex);
      for (const k of ['history', 'rateHistory', 'indexHistory']) if (s[k].length > 700) s[k].shift();

      if (s.status === 'playing') {
        const nw = this.netWorth();
        const hold = this.holdRequired();
        if (hold) {
          if (nw >= s.goal) {
            if (!s.holding) this._log('Target reached! Hold it for ' + hold + ' months to make it count.', 'good');
            s.holding = (s.holding || 0) + 1;
          } else {
            if (s.holding) this._log('Net worth slipped below the target; the clock resets.', 'bad');
            s.holding = 0;
          }
        }
        if (nw >= s.goal && (!hold || s.holding >= hold)) {
          s.status = 'won';
          this._log('You are a Rent Baron! Net worth ' + fmt(nw) + ' in ' + s.month + ' months.', 'end');
        } else if (s.month >= s.maxMonths) {
          s.status = 'retired';
          this._log('Time is up. You finish with a net worth of ' + fmt(nw) + '.', 'end');
        }
      }
      return ok('Month ended.', report);
    }

    // Mod A: base rate follows a lagged reaction to the property market, with
    // occasional regime shifts. Inflation tracks the rate.
    _tickRates(report) {
      const s = this.s;
      s.smoothIndex += (s.marketIndex - s.smoothIndex) * RULES.rateLag;
      s.trendIndex = (s.trendIndex || 1) + (s.marketIndex - (s.trendIndex || 1)) * RULES.rateTrendLag;
      const heat = s.smoothIndex - s.trendIndex; // > 0 when prices run ahead of trend
      const c = s.cycle;
      c.phase += c.speed;
      if (c.phase >= Math.PI * 2) {
        c.phase -= Math.PI * 2;
        Object.assign(c, this._newCycle(), { phase: c.phase });
      }
      const target = RULES.rateTarget + c.amp * Math.sin(c.phase) + heat * RULES.rateBoomPressure;
      let drift = (target - s.baseRateRaw) * RULES.rateFollow + this._range(-0.001, 0.001);
      if (this._chance(RULES.rateShock)) {
        const up = this._chance(heat > 0 ? 0.7 : 0.4);
        drift += (up ? 1 : -1) * this._range(0.01, 0.02);
        this._log(up ? 'Sterling wobbles; the bank acts in an emergency meeting.' : 'Surprise rate cut as the economy stalls.', up ? 'bad' : 'good');
      }
      s.baseRateRaw = clamp(s.baseRateRaw + drift, RULES.minBaseRate, RULES.maxBaseRate);
      const shown = bp(s.baseRateRaw);
      if (shown !== s.baseRate) {
        report.rateMove = shown - s.baseRate;
        const big = Math.abs(report.rateMove) >= 0.005;
        this._log('Bank ' + (report.rateMove > 0 ? 'raises' : 'cuts') + ' base rate to ' + pctStr(shown) + '.',
          big ? (report.rateMove > 0 ? 'bad' : 'good') : 'bank');
        s.baseRate = shown;
      }
      s.priceLevel *= 1 + (0.025 + (s.baseRate - 0.075) * 0.3) / 12;
    }

    _newCycle() {
      const [y0, y1] = RULES.cycleYears, [a0, a1] = RULES.cycleAmp;
      return { speed: Math.PI * 2 / (12 * this._range(y0, y1)), amp: this._range(a0, a1) };
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
      // Cheap money inflates prices; dear money deflates them.
      if (this.hasMod('bank')) drift += (RULES.rateTarget - s.baseRate) * RULES.rateCoupling;
      s.marketIndex = clamp(s.marketIndex * (1 + drift), 0.6, 1.9);
    }

    _tickDistricts() {
      const build = this.hasMod('build');
      for (const d of Object.values(this.s.districts)) {
        const orig = DISTRICTS[d.key].desirability;
        if (build) {
          // The state of a district's buildings slowly moves where it settles.
          let sum = 0, n = 0;
          for (const p of this.s.properties) if (p.district === d.key) { sum += this.streetScore(p); n++; }
          d.base = clamp((d.base || orig) + (sum / n) * 0.001, orig - 0.3, orig + 0.4);
        }
        const base = build ? d.base : orig;
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

    _tickCouncil() {
      const s = this.s;
      s.councilRelations += (50 - s.councilRelations) * 0.02;
      s.slush *= 0.95;
      if (s.slush > 0 && this._chance(Math.min(0.08, s.slush / (300000 * this.priceLevel())))) {
        this._log('Scandal! The mayor\'s fund is exposed and your name is on the list.', 'bad');
        s.councilRelations = 0;
        s.reputation = clamp(s.reputation - 15, 0, 100);
        s.slush = 0;
      }
    }

    _tickSchemes() {
      const s = this.s;
      const { width, height } = this.mapSize;
      for (const sc of s.schemes.slice()) {
        if (s.month < sc.due) continue;
        s.schemes.splice(s.schemes.indexOf(sc), 1);
        const tiles = sc.tiles.map(i => s.properties[i]);
        if (sc.kind === 'regen') {
          let paid = 0;
          for (const p of tiles) {
            if (p.owned) {
              const amt = round(this.value(p) * 1.3, 100);
              s.cash += amt;
              paid += amt;
              p.owned = false;
            }
            p.build = null; p.app = null; p.refused = null;
            p.type = 'flats';
            p.units = TYPES.flats.units;
            p.condition = 100;
            p.forSale = false;
            p.cooldown = 36;
            p.rent = this.marketRent(p);
            p.tenants = 0;
            if (p.lets) p.lets = new Array(p.units).fill(null);
          }
          this._log('Regeneration: the council clears ' + sc.name + ' and builds new flats' +
            (paid ? '. Compulsory purchase pays you ' + fmt(paid) + '.' : '.'), paid ? 'good' : 'info');
        } else {
          for (const p of tiles) p.localMod = (p.localMod || 1) * 0.8;
          this._log('The bypass opens through ' + sc.name + '. Property values along it slump.', 'bad');
        }
      }
      if (!s.schemes.length && this._chance(0.006)) {
        const regen = this._chance(0.6);
        let tiles = [];
        if (regen) {
          const x = this._int(0, width - 2), y = this._int(0, height - 2);
          tiles = [y * width + x, y * width + x + 1, (y + 1) * width + x, (y + 1) * width + x + 1];
        } else {
          const y = this._int(0, height - 1), x = this._int(0, width - 4);
          tiles = [0, 1, 2, 3].map(k => y * width + x + k);
        }
        const first = s.properties[tiles[0]];
        const name = 'the ' + first.address.replace(/^\d+ /, '') + ' area';
        const due = s.month + 24;
        s.schemes.push({ kind: regen ? 'regen' : 'bypass', tiles, due, name });
        this._log(regen
          ? 'Council announces regeneration of ' + name + ': compulsory purchase at 130% of value in ' + this.dateLabel(due) + '.'
          : 'Council confirms a bypass through ' + name + ', opening ' + this.dateLabel(due) + '. Values along it will fall.', 'info');
      }
    }

    _tickUnowned(p) {
      if (p.type === 'lot') {
        // Developers eventually build on empty plots they own.
        if (!p.forSale && this.hasMod('build') && this._chance(0.015)) {
          p.type = this._weighted(DISTRICTS[p.district].types);
          p.units = TYPES[p.type].units;
          p.condition = 100;
          p.rent = this.marketRent(p);
          p.tenants = 0;
          if (p.lets) p.lets = new Array(p.units).fill(null);
          this._log('A developer finishes a new ' + TYPES[p.type].label.toLowerCase() + ' at ' + p.address + '.', 'info');
        }
        this._tickListing(p);
        return;
      }
      p.condition = clamp(p.condition - this._range(0.2, 0.9), 5, 100);
      // Other landlords occasionally fix their places up.
      if (p.condition < 35 && this._chance(0.06)) p.condition = clamp(p.condition + this._range(25, 50), 0, 100);
      if (this._tickListing(p)) return;
      // Keep unowned buildings' tenancy roughly realistic so purchases inherit tenants.
      p.rent = round(this.marketRent(p) * this._range(0.85, 1.05), 5);
      const target = p.condition < 15 && this.hasMod('build') ? 0 : Math.round(p.units * this._range(0.5, 0.95));
      if (p.lets) {
        const occ = this.occupied(p);
        if (occ < target) {
          const i = p.lets.findIndex(l => !l || !l.cls);
          const cls = this._weighted(this._mix(p, null));
          if (i >= 0 && cls) p.lets[i] = this._newLet(cls, cls === 'council' ? this._councilRent(p) : round(p.rent * this._range(0.85, 1), 5));
        } else if (occ > target) {
          const i = p.lets.findIndex(l => l && l.cls);
          if (i >= 0) p.lets[i] = null;
        }
        this._sync(p);
      } else {
        p.tenants += Math.sign(target - p.tenants);
      }
    }

    /** Listing churn; returns true while in post-sale cooldown. */
    _tickListing(p) {
      if (p.cooldown > 0) { p.cooldown--; return true; }
      if (p.forSale) {
        if (this._chance(0.07)) p.forSale = false;
      } else if (this._chance(0.045)) {
        p.forSale = true;
        p.askMult = this._range(0.93, 1.15);
      }
      return false;
    }

    _tickOwned(p, r) {
      const s = this.s;
      const tax = Math.round(this.value(p) * RULES.propertyTax);
      r.tax += tax;
      s.cash -= tax;

      if (this.hasMod('build') && this._tickWorks(p, r)) return; // just completed: opens next month
      if (p.type === 'lot' || p.build) return;

      const d = s.districts[p.district];
      const t = TYPES[p.type];
      const label = p.address;
      const pl = this.priceLevel();

      let rent, wearSum, ratio, extra = 0;
      if (p.lets) ({ rent, wearSum, ratio, extra } = this._tickLets(p, r));
      else ({ rent, wearSum, ratio } = this._tickTenancyClassic(p, r));

      // Upkeep includes empty-unit charges and arrears chasing under Mod B.
      const upkeep = Math.round(t.upkeep * p.units * pl + extra);
      let incident = 0;

      // Wear and tear.
      p.condition = clamp(p.condition - (0.2 + 0.5 * wearSum / p.units + this._range(0, 0.3)), 0, 100);

      // Random events.
      const wear = (100 - p.condition) / 100;
      if (p.tenants > 0 && ratio > 1.25 && this._chance(0.12)) {
        rent = 0;
        s.reputation -= 3;
        this._log('Rent strike at ' + label + '! Tenants refuse to pay this month.', 'bad');
      }
      if (this._chance(0.015 + wear * 0.04)) {
        const c = Math.round(p.units * this._range(60, 180) * pl);
        incident += c;
        p.condition = clamp(p.condition - 4, 0, 100);
        this._log('Burst pipes at ' + label + '. Plumber\'s bill: ' + fmt(c) + '.', 'bad');
      }
      if (this._chance(p.condition < 30 ? 0.02 : 0.002)) {
        const c = Math.round(this.value(p) * 0.04);
        incident += c;
        p.condition = clamp(p.condition - 30, 0, 100);
        const fled = Math.ceil(p.tenants / 2);
        this._removeTenants(p, fled);
        s.reputation -= 6;
        this._log('Fire at ' + label + '! ' + fled + ' household' + (fled === 1 ? '' : 's') + ' left; damage costs ' + fmt(c) + '.', 'bad');
      }
      if (p.condition < 25 && this._chance(0.12)) {
        const c = Math.round(600 * p.units * pl);
        incident += c;
        s.reputation -= 4;
        this._log('Council inspectors condemn conditions at ' + label + '. Fined ' + fmt(c) + '.', 'bad');
      }
      if (p.lets && p.condition < 30 && p.lets.some(l => l && l.cls === 'council') && this._chance(0.15)) {
        let n = 0;
        p.lets.forEach((l, i) => { if (l && l.cls === 'council') { p.lets[i] = null; n++; } });
        this._sync(p);
        s.reputation -= 3;
        if (this.hasMod('build')) s.councilRelations = clamp(s.councilRelations - 5, 0, 100);
        this._log('Council inspection fails at ' + label + ': ' + n + ' placement' + (n === 1 ? '' : 's') + ' withdrawn.', 'bad');
      }
      if (this._chance(DISTRICTS[p.district].crime * (d.desirability < 0.8 ? 1.3 : 1))) {
        const c = Math.round(this._range(300, 1500) * pl);
        incident += c;
        p.condition = clamp(p.condition - 6, 0, 100);
        this._log('Vandals hit ' + label + '. Clean-up costs ' + fmt(c) + '.', 'bad');
      }
      if (p.tenants === 0 && this._chance(0.06)) {
        const c = Math.round(1500 * pl);
        incident += c;
        p.condition = clamp(p.condition - 8, 0, 100);
        this._log('Squatters moved into empty ' + label + '. Evicting them costs ' + fmt(c) + '.', 'bad');
      }
      if (p.condition > 85 && p.tenants === p.units && this._chance(0.03)) {
        s.reputation += 2;
        this._log('The local paper praises ' + label + ' as a model rental.', 'good');
      }

      s.cash += rent - upkeep - incident;
      r.rent += rent;
      r.upkeep += upkeep;
      r.incidents += incident;
    }

    _removeTenants(p, n) {
      if (!p.lets) { p.tenants = Math.max(0, p.tenants - n); return; }
      for (let i = 0; i < p.lets.length && n > 0; i++) if (p.lets[i] && p.lets[i].cls) { p.lets[i] = null; n--; }
      this._sync(p);
    }

    _tickTenancyClassic(p, r) {
      // Tenants respond to price relative to market and to your reputation.
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
      return { rent: p.tenants * p.rent, wearSum: p.tenants, ratio };
    }

    // Mod B: each unit is a let with a class, rent, review date and arrears.
    _tickLets(p, r) {
      const s = this.s;
      const mr = this.marketRent(p);
      const pl = this.priceLevel();
      const econ = 1 + Math.max(0, s.smoothIndex - s.marketIndex) * 5 +
        (this.hasMod('bank') ? Math.max(0, s.baseRate - 0.08) * 20 : 0);
      let rent = 0, wearSum = 0, ratioSum = 0, paying = 0, chaseCost = 0;
      let left = 0, moved = 0, evicted = 0, arrearsNow = 0;
      const summer = s.month % 12 === 6;

      for (let i = 0; i < p.lets.length; i++) {
        const l = p.lets[i];
        if (l && !l.cls) {                               // void after eviction
          if (s.month >= l.until) p.lets[i] = null;
          r.voids++;
          continue;
        }
        if (!l) {
          r.voids++;
          // Applicants for empty units.
          if (!this._chance(this._applicantRate())) continue;
          const cls = this._weighted(this._mix(p, null));
          if (!cls || !this._chance(this._acceptance(p, cls, p.rent, mr))) continue;
          p.lets[i] = this._newLet(cls, cls === 'council' ? this._councilRent(p) : p.rent);
          moved++;
          continue;
        }
        const k = CLASSES[l.cls];
        // Leaving.
        let leave = k.churn;
        if (summer && k.summer) leave = k.summer;
        if (l.cls === 'pro' && s.reputation < 45) leave += (45 - s.reputation) * 0.004;
        if (this._chance(leave)) { p.lets[i] = null; left++; continue; }
        // Annual rent review.
        if (s.month >= l.review) {
          l.review += 12;
          if (k.council) l.rent = this._councilRent(p);
          else if (p.rent > l.rent) {
            const rise = p.rent / l.rent - 1;
            const go = clamp(rise * k.raiseSens + Math.max(0, p.rent / mr - k.ceiling) * 3, 0, 0.95);
            if (this._chance(go)) { p.lets[i] = null; left++; continue; }
            l.rent = p.rent;
          } else if (p.rent < l.rent) l.rent = p.rent;
        }
        // Arrears.
        if (!l.arrears && !k.council && this._chance(k.arrears * econ)) l.arrears = 1;
        if (l.arrears) {
          arrearsNow++;
          const policy = p.arrearsPolicy || 'chase';
          if (policy === 'evict') {
            chaseCost += RULES.evictFee * pl;
            p.lets[i] = { cls: null, until: s.month + RULES.evictVoidMonths };
            evicted++;
            this._evictionFallout(p, l.cls, 'arrears', 1);
            continue;
          }
          if (policy === 'chase') {
            chaseCost += RULES.chaseFee * pl;
            s.reputation -= 0.05;
            if (this._chance(0.5)) { rent += l.owed; l.arrears = 0; l.owed = 0; }
            else { l.owed += l.rent; l.arrears++; }
            if (l.arrears > 8) { p.lets[i] = null; left++; continue; }
          } else {
            if (this._chance(0.12)) { l.arrears = 0; l.owed = 0; }
            else { l.owed += l.rent; l.arrears++; }
            if (l.arrears > 6) { p.lets[i] = null; left++; continue; }
          }
          if (l.arrears) { r.arrears += l.rent; wearSum += k.wear; continue; }
        }
        rent += l.rent;
        paying++;
        wearSum += k.wear;
        ratioSum += k.council ? 0.8 : l.rent / mr;
      }
      this._sync(p);
      r.moveIns += moved;
      r.moveOuts += left + evicted;
      r.evictions += evicted;
      const empty = p.units - p.tenants;
      const emptyCost = empty * RULES.emptyCharge * pl;
      return { rent: Math.round(rent), extra: chaseCost + emptyCost, wearSum, ratio: paying ? ratioSum / paying : 0 };
    }

    // Mod C: planning decisions and construction progress on owned plots.
    _tickWorks(p, r) {
      const s = this.s;
      if (p.app && s.month + 1 >= p.app.decideAt) {
        const a = p.app;
        p.app = null;
        if (this._chance(a.chance)) {
          const cost = a.kind === 'convert' ? this.conversionCost(p) : this.buildCost(p, a.to);
          const months = a.kind === 'convert' ? CONVERSIONS[p.type].months : BUILD_MONTHS[a.to];
          p.build = { to: a.to, kind: a.kind, months, monthsLeft: months, cost, paid: 0 };
          if (a.kind === 'convert') this._displaceAll(p, 'conversion');
          this._log((a.appeal ? 'Appeal upheld' : 'Planning granted') + ' at ' + p.address + '. Works start: ' + fmt(cost) +
            ' over ' + months + ' months.', 'good');
        } else {
          p.refused = { to: a.to, kind: a.kind };
          p.blockedUntil = s.month + RULES.refusalBlock;
          this._log((a.appeal ? 'Appeal dismissed' : 'Planning refused') + ' at ' + p.address + '.' +
            (a.appeal ? '' : ' You may appeal.'), 'bad');
        }
      }
      if (p.build) {
        const b = p.build;
        const stage = Math.round(b.cost / b.months);
        s.cash -= stage;
        b.paid += stage;
        r.construction += stage;
        b.monthsLeft--;
        if (b.monthsLeft <= 0) {
          p.type = b.to;
          p.units = TYPES[b.to].units;
          p.condition = b.kind === 'convert' ? Math.max(p.condition, 80) : 100;
          p.build = null;
          p.tenants = 0;
          if (this.hasMod('tenants')) p.lets = new Array(p.units).fill(null);
          p.rent = this.marketRent(p);
          this._log('Works complete at ' + p.address + ': a new ' + TYPES[p.type].label.toLowerCase() + ', ready to let.', 'good');
          return true;
        }
      }
      return false;
    }

    _tickReputation() {
      const s = this.s;
      const owned = this.portfolio().filter(p => p.units && !p.build);
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

    _seize(p, discount) {
      const proceeds = round(this.value(p) * discount, 100);
      p.owned = false;
      p.forSale = false;
      p.cooldown = 6;
      p.build = null;
      p.app = null;
      return proceeds;
    }

    _settleCash() {
      const s = this.s;
      if (s.cash >= 0) return;
      const need = round(-s.cash + 50, 100);
      if (!s.covenant && need <= this.availableCredit()) {
        s.loan += need;
        s.cash += need;
        this._log('Overdrawn: the bank added ' + fmt(need) + ' to your loan.', 'bank');
        return;
      }
      // Fire-sale properties, cheapest first, until solvent.
      const owned = this.portfolio().sort((a, b) => this.value(a) - this.value(b));
      for (const p of owned) {
        if (s.cash >= 0) break;
        const proceeds = this._seize(p, RULES.seizeDiscount);
        s.cash += proceeds;
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

    // Mod A: monthly LTV covenant. Breach -> notice -> cure or seizure.
    /** Why the covenant is breached right now, or null. */
    covenantBreach() {
      if (!this.hasMod('bank') || this.s.loan <= 0) return null;
      if (this.s.loan > this.creditLimit()) return 'ltv';
      if (this.s.loan > RULES.creditBase * this.priceLevel() && this.interestCover() < RULES.minCover) return 'cover';
      return null;
    }

    _checkCovenant() {
      const s = this.s;
      const limit = this.creditLimit();
      const breach = this.covenantBreach();
      if (!breach) {
        if (s.covenant) {
          s.covenant = null;
          this._log('Covenant restored. The bank relaxes.', 'good');
        }
        return;
      }
      if (!s.covenant) {
        s.covenant = { since: s.month, deadline: s.month + RULES.covenantMonths, reason: breach };
        this._log('Covenant breach! ' + (breach === 'ltv'
          ? 'Loan ' + fmt(s.loan) + ' exceeds the bank\'s limit of ' + fmt(limit) + '.'
          : 'Rent covers interest only ' + this.interestCover().toFixed(2) + '×; the bank wants ' + RULES.minCover + '×.') +
          ' Repay or sell by ' + this.dateLabel(s.covenant.deadline) + ' or the bank sells for you.', 'bad');
        return;
      }
      s.covenant.reason = breach;
      if (s.month + 1 < s.covenant.deadline) return;
      // Enforcement: seize cheapest first, proceeds pay down the loan.
      const owned = this.portfolio().sort((a, b) => this.value(a) - this.value(b));
      for (const p of owned) {
        if (!this.covenantBreach()) break;
        const proceeds = this._seize(p, RULES.seizeDiscount);
        const paid = this._paydown(proceeds);
        s.cash += proceeds - paid;
        this._log('The bank enforces its covenant: ' + p.address + ' sold for ' + fmt(proceeds) + '.', 'bad');
      }
      s.covenant = null;
      if (s.loan > this.creditLimit() && this.portfolio().length === 0 && this.netWorth() < 0) {
        s.status = 'bankrupt';
        this._log('You are bankrupt. The bank takes everything.', 'end');
      }
    }
  }

  function fmt(n) {
    const sign = n < 0 ? '-' : '';
    return sign + '£' + Math.round(Math.abs(n)).toLocaleString('en-GB');
  }
  function pctStr(r) { return (Math.round(r * 10000) / 100).toFixed(2).replace(/\.?0+$/, '') + '%'; }

  const api = {
    Game, TYPES, DISTRICTS, RULES, MAP, CLASSES, POLICIES, ARREARS_POLICIES, MOD_KEYS, MOD_INFO,
    BUILDABLE, TARGETS, targetFor, modSig, formatMoney: fmt, formatRate: pctStr,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RentBaron = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
