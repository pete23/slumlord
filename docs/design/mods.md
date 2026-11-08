# Making Rent Baron interesting

Diagnosis of why the current rules are a one-button game, and three rule
modifications that work alone or in any combination. Rules only: UI and
implementation are deliberately left open. Numbers quoted below come from
`game.js` as of this commit and from `tools/balance.js`-style bot runs.

## 1. Diagnosis

### The exploit, quantified

Every building in town is a free money pump.

| Measure (game start, seed 1) | Value |
|---|---|
| Net yield after upkeep, tax and maintenance, worst building | 12.4% |
| Median | 18.2% |
| Best | 25.6% |
| Cost of debt | 7.5%, fixed forever |
| Gross yield at the very top of a boom (`marketIndex` 1.9) | 24.9% |

There is no state of the world in which borrowing to buy loses money. The
spread between yield and debt never closes: values scale with `marketIndex`
but rent only moves `0.85 + 0.15 × marketIndex`, so even a maximal boom
leaves gross yields above 24%.

Leverage carries no risk either:

- The 75% LTV limit is tested only when you *ask* to borrow. A crash can take
  you to 95% LTV and nothing happens.
- Interest is a flat 7.5% for 10–50 years.
- The only failure path is cash < 0 with no credit left, and a leveraged
  portfolio covers its interest 2.5–3× from rent alone.

A bot that borrows to 65–80% LTV every month sat through three property
crashes and a 55% net-worth drawdown in one 20-year game without a single
consequence, and owned all 48 buildings by year 14.

### Every decision has a dominant answer

| Decision | Correct answer | Ever wrong? |
|---|---|---|
| Rent | 0.95 × market | No |
| Repair | Patch below 70 | No |
| Buy | Everything, in yield order | No |
| Sell | Never (5% fee, assets appreciate, yields exceed debt) | No |
| Borrow | Maximum | No |

Four controls, each with one setting. The game is "press End month until
you can afford the next building".

### Risk is cosmetic

The largest routine incident (fire) costs 4% of one building's value.
Rent strikes only occur above 1.25× market, where nobody goes. Reputation
moves occupancy by ±20% and is trivially held above 50. Random events are
flavour text with a small invoice attached.

### The flat fix does not work

Raising the interest rate is the obvious patch. Sweep, 10-year games,
same bot:

| Rate | Won | Bankrupt | Median worth |
|---|---|---|---|
| 7.5% | 50% | 0% | £890k |
| 10% | 20% | 10% | £514k |
| 12.5% | 5% | 10% | £215k |
| 15% | 0% | 35% | £76k |

At 12.5% the game is hard, but it is a *grind*: the same dominant
strategies, slower. Difficulty is not interest. Interest is "the right
answer depends on something I have to read, and being wrong hurts".

### Design principle for every mod below

Each modification must:

1. remove at least one dominant strategy from the table above;
2. add a signal the player can read and act on ahead of time;
3. add a failure mode that is unambiguously the player's fault.

Randomness is allowed to set the question. It must never be the answer.

---

## 2. Mod A: the bank has moods

**What it fixes:** the leverage pump. This is the only mod of the three
that removes the exploit on its own, so it is the one to ship first.

**Fantasy:** late-1980s money. Cheap credit inflates a boom; the bank then
doubles rates and discovers covenants it never mentioned. Players who read
the cycle buy in the bust and fix their rate before the peak. Players who
don't, meet the bailiffs.

### Rules

**A1. Base rate is state.** `s.baseRate`, starting ~7%, moving monthly as a
mean-reverting walk with regime shifts, bounded 4–16%. Drawn from the seeded
RNG, so games remain reproducible. Rate moves are logged
("Bank raises base rate to 12%").

**A2. The cycle is readable.** Cheap money feeds the property market and
dear money follows a boom with a lag:

- `marketIndex` drift gains a term `+(0.08 − baseRate) × k₁` (cheap money
  inflates prices).
- `baseRate` drift gains a term `+(marketIndex − 1.15) × k₂` (booms draw
  rate rises) with a 12–24 month lag (track a smoothed market index).

The player who watches both lines can see the squeeze coming a year out.
That is the skill.

**A3. Loan rate = base + 2.5%, variable, charged monthly** on the current
balance. Replaces `RULES.interestRate`.

**A4. Fix your rate.** New action `fixRate(years)`: locks the *current*
balance at base + 3.5% for 2 or 5 years. One fixed tranche at a time; new
borrowing is variable. Breaking a fix early costs 3% of the fixed balance.
This is the hedge, and it costs 1% a year, so it is a decision rather than a
default.

