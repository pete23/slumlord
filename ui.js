/*
 * Rent Baron — user interface.
 *
 * Owns the DOM, the pixel-art town renderer, input handling and browser
 * storage. All game rules live in game.js; this file only calls the engine's
 * public API and draws the result.
 */
(function () {
  'use strict';

  const {
    Game, TYPES, DISTRICTS, RULES, CLASSES, POLICIES, ARREARS_POLICIES, MOD_KEYS, MOD_INFO, BUILDABLE,
    targetFor, formatMoney: money, formatRate: rate,
  } = window.RentBaron;
  const SAVE_KEY = 'rentbaron.save.v1';
  const PREFS_KEY = 'rentbaron.prefs.v1';
  const LENGTHS = [10, 15, 20, 25, 30, 35, 40, 45, 50];

  const ui = {
    game: null,
    selected: null,
    cursor: 0,
    hover: null,
    tab: 'portfolio',
    lastStatus: 'playing',
    years: RULES.defaultYears,
    mods: { bank: true, tenants: true, build: true },
  };

  const $ = (sel) => document.querySelector(sel);
  const el = {
    stats: $('#stats'), map: $('#map'), town: $('#town'), legend: $('#legend'), detail: $('#detail'),
    bank: $('#bank'), bankForm: $('#bank-form'), bankAmount: $('#bank-amount'),
    report: $('#report'), chart: $('#chart'), chartNote: $('#chart-note'), list: $('#list'), log: $('#log'),
    bankExtra: $('#bank-extra'), rateChart: $('#ratechart'), rateWrap: $('#rate-wrap'),
    toast: $('#toast'), dialog: $('#dialog'), dialogTitle: $('#dialog-title'),
    dialogBody: $('#dialog-body'), dialogActions: $('#dialog-actions'),
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
  const signed = (n) => (n >= 0 ? '+' : '−') + money(Math.abs(n));
  const short = (n) => {
    const a = Math.abs(n), s = n < 0 ? '−£' : '£';
    if (a >= 1e6) return s + (a / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
    if (a >= 1e4) return s + Math.round(a / 1e3) + 'k';
    return money(n);
  };

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

  /** Run an engine action, report the outcome, re-render. */
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
  // Pixel renderer
  //
  // The town is drawn into a 320x240 framebuffer (one tile = 40x40) using a
  // 12-bit palette, then scaled up by an integer factor. Static scenery is
  // rebuilt on each render(); a small overlay (smoke, flags, water, cursor)
  // animates on top of it.
  // ---------------------------------------------------------------------------

  const TILE = 40, GROUND = 34;

  const C = {}; // packed colours, keyed by 12-bit hex
  function col(hex) {
    if (C[hex] == null) {
      const r = parseInt(hex[1], 16) * 17, g = parseInt(hex[2], 16) * 17, b = parseInt(hex[3], 16) * 17;
      C[hex] = ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
    }
    return C[hex];
  }

  // Dusk sky, one entry per band of scanlines (copper-style gradient).
  const SKY = ['#102', '#113', '#214', '#225', '#326', '#437', '#548', '#649', '#859', '#a69', '#c78', '#d87'];

  const BUILD = {
    terrace: { w: 24, body: 15, roof: 7, brick: true, c: ['#c64', '#a53', '#732'], roofC: ['#644', '#433'] },
    bedsit:  { w: 26, body: 24, roof: 6, brick: true, c: ['#ca6', '#a85', '#764'], roofC: ['#557', '#335'] },
    flats:   { w: 32, body: 28, roof: 0, brick: false, c: ['#cb9', '#a98', '#776'] },
    tower:   { w: 24, body: 32, roof: 0, brick: false, c: ['#abb', '#899', '#577'] },
  };

  const GROUND_C = {
    G: ['#443', '#332'], O: ['#776', '#554'], M: ['#998', '#776'], R: ['#887', '#665'], P: ['#4a3', '#282'],
  };

  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

  function hash(a, b, c) {
    let x = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 1274126177);
    x = Math.imul(x ^ (x >>> 13), 1103515245);
    x ^= x >>> 16;
    return (x >>> 0) / 4294967296;
  }

  class Raster {
    constructor(w, hgt) {
      this.w = w; this.h = hgt;
      this.img = new ImageData(w, hgt);
      this.px = new Uint32Array(this.img.data.buffer);
    }
    set(x, y, c) {
      if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
      this.px[y * this.w + x] = typeof c === 'string' ? col(c) : c;
    }
    get(x, y) { return this.px[y * this.w + x]; }
    rect(x, y, w, hgt, c) {
      const v = typeof c === 'string' ? col(c) : c;
      for (let j = Math.max(0, y); j < Math.min(this.h, y + hgt); j++) {
        for (let i = Math.max(0, x); i < Math.min(this.w, x + w); i++) this.px[j * this.w + i] = v;
      }
    }
    sprite(x, y, rows, map) {
      rows.forEach((r, j) => { for (let i = 0; i < r.length; i++) if (map[r[i]]) this.set(x + i, y + j, map[r[i]]); });
    }
  }

  // Lit-window colours by tenant class (Mod B); arrears glow red.
  const CLASS_WIN = {
    family: ['#fd6', '#fa3'], student: ['#d9f', '#a6e'], pro: ['#eef', '#aac'],
    pensioner: ['#ca6', '#a84'], council: ['#9df', '#6ad'], arrears: ['#f75', '#c43'],
  };

  const POUND = ['.##.', '#...', '###.', '#...', '####'];
  const TREE = ['..###..', '.#####.', '###:###', '##:####', '.#####.', '..###..', '...|...', '...|...'];

  const town = {
    raster: null,
    buffer: document.createElement('canvas'),
    ctx: el.town.getContext('2d'),
    scale: 1,
    frame: 0,
    fx: { smoke: [], flags: [], lights: [], water: [] },
  };
  town.buffer.width = 320;
  town.buffer.height = 240;

  function drawTown(g) {
    const { width, height } = g.mapSize;
    const W = width * TILE, H = height * TILE;
    if (!town.raster || town.raster.w !== W) {
      town.raster = new Raster(W, H);
      el.town.width = town.buffer.width = W;
      el.town.height = town.buffer.height = H;
    }
    const r = town.raster;
    town.fx = { smoke: [], flags: [], lights: [], water: [] };
    for (const p of g.state.properties) drawTile(r, g, p, p.x * TILE, p.y * TILE);
    town.buffer.getContext('2d').putImageData(r.img, 0, 0);
    paintTown();
  }

  function drawTile(r, g, p, ox, oy) {
    const d = p.district;

    // Sky with copper bands, a few stars near the top.
    for (let y = 0; y < GROUND; y++) {
      const c = col(SKY[Math.floor(y * SKY.length / GROUND)]);
      for (let x = 0; x < TILE; x++) r.px[(oy + y) * r.w + ox + x] = c;
    }
    for (let y = 0; y < 12; y++) {
      for (let x = 0; x < TILE; x++) if (hash(ox + x, oy + y, 3) < 0.012) r.set(ox + x, oy + y, y < 6 ? '#fff' : '#99c');
    }
    // Distant skyline, continuous across the street.
    for (let x = 0; x < TILE; x++) {
      const gx = ox + x;
      const top = GROUND - 3 - Math.floor(hash(Math.floor(gx / 5), oy, 7) * 9);
      for (let y = top; y < GROUND; y++) r.set(gx, oy + y, (gx % 5 === 2 && y % 3 === 0 && hash(gx, y, oy) < 0.3) ? '#a85' : '#213');
    }

    // Ground: pavement, kerb, then road (water in Riverside).
    const gc = GROUND_C[d];
    for (let y = GROUND; y < GROUND + 2; y++) {
      for (let x = 0; x < TILE; x++) {
        let c = gc[0];
        if (d === 'O') c = ((x >> 1) + (y & 1)) & 1 ? gc[0] : gc[1];
        else if (d === 'M') c = x % 8 === 0 ? gc[1] : gc[0];
        else if (d === 'G') c = hash(ox + x, oy + y, 11) < 0.35 ? gc[1] : gc[0];
        else if (d === 'P') c = BAYER[(y & 3) * 4 + (x & 3)] < 7 ? gc[1] : gc[0];
        r.set(ox + x, oy + y, c);
      }
    }
    r.rect(ox, oy + GROUND + 2, TILE, 1, p.owned ? '#f80' : '#bbb');
    if (d === 'R') {
      r.rect(ox, oy + GROUND + 3, TILE, 3, '#137');
      for (let x = 0; x < TILE; x += 6) town.fx.water.push([ox + x + (oy % 4), oy + GROUND + 4]);
    } else {
      r.rect(ox, oy + GROUND + 3, TILE, 3, '#333');
      for (let x = 2; x < TILE; x += 8) r.rect(ox + x, oy + GROUND + 4, 4, 1, '#776');
    }

    // District scenery behind or beside the building.
    const b = BUILD[p.type] || { w: 30 };
    const bx = ox + Math.floor((TILE - b.w) / 2);
    if (d === 'G' && hash(p.id, 1, 2) < 0.6) {
      const cx = ox + (hash(p.id, 2, 3) < 0.5 ? 2 : TILE - 6);
      r.rect(cx, oy + 6, 4, GROUND - 6, '#433');
      r.rect(cx + 3, oy + 6, 1, GROUND - 6, '#322');
      r.rect(cx, oy + 8, 4, 1, '#a33');
      town.fx.smoke.push([cx + 1, oy + 5]);
    }
    if (d === 'P') {
      const space = (TILE - b.w) / 2;
      if (space >= 7) r.sprite(ox, oy + GROUND - 8, TREE, { '#': '#262', ':': '#4a3', '|': '#532' });
      if (space >= 7 && hash(p.id, 5, 5) < 0.6) r.sprite(ox + TILE - 7, oy + GROUND - 8, TREE, { '#': '#373', ':': '#5b4', '|': '#532' });
    }

    if (p.type === 'lot') drawPlot(r, g, p, ox, oy);
    else drawBuilding(r, g, p, bx, oy);
    if (p.build && p.type !== 'lot') scaffold(r, bx - 1, oy + GROUND - b.body - 1, b.w + 2, b.body + 1);

    // For-sale board on the pavement.
    if (p.forSale && !p.owned) {
      const sx = ox + TILE - 10, sy = oy + GROUND - 9;
      r.rect(sx + 3, sy + 7, 1, 4, '#ccc');
      r.rect(sx, sy, 8, 7, '#172');
      r.rect(sx + 1, sy + 1, 6, 5, '#2a4');
      r.sprite(sx + 2, sy + 1, POUND, { '#': '#fff' });
    }
  }

  function drawBuilding(r, g, p, bx, oy) {
    const b = BUILD[p.type];
    const t = TYPES[p.type];
    const top = oy + GROUND - b.body;
    const cond = p.condition;
    const grime = Math.pow(1 - cond / 100, 1.4) * 0.85;

    // Body with brick or panel texture, side shading and grime dithering.
    for (let y = 0; y < b.body; y++) {
      for (let x = 0; x < b.w; x++) {
        let c = x >= b.w - 2 ? b.c[1] : b.c[0];
        if (b.brick && y % 3 === 2 && (x + (y % 6 === 2 ? 0 : 2)) % 4 === 0) c = b.c[1];
        if (!b.brick && p.type === 'tower' && y % 5 === 0) c = b.c[1];
        if (!b.brick && p.type === 'flats' && (y % 7 === 0 || x === 0)) c = b.c[1];
        const level = grime * (0.45 + 0.55 * y / b.body) * 16;
        if (BAYER[(y & 3) * 4 + (x & 3)] < level) c = c === b.c[0] ? b.c[1] : b.c[2];
        r.set(bx + x, top + y, c);
      }
    }
    r.rect(bx, top, b.w, 1, b.roof ? b.c[1] : '#ddd');

    // Roof.
    let roofTop = top;
    if (b.roof) {
      for (let j = 0; j < b.roof; j++) {
        const inset = Math.round((b.roof - j) * (b.w / 2 - 3) / b.roof);
        const y = top - b.roof + j;
        for (let x = inset - 1; x < b.w - inset + 1; x++) {
          let c = j % 2 ? b.roofC[0] : b.roofC[1];
          if (cond < 45 && hash(p.id * 97 + x, j, 9) < (45 - cond) / 80) c = '#112';
          r.set(bx + x, y, c);
        }
      }
      roofTop = top - b.roof;
      // Chimney.
      r.rect(bx + b.w - 7, top - b.roof + 1, 3, 3, b.c[2]);
      r.rect(bx + b.w - 7, top - b.roof, 3, 1, '#222');
    } else {
      r.rect(bx - 1, top - 1, b.w + 2, 1, b.c[2]);
      if (p.type === 'flats') r.rect(bx + 4, top - 4, 6, 3, '#667');
      if (p.type === 'tower') {
        r.rect(bx + b.w - 5, top - 4, 1, 3, '#999');
        town.fx.lights.push([bx + b.w - 5, top - 5]);
      }
    }

    // Windows: lit = let (coloured by tenant class), dark = empty,
    // boarded/broken when the place is a wreck or a unit is void after eviction.
    const layout = windowLayout(p.type, b);
    const order = layout.map((_, i) => i).sort((a, c) => hash(p.id, a, 1) - hash(p.id, c, 1));
    const lit = new Set(order.slice(0, p.tenants));
    layout.forEach(([wx, wy, ww, wh], i) => {
      const x = bx + wx, y = top + wy;
      const L = p.lets ? p.lets[order[i]] : null;
      const isLit = p.lets ? !!(L && L.cls) : lit.has(i);
      if (isLit) {
        const wc = L ? CLASS_WIN[L.arrears ? 'arrears' : L.cls] : CLASS_WIN.family;
        r.rect(x, y, ww, wh, wc[0]);
        r.rect(x, y + wh - 1, ww, 1, wc[1]);
        if (ww > 2 && hash(p.id, i, 4) < 0.5) r.rect(x, y, 1, wh, '#c84');
      } else if (cond < 20 && hash(p.id, i, 5) < 0.5) {
        r.rect(x, y, ww, wh, '#000');
        r.set(x + 1, y, '#9ab');
      } else if (cond < 35 || (L && !L.cls)) {
        r.rect(x, y, ww, wh, '#a74');
        for (let k = 0; k < Math.min(ww, wh); k++) r.set(x + k, y + k, '#642');
      } else {
        r.rect(x, y, ww, wh, '#224');
        r.set(x, y, '#558');
      }
    });

    // Front door for the houses and flats.
    if (p.type !== 'tower') {
      const dw = 4, dh = p.type === 'terrace' ? 7 : 6;
      const dx = bx + Math.floor((b.w - dw) / 2), dy = oy + GROUND - dh;
      r.rect(dx - 1, dy - 1, dw + 2, dh + 1, b.c[2]);
      r.rect(dx, dy, dw, dh, cond < 30 ? '#764' : '#422');
      r.set(dx + dw - 1, dy + 3, '#fc4');
    } else {
      r.rect(bx + 9, oy + GROUND - 4, 6, 4, '#223');
    }

    // Weeds and graffiti on the worst places.
    if (cond < 40) {
      for (let x = -1; x <= b.w; x++) if (hash(p.id, x, 6) < (40 - cond) / 50) r.set(bx + x, oy + GROUND - 1, '#3a2');
    }
    if (cond < 50 && (p.district === 'G' || p.district === 'R' || p.district === 'O')) {
      const gc = ['#f4c', '#4cf', '#ff4'][p.id % 3];
      for (let k = 0; k < 6; k++) if (hash(p.id, k, 8) < 0.7) r.set(bx + 2 + k, oy + GROUND - 3 + (k & 1), gc);
    }

    // Your flag on the roof.
    if (p.owned) {
      const fx = b.roof ? bx + Math.floor(b.w / 2) : bx + 2;
      const fy = roofTop - 7;
      r.rect(fx, fy, 1, 7, '#ddd');
      town.fx.flags.push([fx + 1, fy]);
    }
  }

  /** Empty plot, planning notice, or a building site in progress (Mod C). */
  function drawPlot(r, g, p, ox, oy) {
    // Rubble and weeds on bare earth.
    for (let y = GROUND - 4; y < GROUND; y++) {
      for (let x = 2; x < TILE - 2; x++) {
        const h0 = hash(ox + x, oy + y, 21);
        if (y === GROUND - 4 && h0 > 0.35) continue;
        r.set(ox + x, oy + y, h0 < 0.15 ? '#776' : h0 < 0.25 ? '#3a2' : '#543');
      }
    }
    // Hoarding posts.
    for (let x = 1; x < TILE - 1; x += 6) r.rect(ox + x, oy + GROUND - 6, 1, 6, '#875');
    r.rect(ox + 1, oy + GROUND - 5, TILE - 2, 1, '#875');

    if (p.build) {
      const t = BUILD[p.build.to];
      const done = 1 - p.build.monthsLeft / p.build.months;
      const hgt = Math.max(3, Math.round(t.body * done));
      const bx = ox + Math.floor((TILE - t.w) / 2);
      const top = oy + GROUND - hgt;
      // Rising walls, dithered to look unfinished.
      for (let y = 0; y < hgt; y++) {
        for (let x = 0; x < t.w; x++) {
          if (BAYER[(y & 3) * 4 + (x & 3)] < 9) r.set(bx + x, top + y, t.c[1]);
        }
      }
      scaffold(r, bx - 1, top - 2, t.w + 2, hgt + 2);
      if (p.build.to === 'flats' || p.build.to === 'tower') {
        const cx = ox + TILE - 6;
        r.rect(cx, oy + 3, 1, GROUND - 3, '#fc0');
        r.rect(cx - 20, oy + 3, 24, 1, '#fc0');
        r.rect(cx + 1, oy + 4, 2, 2, '#666');
        r.rect(cx - 14, oy + 4, 1, 4 + (p.build.monthsLeft % 5), '#ccc');
      }
    } else if (p.app || p.refused) {
      // Planning notice on a post.
      const sx = ox + 4, sy = oy + GROUND - 13;
      r.rect(sx + 3, sy + 6, 1, 7, '#ccc');
      r.rect(sx, sy, 8, 6, '#eee');
      for (let k = 1; k < 5; k += 2) r.rect(sx + 1, sy + k, 6, 1, '#558');
      if (p.refused) for (let k = 0; k < 6; k++) { r.set(sx + 1 + k, sy + k, '#d22'); r.set(sx + 6 - k, sy + k, '#d22'); }
    }
    if (p.owned) {
      r.rect(ox + 19, oy + GROUND - 13, 1, 7, '#ddd');
      town.fx.flags.push([ox + 20, oy + GROUND - 13]);
    }
  }

  function scaffold(r, x, y, w, hgt) {
    for (let j = 0; j < hgt; j += 4) r.rect(x, y + j, w, 1, '#a86');
    for (let i = 0; i < w; i += 5) r.rect(x + i, y, 1, hgt, '#a86');
  }

  function windowLayout(type, b) {
    const out = [];
    if (type === 'terrace') {
      out.push([4, 2, 5, 5], [b.w - 9, 2, 5, 5]);
    } else if (type === 'bedsit') {
      for (let row = 0; row < 3; row++) for (let c = 0; c < 2; c++) out.push([c ? b.w - 9 : 4, 2 + row * 7, 5, 5]);
    } else if (type === 'flats') {
      for (let row = 0; row < 4; row++) for (let c = 0; c < 3; c++) out.push([3 + c * 10, 2 + row * 6, 6, 4]);
    } else {
      for (let row = 0; row < 6; row++) for (let c = 0; c < 5; c++) out.push([3 + c * 4, 2 + row * 5, 2, 3]);
    }
    return out;
  }

  /** Composite static buffer + animated overlay onto the visible canvas. */
  function paintTown() {
    const ctx = town.ctx, f = town.frame;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(town.buffer, 0, 0);
    const px = (x, y, c, w, hh) => { ctx.fillStyle = c; ctx.fillRect(x, y, w || 1, hh || 1); };

    for (const [x, y] of town.fx.smoke) {
      for (let k = 0; k < 3; k++) {
        const t = (f + k * 6) % 18;
        const sx = x + Math.round(Math.sin((t + x) / 3) * 1.5) + (t >> 3);
        const sy = y - t;
        if (sy >= y - 17) px(sx, sy, t < 9 ? '#999' : '#666', t < 6 ? 2 : 3, 2);
      }
    }
    for (const [x, y] of town.fx.lights) px(x, y, (f >> 3) & 1 ? '#f22' : '#600');
    for (const [x, y] of town.fx.flags) {
      const wave = (f >> 2) & 1;
      px(x, y, '#f80', 4, 1); px(x, y + 1, '#f80', wave ? 5 : 4, 1); px(x, y + 2, '#c50', wave ? 4 : 5, 1);
    }
    for (const [x, y] of town.fx.water) {
      const o = (f >> 1) % 4;
      px(x + o, y, '#48c', 2, 1);
    }

    // Council schemes: blinking outline (cyan = regeneration, red = bypass).
    if (ui.game.state.schemes && (f >> 2) & 1) {
      for (const sc of ui.game.state.schemes) {
        ctx.fillStyle = sc.kind === 'regen' ? '#4cf' : '#f44';
        for (const id of sc.tiles) {
          const q = ui.game.property(id);
          const x0 = q.x * TILE, y0 = q.y * TILE;
          for (let i = 0; i < TILE; i += 4) {
            ctx.fillRect(x0 + i, y0 + 1, 2, 1); ctx.fillRect(x0 + i, y0 + TILE - 2, 2, 1);
            ctx.fillRect(x0 + 1, y0 + i, 1, 2); ctx.fillRect(x0 + TILE - 2, y0 + i, 1, 2);
          }
        }
      }
    }

    const tileRect = (id) => {
      const p = ui.game.property(id);
      return p ? [p.x * TILE, p.y * TILE] : null;
    };
    if (ui.hover != null && ui.hover !== ui.selected) {
      const tr = tileRect(ui.hover);
      if (tr) corners(ctx, tr[0], tr[1], '#fff');
    }
    if (document.activeElement === el.town && ui.cursor !== ui.selected) {
      const tr = tileRect(ui.cursor);
      if (tr) corners(ctx, tr[0], tr[1], '#f80');
    }
    if (ui.selected != null) {
      const tr = tileRect(ui.selected);
      if (tr) ants(ctx, tr[0], tr[1], f);
    }
  }

  function corners(ctx, x, y, c) {
    ctx.fillStyle = c;
    const L = 6, e = TILE - 1;
    for (const [cx, cy, dx, dy] of [[0, 0, 1, 1], [e, 0, -1, 1], [0, e, 1, -1], [e, e, -1, -1]]) {
      ctx.fillRect(x + cx + (dx < 0 ? -L + 1 : 0), y + cy, L, 1);
      ctx.fillRect(x + cx, y + cy + (dy < 0 ? -L + 1 : 0), 1, L);
    }
  }

  /** Marching-ants selection box. */
  function ants(ctx, x, y, f) {
    const e = TILE - 1;
    const dot = (i, px, py) => { ctx.fillStyle = ((i + f) >> 1) & 1 ? '#fff' : '#000'; ctx.fillRect(px, py, 1, 1); };
    for (let i = 0; i <= e; i++) {
      dot(i, x + i, y);
      dot(i + e, x + e, y + i);
      dot(3 * e - i, x + i, y + e);
      dot(4 * e - i, x, y + i);
    }
  }

  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let lastTick = 0;
  function animate(ts) {
    if (ts - lastTick > 110) {
      lastTick = ts;
      town.frame++;
      if (town.raster) paintTown();
    }
    requestAnimationFrame(animate);
  }

  function fitTown() {
    const avail = el.map.clientWidth;
    const w = el.town.width;
    const scale = Math.max(1, Math.floor(avail / w));
    town.scale = scale;
    if (avail < w) {
      el.town.style.width = '100%';
      el.town.style.height = 'auto';
    } else {
      el.town.style.width = w * scale + 'px';
      el.town.style.height = el.town.height * scale + 'px';
    }
  }

  function tileAt(evt) {
    const rect = el.town.getBoundingClientRect();
    const x = Math.floor((evt.clientX - rect.left) / rect.width * el.town.width / TILE);
    const y = Math.floor((evt.clientY - rect.top) / rect.height * el.town.height / TILE);
    const p = ui.game.state.properties.find(q => q.x === x && q.y === y);
    return p ? p.id : null;
  }

  // ---------------------------------------------------------------------------
  // Rendering (DOM panels)
  // ---------------------------------------------------------------------------

  function render() {
    const g = ui.game;
    renderStats(g);
    renderLegend(g);
    drawTown(g);
    renderDetail(g);
    renderBank(g);
    renderChart(g);
    renderList(g);
    renderLog(g);
    el.bankForm.querySelectorAll('button, input').forEach(b => { b.disabled = g.isOver(); });
    $('#btn-end').disabled = g.isOver();
    store(SAVE_KEY, g.toJSON());
    store(PREFS_KEY, { tab: ui.tab, selected: ui.selected, years: ui.years, mods: ui.mods });

    if (g.state.status !== ui.lastStatus) {
      ui.lastStatus = g.state.status;
      if (g.isOver()) showGameOver(g);
    }
  }

  function renderStats(g) {
    const s = g.state;
    const nw = g.netWorth();
    const items = [
      ['Date', g.dateLabel(), g.monthsLeft() + ' mo left'],
      ['Cash', money(s.cash), s.cash < 0 ? 'OVERDRAWN' : ''],
      ['Loan', money(s.loan), money(g.monthlyInterest()) + '/mo'],
    ];
    if (g.hasMod('bank')) {
      const hist = s.rateHistory, prev = hist[Math.max(0, hist.length - 7)];
      items.push(['Base rate', rate(g.baseRate()), g.baseRate() > prev ? '▲ rising' : g.baseRate() < prev ? '▼ falling' : '– steady']);
    }
    const hold = g.holdRequired();
    items.push(['Worth', money(nw), hold && g.holdProgress()
      ? 'holding ' + g.holdProgress() + '/' + hold + ' mo'
      : pct(Math.max(0, nw) / g.goal) + ' of ' + short(g.goal)]);
    items.push(['Rep', Math.round(s.reputation) + '/100', s.reputation >= 60 ? 'well liked' : s.reputation >= 35 ? 'tolerated' : 'notorious']);
    el.stats.replaceChildren(...items.map(([k, v, sub]) =>
      h('div', { class: 'stat' + (k === 'Loan' && s.covenant ? ' alarm' : '') }, h('dt', null, k), h('dd', null, v), sub ? h('dd', { class: 'sub' }, sub) : null)));
  }

  function renderLegend(g) {
    const items = Object.entries(DISTRICTS).map(([k, d]) =>
      h('span', { class: 'legend-item' }, h('i', { style: 'background:' + GROUND_C[k][0] }), d.name));
    if (g && g.hasMod('tenants')) {
      items.push(h('br'));
      for (const c of Object.keys(CLASSES)) {
        items.push(h('span', { class: 'legend-item' }, h('i', { style: 'background:' + CLASS_WIN[c][0] }), CLASSES[c].label));
      }
      items.push(h('span', { class: 'legend-item' }, h('i', { style: 'background:' + CLASS_WIN.arrears[0] }), 'In arrears'));
    }
    el.legend.replaceChildren(...items);
  }

  function row(label, value, extra) {
    return h('div', { class: 'kv' + (extra ? ' ' + extra : '') }, h('dt', null, label), h('dd', null, value));
  }

  function bar(value, cls) {
    return h('span', { class: 'bar ' + (cls || '') }, h('span', { style: 'width:' + Math.round(clampN(value, 0, 1) * 100) + '%' }));
  }
  const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function btn(label, cost, onclick, opts) {
    opts = opts || {};
    return h('button', { type: 'button', class: opts.cls || null, disabled: opts.disabled || ui.game.isOver(), title: opts.title || null, onclick },
      label, cost != null ? h('span', { class: 'cost' }, cost) : null);
  }

  function renderDetail(g) {
    const p = ui.selected == null ? null : g.property(ui.selected);
    if (!p) {
      el.detail.replaceChildren(
        h('p', null, 'Click a building on the map, or a row in the ledger, to inspect it.'),
        h('p', { class: 'dim' }, 'Rough areas are cheap and pay high yields but rot fast and attract trouble. ' +
          'Posh areas cost more, rent for less against the price, and reward repairs.'),
        g.hasMod('bank') ? h('p', { class: 'dim' }, 'Watch the base rate. Cheap money inflates prices; dear money tightens the bank\'s limits and can trigger a covenant breach.') : null);
      return;
    }
    if (p.type === 'lot') { el.detail.replaceChildren(...plotDetail(g, p).filter(Boolean)); return; }

    const t = TYPES[p.type];
    const d = g.district(p.district);
    const local = g.localDesirability(p);
    const mr = g.marketRent(p);
    const parts = [
      h('h3', { class: 'addr' }, p.address),
      h('p', { class: 'dim' }, t.label + ' · ' + d.name + ' · ' + t.units + ' unit' + (t.units > 1 ? 's' : '')),
      p.build ? h('p', { class: 'notice' }, 'Conversion to ' + TYPES[p.build.to].label.toLowerCase() + ': ' + p.build.monthsLeft + ' months left.') : null,
      h('dl', { class: 'kvs' },
        row('Condition', h('span', null, bar(p.condition / 100, p.condition < 30 ? 'bad' : p.condition < 60 ? 'warn' : 'good'),
          ' ' + conditionLabel(p.condition))),
        row('Tenants', h('span', null, bar(p.units ? p.tenants / p.units : 0), ' ' + p.tenants + '/' + p.units)),
        row(g.hasMod('build') ? 'Street' : 'Area', h('span', null, bar(Math.min(1, local / 1.9)), ' ' + local.toFixed(2) +
          (g.hasMod('build') && Math.abs(local - d.desirability) >= 0.01 ? (local > d.desirability ? ' ▲' : ' ▼') : ''))),
        row('Value', money(g.value(p))),
        row('Market rent', money(mr) + '/unit'),
        row(g.hasMod('tenants') ? 'Asking rent' : 'Your rent', money(p.rent) + '/unit')),
    ];

    if (p.owned) {
      const net = g.projectedNet(p);
      parts.push(h('dl', { class: 'kvs' },
        row('Running cost', money(g.runningCost(p)) + '/mo'),
        row('Net (now)', signed(net) + '/mo', net < 0 ? 'neg' : 'pos'),
        row('Paid', money(p.boughtFor) + ' ' + g.dateLabel(p.boughtMonth))));
      if (g.hasMod('tenants') && !p.build) parts.push(tenantPanel(g, p));
      if (!p.build) parts.push(rentControls(g, p, mr));
      parts.push(h('div', { class: 'actions' },
        btn('Patch', p.condition >= 100 ? '—' : money(g.patchCost(p)), () => act(g.repair(p.id, 'patch')),
          { disabled: p.condition >= 100 || !!p.build, title: 'Fix the worst of it: +' + g.rules.patchPoints + ' condition' }),
        btn('Refurb', p.condition >= 100 ? '—' : money(g.refurbCost(p)), () => act(g.repair(p.id, 'refurb')),
          { disabled: p.condition >= 100 || !!p.build, title: 'Restore fully; some tenants move out during the works' }),
        btn('Sell', money(g.saleProceeds(p)), () => confirmSell(g, p), { cls: 'danger', disabled: !!p.build })));
      if (g.hasMod('build')) parts.push(...developPanel(g, p));
    } else if (p.forSale) {
      parts.push(...buyPanel(g, p, mr));
    } else {
      parts.push(h('p', { class: 'dim' }, p.cooldown > 0 ? 'Recently sold. The new owner is not selling yet.' : 'Not on the market. Listings change monthly.'));
    }
    el.detail.replaceChildren(...parts.filter(Boolean));
  }

  function buyPanel(g, p, mr) {
    const price = g.askingPrice(p);
    const shortfall = price - g.state.cash;
    const parts = [];
    if (p.units) {
      const estNet = mr * p.units * g.expectedOccupancy(p, mr) - g.runningCost(p);
      parts.push(h('dl', { class: 'kvs' },
        row('Asking price', money(price), 'big'),
        row('Est. net', signed(Math.round(estNet)) + '/mo'),
        row('Yield', ((estNet * 12) / price * 100).toFixed(1) + '%/yr')));
      if (p.condition < 15) parts.push(h('p', { class: 'warn' }, 'Derelict: nobody will rent it until it is repaired.'));
    } else {
      parts.push(h('dl', { class: 'kvs' }, row('Asking price', money(price), 'big')));
    }
    const actions = [btn(p.units ? 'Buy' : 'Buy plot', money(price), () => act(g.buy(p.id)), { cls: 'primary', disabled: shortfall > 0 })];
    if (shortfall > 0 && !g.isOver()) {
      const need = Math.ceil(shortfall / 1000) * 1000;
      const can = need <= g.availableCredit() && !g.state.covenant;
      actions.push(btn('Borrow & buy', '+' + money(need), () => { if (act(g.borrow(need)).ok) act(g.buy(p.id)); },
        { disabled: !can, title: can ? '' : 'The bank will not lend that much' }));
    }
    parts.push(h('div', { class: 'actions' }, actions));
    return parts;
  }

  function tenantPanel(g, p) {
    const sum = g.tenantSummary(p.id);
    const chips = Object.entries(sum.classes).filter(([, n]) => n).map(([c, n]) =>
      h('span', { class: 'chip' }, h('i', { style: 'background:' + CLASS_WIN[c][0] }), CLASSES[c].label + ' ' + n));
    const policy = h('select', { id: 'policy-select', 'aria-label': 'Letting policy',
      onchange: (e) => act(g.setPolicy(p.id, e.target.value)) },
      Object.entries(POLICIES).map(([k, v]) => h('option', { value: k, selected: p.policy === k ? true : null }, v.label)));
    const arrears = h('select', { id: 'arrears-select', 'aria-label': 'Arrears policy',
      onchange: (e) => act(g.setArrearsPolicy(p.id, e.target.value)) },
      Object.entries(ARREARS_POLICIES).map(([k, v]) => h('option', { value: k, selected: p.arrearsPolicy === k ? true : null }, v)));
    const mix = g.applicantMix(p.id).filter(a => a.eligible && a.accept > 0)
      .sort((a, b) => b.share * b.accept - a.share * a.accept)
      .map(a => CLASSES[a.cls].label.toLowerCase()).slice(0, 3);
    return h('div', { class: 'tenants' },
      h('h3', null, 'Tenants'),
      chips.length ? h('div', { class: 'chips' }, chips) : h('p', { class: 'dim' }, 'No sitting tenants.'),
      h('dl', { class: 'kvs' },
        sum.arrears ? row('In arrears', sum.arrears + ' (' + money(sum.owed) + ' owed)', 'neg') : null,
        sum.stale ? row('Stale rents', sum.stale + ' below market') : null,
        sum.voids ? row('Void units', String(sum.voids)) : null,
        sum.nextReview != null ? row('Next review', g.dateLabel(sum.nextReview)) : null),
      h('div', { class: 'policy-row' }, h('label', { for: 'policy-select' }, 'Letting'), policy),
      h('div', { class: 'policy-row' }, h('label', { for: 'arrears-select' }, 'Arrears'), arrears),
      h('p', { class: 'dim' }, mix.length ? 'Likely applicants: ' + mix.join(', ') + '.' : 'Nobody will apply at this rent and condition.'));
  }

  function developPanel(g, p) {
    const out = [];
    const conv = g.conversionFor(p);
    const busy = g.isBusy(p);
    const blocked = p.blockedUntil > g.state.month;
    out.push(h('h3', null, 'Development'));
    if (p.app) out.push(h('p', { class: 'notice' }, (p.app.appeal ? 'Appeal' : 'Planning application') + ': ' +
      (p.app.kind === 'convert' ? 'convert to ' : 'build ') + TYPES[p.app.to].label.toLowerCase() + ', ' +
      Math.round(p.app.chance * 100) + '% likely. Decision ' + g.dateLabel(p.app.decideAt) + '.'));
    if (p.refused) out.push(refusalBox(g, p));
    const actions = [];
    if (conv) {
      actions.push(btn('Convert', money(g.conversionCost(p)) + ' · ' + Math.round(g.planningChance(p, conv.to) * 100) + '%',
        () => act(g.convert(p.id)), { disabled: busy || blocked,
          title: 'Apply to convert to ' + TYPES[conv.to].label.toLowerCase() + ' (' + conv.months + ' months; sitting tenants displaced). Fee ' + money(g.applicationFee()) }));
    }
    actions.push(btn('Demolish', money(g.demolishCost(p)), () => confirmDemolish(g, p), { cls: 'danger', disabled: busy }));
    out.push(h('div', { class: 'actions' }, actions));
    return out;
  }

  function refusalBox(g, p) {
    const chance = Math.min(0.9, g.planningChance(p, p.refused.to) * 1.5);
    return h('div', { class: 'notice bad' },
      h('p', null, 'Planning refused for ' + TYPES[p.refused.to].label.toLowerCase() + '. Blocked until ' + g.dateLabel(p.blockedUntil) + '.'),
      btn('Appeal', money(g.appealFee()) + ' · ' + Math.round(chance * 100) + '%', () => act(g.appeal(p.id)), { title: 'Six months; better odds than a fresh application' }));
  }

  function plotDetail(g, p) {
    const d = g.district(p.district);
    const parts = [
      h('h3', { class: 'addr' }, p.address),
      h('p', { class: 'dim' }, (p.build ? 'Building site' : 'Vacant lot') + ' · ' + d.name),
      h('dl', { class: 'kvs' },
        row('Street', g.localDesirability(p).toFixed(2)),
        row('Value', money(g.value(p)))),
    ];
    if (!p.owned) {
      if (p.forSale) parts.push(...buyPanel(g, p, 0));
      else parts.push(h('p', { class: 'dim' }, 'Not for sale. A developer may build here.'));
      return parts;
    }
    if (p.build) {
      const done = 1 - p.build.monthsLeft / p.build.months;
      parts.push(h('dl', { class: 'kvs' },
        row('Building', TYPES[p.build.to].label),
        row('Progress', h('span', null, bar(done, 'good'), ' ' + p.build.monthsLeft + ' mo left')),
        row('Paid so far', money(p.build.paid) + ' of ' + money(p.build.cost))));
      return parts;
    }
    if (p.app) {
      parts.push(h('p', { class: 'notice' }, (p.app.appeal ? 'Appeal' : 'Application') + ' for ' + TYPES[p.app.to].label.toLowerCase() +
        ': ' + Math.round(p.app.chance * 100) + '% likely. Decision ' + g.dateLabel(p.app.decideAt) + '.'));
      return parts;
    }
    if (p.refused) parts.push(refusalBox(g, p));
    const blocked = p.blockedUntil > g.state.month;
    parts.push(h('h3', null, 'Build'), h('p', { class: 'dim' }, 'Application fee ' + money(g.applicationFee()) +
      '; decision in ' + g.rules.planningMonths + ' months. Costs are paid monthly during the works.'));
    const mi = g.state.marketIndex * g.priceLevel();
    parts.push(h('table', { class: 'build-table' },
      h('thead', null, h('tr', null, ['Type', 'Cost', 'Months', 'Value', 'Odds', ''].map(c => h('th', null, c)))),
      h('tbody', null, BUILDABLE.map(t => {
        const cost = g.buildCost(p, t);
        const value = TYPES[t].baseValue * g.localDesirability(p) * mi;
        const ch = g.planningChance(p, t);
        return h('tr', null,
          h('td', null, TYPES[t].label),
          h('td', { class: 'num' }, short(cost)),
          h('td', { class: 'num' }, String(g.buildMonths(t))),
          h('td', { class: 'num' + (value > cost ? ' pos' : ' neg') }, short(value)),
          h('td', { class: 'num' }, Math.round(ch * 100) + '%'),
          h('td', null, btn('Apply', null, () => act(g.build(p.id, t)), { disabled: blocked })));
      }))));
    return parts;
  }

  function rentControls(g, p, mr) {
    const input = h('input', {
      type: 'number', id: 'rent-input', min: 0, step: 1, value: p.rent, inputmode: 'numeric',
      'aria-label': 'Rent per unit',
    });
    const outlook = h('p', { class: 'outlook' });
    const update = () => {
      const r = Number(input.value) || 0;
      const occ = g.expectedOccupancy(p, r);
      const income = Math.round(occ * p.units) * r - g.runningCost(p);
      outlook.textContent = '→ ~' + Math.round(occ * p.units) + '/' + p.units + ' let, ' + signed(income) + '/mo' +
        (r / mr > 1.25 ? '. Strike risk!' : '');
      outlook.classList.toggle('warn', r / mr > 1.25);
    };
    input.addEventListener('input', update);
    update();
    const apply = (e) => { e.preventDefault(); act(g.setRent(p.id, input.value)); };
    const nudge = (k) => { input.value = Math.max(0, Math.round((Number(input.value) || 0) * k / 5) * 5); update(); };
    return h('form', { class: 'rent', onsubmit: apply, novalidate: true },
      h('label', { for: 'rent-input' }, g.hasMod('tenants') ? 'Asking rent £ (sitting tenants at review)' : 'Rent per unit £'),
      h('div', { class: 'rent-row' },
        h('button', { type: 'button', onclick: () => nudge(0.9), 'aria-label': 'Lower rent 10%' }, '↓'),
        input,
        h('button', { type: 'button', onclick: () => nudge(1.1), 'aria-label': 'Raise rent 10%' }, '↑'),
        h('button', { type: 'button', onclick: () => { input.value = mr; update(); } }, 'Mkt'),
        h('button', { type: 'submit', class: 'primary', disabled: g.isOver() }, 'Set')),
      outlook);
  }

  function renderBank(g) {
    const s = g.state;
    const bank = g.hasMod('bank');
    const cover = g.interestCover();
    const coverTxt = Number.isFinite(cover) ? cover.toFixed(2) + '×' : '—';
    const rows = [
      row('Cash', money(s.cash), s.cash < 0 ? 'neg' : ''),
      row('Loan', money(s.loan)),
      row('Limit', money(g.creditLimit())),
      row('Can borrow', money(s.covenant ? 0 : g.availableCredit())),
    ];
    if (bank) {
      const ltv = g.ltv();
      rows.push(
        row('LTV', h('span', null, bar(Number.isFinite(ltv) ? ltv : 1, ltv > g.maxLtv() ? 'bad' : ltv > g.maxLtv() - 0.1 ? 'warn' : 'good'),
          ' ' + (Number.isFinite(ltv) ? pct(ltv) : '—') + ' / ' + pct(g.maxLtv()))),
        row('Interest cover', coverTxt, 'cover ' + (cover < g.rules.minCover ? 'neg' : cover < 2 ? 'warnc' : 'pos')),
        row('Variable', rate(g.loanRate())),
        s.fixed ? row('Fixed', money(s.fixed.balance) + ' @ ' + rate(s.fixed.rate) + ' to ' + g.dateLabel(s.fixed.until)) : null);
    } else {
      rows.push(row('Interest', rate(g.loanRate()) + '/yr'));
    }
    rows.push(row('Portfolio', money(g.portfolioValue())));
    el.bank.replaceChildren(h('dl', { class: 'kvs' }, rows));

    const extra = [];
    if (bank) {
      if (s.covenant) {
        extra.push(h('div', { class: 'notice bad' },
          h('b', null, 'COVENANT BREACH'),
          h('p', null, (s.covenant.reason === 'cover' ? 'Interest cover below ' + g.rules.minCover + '×.' : 'Loan above the bank\'s limit.') +
            ' Repay or sell by ' + g.dateLabel(s.covenant.deadline) + ' or the bank sells for you at ' + Math.round(g.rules.seizeDiscount * 100) + '% of value.')));
      }
      const fixBtns = s.fixed
        ? [btn('Break fix', money(Math.round(s.fixed.balance * g.rules.breakFee)), () => act(g.breakFix()))]
        : g.rules.fixYears.map(y => btn('Fix ' + y + 'y', rate(g.fixedRateOffer()), () => act(g.fixRate(y)),
            { disabled: s.loan <= 0, title: 'Lock the current loan at this rate for ' + y + ' years' }));
      extra.push(h('div', { class: 'actions' }, fixBtns));
    }
    if (g.hasMod('build')) {
      extra.push(h('h3', null, 'Council'),
        h('dl', { class: 'kvs' }, row('Relations', h('span', null, bar(s.councilRelations / 100, s.councilRelations < 30 ? 'bad' : ''), ' ' + Math.round(s.councilRelations)))),
        h('div', { class: 'actions' },
          btn('Mayor\'s fund', money(5000 * Math.round(g.priceLevel())), () => act(g.donate(5000 * Math.round(g.priceLevel()))),
            { title: 'Better planning odds. The more you give, the likelier a scandal.' })),
        ...s.schemes.map(sc => h('p', { class: 'notice' + (sc.kind === 'bypass' ? ' bad' : '') },
          (sc.kind === 'regen' ? 'Regeneration of ' : 'Bypass through ') + sc.name + ' in ' + g.dateLabel(sc.due) + '.')));
    }
    el.bankExtra.replaceChildren(...extra.filter(Boolean));

    const r = s.lastReport;
    if (!r) { el.report.replaceChildren(h('p', { class: 'dim' }, 'No accounts yet.')); return; }
    el.report.replaceChildren(
      h('h3', null, 'Last month'),
      h('dl', { class: 'kvs' },
        row('Rent', money(r.rent), 'pos'),
        r.arrears ? row('Unpaid', money(r.arrears), 'neg') : null,
        row('Upkeep', '−' + money(r.upkeep)),
        row('Tax', '−' + money(r.tax)),
        r.incidents ? row('Incidents', '−' + money(r.incidents), 'neg') : null,
        r.construction ? row('Works', '−' + money(r.construction)) : null,
        row('Interest', '−' + money(r.interest)),
        row('Net', signed(r.net), r.net < 0 ? 'neg total' : 'pos total'),
        row('Tenants', '+' + r.moveIns + ' / −' + r.moveOuts + (r.evictions ? ' (' + r.evictions + ' evicted)' : ''))));
  }

  /** Stepped pixel line chart into a small canvas. */
  function lineChart(cv, series, opts) {
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    const n = Math.max(opts.span, ...series.map(s => s.data.length - 1));
    const x = (i) => 1 + Math.round(i / n * (W - 3));
    ctx.fillStyle = '#028';
    for (let i = 0; i <= 10; i++) for (let yy = 0; yy < H; yy += 2) ctx.fillRect(x(n * i / 10), yy, 1, 1);
    for (const s of series) {
      const y = (v) => H - 2 - Math.round((v - s.min) / (s.max - s.min || 1) * (H - 4));
      if (s.line != null) { ctx.fillStyle = s.lineColour; for (let xx = 0; xx < W; xx += 4) ctx.fillRect(xx, y(s.line), 2, 1); }
      ctx.fillStyle = s.colour;
      let prev = null;
      s.data.forEach((v, i) => {
        const px = x(i), py = y(v);
        if (prev) {
          ctx.fillRect(prev[0], Math.min(prev[1], py), 1, Math.abs(py - prev[1]) + 1);
          ctx.fillRect(prev[0], py, px - prev[0] + 1, 1);
        } else ctx.fillRect(px, py, 1, 1);
        prev = [px, py];
      });
      if (prev && s.dot) { ctx.fillStyle = '#fff'; ctx.fillRect(prev[0] - 1, prev[1] - 1, 3, 3); }
    }
  }

  function renderChart(g) {
    const s = g.state;
    const hist = s.history;
    const goal = g.goal;
    lineChart(el.chart, [{
      data: hist, colour: '#f80', dot: true, min: Math.min(0, ...hist), max: Math.max(goal, ...hist), line: goal, lineColour: '#4e4',
    }], { span: g.maxMonths });
    el.chart.setAttribute('aria-label', 'Net worth chart: now ' + money(hist[hist.length - 1]) + ', goal ' + money(goal));
    el.chartNote.textContent = 'Green dashes: ' + short(goal) + ' goal';

    el.rateWrap.hidden = !g.hasMod('bank');
    if (g.hasMod('bank')) {
      lineChart(el.rateChart, [
        { data: s.indexHistory, colour: '#fc8', min: 0.5, max: 2 },
        { data: s.rateHistory, colour: '#8af', dot: true, min: 0.03, max: 0.17, line: g.rules.rateTarget, lineColour: '#555' },
      ], { span: g.maxMonths });
      el.rateChart.setAttribute('aria-label', 'Base rate ' + rate(g.baseRate()) + ' and house price index ' + s.marketIndex.toFixed(2));
    }
  }

  function renderList(g) {
    document.querySelectorAll('.tabs [role=tab]').forEach(b => {
      const on = b.dataset.tab === ui.tab;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.classList.toggle('active', on);
    });
    const own = ui.tab === 'portfolio';
    const props = own ? g.portfolio() : g.listings();
    $('#tab-portfolio').textContent = 'Portfolio ' + g.portfolio().length;
    $('#tab-market').textContent = 'For sale ' + g.listings().length;

    if (!props.length) {
      el.list.replaceChildren(h('p', { class: 'dim empty' }, own
        ? 'You own nothing yet. Try the For sale tab.'
        : 'Nothing on the market this month.'));
      return;
    }

    const head = own
      ? ['Address', 'Area', 'Type', 'Let', 'Rent', 'Cond', 'Value', 'Net/mo']
      : ['Address', 'Area', 'Type', 'Let', 'Cond', 'Price', 'Yield'];
    const rows = props.map(p => {
      const t = TYPES[p.type];
      const d = g.district(p.district);
      let cells;
      const label = p.type === 'lot' ? (p.build ? 'Site: ' + TYPES[p.build.to].label : 'Vacant lot') : t.label + (p.build ? ' (works)' : '');
      const arrears = p.lets ? p.lets.filter(l => l && l.arrears).length : 0;
      const let_ = p.units ? p.tenants + '/' + p.units + (arrears ? '!' : '') : '—';
      if (own) {
        const net = g.projectedNet(p);
        cells = [p.address, d.name, label, let_, p.units ? money(p.rent) : '—',
          p.units ? Math.round(p.condition) : '—', short(g.value(p)), h('span', { class: net < 0 ? 'neg' : 'pos' }, signed(net))];
      } else {
        const price = g.askingPrice(p);
        const mr = g.marketRent(p);
        const est = p.units ? mr * p.units * g.expectedOccupancy(p, mr) - g.runningCost(p) : 0;
        cells = [p.address, d.name, label, let_, p.units ? Math.round(p.condition) : '—',
          short(price), p.units ? (est * 12 / price * 100).toFixed(1) + '%' : '—'];
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
  // Dialogs (styled as system requesters)
  // ---------------------------------------------------------------------------

  function dialog(title, body, actions, cls) {
    el.dialog.className = cls || '';
    el.dialogTitle.textContent = title;
    el.dialogBody.replaceChildren(...body);
    el.dialogActions.replaceChildren(...actions.map(([label, bcls, fn]) =>
      h('button', { value: label, class: bcls || '', onclick: fn || null }, label)));
    if (typeof el.dialog.showModal === 'function') { if (!el.dialog.open) el.dialog.showModal(); }
    else el.dialog.setAttribute('open', '');
  }

  function confirmSell(g, p) {
    const proceeds = g.saleProceeds(p);
    const gain = proceeds - p.boughtFor;
    dialog('Sell property', [
      h('p', null, 'Sell ' + p.address + ' for ' + money(proceeds) + ' after the ' + Math.round(g.rules.sellFee * 100) + '% agent\'s fee?'),
      h('p', { class: gain >= 0 ? 'pos' : 'neg' }, (gain >= 0 ? 'Profit ' : 'Loss ') + money(Math.abs(gain))),
    ], [['Cancel'], ['Sell', 'danger', () => act(g.sell(p.id))]]);
  }

  function confirmDemolish(g, p) {
    const n = p.tenants;
    dialog('Demolish', [
      h('p', null, 'Knock down ' + p.address + ' for ' + money(g.demolishCost(p)) + '? The plot is clear next month and you can apply to build.'),
      n ? h('p', { class: 'warn' }, n + ' household' + (n === 1 ? '' : 's') + ' will be displaced. Families and pensioners make the papers.') : null,
    ], [['Cancel'], ['Demolish', 'danger', () => act(g.demolish(p.id))]]);
  }

  function showHelp() {
    const g = ui.game;
    const hold = g.holdRequired();
    dialog('How to play', [
      h('p', null, 'Start with ' + money(g.rules.startCash) + '. Reach a net worth of ' + money(g.goal) +
        ' within ' + g.state.years + ' years' + (hold ? ', and hold it for ' + hold + ' months' : '') + '.'),
      h('ul', null,
        h('li', null, h('b', null, 'Buy'), ' buildings with a £ board. Tenants come with them.'),
        h('li', null, h('b', null, 'Rent'), ' above market and tenants leave; far above and they strike. Cheap rent fills the place and helps your reputation.'),
        h('li', null, h('b', null, 'Repair'), '. Buildings decay monthly. Wrecks lose value, catch fire and get fined.'),
        h('li', null, h('b', null, 'Borrow'), ' against your portfolio. Run out of cash and credit and the bailiffs sell your buildings cheap.'),
        h('li', null, h('b', null, 'Sell'), ' at market value minus a ' + Math.round(g.rules.sellFee * 100) + '% fee.')),
      g.hasMod('bank') ? h('div', null, h('h3', null, 'Bank moods'), h('ul', null,
        h('li', null, 'The base rate moves in a cycle of several years. Cheap money inflates prices; dear money deflates them, with a lag.'),
        h('li', null, 'Every month the bank checks your loan against its limit (', h('b', null, 'LTV'), ', which tightens as rates rise) and your ', h('b', null, 'interest cover'), ' (at least ' + g.rules.minCover + '×).'),
        h('li', null, 'Breach either and you get ' + g.rules.covenantMonths + ' months to fix it, then the bank sells your cheapest buildings at ' + Math.round(g.rules.seizeDiscount * 100) + '% of value.'),
        h('li', null, 'Fix your rate for 2 or 5 years at base + ' + rate(g.rules.fixedMargin) + '. It protects your interest, not your LTV.'))) : null,
      g.hasMod('tenants') ? h('div', null, h('h3', null, 'Tenant faces'), h('ul', null,
        h('li', null, 'Window colours show who lives there. Students pay well and wreck the place; professionals pay most but need good buildings and a good name; pensioners stay for ever at low rents; council placements are steady, until an inspection fails.'),
        h('li', null, 'Changing rent sets the asking rent. Sitting tenants move to it at their annual review, and may leave.'),
        h('li', null, 'Arrears rise when rates are high and prices fall. Tolerate, chase or evict; evicting families and pensioners makes the papers.'))) : null,
      g.hasMod('build') ? h('div', null, h('h3', null, 'Bricks & permission'), h('ul', null,
        h('li', null, 'Demolish, build on lots, or convert terraces to bedsits and back. Each needs planning; odds depend on the area, your reputation and council relations.'),
        h('li', null, 'Buildings affect their street: wrecks drag neighbours down, good buildings lift them. Districts drift with the state of their stock.'),
        h('li', null, 'Watch for council schemes: regeneration buys at 130%, a bypass knocks 20% off.'))) : null,
      h('p', { class: 'dim' }, 'Space ends the month. Arrow keys + Enter work on the map. The game saves itself.'),
    ], [['OK', 'primary']]);
  }

  function newGameDialog(firstRun) {
    const mods = Object.assign({}, ui.mods);
    const select = h('select', { id: 'years-select' });
    const fill = () => {
      const keep = Number(select.value) || ui.years;
      select.replaceChildren(...LENGTHS.map(y =>
        h('option', { value: y, selected: y === keep ? true : null }, y + ' years, goal ' + short(targetFor(y, mods)))));
    };
    const note = h('p', { class: 'dim' });
    const update = () => {
      const y = Number(select.value);
      note.textContent = 'Reach ' + money(targetFor(y, mods)) + ' net worth by ' + (RULES.startYear + y) +
        (mods.bank ? ' and hold it for ' + RULES.holdMonths + ' months.' : '.');
    };
    const boxes = MOD_KEYS.map(k => {
      const id = 'mod-' + k;
      const cb = h('input', { type: 'checkbox', id, checked: mods[k] ? true : null,
        onchange: (e) => { mods[k] = e.target.checked; fill(); update(); } });
      return h('div', { class: 'mod-row' }, cb, h('label', { for: id }, h('b', null, MOD_INFO[k].label), ' ', MOD_INFO[k].blurb));
    });
    select.addEventListener('change', update);
    fill();
    update();
    dialog(firstRun ? 'Welcome to Rent Baron' : 'New game', [
      firstRun ? h('p', null, 'Buy property, rent it out, keep it standing, get rich.') : h('p', null, 'Your current game will be lost.'),
      h('label', { for: 'years-select' }, 'Game length'),
      select,
      note,
      h('h3', null, 'Rules'),
      ...boxes,
      h('p', { class: 'dim' }, 'All off is the classic game. Targets adjust to the rules you pick.'),
    ], [
      firstRun ? null : ['Cancel'],
      ['Start', 'primary', () => { ui.years = Number(select.value); ui.mods = mods; newGame(); }],
    ].filter(Boolean));
  }

  function showGameOver(g) {
    const s = g.state;
    const nw = g.netWorth();
    if (s.status === 'bankrupt') {
      dialog('Bank failure', [
        h('p', { class: 'guru' }, 'Bankruptcy. Press New game to continue.'),
        h('p', { class: 'guru' }, 'Meditation #' + String(s.month).padStart(4, '0') + '.' + (Math.abs(Math.round(nw)) & 0xffff).toString(16).toUpperCase().padStart(4, '0')),
      ], [['Look around'], ['New game', 'primary', () => newGameDialog(false)]], 'guru-box');
      return;
    }
    const won = s.status === 'won';
    dialog(won ? 'Success' : 'Retired', [
      h('p', { class: 'big' }, won ? 'You are a Rent Baron!' : 'Time to hang up the keys.'),
      h('p', null, won
        ? 'You reached ' + money(nw) + (g.holdRequired() ? ' and held it' : '') + ' in ' + s.month + ' months.'
        : 'Net worth ' + money(nw) + ', ' + pct(Math.max(0, nw) / g.goal) + ' of the ' + money(g.goal) + ' goal.'),
    ], [['Look around'], ['New game', 'primary', () => newGameDialog(false)]]);
  }

  // ---------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------

  function select(id) {
    ui.selected = id;
    if (id != null) ui.cursor = id;
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
    ui.game = new Game({ years: ui.years, mods: ui.mods });
    ui.selected = null;
    ui.cursor = 0;
    ui.lastStatus = 'playing';
    ui.tab = 'market';
    render();
  }

  function moveCursor(dx, dy) {
    const g = ui.game;
    const { width, height } = g.mapSize;
    const p = g.property(ui.cursor) || g.property(0);
    const x = Math.max(0, Math.min(width - 1, p.x + dx));
    const y = Math.max(0, Math.min(height - 1, p.y + dy));
    const q = g.state.properties.find(o => o.x === x && o.y === y);
    if (q) ui.cursor = q.id;
    paintTown();
  }

  function bind() {
    el.town.addEventListener('click', (e) => {
      const id = tileAt(e);
      if (id != null) select(ui.selected === id ? null : id);
    });
    el.town.addEventListener('mousemove', (e) => {
      const id = tileAt(e);
      if (id !== ui.hover) {
        ui.hover = id;
        const p = id == null ? null : ui.game.property(id);
        el.town.title = p ? p.address + ' · ' + TYPES[p.type].label + (p.owned ? ' (yours)' : p.forSale ? ' (for sale)' : '') : '';
        paintTown();
      }
    });
    el.town.addEventListener('mouseleave', () => { ui.hover = null; paintTown(); });
    el.town.addEventListener('focus', paintTown);
    el.town.addEventListener('blur', paintTown);
    el.town.addEventListener('keydown', (e) => {
      const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (moves[e.key]) { e.preventDefault(); moveCursor(...moves[e.key]); }
      else if (e.key === 'Enter') { e.preventDefault(); select(ui.cursor); }
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
    $('#btn-new').addEventListener('click', () => newGameDialog(false));
    $('#btn-help').addEventListener('click', showHelp);
    $('#detail-close').addEventListener('click', () => select(null));
    $('#dialog-close').addEventListener('click', () => el.dialog.close());

    document.addEventListener('keydown', (e) => {
      if (el.dialog.open) return;
      const tag = (e.target.tagName || '').toLowerCase();
      if (['input', 'textarea', 'select', 'button', 'canvas'].includes(tag) || e.target.closest('tr[data-id]')) {
        if (!(tag === 'canvas' && e.key === ' ')) return;
      }
      if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); endMonth(); }
      else if (e.key === 'Escape') select(null);
    });

    window.addEventListener('resize', fitTown);
  }

  function init() {
    bind();
    const saved = load(SAVE_KEY);
    const prefs = load(PREFS_KEY) || {};
    if (LENGTHS.includes(prefs.years)) ui.years = prefs.years;
    if (prefs.mods && typeof prefs.mods === 'object') for (const k of MOD_KEYS) ui.mods[k] = !!prefs.mods[k];
    if (saved) {
      try { ui.game = Game.fromJSON(saved); } catch (e) { forget(SAVE_KEY); }
    }
    if (ui.game) {
      ui.tab = prefs.tab === 'market' ? 'market' : 'portfolio';
      ui.selected = Number.isInteger(prefs.selected) && ui.game.property(prefs.selected) ? prefs.selected : null;
      ui.cursor = ui.selected || 0;
      ui.lastStatus = ui.game.state.status;
      render();
    } else {
      ui.game = new Game({ years: ui.years, mods: ui.mods });
      ui.tab = 'market';
      render();
      newGameDialog(true);
    }
    fitTown();
    if (!reduceMotion) requestAnimationFrame(animate);
  }

  init();
})();
