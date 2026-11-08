/*
 * Rent Baron — text-mode user interface.
 *
 * An alternative front end to game.js: an 80x32 character screen in the
 * style of a 16-bit hi-res display, driven entirely by multiple-choice menus
 * (keyboard hotkeys or mouse clicks). Like ui.js it only uses the engine's
 * public API, and it shares the same save slot, so you can switch between
 * the two interfaces mid-game.
 */
(function () {
  'use strict';

  const {
    Game, TYPES, DISTRICTS, RULES, CLASSES, POLICIES, ARREARS_POLICIES, MOD_KEYS, MOD_INFO, BUILDABLE,
    targetFor, formatMoney: money, formatRate: rate,
  } = window.RentBaron;

  const COLS = 80, ROWS = 32;
  const SAVE_KEY = 'rentbaron.save.v1';          // shared with the graphical UI
  const PREFS_KEY = 'rentbaron.textprefs.v1';
  const LENGTHS = [10, 15, 20, 25, 30, 35, 40, 45, 50];
  const PAGE = 20;                               // list rows per page (keys A-T)
  const LETTERS = 'ABCDEFGHIJKLMNOPQRST';

  // Colours (12-bit palette).
  const BG = '#05a', FG = '#fff', KEY = '#f80', DIM = '#8af', GOOD = '#4e4', BAD = '#f66', WARN = '#fc0', INK = '#000';
  const CLASS_FG = { family: '#fd6', student: '#d9f', pro: '#eef', pensioner: '#ca6', council: '#9df' };
  const TYPE_CODE = { terrace: 'TER', bedsit: 'BED', flats: 'FLT', tower: 'TWR', lot: 'LOT' };

  const screenEl = document.getElementById('screen');
  const wrapEl = document.getElementById('wrap');

  const ui = {
    game: null,
    stack: [{ id: 'main' }],
    keys: {},          // hotkey -> handler, rebuilt every render
    message: null,     // { text, bad }
    prompt: null,      // { label, buf, onSubmit, hint }
    cursor: 0,         // town map cursor (property id)
    lastStatus: 'playing',
    years: RULES.defaultYears,
    mods: { bank: true, tenants: true, build: true },
  };

  // ---------------------------------------------------------------------------
  // Screen buffer
  // ---------------------------------------------------------------------------

  let buf;
  function cls() {
    buf = [];
    for (let y = 0; y < ROWS; y++) {
      const row = [];
      for (let x = 0; x < COLS; x++) row.push({ ch: ' ', fg: FG, bg: BG, k: null });
      buf.push(row);
    }
    ui.keys = {};
  }

  /** Write text at (x, y); returns the column after the text. */
  function put(x, y, text, fg, bg, k) {
    text = String(text);
    for (let i = 0; i < text.length; i++) {
      const cx = x + i;
      if (y < 0 || y >= ROWS || cx < 0 || cx >= COLS) continue;
      const c = buf[y][cx];
      c.ch = text[i];
      if (fg) c.fg = fg;
      if (bg) c.bg = bg;
      c.k = k || null;
    }
    return x + text.length;
  }
  function fillRow(y, bg, fg) { for (let x = 0; x < COLS; x++) { buf[y][x].bg = bg; if (fg) buf[y][x].fg = fg; } }
  function hline(y, ch, fg) { put(0, y, (ch || '-').repeat(COLS), fg || DIM); }
  const pad = (s, n) => { s = String(s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); };
  const rpad = (s, n) => { s = String(s); return s.length >= n ? s.slice(0, n) : ' '.repeat(n - s.length) + s; };

  /** A menu option: "[K] label". Registers the hotkey unless disabled. */
  function opt(x, y, key, label, handler, disabled, fg) {
    const k = disabled ? null : String(key).toUpperCase();
    if (k) ui.keys[k] = handler;
    put(x, y, '[', disabled ? DIM : FG, null, k);
    put(x + 1, y, String(key), disabled ? DIM : KEY, null, k);
    put(x + 2, y, '] ', disabled ? DIM : FG, null, k);
    return put(x + 4, y, label, disabled ? DIM : (fg || FG), null, k);
  }

  /** Word-wrap text into the box starting at (x, y); returns next free row. */
  function para(x, y, w, text, fg) {
    const words = String(text).split(/\s+/);
    let line = '';
    for (const word of words) {
      if ((line + ' ' + word).trim().length > w) { put(x, y++, line, fg); line = word; }
      else line = (line + ' ' + word).trim();
    }
    if (line) put(x, y++, line, fg);
    return y;
  }

  function flush() {
    const html = [];
    for (let y = 0; y < ROWS; y++) {
      let run = null, text = '';
      const out = [];
      const close = () => {
        if (!run) return;
        const attrs = 'style="color:' + run.fg + ';background:' + run.bg + '"' + (run.k ? ' data-k="' + run.k + '" class="opt"' : '');
        out.push('<span ' + attrs + '>' + text.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</span>');
      };
      for (let x = 0; x < COLS; x++) {
        const c = buf[y][x];
        if (!run || run.fg !== c.fg || run.bg !== c.bg || run.k !== c.k) { close(); run = c; text = ''; }
        text += c.ch;
      }
      close();
      html.push(out.join(''));
    }
    screenEl.innerHTML = html.join('\n');
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const short = (n) => {
    const a = Math.abs(n), s = n < 0 ? '-£' : '£';
    if (a >= 1e6) return s + (a / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
    if (a >= 1e4) return s + Math.round(a / 1e3) + 'k';
    return money(n);
  };
  const signed = (n) => (n >= 0 ? '+' : '-') + money(Math.abs(n));
  const pct = (n) => Math.round(n * 100) + '%';
  const conditionLabel = (c) => c >= 85 ? 'Pristine' : c >= 65 ? 'Good' : c >= 45 ? 'Tired' : c >= 25 ? 'Shabby' : 'Derelict';
  const typeLabel = (p) => p.type === 'lot' ? (p.build ? 'Site: ' + TYPES[p.build.to].label : 'Vacant lot') : TYPES[p.type].label + (p.build ? ' (works)' : '');

  function store(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* ignore */ } }
  function load(key) { try { const r = localStorage.getItem(key); return r ? JSON.parse(r) : null; } catch (e) { return null; } }

  function say(text, bad) { ui.message = text ? { text, bad: !!bad } : null; }
  /** Run an engine action and report its result on the message line. */
  function act(result) { say(result.message, !result.ok); return result; }

  function top() { return ui.stack[ui.stack.length - 1]; }
  function go(id, args) { ui.stack.push(Object.assign({ id }, args)); render(); }
  function back() { if (ui.prompt) { ui.prompt = null; } else if (ui.stack.length > 1) ui.stack.pop(); render(); }
  function home() { ui.stack = [{ id: 'main' }]; render(); }

  function ask(label, hint, onSubmit) { ui.prompt = { label, hint, buf: '', onSubmit }; render(); }

  function confirm(question, detail, yes) {
    go('confirm', { question, detail, yes });
  }

  // ---------------------------------------------------------------------------
  // Frame: status lines and footer
  // ---------------------------------------------------------------------------

  function frame(title) {
    const g = ui.game, s = g.state;
    fillRow(0, FG, BG);
    let x = put(0, 0, ' RENT BARON ', BG, FG);
    x = put(x + 1, 0, g.dateLabel() + ' (' + g.monthsLeft() + ' mo left)', INK, FG);
    x = put(x + 2, 0, 'Cash ' + money(s.cash), s.cash < 0 ? '#c00' : INK, FG);
    x = put(x + 2, 0, 'Loan ' + money(s.loan), s.covenant ? '#c00' : INK, FG);
    put(x + 2, 0, 'Rep ' + Math.round(s.reputation), INK, FG);

    const nw = g.netWorth();
    x = put(1, 1, 'Worth ' + money(nw) + ' of ' + short(g.goal), FG);
    if (g.holdRequired() && g.holdProgress()) x = put(x + 1, 1, '(holding ' + g.holdProgress() + '/' + g.holdRequired() + ')', GOOD);
    if (g.hasMod('bank')) {
      const hist = s.rateHistory, prev = hist[Math.max(0, hist.length - 7)];
      const dir = g.baseRate() > prev ? '↑' : g.baseRate() < prev ? '↓' : '-';
      x = put(x + 2, 1, 'Base ' + rate(g.baseRate()) + dir, DIM);
      const ltv = g.ltv();
      x = put(x + 2, 1, 'LTV ' + (Number.isFinite(ltv) ? pct(ltv) : '--') + '/' + pct(g.maxLtv()), ltv > g.maxLtv() ? BAD : DIM);
      const cover = g.interestCover();
      put(x + 2, 1, 'Cover ' + (Number.isFinite(cover) ? cover.toFixed(2) + 'x' : '--'), cover < RULES.minCover ? BAD : cover < 2 ? WARN : DIM);
    }
    hline(2, '=');
    put(2, 2, ' ' + title + ' ', KEY);

    hline(ROWS - 3, '-');
    if (s.covenant) put(2, ROWS - 3, ' COVENANT BREACH: cure by ' + g.dateLabel(s.covenant.deadline) + ' ', '#fff', '#c00');
  }

  function footer(extra) {
    const y = ROWS - 2;
    if (ui.prompt) {
      const p = ui.prompt;
      const x = put(1, y, p.label + ' ', KEY);
      put(x, y, p.buf + '_', FG, '#000');
      put(1, ROWS - 1, p.hint || '[Enter] confirm  [Esc] cancel', DIM);
      return;
    }
    if (ui.message) put(1, y, ui.message.text.slice(0, COLS - 2), ui.message.bad ? BAD : GOOD);
    const parts = [];
    if (ui.stack.length > 1) parts.push(['Esc', 'Back']);
    if (!ui.game.isOver()) parts.push(['Spc', 'End month']);
    if (extra) parts.push(...extra);
    let x = 1;
    for (const [k, label] of parts) {
      const key = k === 'Esc' ? 'ESCAPE' : k === 'Spc' ? ' ' : k === 'Ent' ? 'ENTER' : k;
      ui.keys[key] = ui.keys[key] || (k === 'Esc' ? back : k === 'Spc' ? endMonth : null);
      x = put(x, ROWS - 1, '[', FG, null, key);
      x = put(x, ROWS - 1, k, KEY, null, key);
      x = put(x, ROWS - 1, '] ' + label + '  ', FG, null, key);
    }
    put(COLS - 18, ROWS - 1, '[G] Graphics mode', DIM, null, 'G');
    ui.keys.G = ui.keys.G || (() => { location.href = 'index.html'; });
  }

  // ---------------------------------------------------------------------------
  // Screens
  // ---------------------------------------------------------------------------

  const SCREENS = {};

  SCREENS.main = function () {
    const g = ui.game, s = g.state;
    frame('Main menu');
    let y = 4;
    opt(2, y++, 'M', 'Town map', () => go('map'));
    opt(2, y++, 'P', 'Portfolio (' + g.portfolio().length + ')', () => go('list', { kind: 'portfolio', page: 0 }));
    opt(2, y++, 'F', 'For sale (' + g.listings().length + ')', () => go('list', { kind: 'market', page: 0 }));
    opt(2, y++, 'D', 'Street directory', () => go('districts'));
    y++;
    opt(2, y++, 'B', 'Bank', () => go('bank'));
    opt(2, y++, 'C', 'Council', () => go('council'), !g.hasMod('build'));
    opt(2, y++, 'A', 'Accounts & charts', () => go('accounts'));
    opt(2, y++, 'Z', 'Gazette', () => go('gazette', { page: 0 }));
    y++;
    opt(2, y++, 'E', 'End month', endMonth, g.isOver());
    opt(2, y++, 'N', 'New game', () => go('newgame'));
    opt(2, y++, 'H', 'Help', () => go('help'));

    // Right-hand summary.
    const x = 34;
    y = 4;
    put(x, y++, 'This month', KEY);
    const r = s.lastReport;
    if (r) {
      put(x, y++, pad('Rent collected', 22) + rpad(money(r.rent), 14), FG);
      put(x, y++, pad('Costs and interest', 22) + rpad('-' + money(r.upkeep + r.tax + r.incidents + r.interest + r.construction), 14), FG);
      put(x, y++, pad('Net', 22) + rpad(signed(r.net), 14), r.net < 0 ? BAD : GOOD);
    } else put(x, y++, 'No accounts yet. Buy something!', DIM);
    y++;
    const SHORT = { bank: 'Bank moods', tenants: 'Tenants', build: 'Building' };
    put(x, y++, 'Rules: ' + (g.modSignature() ? MOD_KEYS.filter(k => g.hasMod(k)).map(k => SHORT[k]).join(', ') : 'classic'), DIM);
    y++;
    put(x, y++, 'Latest news', KEY);
    const news = s.log.slice(-6).reverse();
    for (const e of news) {
      if (y > ROWS - 5) break;
      y = para(x, y, COLS - x - 1, g.dateLabel(e.month) + ' ' + e.text, e.kind === 'bad' ? BAD : e.kind === 'good' ? GOOD : FG);
    }
    footer();
  };

  // Town map: 8x6 tiles of 10x3 characters; arrows move, Enter opens.
  SCREENS.map = function () {
    const g = ui.game, s = g.state;
    frame('Town map');
    const { width, height } = g.mapSize;
    const scheme = {};
    for (const sc of s.schemes || []) for (const id of sc.tiles) scheme[id] = sc.kind;
    for (const p of s.properties) {
      const x0 = p.x * 10, y0 = 4 + p.y * 4;
      const sel = p.id === ui.cursor;
      const k = 'T' + p.id;
      ui.keys[k] = () => { ui.cursor = p.id; go('property', { pid: p.id }); };
      const bg = sel ? FG : scheme[p.id] === 'regen' ? '#038' : scheme[p.id] === 'bypass' ? '#600' : BG;
      const fg = sel ? BG : p.owned ? KEY : p.forSale ? GOOD : FG;
      const code = p.build ? 'SIT' : TYPE_CODE[p.type];
      const l1 = code + ' ' + p.district + (p.owned ? ' *' : p.forSale ? ' £' : '  ');
      const l2 = p.units ? p.tenants + '/' + p.units + (p.lets && p.lets.some(l => l && l.arrears) ? '!' : '') : p.app ? 'planning' : '--';
      const l3 = p.units ? 'c' + Math.round(p.condition) : p.build ? p.build.monthsLeft + 'mo' : '';
      put(x0, y0, pad(' ' + l1, 9), fg, bg, k);
      put(x0, y0 + 1, pad(' ' + l2, 9), sel ? BG : DIM, bg, k);
      put(x0, y0 + 2, pad(' ' + l3, 9), sel ? BG : (p.condition < 30 && p.units ? BAD : DIM), bg, k);
    }
    const p = g.property(ui.cursor);
    put(0, 28, pad(' ' + p.address + ' - ' + typeLabel(p) + ' - ' + DISTRICTS[p.district].name, COLS), FG);
    const moveTo = (dx, dy) => () => {
      const q = g.property(ui.cursor);
      const nx = Math.max(0, Math.min(width - 1, q.x + dx)), ny = Math.max(0, Math.min(height - 1, q.y + dy));
      ui.cursor = ny * width + nx;
      render();
    };
    ui.keys.ARROWLEFT = moveTo(-1, 0); ui.keys.ARROWRIGHT = moveTo(1, 0);
    ui.keys.ARROWUP = moveTo(0, -1); ui.keys.ARROWDOWN = moveTo(0, 1);
    ui.keys.ENTER = () => go('property', { pid: ui.cursor });
    put(1, 3, 'Arrows move, Enter opens.  * yours  £ for sale  ! arrears  c = condition', DIM);
    footer([['Ent', 'Open']]);
  };

  function listRow(g, p, own) {
    const d = DISTRICTS[p.district].name;
    const let_ = p.units ? p.tenants + '/' + p.units : '--';
    if (own) {
      const net = g.projectedNet(p);
      return [pad(p.address, 17), pad(d, 12), pad(typeLabel(p), 13), rpad(let_, 6), rpad(p.units ? money(p.rent) : '--', 7),
        rpad(p.units ? Math.round(p.condition) : '--', 5), rpad(short(g.value(p)), 7), rpad(signed(net), 9)].join(' ');
    }
    const price = g.askingPrice(p);
    const mr = g.marketRent(p);
    const est = p.units ? mr * p.units * g.expectedOccupancy(p, mr) - g.runningCost(p) : 0;
    return [pad(p.address, 17), pad(d, 12), pad(typeLabel(p), 13), rpad(let_, 6), rpad(p.units ? Math.round(p.condition) : '--', 5),
      rpad(short(price), 8), rpad(p.units ? (est * 12 / price * 100).toFixed(1) + '%' : '--', 7)].join(' ');
  }

  SCREENS.list = function (args) {
    const g = ui.game;
    const own = args.kind === 'portfolio';
    let items = own ? g.portfolio() : args.kind === 'market' ? g.listings() : g.state.properties.filter(p => p.district === args.district);
    const title = own ? 'Portfolio' : args.kind === 'market' ? 'For sale' : 'Directory: ' + DISTRICTS[args.district].name;
    frame(title);
    const pages = Math.max(1, Math.ceil(items.length / PAGE));
    args.page = Math.min(args.page || 0, pages - 1);
    const head = own
      ? '    Address           Area         Type             Let    Rent  Cond   Value       Net'
      : '    Address           Area         Type             Let  Cond    Price   Yield';
    put(0, 4, head, KEY);
    if (!items.length) put(4, 6, own ? 'You own nothing yet. Try [F] For sale from the main menu.' : 'Nothing here this month.', DIM);
    items.slice(args.page * PAGE, args.page * PAGE + PAGE).forEach((p, i) => {
      const key = LETTERS[i];
      const fg = p.owned ? (own ? FG : KEY) : p.forSale ? GOOD : FG;
      opt(0, 5 + i, key, listRow(g, p, own || p.owned), () => { ui.cursor = p.id; go('property', { pid: p.id }); }, false, fg);
    });
    const extra = [];
    if (pages > 1) {
      put(1, ROWS - 4, 'Page ' + (args.page + 1) + ' of ' + pages, DIM);
      if (args.page > 0) { ui.keys['<'] = ui.keys[','] = () => { args.page--; render(); }; extra.push(['<', 'Prev']); }
      if (args.page < pages - 1) { ui.keys['>'] = ui.keys['.'] = () => { args.page++; render(); }; extra.push(['>', 'Next']); }
    }
    footer(extra);
  };

  SCREENS.districts = function () {
    frame('Street directory');
    let y = 4;
    Object.entries(DISTRICTS).forEach(([k, d], i) => {
      const dd = ui.game.district(k);
      opt(2, y, i + 1, pad(d.name, 14), () => go('list', { kind: 'district', district: k, page: 0 }));
      put(24, y, 'appeal ' + dd.desirability.toFixed(2), DIM);
      y += 2;
    });
    footer();
  };

  SCREENS.property = function (args) {
    const g = ui.game, s = g.state;
    const p = g.property(args.pid);
    frame(p.address);
    const d = g.district(p.district);
    let y = 4;
    put(1, y++, typeLabel(p) + ' - ' + d.name + (p.units ? ' - ' + p.units + ' units' : ''), KEY);
    y++;
    const kv = (label, value, fg) => { put(1, y, pad(label, 15), DIM); put(16, y++, value, fg || FG); };
    if (p.units) {
      kv('Condition', Math.round(p.condition) + ' ' + conditionLabel(p.condition), p.condition < 30 ? BAD : p.condition < 60 ? WARN : GOOD);
      kv('Tenants', p.tenants + '/' + p.units);
    }
    kv(g.hasMod('build') ? 'Street appeal' : 'Area appeal', g.localDesirability(p).toFixed(2) + ' (district ' + d.desirability.toFixed(2) + ')');
    kv('Value', money(g.value(p)));
    if (p.units) {
      kv('Market rent', money(g.marketRent(p)) + '/unit');
      kv(g.hasMod('tenants') ? 'Asking rent' : 'Your rent', money(p.rent) + '/unit');
    }
    if (p.owned) {
      if (p.units) kv('Running cost', money(g.runningCost(p)) + '/mo');
      const net = g.projectedNet(p);
      kv('Net (now)', signed(net) + '/mo', net < 0 ? BAD : GOOD);
      kv('Paid', money(p.boughtFor) + ' ' + g.dateLabel(p.boughtMonth));
    } else if (p.forSale) {
      kv('Asking price', money(g.askingPrice(p)), KEY);
      if (p.units) {
        const mr = g.marketRent(p);
        const est = mr * p.units * g.expectedOccupancy(p, mr) - g.runningCost(p);
        kv('Est. net', signed(Math.round(est)) + '/mo');
        kv('Yield', (est * 12 / g.askingPrice(p) * 100).toFixed(1) + '%/yr');
      }
    } else {
      put(1, y++, p.cooldown > 0 ? 'Recently sold; not for sale yet.' : 'Not on the market.', DIM);
    }

    // Right column: tenants or development status.
    let ry = 6;
    const rx = 42;
    if (p.lets && p.units) {
      const sum = g.tenantSummary(p.id);
      put(rx, ry++, 'Tenants', KEY);
      for (const [c, n] of Object.entries(sum.classes)) if (n) put(rx, ry++, pad(CLASSES[c].label, 16) + rpad(n, 3), CLASS_FG[c]);
      if (sum.arrears) put(rx, ry++, sum.arrears + ' in arrears (' + money(sum.owed) + ')', BAD);
      if (sum.stale) put(rx, ry++, sum.stale + ' stale rents below market', WARN);
      if (sum.voids) put(rx, ry++, sum.voids + ' void after eviction', DIM);
      if (sum.nextReview != null) put(rx, ry++, 'Next review ' + g.dateLabel(sum.nextReview), DIM);
      if (p.owned) {
        put(rx, ry++, 'Letting: ' + POLICIES[p.policy].label, FG);
        put(rx, ry++, 'Arrears: ' + ARREARS_POLICIES[p.arrearsPolicy], FG);
      }
    }
    if (p.app) ry = para(rx, ry + 1, COLS - rx - 1, (p.app.appeal ? 'Appeal' : 'Planning') + ': ' + (p.app.kind === 'convert' ? 'convert to ' : 'build ') +
      TYPES[p.app.to].label.toLowerCase() + ', ' + Math.round(p.app.chance * 100) + '% likely, decision ' + g.dateLabel(p.app.decideAt) + '.', WARN);
    if (p.refused) ry = para(rx, ry + 1, COLS - rx - 1, 'Planning refused for ' + TYPES[p.refused.to].label.toLowerCase() + '. Blocked until ' + g.dateLabel(p.blockedUntil) + '.', BAD);
    if (p.build) ry = para(rx, ry + 1, COLS - rx - 1, 'Works: ' + TYPES[p.build.to].label.toLowerCase() + ', ' + p.build.monthsLeft + ' months left. Paid ' + money(p.build.paid) + ' of ' + money(p.build.cost) + '.', WARN);

    // Actions.
    y = Math.max(y, ry) + 1;
    hline(y++, '-');
    put(1, y++, 'Actions', KEY);
    const actions = [];
    if (p.owned) {
      if (p.units && !p.build) {
        actions.push(['Set ' + (g.hasMod('tenants') ? 'asking ' : '') + 'rent', () => go('rent', { pid: p.id })]);
        actions.push(['Patch up (' + money(g.patchCost(p)) + ')', () => { act(g.repair(p.id, 'patch')); render(); }, p.condition >= 100]);
        actions.push(['Refurbish (' + money(g.refurbCost(p)) + ')', () => { act(g.repair(p.id, 'refurb')); render(); }, p.condition >= 100]);
        if (g.hasMod('tenants')) {
          actions.push(['Letting policy', () => go('choose', {
            title: 'Letting policy: ' + p.address, options: Object.entries(POLICIES).map(([k, v]) => [v.label, () => act(g.setPolicy(p.id, k)), p.policy === k]),
          })]);
          actions.push(['Arrears policy', () => go('choose', {
            title: 'Arrears policy: ' + p.address, options: Object.entries(ARREARS_POLICIES).map(([k, v]) => [v, () => act(g.setArrearsPolicy(p.id, k)), p.arrearsPolicy === k]),
          })]);
        }
      }
      if (g.hasMod('build')) {
        const conv = g.conversionFor(p);
        if (conv && !p.build) actions.push(['Convert to ' + TYPES[conv.to].label.toLowerCase() + ' (' + money(g.conversionCost(p)) + ', ' + Math.round(g.planningChance(p, conv.to) * 100) + '%)',
          () => { act(g.convert(p.id)); render(); }, g.isBusy(p) || p.blockedUntil > s.month]);
        if (p.type === 'lot' && !p.build && !p.app) actions.push(['Build...', () => go('build', { pid: p.id }), p.blockedUntil > s.month]);
        if (p.refused) actions.push(['Appeal (' + money(g.appealFee()) + ')', () => { act(g.appeal(p.id)); render(); }]);
        if (p.type !== 'lot' && !p.build) actions.push(['Demolish (' + money(g.demolishCost(p)) + ')', () => confirm('Demolish ' + p.address + '?',
          p.tenants ? p.tenants + ' households will be displaced. Families and pensioners make the papers.' : 'The plot is clear next month.',
          () => act(g.demolish(p.id))), g.isBusy(p)]);
      }
      if (!p.build) actions.push(['Sell (' + money(g.saleProceeds(p)) + ')', () => confirm('Sell ' + p.address + ' for ' + money(g.saleProceeds(p)) + '?',
        'After the ' + Math.round(RULES.sellFee * 100) + '% agent\'s fee. You paid ' + money(p.boughtFor) + '.', () => act(g.sell(p.id)))]);
    } else if (p.forSale) {
      const price = g.askingPrice(p);
      actions.push(['Buy for ' + money(price), () => { act(g.buy(p.id)); render(); }, price > s.cash]);
      if (price > s.cash) {
        const need = Math.ceil((price - s.cash) / 1000) * 1000;
        actions.push(['Borrow ' + money(need) + ' and buy', () => { if (act(g.borrow(need)).ok) act(g.buy(p.id)); render(); },
          need > g.availableCredit() || !!s.covenant]);
      }
    }
    actions.forEach(([label, fn, disabled], i) => {
      const col = i % 2, row = Math.floor(i / 2);
      opt(1 + col * 40, y + row, i + 1, label.slice(0, 34), fn, disabled || g.isOver());
    });
    if (!actions.length) put(1, y, 'Nothing to do here.', DIM);
    footer();
  };

  SCREENS.rent = function (args) {
    const g = ui.game;
    const p = g.property(args.pid);
    const mr = g.marketRent(p);
    frame('Rent: ' + p.address);
    let y = 4;
    put(1, y++, 'Market rent ' + money(mr) + '/unit. Current ' + (g.hasMod('tenants') ? 'asking ' : '') + 'rent ' + money(p.rent) + '.', FG);
    if (g.hasMod('tenants')) y = para(1, y, 78, 'Sitting tenants move to the asking rent at their annual review; rises may drive them out.', DIM);
    y++;
    const choices = [0.8, 0.9, 0.95, 1.0, 1.1, 1.2, 1.3].map(k => Math.round(mr * k / 5) * 5);
    choices.forEach((r, i) => {
      const occ = g.expectedOccupancy(p, r);
      const income = Math.round(occ * p.units) * r - g.runningCost(p);
      opt(2, y, i + 1, pad(money(r) + '/unit', 13) + pad('(' + pct(r / mr) + ' of market)', 18) +
        '~' + Math.round(occ * p.units) + '/' + p.units + ' let, ' + signed(income) + '/mo' + (r / mr > 1.25 ? '  strike risk' : ''),
      () => { act(g.setRent(p.id, r)); back(); }, false, r === p.rent ? KEY : FG);
      y++;
    });
    y++;
    opt(2, y, 'O', 'Other amount...', () => ask('Rent per unit £', null, (v) => { act(g.setRent(p.id, v)); back(); }));
    footer();
  };

  SCREENS.build = function (args) {
    const g = ui.game;
    const p = g.property(args.pid);
    frame('Build on ' + p.address);
    put(1, 4, 'Application fee ' + money(g.applicationFee()) + '. Decision in ' + RULES.planningMonths + ' months; works paid monthly.', DIM);
    put(5, 6, pad('Type', 14) + rpad('Cost', 10) + rpad('Months', 8) + rpad('Value', 10) + rpad('Odds', 7), KEY);
    const mi = g.state.marketIndex * g.priceLevel();
    BUILDABLE.forEach((t, i) => {
      const cost = g.buildCost(p, t);
      const value = TYPES[t].baseValue * g.localDesirability(p) * mi;
      const ch = g.planningChance(p, t);
      opt(1, 7 + i, i + 1, pad(TYPES[t].label, 14) + rpad(short(cost), 10) + rpad(g.buildMonths(t), 8) + rpad(short(value), 10) + rpad(Math.round(ch * 100) + '%', 7),
        () => { act(g.build(p.id, t)); back(); }, false, value > cost ? FG : DIM);
    });
    para(1, 13, COLS - 2, 'Value is what the finished building would be worth today. Planning odds depend on the area, your reputation and council relations.', DIM);
    footer();
  };

  /** Generic single-choice submenu: options are [label, fn, current]. */
  SCREENS.choose = function (args) {
    frame(args.title);
    args.options.forEach(([label, fn, current], i) => {
      opt(2, 5 + i * 2, i + 1, label + (current ? '  (current)' : ''), () => { fn(); back(); }, false, current ? KEY : FG);
    });
    footer();
  };

  SCREENS.confirm = function (args) {
    frame('Confirm');
    put(2, 6, args.question, KEY);
    if (args.detail) para(2, 8, COLS - 4, args.detail, FG);
    opt(2, 12, 'Y', 'Yes', () => { args.yes(); back(); });
    opt(14, 12, 'N', 'No', back);
    footer();
  };

  /** Amount picker for borrowing/repaying. */
  function amountMenu(title, presets, fn) {
    go('choose', { title, options: presets.filter(([, v]) => v > 0).map(([label, v]) => [label, () => act(fn(v))]).concat([
      ['Other amount...', () => setTimeout(() => ask('Amount £', null, (v) => act(fn(Number(v)))), 0)],
    ]) });
  }

  SCREENS.bank = function () {
    const g = ui.game, s = g.state;
    const bank = g.hasMod('bank');
    frame('Bank');
    let y = 4;
    const kv = (label, value, fg) => { put(1, y, pad(label, 18), DIM); put(19, y++, value, fg || FG); };
    kv('Cash', money(s.cash), s.cash < 0 ? BAD : FG);
    kv('Loan', money(s.loan));
    kv('Credit limit', money(g.creditLimit()));
    kv('Can borrow', money(s.covenant ? 0 : g.availableCredit()));
    kv('Interest', money(g.monthlyInterest()) + '/mo');
    if (bank) {
      kv('Variable rate', rate(g.loanRate()) + ' (base ' + rate(g.baseRate()) + ')');
      if (s.fixed) kv('Fixed', money(s.fixed.balance) + ' @ ' + rate(s.fixed.rate) + ' to ' + g.dateLabel(s.fixed.until), GOOD);
      const ltv = g.ltv();
      kv('Loan to value', (Number.isFinite(ltv) ? pct(ltv) : '--') + ' (limit ' + pct(g.maxLtv()) + ')', ltv > g.maxLtv() ? BAD : FG);
      const cover = g.interestCover();
      kv('Interest cover', Number.isFinite(cover) ? cover.toFixed(2) + 'x (covenant ' + RULES.minCover + 'x)' : '--', cover < RULES.minCover ? BAD : cover < 2 ? WARN : GOOD);
    } else {
      kv('Rate', rate(g.loanRate()));
    }
    kv('Portfolio value', money(g.portfolioValue()));
    if (s.covenant) {
      y++;
      y = para(1, y, 38, 'COVENANT BREACH (' + (s.covenant.reason === 'cover' ? 'interest cover' : 'loan to value') + '). Repay or sell by ' +
        g.dateLabel(s.covenant.deadline) + ' or the bank sells your cheapest buildings at ' + pct(RULES.seizeDiscount) + ' of value.', BAD);
    }

    let ay = 4;
    const ax = 42;
    put(ax, ay++, 'Actions', KEY);
    opt(ax, ay++, 1, 'Borrow...', () => amountMenu('Borrow', [['£10,000', 10000], ['£50,000', 50000], ['£100,000', 100000],
      ['Maximum (' + money(g.availableCredit()) + ')', Math.floor(g.availableCredit() / 100) * 100]], (v) => g.borrow(v)), g.isOver() || !!s.covenant);
    opt(ax, ay++, 2, 'Repay...', () => amountMenu('Repay', [['£10,000', 10000], ['£50,000', 50000],
      ['All I can (' + money(Math.min(s.loan, Math.max(0, Math.floor(s.cash)))) + ')', Math.min(s.loan, Math.max(0, Math.floor(s.cash)))]], (v) => g.repay(v)), g.isOver() || s.loan <= 0);
    if (bank) {
      if (!s.fixed) {
        RULES.fixYears.forEach((yrs, i) => opt(ax, ay++, 3 + i, 'Fix ' + yrs + ' years at ' + rate(g.fixedRateOffer()), () => { act(g.fixRate(yrs)); render(); }, s.loan <= 0));
      } else {
        opt(ax, ay++, 3, 'Break fix (' + money(Math.round(s.fixed.balance * RULES.breakFee)) + ')', () => confirm('Break your fixed-rate deal?',
          'Costs ' + pct(RULES.breakFee) + ' of the fixed balance.', () => act(g.breakFix())));
      }
      ay++;
      put(ax, ay++, 'Base rate, last ' + Math.min(36, s.rateHistory.length) + ' months', KEY);
      chart(ax, ay, 36, 6, s.rateHistory.slice(-36), 0.03, 0.17, DIM);
      ay += 7;
      put(ax, ay++, 'House prices', KEY);
      chart(ax, ay, 36, 5, s.indexHistory.slice(-36), 0.5, 2, '#fc8');
    }
    footer();
  };

  /** Bar chart in characters: '#' bars topped with '*'. */
  function chart(x, y, w, hgt, data, min, max, fg) {
    if (!data.length) return;
    const step = data.length > w ? data.length / w : 1;
    const cols = Math.min(w, data.length);
    for (let i = 0; i < cols; i++) {
      const v = data[Math.min(data.length - 1, Math.floor(i * step))];
      const lvl = Math.max(1, Math.round((v - min) / (max - min) * hgt));
      for (let j = 0; j < hgt; j++) {
        const yy = y + hgt - 1 - j;
        if (j < lvl - 1) put(x + i, yy, ':', fg);
        else if (j === lvl - 1) put(x + i, yy, '*', FG);
        else put(x + i, yy, '.', '#028');
      }
    }
  }

  SCREENS.council = function () {
    const g = ui.game, s = g.state;
    frame('Council');
    let y = 4;
    put(1, y++, 'Relations ' + Math.round(s.councilRelations) + '/100', s.councilRelations < 30 ? BAD : FG);
    y = para(1, y + 1, 76, 'Good relations improve planning odds. A contribution to the mayor\'s fund helps; the more you give, the likelier a scandal that costs you reputation and every friend at the town hall.', DIM);
    y++;
    const pl = Math.max(1, Math.round(g.priceLevel()));
    [5000, 25000, 100000].forEach((n, i) => opt(2, y++, i + 1, 'Give ' + money(n * pl) + ' to the mayor\'s fund', () => { act(g.donate(n * pl)); render(); }, g.isOver()));
    y++;
    put(1, y++, 'Schemes', KEY);
    if (!s.schemes.length) put(1, y++, 'None announced.', DIM);
    for (const sc of s.schemes) {
      y = para(1, y, 76, (sc.kind === 'regen' ? 'Regeneration of ' + sc.name + ': compulsory purchase at 130% in ' : 'Bypass through ' + sc.name + ' opens ') + g.dateLabel(sc.due) + '.', sc.kind === 'regen' ? GOOD : BAD);
    }
    footer();
  };

  SCREENS.accounts = function () {
    const g = ui.game, s = g.state;
    frame('Accounts');
    let y = 4;
    const r = s.lastReport;
    put(1, y++, 'Last month', KEY);
    if (!r) put(1, y++, 'No accounts yet.', DIM);
    else {
      const line = (label, v, fg) => { put(1, y, pad(label, 20), DIM); put(21, y++, rpad(v, 14), fg || FG); };
      line('Rent collected', money(r.rent), GOOD);
      if (r.arrears) line('Unpaid (arrears)', money(r.arrears), BAD);
      line('Upkeep', '-' + money(r.upkeep));
      line('Property tax', '-' + money(r.tax));
      if (r.incidents) line('Incidents', '-' + money(r.incidents), BAD);
      if (r.construction) line('Building works', '-' + money(r.construction));
      line('Interest', '-' + money(r.interest));
      line('Net', signed(r.net), r.net < 0 ? BAD : GOOD);
      line('Move-ins / outs', '+' + r.moveIns + ' / -' + r.moveOuts);
      if (r.evictions) line('Evictions', String(r.evictions), BAD);
    }
    put(40, 4, 'Net worth (whole game)', KEY);
    const hist = s.history;
    chart(40, 5, 38, 10, hist, Math.min(0, ...hist), Math.max(g.goal, ...hist), KEY);
    put(40, 16, 'Goal ' + money(g.goal) + ', now ' + money(g.netWorth()), DIM);
    footer();
  };

  SCREENS.gazette = function (args) {
    const g = ui.game;
    frame('Gazette');
    const entries = g.state.log.slice().reverse();
    const lines = [];
    for (const e of entries) {
      const text = g.dateLabel(e.month) + '  ' + e.text;
      const fg = e.kind === 'bad' ? BAD : e.kind === 'good' ? GOOD : e.kind === 'end' ? KEY : FG;
      const words = text.split(' ');
      let line = '';
      for (const w of words) {
        if ((line + ' ' + w).trim().length > 76) { lines.push([line, fg]); line = '          ' + w; }
        else line = (line ? line + ' ' : '') + w;
      }
      lines.push([line, fg]);
    }
    const per = ROWS - 8;
    const pages = Math.max(1, Math.ceil(lines.length / per));
    args.page = Math.min(args.page || 0, pages - 1);
    lines.slice(args.page * per, args.page * per + per).forEach(([t, fg], i) => put(1, 4 + i, t, fg));
    const extra = [];
    if (args.page > 0) { ui.keys['<'] = ui.keys[','] = () => { args.page--; render(); }; extra.push(['<', 'Newer']); }
    if (args.page < pages - 1) { ui.keys['>'] = ui.keys['.'] = () => { args.page++; render(); }; extra.push(['>', 'Older']); }
    footer(extra);
  };

  SCREENS.help = function () {
    const g = ui.game;
    frame('Help');
    let y = 4;
    y = para(1, y, 78, 'Start with ' + money(RULES.startCash) + '. Reach a net worth of ' + money(g.goal) + ' within ' + g.state.years + ' years' +
      (g.holdRequired() ? ' and hold it for ' + g.holdRequired() + ' months' : '') + '.', FG);
    y++;
    y = para(1, y, 78, 'Every screen is a menu: press the key in [brackets] or click the option. Esc goes back, Space ends the month. On the town map, arrow keys move and Enter opens a building.', FG);
    y++;
    y = para(1, y, 78, 'Buy buildings, set rents (above market and tenants leave; far above and they strike), repair them before they rot, borrow against them, sell at market value minus a fee.', DIM);
    if (g.hasMod('bank')) y = para(1, y + 1, 78, 'BANK MOODS: the base rate moves in a credit cycle. Cheap money inflates prices, dear money deflates them with a lag. The bank tests loan-to-value (tighter when rates are high) and interest cover every month; breach and you have ' + RULES.covenantMonths + ' months before it sells for you. Fixing the rate protects your interest, not your LTV.', DIM);
    if (g.hasMod('tenants')) y = para(1, y + 1, 78, 'TENANT FACES: students, families, professionals, pensioners and council placements pay, wear and leave differently. Rent changes reach sitting tenants at their annual review. Arrears rise when times are hard: tolerate, chase or evict.', DIM);
    if (g.hasMod('build')) y = para(1, y + 1, 78, 'BRICKS & PERMISSION: demolish, build and convert with planning odds; buildings affect their street; watch for regeneration and bypass schemes.', DIM);
    footer();
  };

  SCREENS.newgame = function (args) {
    const mods = args.mods || (args.mods = Object.assign({}, ui.mods));
    if (args.years == null) args.years = ui.years;
    frame('New game');
    let y = 4;
    put(1, y++, 'Game length', KEY);
    LENGTHS.forEach((yrs, i) => {
      const col = i % 3, row = Math.floor(i / 3);
      opt(2 + col * 26, y + row, i + 1, pad(yrs + ' years', 9) + rpad(short(targetFor(yrs, mods)), 7), () => { args.years = yrs; render(); },
        false, args.years === yrs ? KEY : FG);
    });
    y += 4;
    put(1, y++, 'Rules (toggle)', KEY);
    MOD_KEYS.forEach(k => {
      const info = MOD_INFO[k];
      opt(2, y++, info.letter, (mods[k] ? '[x] ' : '[ ] ') + info.label, () => { mods[k] = !mods[k]; render(); }, false, mods[k] ? FG : DIM);
      put(10, y++, info.blurb, DIM);
    });
    y++;
    put(1, y++, 'Goal: ' + money(targetFor(args.years, mods)) + ' by ' + (RULES.startYear + args.years) + (mods.bank ? ', held for ' + RULES.holdMonths + ' months.' : '.'), GOOD);
    y++;
    opt(2, y, 'S', 'Start new game' + (ui.stack.length > 1 && !args.first ? ' (current game will be lost)' : ''), () => {
      ui.years = args.years;
      ui.mods = mods;
      ui.game = new Game({ years: ui.years, mods: ui.mods });
      ui.lastStatus = 'playing';
      ui.cursor = 0;
      say('New game: ' + args.years + ' years. Good luck.');
      home();
    });
    footer();
  };

  SCREENS.gameover = function () {
    const g = ui.game, s = g.state;
    frame(s.status === 'won' ? 'Success' : s.status === 'bankrupt' ? 'Bankrupt' : 'Retired');
    const nw = g.netWorth();
    if (s.status === 'bankrupt') {
      for (let yy = 8; yy < 14; yy++) fillRow(yy, '#000', '#f00');
      put(10, 10, 'Bankruptcy.   Press [N] for a new game.', '#f00', '#000');
      put(10, 11, 'Meditation #' + String(s.month).padStart(4, '0') + '.' + (Math.abs(Math.round(nw)) & 0xffff).toString(16).toUpperCase().padStart(4, '0'), '#f00', '#000');
    } else {
      put(4, 8, s.status === 'won' ? 'You are a Rent Baron!' : 'Time to hang up the keys.', KEY);
      para(4, 10, 72, s.status === 'won'
        ? 'You reached ' + money(nw) + (g.holdRequired() ? ' and held it' : '') + ' in ' + s.month + ' months.'
        : 'Net worth ' + money(nw) + ', ' + pct(Math.max(0, nw) / g.goal) + ' of the ' + money(g.goal) + ' goal.', FG);
    }
    opt(4, 16, 'N', 'New game', () => go('newgame'));
    opt(4, 17, 'L', 'Look around', home);
    footer();
  };

  // ---------------------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------------------

  function endMonth() {
    const g = ui.game;
    if (g.isOver()) return;
    const r = g.endMonth();
    if (r.ok && r.data) say(g.dateLabel() + ': net ' + signed(r.data.net) + '.', r.data.net < 0);
    render();
  }

  function render() {
    const g = ui.game;
    if (g.state.status !== ui.lastStatus) {
      ui.lastStatus = g.state.status;
      if (g.isOver()) ui.stack = [{ id: 'main' }, { id: 'gameover' }];
    }
    cls();
    const s = top();
    (SCREENS[s.id] || SCREENS.main)(s);
    flush();
    ui.message = null;
    store(SAVE_KEY, g.toJSON());
    store(PREFS_KEY, { years: ui.years, mods: ui.mods, cursor: ui.cursor });
  }

  function keyName(e) {
    if (e.key === ' ') return ' ';
    if (e.key.length === 1) return e.key.toUpperCase();
    return e.key.toUpperCase();
  }

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (ui.prompt) {
      const p = ui.prompt;
      if (e.key === 'Enter') { ui.prompt = null; if (p.buf) p.onSubmit(p.buf); render(); }
      else if (e.key === 'Escape') { ui.prompt = null; render(); }
      else if (e.key === 'Backspace') { p.buf = p.buf.slice(0, -1); render(); }
      else if (/^[0-9]$/.test(e.key) && p.buf.length < 10) { p.buf += e.key; render(); }
      e.preventDefault();
      return;
    }
    let k = keyName(e);
    if (k === 'BACKSPACE') k = 'ESCAPE';
    const fn = ui.keys[k];
    if (fn) { e.preventDefault(); fn(); }
  });

  screenEl.addEventListener('click', (e) => {
    const span = e.target.closest('[data-k]');
    if (!span) return;
    const fn = ui.keys[span.dataset.k];
    if (fn) fn();
  });

  /** Scale the 640x256 screen with tall hi-res pixels (1:2) to fit the window. */
  function fit() {
    const dpr = window.devicePixelRatio || 1;
    const availW = wrapEl.clientWidth - 16, availH = window.innerHeight - 16;
    let k = Math.min(availW / 640, availH / 512);
    if (k >= 1) k = Math.floor(k * dpr) / dpr;   // keep device-pixel alignment when we can
    k = Math.max(0.3, k);
    screenEl.style.transform = 'scale(' + k + ',' + 2 * k + ')';
    screenEl.parentElement.style.width = Math.floor(640 * k) + 'px';
    screenEl.parentElement.style.height = Math.floor(512 * k) + 'px';
  }

  function init() {
    const prefs = load(PREFS_KEY) || {};
    if (LENGTHS.includes(prefs.years)) ui.years = prefs.years;
    if (prefs.mods) for (const k of MOD_KEYS) ui.mods[k] = !!prefs.mods[k];
    const saved = load(SAVE_KEY);
    if (saved) { try { ui.game = Game.fromJSON(saved); } catch (e) { ui.game = null; } }
    if (ui.game) {
      ui.lastStatus = ui.game.state.status;
      if (Number.isInteger(prefs.cursor) && ui.game.property(prefs.cursor)) ui.cursor = prefs.cursor;
      if (ui.game.isOver()) ui.stack = [{ id: 'main' }, { id: 'gameover' }];
    } else {
      ui.game = new Game({ years: ui.years, mods: ui.mods });
      ui.stack = [{ id: 'main' }, { id: 'newgame', first: true }];
    }
    render();
    fit();
    window.addEventListener('resize', fit);
    screenEl.focus();
  }

  init();
})();
