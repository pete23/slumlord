# Rent Baron

A property tycoon game in plain HTML, CSS and JavaScript, drawn in 16-bit
home-computer style. Buy buildings, set rents, keep them standing, borrow
against them, and reach a net-worth target before time runs out.

**Play:** open `index.html` in a browser. No server, build step or install
needed. The game saves itself in the browser's local storage.

**Text mode:** open `text.html` (or press *Text mode*) for the same game on an
80×32 character screen in hi-res style: Baron8 at 1:1, 640×256 pixels drawn
twice as tall as wide. Every screen is a multiple-choice menu, played with
hotkeys or mouse clicks; arrow keys move around the town map. Both interfaces
share one save, so you can switch mid-game.

## Rules

New games offer three optional rule modules, all on by default (see
`docs/design/mods.md`):

| | Mod | What it adds |
|---|---|---|
| A | Bank moods | Base rate moves in a credit cycle; the bank tests loan-to-value and interest cover monthly, with seizure after six months in breach; fixed-rate deals; the target must be held for 12 months |
| B | Tenant faces | Five tenant classes with their own rents, wear, churn and arrears; annual rent reviews; letting and arrears policies; evictions that make the papers |
| C | Bricks & permission | Demolish, build and convert with planning odds; council relations; neighbours and districts respond to the state of their buildings; regeneration and bypass schemes |

All three off is the classic game. Targets are tuned per combination.

## The game

| File | What it is |
|---|---|
| `index.html` | Page structure |
| `game.js` | Engine: state, rules, seeded RNG. No DOM access, so it also runs in Node |
| `ui.js` | Graphical interface: pixel-art town renderer, panels, input, saving |
| `style.css` | Graphical interface look and feel |
| `text.html`, `text.js`, `text.css` | Text-mode interface: 80-column menu screens over the same engine |
| `font.css` | The embedded `Baron8` bitmap font, shared by both interfaces |

`ui.js` only uses the engine's public API (`buy`, `sell`, `setRent`,
`repair`, `borrow`, `repay`, `endMonth`, and read-only queries such as
`value`, `marketRent` and `expectedOccupancy`). Game rules belong in
`game.js`.

## Supporting tools

Not needed to play; used to develop the game.

| Path | Purpose |
|---|---|
| `tests/engine.test.js` | Engine unit tests (`node:test`) |
| `tests/smoke.js` | Headless-browser check of both interfaces (desktop, phone, text mode) |
| `tools/balance.js` | Bot simulator for tuning the economy and targets |
| `tools/font/glyphs.py` | Source pixels for the `Baron8` font (8×8 per glyph) |
| `tools/font/build_font.py` | Builds the font and re-embeds it in `font.css` |
| `docs/design/mods.md` | Why the current rules are too easy, and three composable rule changes to fix it |

```sh
npm test                         # engine unit tests (Node 18+)
npm install && npm run smoke     # browser smoke test (installs Playwright;
                                 # run `npx playwright install chromium` once)
npm run smoke -- --shots out     # ...and save screenshots to ./out

npm run balance                  # greedy vs prudent bots, all mods, 10-50 year games
npm run balance -- --mods AB     # a subset of mods ('none' = classic)
npm run balance -- --derive --all  # targets for every mod combination (JS to paste)
npm run balance -- --years 20 --seeds 100 --bot prudent --verbose

pip install -r tools/requirements.txt
npm run font                     # rebuild Baron8 after editing glyphs.py
```

### Tuning the economy

The numbers live in `TYPES`, `DISTRICTS`, `CLASSES` and `RULES` at the top
of `game.js`. After changing them, run `npm run balance -- --derive --all
--seeds 40` and paste the output over the `TARGETS` table, so each target
sits near the median of the better bot for that rule set and length. Check
`npm run balance` afterwards: with all mods on, greedy should lose and go
bankrupt far more often than prudent.

### Editing the font

Each glyph in `tools/font/glyphs.py` is 8 rows of 8 characters: `#` is a
pixel. Rows 0–6 sit above the baseline and row 7 is the descender. Vertical
strokes are 2 pixels wide, in the style of the Amiga Topaz font. Characters
missing from the font fall back to the system monospace font. The build is
deterministic, so an unchanged glyph file produces an identical `font.css`.
