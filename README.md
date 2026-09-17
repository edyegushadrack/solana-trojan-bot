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