**A5. Covenant tested monthly.** If `loan > maxLtv × portfolioValue` at
month end, the bank serves notice: cure within 6 months (repay or sell) or
the existing bailiff code seizes properties, cheapest first, at 75% of
value, until the covenant holds. Notice state is visible and logged.

**A6. Banks tighten when money is dear.** `maxLtv` is 75% at base ≤ 6%,
falling linearly to 55% at base ≥ 14%. A rate spike therefore breaches
covenants *without* a crash. This is the mechanism that turns "leverage to
the max" from optimal into fatal: the same portfolio is fine at 7% and in
notice at 13%.

**A7. Interest cover is the player's gauge.** Expose
`interestCover() = monthly net rent / monthly interest`. Nothing in the
rules uses it; it is the number a competent player steers by (keep it ≥ 2
into a rising cycle) and the UI should make it prominent.

### What the player now decides

- How much leverage to carry *given where the rate is in its cycle*.
- Whether to pay 1%/yr to fix, and when (fixing at the peak is the classic
  mistake and should feel like one).
- Whether to buy in a bust at low prices and high rates, or wait.
- When to sell into a boom to pay down debt before the squeeze. Selling
  finally has a reason to exist.

### Failure mode

Over-leveraged on variable debt into a rate rise; covenant notice; forced
sales at the bottom of the market; back to zero. Entirely foreseeable from
the rate chart, entirely the player's fault.

### Tuning anchors and acceptance test

- The long-run *average* loan rate should stay near 8–9%, so the economy
  is not uniformly harder; it is harder *at the wrong moments*.
- Peaks of 13–15% lasting 12–24 months, roughly once per decade.
- Acceptance: write two bots in `tools/balance.js`.
  - *Greedy* (current bot, always at 70% of available credit) must win
    < 10% and go bankrupt > 30% of 10-year games.
  - *Prudent* (caps interest cover at ≥ 2, fixes when base rate is below
    its 24-month average and rising, sells down when `marketIndex` > 1.5)
    must win ~50%. Re-derive `TARGETS` from the prudent bot.

### Engine surface

New state: `baseRate`, `rateHistory`, `fixed: {balance, rate, until} | null`,
`covenantNotice: {since, deadline} | null`. New actions: `fixRate(years)`,
`breakFix()`. New queries: `loanRate()`, `maxLtv()`, `interestCover()`.
Report gains `rateMove`. Save version bump.

---

## 3. Mod B: tenants have faces

**What it fixes:** the rent and repair controls having one correct setting,
and risk being uncorrelated noise. Turns per-building management into
monthly decisions with trade-offs. Does **not** fix the leverage pump on
its own; pair with A.

**Fantasy:** you are not managing "occupancy"; you are managing people who
pay late, leave, complain to the paper, or quietly stay for twenty years.

### Rules

**B1. Tenant classes.** Each let is one of five classes. Suggested starting
profiles (tune freely):

| Class | Rent ceiling (× market) | Wear | Arrears risk | Churn | Rep sensitivity | Notes |
|---|---|---|---|---|---|---|
| Students | 1.1 | ×1.8 | medium | very high (leave each summer) | low | Prefer Old Quarter, bedsits. Lower neighbours' desirability slightly (noise). |
| Families | 1.0 | ×1.0 | low | low | medium | Prefer terraces, condition ≥ 50. Evicting one is a press event. |
| Professionals | 1.4 | ×0.7 | very low | medium | very high | Need condition ≥ 70 and district ≥ 0.9. Leave fast when rep falls. Raise neighbours' desirability. |
| Pensioners | 0.8 | ×0.5 | very low | very low | medium | Stay decades at stale rents. Evicting one is a scandal. |
| Council-placed | 0.8, paid by the council | ×1.3 | none while placed | low | low | Reliable cash in Gasworks. A failed council inspection (condition < 30) stops the payments and removes the placement. |

**B2. Discrete tenancies.** A unit is empty or holds
`{class, rent, since, arrears}`. `p.tenants` becomes a derived count so
existing UI and tests keep working.

**B3. Letting.** An empty unit receives applicants each month, drawn by
class from district, type, condition, asking rent and reputation. The
player sets one *letting policy* per building (any / no students /
professionals only / council-placed) rather than vetting individuals. The
engine lets to the first acceptable applicant. Voids take time: a wreck in
Gasworks asking 1.3× market stays empty.

