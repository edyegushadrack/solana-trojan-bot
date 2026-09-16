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
- [ ] **Phase 4 — Risk/safety layer.** Mint/freeze authority checks, LP
      lock/burn checks, max slippage, max spend per trade, kill switch. This
      gates phases 2 and 3 — don't wire snipe/copy to real money without it.
- [ ] **Phase 5 — Persistence.** Postgres/SQLite (or reuse the Supabase
      project from the meme-scanner) for trade history, open positions,
      settings.

Given you already have contract-forensics and rug-check logic in the
meme-scanner repo (mint/freeze authority, bundler/sniper detection,
deployer rug history), phase 4 here should call into that rather than
duplicate it — worth deciding now whether this bot and the scanner share a
package or stay separate repos that both hit the same Supabase project.

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

- `/balance` — SOL balance of the hot wallet
- `/buy <mint> <sol_amount> [slippage_bps]` — market buy via Jupiter
- `/sell <mint> <percent> [slippage_bps]` — sell a % of your holding of `mint`
- `/snipe on` / `/snipe off` — start/stop the auto-snipe engine

## ⚠️ Before you turn /snipe on

The rug/forensics checks (mint & freeze authority, bundler/sniper detection,
deployer rug history) live in the `meme-scanner` repo and are **not wired
into this bot yet** — that's Phase 4. Right now `/snipe on` fires on any
pump.fun launch that clears a basic liquidity threshold
(`SNIPE_MIN_LIQUIDITY_SOL`), nothing more. Keep `SNIPE_BUY_SOL` at a
throwaway amount until Phase 4 is in.
