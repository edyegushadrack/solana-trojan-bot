# solana-trojan-bot

Personal Solana trading bot — Telegram-controlled, single hot wallet, v1 scope:
manual buy/sell, auto-snipe, copy-trading. Built for yourself first, multi-user
later if it proves out.

## Architecture

```
src/
  config.js           env loading + validation
  wallet/keypair.js    loads your hot wallet keypair from env
  rpc/connection.js    Solana connection (Helius/QuickNode/Triton)
  execution/jupiter.js quote + swap via Jupiter Swap API, sign & send
  snipe/pumpfunCurve.js direct pump.fun bonding-curve buy (pre-graduation)
  execution/trade.js   routes buys/sells to paper simulation or real execution
  paper/portfolio.js   simulated SOL + token balances for paper trading
  bot/index.js         grammy Telegram bot — commands + session state
  risk/                (phase 4) rug checks, spend limits, kill switch
  snipe/                (phase 2) pool-creation listener + auto-buy
  copytrade/            (phase 3) target wallet watcher + mirrored trades
```

## Build order

- [x] **Phase 1 — Core execution.** Wallet keypair mgmt, RPC connection,
      Jupiter quote/swap, Telegram `/buy` `/sell` `/balance` with manual
      amount + slippage args. This is what's scaffolded below — enough to
      manually trade end-to-end and prove the signing/sending path works
      before anything automated touches your wallet.
- [x] **Phase 2 — Snipe engine (pump.fun side only).** PumpPortal websocket
      listener for new launches, a basic liquidity pre-filter, and Jito
      bundle submission (signed swap tx + tip tx, sent atomically) via
      `/snipe on|off`. Raydium pool-init detection isn't wired in yet — this
      only catches pump.fun launches for now.
