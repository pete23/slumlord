/*
 * Rent Baron — user interface.
 *
 * Owns the DOM, input handling and browser storage. All game rules live in
 * game.js; this file only calls the engine's public API and draws the result.
 */
(function () {
  'use strict';

  const { Game, TYPES, DISTRICTS, formatMoney: money } = window.RentBaron;
  const SAVE_KEY = 'rentbaron.save.v1';
  const PREFS_KEY = 'rentbaron.prefs.v1';

  // Window grid (columns) per building type, for the map tiles.
  const WINDOW_COLS = { terrace: 2, bedsit: 2, flats: 3, tower: 5 };

  const ui = {
    game: null,
    selected: null,
    tab: 'portfolio',
    lastStatus: 'playing',
  };

  const $ = (sel) => document.querySelector(sel);
  const el = {
    stats: $('#stats'), map: $('#map'), legend: $('#legend'), detail: $('#detail'),
    bank: $('#bank'), bankForm: $('#bank-form'), bankAmount: $('#bank-amount'),
    report: $('#report'), chart: $('#chart'), list: $('#list'), log: $('#log'),
    toast: $('#toast'), dialog: $('#dialog'), dialogBody: $('#dialog-body'), dialogActions: $('#dialog-actions'),
  };

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else if (k === 'style') node.style.cssText = v;
        else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  const pct = (n) => Math.round(n * 100) + '%';
  const signed = (n) => (n >= 0 ? '+' : '') + money(n);

  function store(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage unavailable */ }
  }
  function load(key) {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  }
  function forget(key) {
    try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
  }

  let toastTimer = 0;
  function toast(msg, bad) {
    if (!msg) return;
    el.toast.textContent = msg;
    el.toast.classList.toggle('bad', !!bad);
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2600);
  }

  /** Run an engine action, report failures, re-render on success. */
  function act(result) {
    if (!result.ok) toast(result.message, true);
    else if (result.message) toast(result.message);
    render();
    return result;
  }

  function conditionLabel(c) {
    if (c >= 85) return 'Pristine';
    if (c >= 65) return 'Good';
    if (c >= 45) return 'Tired';
    if (c >= 25) return 'Shabby';
    return 'Derelict';
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  function render() {
    const g = ui.game;
    renderStats(g);
    renderMap(g);
    renderDetail(g);
    renderBank(g);
    renderList(g);
    renderLog(g);
    renderChart(g);
    el.bankForm.querySelectorAll('button, input').forEach(b => { b.disabled = g.isOver(); });
    $('#btn-end').disabled = g.isOver();
    store(SAVE_KEY, g.toJSON());
    store(PREFS_KEY, { tab: ui.tab, selected: ui.selected });

    if (g.state.status !== ui.lastStatus) {
      ui.lastStatus = g.state.status;
      if (g.isOver()) showGameOver(g);
    }
  }

  function renderStats(g) {
    const s = g.state;
    const nw = g.netWorth();
    const items = [
      ['Date', g.dateLabel(), g.monthsLeft() + ' months left'],
      ['Cash', money(s.cash), s.cash < 0 ? 'overdrawn' : ''],
      ['Loan', money(s.loan), money(g.monthlyInterest()) + '/mo interest'],
      ['Net worth', money(nw), pct(Math.max(0, nw) / g.rules.goal) + ' of goal'],
      ['Reputation', Math.round(s.reputation) + '/100', s.reputation >= 60 ? 'well liked' : s.reputation >= 35 ? 'tolerated' : 'notorious'],
    ];
    el.stats.replaceChildren(...items.map(([k, v, sub]) =>
      h('div', { class: 'stat' }, h('dt', null, k), h('dd', null, v, sub ? h('small', null, sub) : null))));
  }

  function renderMap(g) {
    const { width } = g.mapSize;
    el.map.style.setProperty('--cols', width);
    const tiles = g.state.properties.map(p => {
      const t = TYPES[p.type];
      const cols = WINDOW_COLS[p.type];
      const windows = [];
      for (let i = 0; i < t.units; i++) windows.push(h('i', { class: i < p.tenants ? 'lit' : '' }));
      const classes = ['tile', 'd-' + p.district, 't-' + p.type];
      if (p.owned) classes.push('owned');
      if (p.forSale && !p.owned) classes.push('sale');
      if (ui.selected === p.id) classes.push('selected');
      return h('button', {
        type: 'button', class: classes.join(' '),
        dataset: { id: p.id },
        style: '--cond:' + (p.condition / 100).toFixed(2) + ';--wcols:' + cols,
        'aria-label': p.address + ', ' + t.label + (p.owned ? ', yours' : p.forSale ? ', for sale' : ''),
        'aria-pressed': ui.selected === p.id ? 'true' : 'false',
        title: p.address + ' · ' + t.label,
      },
        h('span', { class: 'bldg' }, h('span', { class: 'windows' }, windows)),
        p.owned ? h('span', { class: 'flag', 'aria-hidden': 'true' }) : null,
        p.forSale && !p.owned ? h('span', { class: 'sign', 'aria-hidden': 'true' }, '£') : null);
    });
    el.map.replaceChildren(...tiles);

    if (!el.legend.childElementCount) {
      el.legend.replaceChildren(...Object.entries(DISTRICTS).map(([k, d]) =>
        h('span', { class: 'legend-item d-' + k }, h('i'), d.name)));
    }
  }

  function row(label, value, extra) {
    return h('div', { class: 'kv' + (extra ? ' ' + extra : '') }, h('dt', null, label), h('dd', null, value));
  }

  function bar(value, cls) {
    return h('span', { class: 'bar ' + (cls || '') }, h('span', { style: 'width:' + Math.round(value * 100) + '%' }));
  }

  function renderDetail(g) {
    const p = ui.selected == null ? null : g.property(ui.selected);
    if (!p) {
      el.detail.replaceChildren(
        h('h2', null, 'Pick a building'),
        h('p', { class: 'muted' }, 'Click any building on the map, or a row in the lists below, to inspect it. ' +
          'Buildings with a £ sign are on the market.'),
        h('p', { class: 'muted' }, 'Rough areas are cheap and pay high yields but fall apart and attract trouble. ' +
          'Posh areas cost more, rent for less relative to price, and reward repairs.'));
      return;
    }

    const t = TYPES[p.type];
    const d = g.district(p.district);
    const value = g.value(p);
    const mr = g.marketRent(p);
    const parts = [
      h('div', { class: 'detail-head' },
        h('div', null,
          h('h2', null, p.address),
          h('p', { class: 'muted' }, t.label + ' · ' + d.name + ' · ' + t.units + ' unit' + (t.units > 1 ? 's' : ''))),
        h('button', { type: 'button', class: 'ghost icon', 'aria-label': 'Close', onclick: () => select(null) }, '×')),
      h('dl', { class: 'kvs' },
        row('Condition', h('span', null, bar(p.condition / 100, p.condition < 30 ? 'bad' : p.condition < 60 ? 'warn' : 'good'),
          ' ' + Math.round(p.condition) + ' · ' + conditionLabel(p.condition))),
        row('Tenants', h('span', null, bar(p.tenants / p.units), ' ' + p.tenants + ' / ' + p.units)),
        row('Area appeal', h('span', null, bar(Math.min(1, d.desirability / 1.9)), ' ' + d.desirability.toFixed(2))),
        row('Market value', money(value)),
        row('Market rent', money(mr) + ' per unit'),
        row('Current rent', money(p.rent) + ' per unit')),
    ];

    if (p.owned) {
      const net = g.projectedNet(p);
      parts.push(h('dl', { class: 'kvs' },
        row('Running costs', money(g.runningCost(p)) + '/mo'),
        row('Net income', signed(net) + '/mo', net < 0 ? 'neg' : 'pos'),
        row('Paid', money(p.boughtFor) + ' in ' + g.dateLabel(p.boughtMonth))));
      parts.push(rentControls(g, p, mr));
      parts.push(h('div', { class: 'actions' },
        h('button', {
          type: 'button', disabled: p.condition >= 100 || g.isOver(),
          onclick: () => act(g.repair(p.id, 'patch')),
          title: 'Fix the worst of it: +' + g.rules.patchPoints + ' condition',
        }, 'Patch up', h('small', null, p.condition >= 100 ? '—' : money(g.patchCost(p)))),
        h('button', {
          type: 'button', disabled: p.condition >= 100 || g.isOver(),
          onclick: () => act(g.repair(p.id, 'refurb')),
          title: 'Restore to 100 condition; some tenants move out during works',
        }, 'Refurbish', h('small', null, p.condition >= 100 ? '—' : money(g.refurbCost(p)))),
        h('button', {
          type: 'button', class: 'danger', disabled: g.isOver(),
          onclick: () => confirmSell(g, p),
        }, 'Sell', h('small', null, money(g.saleProceeds(p))))));
    } else if (p.forSale) {
      const price = g.askingPrice(p);
      const short = price - g.state.cash;
      const estNet = mr * p.units * g.expectedOccupancy(p, mr) - g.runningCost(p);
      parts.push(h('dl', { class: 'kvs' },
        row('Asking price', money(price), 'big'),
        row('Est. net at market rent', signed(Math.round(estNet)) + '/mo'),
        row('Gross yield', ((estNet * 12) / price * 100).toFixed(1) + '% / yr')));
      const actions = [h('button', {
        type: 'button', class: 'primary', disabled: short > 0 || g.isOver(),
        onclick: () => act(g.buy(p.id)),
      }, 'Buy for ' + money(price))];
      if (short > 0 && !g.isOver()) {
        const need = Math.ceil(short / 1000) * 1000;
        const can = need <= g.availableCredit();
        actions.push(h('button', {
          type: 'button', disabled: !can,
          onclick: () => { if (act(g.borrow(need)).ok) act(g.buy(p.id)); },
          title: can ? '' : 'The bank will not lend that much',
        }, 'Borrow ' + money(need) + ' & buy'));
      }
      parts.push(h('div', { class: 'actions' }, actions));
    } else {
      parts.push(h('p', { class: 'muted' }, p.cooldown > 0 ? 'Recently sold; the new owner is not selling yet.' : 'Not on the market right now. Listings change every month.'));
    }

    el.detail.replaceChildren(...parts);
  }

  function rentControls(g, p, mr) {
    const input = h('input', {
      type: 'number', id: 'rent-input', min: 0, step: 5, value: p.rent, inputmode: 'numeric',
      'aria-label': 'Rent per unit',
    });
    const outlook = h('p', { class: 'outlook' });
    const update = () => {
      const r = Number(input.value) || 0;
      const occ = g.expectedOccupancy(p, r);
      const income = Math.round(occ * p.units) * r - g.runningCost(p);
      const ratio = r / mr;
      outlook.textContent = 'Expect about ' + Math.round(occ * p.units) + '/' + p.units + ' tenants → ' +
        signed(income) + '/mo.' + (ratio > 1.25 ? ' Risk of a rent strike.' : '');
      outlook.classList.toggle('warn', ratio > 1.25);
    };
    input.addEventListener('input', update);
    update();
    const apply = (e) => { e.preventDefault(); act(g.setRent(p.id, input.value)); };
    const nudge = (k) => { input.value = Math.max(0, Math.round((Number(input.value) || 0) * k / 5) * 5); update(); };
    return h('form', { class: 'rent', onsubmit: apply },
      h('label', { for: 'rent-input' }, 'Rent per unit'),
      h('div', { class: 'rent-row' },
        h('button', { type: 'button', onclick: () => nudge(0.9), 'aria-label': 'Lower rent 10%' }, '−10%'),
        input,
        h('button', { type: 'button', onclick: () => nudge(1.1), 'aria-label': 'Raise rent 10%' }, '+10%'),
        h('button', { type: 'button', onclick: () => { input.value = mr; update(); } }, 'Market'),
        h('button', { type: 'submit', class: 'primary', disabled: g.isOver() }, 'Set')),
      outlook);
  }

  function renderBank(g) {
    const s = g.state;
    el.bank.replaceChildren(h('dl', { class: 'kvs' },
      row('Cash', money(s.cash), s.cash < 0 ? 'neg' : ''),
      row('Loan', money(s.loan)),
      row('Credit limit', money(g.creditLimit())),
      row('Can borrow', money(g.availableCredit())),
      row('Interest', (g.rules.interestRate * 100).toFixed(1) + '% / yr · ' + money(g.monthlyInterest()) + '/mo'),
      row('Portfolio value', money(g.portfolioValue()))));

    const r = s.lastReport;
    if (!r) { el.report.replaceChildren(h('p', { class: 'muted' }, 'No monthly accounts yet.')); return; }
    el.report.replaceChildren(
      h('h3', null, 'Last month'),
      h('dl', { class: 'kvs compact' },
        row('Rent collected', money(r.rent), 'pos'),
        row('Upkeep', '−' + money(r.upkeep)),
        row('Property tax', '−' + money(r.tax)),
        r.incidents ? row('Incidents', '−' + money(r.incidents), 'neg') : null,
        row('Interest', '−' + money(r.interest)),
        row('Net', signed(r.net), r.net < 0 ? 'neg total' : 'pos total'),
        row('Tenants', '+' + r.moveIns + ' in / −' + r.moveOuts + ' out')));
  }

  function renderChart(g) {
    const hist = g.state.history;
    const W = 300, H = 90, pad = 4;
    const goal = g.rules.goal;
    const max = Math.max(goal, ...hist);
    const min = Math.min(0, ...hist);
    const n = Math.max(g.rules.maxMonths, hist.length - 1);
    const x = (i) => pad + (i / n) * (W - 2 * pad);
    const y = (v) => H - pad - ((v - min) / (max - min || 1)) * (H - 2 * pad);
    const pts = hist.map((v, i) => x(i).toFixed(1) + ',' + y(v).toFixed(1)).join(' ');
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Net worth over time: now ' + money(hist[hist.length - 1]));
    const add = (tag, attrs) => {
      const e = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
      svg.appendChild(e);
      return e;
    };
    add('line', { x1: pad, x2: W - pad, y1: y(goal), y2: y(goal), class: 'goal' });
    if (min < 0) add('line', { x1: pad, x2: W - pad, y1: y(0), y2: y(0), class: 'zero' });
    add('polyline', { points: pts, class: 'worth' });
    const last = hist.length - 1;
    add('circle', { cx: x(last), cy: y(hist[last]), r: 3, class: 'dot' });
    el.chart.replaceChildren(svg, h('p', { class: 'muted small' }, 'Dashed line: ' + money(goal) + ' goal'));
  }

  function renderList(g) {
    document.querySelectorAll('.tabs [role=tab]').forEach(b => {
      const on = b.dataset.tab === ui.tab;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.classList.toggle('active', on);
    });
    const own = ui.tab === 'portfolio';
    const props = own ? g.portfolio() : g.listings();
    $('#tab-portfolio').textContent = 'Portfolio (' + g.portfolio().length + ')';
    $('#tab-market').textContent = 'For sale (' + g.listings().length + ')';

    if (!props.length) {
      el.list.replaceChildren(h('p', { class: 'muted empty' }, own
        ? 'You own nothing yet. Check the "For sale" tab.'
        : 'Nothing on the market this month.'));
      return;
    }

    const head = own
      ? ['Address', 'Area', 'Type', 'Tenants', 'Rent', 'Cond.', 'Value', 'Net/mo']
      : ['Address', 'Area', 'Type', 'Tenants', 'Cond.', 'Price', 'Yield'];
    const rows = props.map(p => {
      const t = TYPES[p.type];
      const d = g.district(p.district);
      let cells;
      if (own) {
        const net = g.projectedNet(p);
        cells = [p.address, d.name, t.label, p.tenants + '/' + p.units, money(p.rent),
          Math.round(p.condition), money(g.value(p)), h('span', { class: net < 0 ? 'neg' : 'pos' }, signed(net))];
      } else {
        const price = g.askingPrice(p);
        const mr = g.marketRent(p);
        const est = mr * p.units * g.expectedOccupancy(p, mr) - g.runningCost(p);
        cells = [p.address, d.name, t.label, p.tenants + '/' + p.units, Math.round(p.condition),
          money(price), (est * 12 / price * 100).toFixed(1) + '%'];
      }
      return h('tr', {
        class: ui.selected === p.id ? 'selected' : '', tabindex: 0, dataset: { id: p.id },
      }, cells.map((c, i) => h('td', { class: i >= 3 ? 'num' : '' }, c)));
    });
    el.list.replaceChildren(h('table', null,
      h('thead', null, h('tr', null, head.map((c, i) => h('th', { class: i >= 3 ? 'num' : '', scope: 'col' }, c)))),
      h('tbody', null, rows)));
  }

  function renderLog(g) {
    const entries = g.state.log.slice(-80).reverse();
    el.log.replaceChildren(...entries.map(e =>
      h('li', { class: 'log-' + e.kind }, h('time', null, g.dateLabel(e.month)), ' ', e.text)));
  }

  // ---------------------------------------------------------------------------
  // Dialogs
  // ---------------------------------------------------------------------------

  function dialog(body, actions) {
    el.dialogBody.replaceChildren(...body);
    el.dialogActions.replaceChildren(...actions.map(([label, cls, fn]) =>
      h('button', { value: label, class: cls || '', onclick: fn || null }, label)));
    if (typeof el.dialog.showModal === 'function') el.dialog.showModal();
    else el.dialog.setAttribute('open', '');
  }

  function confirmSell(g, p) {
    const proceeds = g.saleProceeds(p);
    const gain = proceeds - p.boughtFor;
    dialog([
      h('h2', null, 'Sell ' + p.address + '?'),
      h('p', null, 'You will receive ' + money(proceeds) + ' after the ' + Math.round(g.rules.sellFee * 100) +
        '% agent\'s fee. That is a ' + (gain >= 0 ? 'profit' : 'loss') + ' of ' + money(Math.abs(gain)) + '.'),
    ], [['Cancel', 'ghost'], ['Sell', 'danger', () => act(g.sell(p.id))]]);
  }

  function showHelp() {
    dialog([
      h('h2', null, 'How to play'),
      h('p', null, 'Start with ' + money(ui.game.rules.startCash) + '. Reach a net worth of ' +
        money(ui.game.rules.goal) + ' within ' + ui.game.rules.maxMonths / 12 + ' years.'),
      h('ul', null,
        h('li', null, h('b', null, 'Buy'), ' buildings marked £ on the map. Tenants come with them.'),
        h('li', null, h('b', null, 'Rent'), ': price above market and tenants leave; too far above and they strike. Cheap rent fills the building and helps your reputation.'),
        h('li', null, h('b', null, 'Repair'), ': buildings decay every month. Shabby places lose value, catch fire and get you fined.'),
        h('li', null, h('b', null, 'Borrow'), ' against your portfolio. Interest is charged monthly. If you run out of cash and credit, the bailiffs sell your buildings cheap.'),
        h('li', null, h('b', null, 'Sell'), ' at market value minus a ' + Math.round(ui.game.rules.sellFee * 100) + '% fee.'),
        h('li', null, h('b', null, 'Reputation'), ' affects how keen tenants are to rent from you.')),
      h('p', { class: 'muted' }, 'Press Space (outside text fields) to end the month. Your game saves automatically.'),
    ], [['Got it', 'primary']]);
  }

  function confirmNew() {
    dialog([
      h('h2', null, 'Start a new game?'),
      h('p', null, 'Your current game will be lost.'),
    ], [['Cancel', 'ghost'], ['New game', 'danger', newGame]]);
  }

  function showGameOver(g) {
    const s = g.state;
    const nw = g.netWorth();
    const title = s.status === 'won' ? 'You are a Rent Baron!' : s.status === 'bankrupt' ? 'Bankrupt' : 'Time to retire';
    const text = s.status === 'won'
      ? 'You reached ' + money(nw) + ' in ' + s.month + ' months.'
      : s.status === 'bankrupt'
        ? 'The bank has taken everything after ' + s.month + ' months.'
        : 'You finish with a net worth of ' + money(nw) + ' (' + pct(Math.max(0, nw) / g.rules.goal) + ' of the goal).';
    dialog([h('h2', null, title), h('p', null, text)],
      [['Look around', 'ghost'], ['New game', 'primary', newGame]]);
  }

  // ---------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------

  function select(id) {
    ui.selected = id;
    render();
  }

  function endMonth() {
    const g = ui.game;
    if (g.isOver()) return;
    const r = g.endMonth();
    if (r.ok && r.data) toast(g.dateLabel() + ': net ' + signed(r.data.net), r.data.net < 0);
    render();
  }

  function newGame() {
    ui.game = new Game();
    ui.selected = null;
    ui.lastStatus = 'playing';
    ui.tab = 'market';
    render();
  }

  function bind() {
    el.map.addEventListener('click', (e) => {
      const tile = e.target.closest('.tile');
      if (tile) select(ui.selected === Number(tile.dataset.id) ? null : Number(tile.dataset.id));
    });
    el.list.addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-id]');
      if (tr) select(Number(tr.dataset.id));
    });
    el.list.addEventListener('keydown', (e) => {
      const tr = e.target.closest('tr[data-id]');
      if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); select(Number(tr.dataset.id)); }
    });
    document.querySelector('.tabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (b) { ui.tab = b.dataset.tab; render(); }
    });
    el.bankForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const op = e.submitter ? e.submitter.value : 'borrow';
      const amount = Number(el.bankAmount.value);
      const res = act(op === 'repay' ? ui.game.repay(amount) : ui.game.borrow(amount));
      if (res.ok) el.bankAmount.value = '';
    });
    $('#btn-end').addEventListener('click', endMonth);
    $('#btn-new').addEventListener('click', confirmNew);
    $('#btn-help').addEventListener('click', showHelp);

    document.addEventListener('keydown', (e) => {
      if (el.dialog.open) return;
      const tag = (e.target.tagName || '').toLowerCase();
      if (['input', 'textarea', 'select', 'button'].includes(tag) || e.target.closest('tr[data-id]')) return;
      if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); endMonth(); }
      else if (e.key === 'Escape') select(null);
    });
  }

  function init() {
    bind();
    const saved = load(SAVE_KEY);
    const prefs = load(PREFS_KEY) || {};
    if (saved) {
      try { ui.game = Game.fromJSON(saved); } catch (e) { forget(SAVE_KEY); }
    }
    if (ui.game) {
      ui.tab = prefs.tab === 'market' ? 'market' : 'portfolio';
      ui.selected = Number.isInteger(prefs.selected) ? prefs.selected : null;
      ui.lastStatus = ui.game.state.status;
      render();
    } else {
      newGame();
      showHelp();
    }
  }

  init();
})();