**B4. Rent reviews.** A sitting tenant's rent only changes at their annual
review. `setRent` sets the *asking* rent for new lets and the review target
for existing ones. At review, a rise above the class's tolerance triggers a
class-specific chance to leave (students shrug, pensioners can't afford it,
professionals compare with the market). Market rents drift up over time
(index them to the smoothed `marketIndex` and, with Mod A, to the rate
cycle as a proxy for inflation), so stale rents are a slow leak the player
must periodically decide to plug, at the cost of voids.

**B5. Arrears.** Each month a tenant may stop paying, with probability
`class risk × economy factor`. The economy factor rises in recessions
(`marketIndex` falling; with Mod A, base rate high). Per building the
player chooses a policy for tenants in arrears:

- *Tolerate*: no cost, no rent, wear continues.
- *Chase*: small fee, 50% chance of recovering each month, slight rep cost.
- *Evict*: fee, two-month void, rep hit scaled by class (student: none;
  family: press story; pensioner: scandal, −10 rep, council attention).

**B6. Voids cost.** Empty units pay a small empty-property charge and are
where squatters go (the existing event moves to unit level).

**B7. Reputation becomes earned.** Rep moves on eviction choices, on
conditions tenants live in, and on press events; it decays toward 50 as
now. Professionals' sensitivity means a high-end strategy is high-yield
and fragile.

### What the player now decides

- Tenant mix per building and per district: yield versus stability versus
  what it does to the street.
- When to push rents at review and how hard, by class.
- Tolerate, chase or evict, with the newspaper watching.
- Whether to refurbish *to change class* (a 70-condition flat in Riverside
  attracts professionals; a 50 one attracts students who will take it back
  down to 40).

### Failure mode

A high-yield professional portfolio bought on debt; reputation slips after
two evictions; professionals leave en masse; voids plus (with Mod A)
rising interest; interest cover collapses. Or the slum route: council-placed
tenants on neglected stock; an inspection fails; the council payments stop
on six buildings in the same month.

### Composition note

With Mod A this creates the correlated risk the current game lacks:
recessions raise arrears exactly when rates rise. Cash flow and interest
move against each other at the same time, which is what makes leverage a
genuine bet rather than a bad bet.

### Tuning anchors

- An all-professional and an all-family strategy should have similar
  expected 10-year returns; professional should have roughly twice the
  variance.
- Council-placed in Gasworks should be the safest income in the game and
  cap out below the target on its own.
- Student houses in Old Quarter: best raw yield, highest maintenance.

### Engine surface

New state per property: `lets[]`, `policy`, `arrearsPolicy`. New actions:
`setPolicy(id, policy)`, `setArrearsPolicy(id, policy)`. Changed:
`setRent` semantics (asking/review target). New queries:
`applicants(id)` (preview, for the UI), `tenantSummary(id)`. Report gains
`arrears`, `evictions`, `voids`. Bot needs a policy heuristic. Save version
bump.

---

## 4. Mod C: bricks and permission

**What it fixes:** supply exhaustion (all 48 buildings owned by year 14,
then nothing to do), the map being decorative, and the absence of any
long-horizon bet. Does **not** fix the leverage pump on its own; with free
money you would simply build everything. Pair with A.

**Fantasy:** the slumlord's real game. Let a street rot, buy it cheap,
knock it down, put up flats, sell the view. Or do the opposite and be
praised in the paper for it.

### Rules

**C1. Plots.** Every tile is a plot. An owned building can be demolished
(cost ≈ 5% of base value, one month) to an empty plot. An empty plot can
be built on: choose a type; build time terrace 6 / bedsit 6 / flats 12 /
tower 18 months; cost ≈ 0.7 × base value × `marketIndex`, paid in equal
monthly stages; earns nothing until complete; completes at condition 100
and empty. Build cost scaling with `marketIndex` makes building in a bust
the smart, counter-cyclical move.

**C2. Conversion.** Terrace → bedsit house (HMO): cheap, 2 months, needs a
licence (C3). Bedsit → terrace: the gentrifier's reverse. Sitting tenants
are displaced on conversion (with Mod B, by class, with the matching
reputation consequences).

**C3. Planning.** Each build or conversion is an application. Approval
probability depends on district policy (towers in Parkview: near zero;
bedsits in Parkview: low; anything in Gasworks: high), reputation, and a
`councilRelations` meter. Refusal imposes a 12-month cooldown on that plot.
Donations to the mayor's fund raise `councilRelations` and carry a small
monthly chance of a scandal that zeroes it and costs 15 reputation.
Appeals cost money and take 6 months. A decision becomes a probability the
player can push, at a price.