- [x] **Exit management (built ahead of Phase 3, since it's more
      important).** `exit/engine.js` scans open paper positions on an
      interval and sells on the first of three triggers: take-profit
      (`EXIT_TAKE_PROFIT_PCT`, default +60%), stop-loss
      (`EXIT_STOP_LOSS_PCT`, default -35%), or max hold time
      (`EXIT_MAX_HOLD_SECONDS`, default 300s — a backstop, not a claim
      that's the right number; tune it once you have real data). `/exits
      on|off`. Sells reuse the exact same execution path as manual `/sell`.
      **Paper positions only right now** — real-mode would need enumerating
      actual wallet token accounts instead of reading the paper portfolio,
      and that path has had zero live testing. `/exits on` refuses outright
      in live mode rather than silently doing nothing.
- [ ] **Phase 3 — Copy-trade engine.** Websocket subscription to a target
      wallet's tx log, swap-instruction parsing, mirrored buy with your own
      sizing logic.
- [x] **Phase 4 — Risk/safety layer (partial).** Mint/freeze authority
      checks (on-chain, real), max spend per trade, max slippage, max price
      impact, and a kill switch that blocks new buys (never sells) all gate
      every buy now — manual or sniped. NOT included: deployer rug-history
      and bundler/sniper same-block detection. That logic already exists in
      the meme-scanner repo, backed by its Supabase project, and porting it
      in is the natural next step rather than rebuilding it here — see
      "Known gap" below.
- [ ] **Phase 5 — Persistence.** Postgres/SQLite (or reuse the Supabase
      project from the meme-scanner) for trade history, open positions,
      settings.

Given you already have contract-forensics and rug-check logic in the
meme-scanner repo (mint/freeze authority, bundler/sniper detection,
deployer rug history), phase 4 here should call into that rather than
duplicate it — worth deciding now whether this bot and the scanner share a
package or stay separate repos that both hit the same Supabase project.

## What the risk gate actually checks, and why

`src/risk/gate.js` runs before every buy (manual or sniped):

1. **Kill switch** — hard stop if active.
2. **Mint/freeze authority** — read directly from the mint account.
3. **Deployer history** (if `SUPABASE_URL` is set) — queries the
   meme-scanner's `launches` table for how many prior pump.fun tokens this
   wallet has created.

**Why authority checks matter less than you'd think, for pump.fun specifically.**
Querying the actual meme-scanner data (56,716 launches) before building
this: `mint_authority_renounced`, `freeze_authority_renounced`, and
`lp_locked_or_burned` are `true` on effectively 100% of them. Pump.fun's
program enforces this at creation — the bonding curve controls minting,
not the individual deployer — so these checks don't differentiate one
pump.fun launch from another. They're still real and still run (they'd
matter for a non-standard token or a future Raydium-graduated check), just
don't expect them to catch much on pump.fun launches specifically.

**Why deployer history uses prior-launch count, not average score.**
`dev_holder_pct` is never populated in the dataset. `top10_holder_pct`
averages ~99% at creation time (the bonding curve holds nearly all supply
before anyone's bought). And — this one's worth knowing about the
scanner's own scoring model — the highest-volume repeat deployers (900+
launches from one wallet) score about the same on average (~65) as the
rest of the dataset, because ~55 of a typical ~100 possible points come
from the three now-universal authority/LP checks above. Score alone
doesn't currently separate a mass-deployer farm from anything else.
Prior-launch count does: median is 1 launch per wallet, 90th percentile is
5, 99th is 46. A wallet with 15+ prior pump.fun launches (the default
threshold, `RISK_MAX_DEPLOYER_PRIOR_LAUNCHES`) is a clear outlier — almost
certainly a farm, not an individual project — so that's what's checked.

**Read access, not the service-role key.** The `launches` table's RLS
originally only allowed the scanner's own service-role key to read it. A
narrow read-only policy (`anon read-only access`, SELECT-only on
`launches`) was added so this bot can use the standard anon/publishable
key instead — safe to have in a second app's env vars, since it can't
write anything and can't read any other table.

**What's still genuinely not covered:** same-block bundler/sniper
detection. The meme-scanner's `token_early_buyers` table exists for this
but has 0 rows in production — that detection isn't actually collecting
data there yet, so there's nothing real to port. Worth building once the
scanner side is actually populating it.

## Setup

```bash
npm install
cp .env.example .env   # fill in RPC_URL, PRIVATE_KEY, TELEGRAM_BOT_TOKEN
npm start
```

`PRIVATE_KEY` is your wallet's base58-encoded secret key (same format
Phantom exports). Never commit `.env`. Start with a wallet that only holds
what you're willing to lose testing this — not your main bag.

## Commands

- `/risk` — current risk limits and kill switch status
- `/killswitch on | off | status` — block/unblock new buys (sells always work)
- `/balance` — SOL balance (simulated or real, depending on mode)
- `/buy <mint> <sol_amount> [slippage_bps]` — buy via Jupiter
- `/sell <mint> <percent> [slippage_bps]` — sell a % of your holding of `mint`
- `/snipe on` / `/snipe off` — start/stop the auto-snipe engine
- `/exits on` / `/exits off` — start/stop auto take-profit/stop-loss/max-hold (paper only)
- `/portfolio` — paper trading balance, holdings, trade count
- `/resetpaper` — reset the paper portfolio to `PAPER_STARTING_SOL`
- `/paper on` / `/paper off` — toggle simulate-only mode (see below)

## Paper trading

The bot boots in paper mode by default: every `/buy`, `/sell`, and snipe
fire a real Jupiter quote so pricing and slippage are realistic, but the
fill is simulated against a local virtual portfolio (`data/paper-portfolio.json`)
instead of signing and sending anything. Good for exercising the whole
pipeline — snipe detection, filters, sizing, the bot commands — before real
funds are at risk.

**Turning it off is a two-key switch, on purpose:**
1. Set `PAPER_TRADING=false` in `.env` and restart the bot. This unlocks
   the switch but doesn't flip it.
2. Send `/paper off` in Telegram to actually arm real trades.

Without step 1, `/paper off` is refused outright — a stray command can't
accidentally arm real money. The bot also always boots back into paper
mode regardless of what `.env` says, so leaving live mode on between
restarts isn't possible either.

## ⚠️ Before you turn /snipe on

The rug/forensics checks (mint & freeze authority, bundler/sniper detection,
deployer rug history) live in the `meme-scanner` repo and are **not wired
into this bot yet** — that's Phase 4. Right now `/snipe on` fires on any
pump.fun launch that clears a basic liquidity threshold
(`SNIPE_MIN_LIQUIDITY_SOL`), nothing more. Keep `SNIPE_BUY_SOL` at a
throwaway amount until Phase 4 is in.


## Why snipes don't go through Jupiter (mostly)

Early testing showed every single snipe failing with "Jupiter quote failed
(400): The token ... is not tradable" — 100% of attempts, not intermittent.
Root cause, confirmed against production logs and cross-checked with
Jupiter's own issue tracker and multiple independent pump.fun sniper
projects: **Jupiter's aggregator only routes through pools it has indexed,
and a pump.fun bonding curve isn't indexed at the instant of creation** —
which is exactly the moment a snipe is reacting to. This isn't a bug in
this bot; it's a structural mismatch between "buy via a general aggregator"
and "buy at creation."

The fix (`src/snipe/pumpfunCurve.js`): buy directly against pump.fun's own
bonding-curve program using the official `@pump-fun/pump-sdk`, bypassing
Jupiter entirely for pre-graduation tokens. If a curve has already
completed (`bondingCurve.complete`), the snipe path falls back to Jupiter
automatically, since a graduated token is an ordinary Raydium/PumpSwap pool
by then and Jupiter routes it fine. Manual `/buy` and `/sell` still use
Jupiter only — they're for tokens you've deliberately chosen, not
zero-second-old launches, so the same failure mode is far less likely
there (though not impossible on a very fresh manual buy).

**A real bug this caught before it shipped:** the SDK splits RPC-reading
(`OnlinePumpSdk`) from pure offline instruction-building (`PumpSdk`, no
connection at all) — early docs examples floating around online predate
this split and show both fetch and build methods on one class. Calling the
fetch methods on the wrong class would have silently returned `undefined`
rather than erroring clearly. Caught by testing the actual installed
package's method list directly rather than trusting documentation
snippets — worth remembering if this SDK gets upgraded later.

**Also caught by testing, not assumed:** `@pump-fun/pump-sdk` pulls in
`@pump-fun/agent-payments-sdk`, which imports `BN` from `@coral-xyz/anchor`
in a way Node's ESM loader can't resolve — a plain `import` of the package
throws `Named export 'BN' not found` before any of this bot's own code
even runs. Worked around with `createRequire` in `pumpfunCurve.js`, which
routes resolution through Node's CommonJS loader instead. Confirmed by
testing both the crash and the fix directly against the real installed
package.

**What's still unverified:** the actual on-chain read calls
(`fetchGlobal`/`fetchFeeConfig`/`fetchBuyState`) and the bonding-curve math
haven't been exercised against live data from this environment — this
sandbox's network doesn't reach Solana RPC endpoints. Module resolution,
class shapes, and method signatures are all confirmed against the real
installed package; the live RPC path itself needs confirming once
deployed. Paper mode is the way to check: it calls the exact same
read/compute path as a real buy, just without signing or sending, so a
clean `[PAPER] Simulated buy (curve)` message on a real fresh mint is
strong evidence the whole thing works end to end.


## The 429 storm, and what was actually causing it

Switching to Helius didn't fix the "429 Too Many Requests" errors — because
Helius's free tier (10 req/s) wasn't actually the problem. The real cause:
`snipe/engine.js` fired off a new, fully-concurrent chain of RPC calls
(mint authority check + bonding-curve state fetch, ~4-6 calls) for *every*
incoming PumpPortal message with no limit on how many could run at once.
When several launches arrive within the same second — completely normal on
pump.fun — that's several concurrent chains all hitting the RPC provider
simultaneously, blowing past any free-tier ceiling regardless of provider.

Two fixes:
1. **`SNIPE_MAX_CONCURRENT`** (default 2) caps how many candidates are
   processed at once. A candidate arriving while at capacity is dropped,
   not queued — by the time a queued candidate's turn came up, the snipe
   window would already be gone, so queueing would just spend RPC budget on
   stale opportunities.
2. **Global/FeeConfig caching** in `pumpfunCurve.js` — these are
   program-wide settings that barely change, and were being re-fetched on
   every candidate for no reason. Cached for 60s, cutting real RPC volume
   per candidate roughly in half.

**A related finding while debugging this:** the basic liquidity pre-filter
(`filters.js`) checks `vSolInBondingCurve` against a threshold, but every
pump.fun token starts with the *same* virtual reserves (~30 SOL) — that's a
protocol constant, not a signal of real interest. On a "create" event
specifically, this filter passes almost everything, which is part of why so
much volume was reaching the expensive per-candidate path in the first
place. Confirmed via research, not assumed — see the comment in
`filters.js`. It's left in place (harmless, protects against malformed
events) but don't expect raising `SNIPE_MIN_LIQUIDITY_SOL` to meaningfully
cut volume; `SNIPE_MAX_CONCURRENT` is the actual volume control right now.


## Follow-up: the concurrency cap alone wasn't enough

`SNIPE_MAX_CONCURRENT` shipped, got deployed (confirmed via Railway's
deploy log), and the 429 storm continued anyway. Root cause: concurrency is
a proxy for request rate, not a direct bound on it. Two concurrent
candidate chains, each firing several RPC calls in quick succession, can
still sustain well above 10 req/s if pump.fun's actual creation rate keeps
both slots continuously refilled — which it does.

**The actual fix:** `@solana/web3.js`'s `Connection` accepts a
`fetchMiddleware` option — a single choke point called before *every* RPC
request the connection makes, from any code path (ours, or the pump-sdk's,
since `OnlinePumpSdk` was built with this same connection instance).
`rpc/connection.js` now paces every request through it, spacing calls to a
hard ceiling (`RPC_MAX_REQUESTS_PER_SECOND`, default 8) regardless of how
many things want to call the RPC at once. Verified directly: fired 30
simultaneous fake requests through the exact pacing logic, confirmed they
came out spaced ~125ms apart (8/sec) rather than all at once.

This is a direct bound on the actual bottleneck, not a proxy for it —
`SNIPE_MAX_CONCURRENT` still helps (no point burning rate budget on stale
candidates), but the rate limiter is what actually prevents 429s now,
independent of how many concurrent chains are running.


## Follow-up: /portfolio had the same Jupiter-quoting gap as buying did

Ran a real paper session and `/portfolio` showed "no route" on 3 of 7 open
positions — exactly the same problem as the original snipe failures, just
in a different code path I hadn't fixed yet. Valuing an open position for
unrealized PnL was still going through Jupiter's quote, which can't price
a pre-graduation pump.fun token for the same reason it can't route a buy
for one.

Fixed with the sell-side equivalent of the buy fix:
`getPumpFunSellValue` (`pumpfunCurve.js`) uses the SDK's
`getSellSolAmountFromTokenAmount` against the live curve — same mechanism
the on-chain program itself uses — falling back to Jupiter only once a
position's curve reports `complete` (graduated). `/portfolio` should now
price every open position correctly regardless of graduation status.


## Follow-up: /portfolio showing 100% "no route" — self-inflicted, not an RPC failure

After running snipe + exits together for a while, /portfolio came back with
all 23 open positions showing "no route." That's not the occasional
propagation-lag case from earlier — 100% failure meant something systemic.

Root cause, confirmed with the actual math before changing anything: the
exit engine was valuing every open position, every scan (every 15s), and
that cost grows with portfolio size — sniping keeps adding positions, so
every scan gets more expensive over time, with no ceiling. All of that
competes with active sniping for the same rate-limited RPC connection (the
429 fix from earlier). Modeled it directly: at ~6+ req/s sustained snipe
traffic (very plausible — 35 trades had already happened), the last calls
in a 23-position batch don't even get dispatched until 10+ seconds in,
which is longer than the 10s timeout those calls were racing against. Calls
were being marked "failed" for sitting in a queue, not because the RPC was
actually down.

**The real fix:** bound the exit engine's own RPC footprint to a small,
fixed number per scan (`EXIT_MAX_POSITIONS_PER_SCAN`, default 6),
regardless of how many positions exist. Positions are checked in rotation
— a large portfolio takes more scan cycles to fully cycle through, but no
single scan's cost is unbounded. Verified directly: 23 positions, 6 per
scan, full coverage confirmed within 4 scans with correct wraparound.
Timeout also raised 10s -> 20s as secondary headroom, since a call
legitimately queued for a while under real load is fine — it just
shouldn't be mistaken for a dead RPC.

`/portfolio` (the manual command) still values everything at once when you
ask for it — it's a one-off request, not a recurring background cost, so
there's no reason to limit it the same way.