**C4. Neighbours matter.** A building's *local* desirability is the
district's, scaled by a neighbourhood factor from the condition and type of
the adjacent tiles (anyone's). Rot spreads; refurbishment spreads. Towers
drag the tiles around them in high-desirability districts and lift them in
low ones. This is the rule that gives the map meaning and makes the
blight-and-buy strategy emergent rather than scripted: let three terraces
decay, watch the neighbours' prices fall, buy them, refurbish all six.
Costs along the way: condemnation fines and reputation.

**C5. District feedback.** District `trend` gains a term from the average
condition and type mix of all its buildings. Players can gentrify
Gasworks or slum Market Hill over a decade. Both are visible in the
desirability history.

**C6. Starting stock.** Replace ~6 of the 48 tiles with vacant lots and
derelicts (condition < 15, cheap, unlettable until refurbished) so there is
something to build on from month one.

**C7. Schemes (optional spice).** Occasionally the council announces a
regeneration zone or a bypass route 24 months ahead: tiles in the zone are
later bought compulsorily at 1.3× value, or lose 20%. Information with a
clock on it.

### What the player now decides

- Where capital goes: another building at today's prices, or a tower that
  pays nothing for 18 months and triples the units on the plot.
- Whether to build into a boom (expensive, fast to let) or a bust (cheap,
  slow to let, and with Mod A, financed at high rates).
- Whether to blight a street on purpose and wear the reputation cost.
- How much to lean on the council.

### Failure mode

The developer's classic: an 18-month tower on variable-rate debt, started
at the top of the market. With Mod A, rates rise during the build, the
covenant tightens, and the half-built site has no rent and no sale value.

### Tuning anchors

- A tower in Gasworks should pay back in 8–10 years of rent at the start
  of the game; in Riverside, 6–7 after the view premium.
- Blight-and-buy on a six-terrace street should return ~1.5× the capital
  over five years, with reputation ending 15–20 points lower.
- Total units in town can grow ~3× over a 50-year game, which is what the
  long game needs.

### Engine surface

New property states: `empty plot`, `under construction {type, monthsLeft,
paid}`, `derelict`. New actions: `demolish(id)`, `build(id, type)`,
`convert(id, type)`, `donate(amount)`, `appeal(id)`. New state:
`councilRelations`, `applications[]`, `schemes[]`. New query:
`localDesirability(p)` replacing direct district lookups in `value` and
`marketRent`. Save version bump. Bot needs a build heuristic (build when
`marketIndex` < 1 and credit allows).

---

## 5. How they combine

| Combination | What the game becomes | Does it kill the exploit? |
|---|---|---|
| A | A timing game. Buy in busts, fix before peaks, keep cover. Supply still runs out, later. | **Yes** |
| B | A management game. Tenant mix, reviews, evictions. Leverage is still free money. | No |
| C | A builder game. You still build everything, because money is free. | No |
| A + B | **The squeeze.** Arrears rise as rates rise; cash flow and interest move against each other. The richest source of tension here. | Yes |
| A + C | **The developer's gamble.** Build cycles against rate cycles; counter-cyclical building is the skill. | Yes |
| B + C | **The gentrifier.** Change stock to change tenants to change the street. Pleasant, toothless without A. | No |
| A + B + C | The full game. Three readable systems whose correlations are the difficulty. | Yes |

### Recommendation

1. **Ship A first and measure it** with the greedy/prudent bot pair. It is
   the smallest change, it removes the exploit, and it makes Sell, Repay
   and the net-worth chart matter. If A alone is not enough, nothing
   layered on top will be.
2. **Then B or C by game length.** For 10–20 year games, B gives more
   decisions per month. For 30–50 year games, C is what stops year 15
   onward being a spreadsheet. If you only want one more, C also answers
   the earlier "the town is too small" problem, so it is the better single
   add.
3. Each mod behind a flag in `RULES` so `tools/balance.js` can measure them
   separately and together, and the new-game requester can offer them as
   options once tuned.

### Deliberately not proposed

- **Rival landlords.** Ruled out earlier. Nothing above depends on them;
  all three mods leave room for rivals later (they would be bidders in C
  and competitors for tenants in B).
- **Bigger random events.** Scaling fires and floods makes the game
  swingier, not more interesting; the randomness would be the answer, not
  the question.
- **A flat higher interest rate.** Shown above to produce a grind.
- **Auctions for purchases.** A good mechanic, but it only matters once
  money is scarce (A) or supply is contested (rivals). Revisit after A.
