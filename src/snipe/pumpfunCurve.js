import { createRequire } from "module";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import { connection } from "../rpc/connection.js";

// @pump-fun/pump-sdk pulls in @pump-fun/agent-payments-sdk, whose ESM build
// does `import { BN } from "@coral-xyz/anchor"` — a named import Node's ESM
// loader can't resolve from anchor's CJS build (confirmed by testing: a
// plain `import` of this package throws "Named export 'BN' not found"
// before any of our own code even runs). Loading it via createRequire
// instead routes resolution through Node's CommonJS loader, which handles
// it fine — verified directly, not assumed.
const require = createRequire(import.meta.url);
const { PumpSdk, OnlinePumpSdk, getBuyTokenAmountFromSolAmount, getSellSolAmountFromTokenAmount } = require("@pump-fun/pump-sdk");

/**
 * WHY THIS FILE EXISTS: Jupiter's aggregator only routes through pools it
 * has indexed, and a pump.fun bonding curve at the moment of creation isn't
 * indexed yet — every quote attempt returns "The token ... is not tradable"
 * (confirmed against production logs; this is a widely-documented Jupiter
 * limitation, not something specific to this bot). Every real pump.fun
 * sniper buys directly against the bonding-curve program instead, for
 * exactly this reason, and only falls back to an aggregator once a token
 * migrates to Raydium/PumpSwap. This file is that direct path, built on the
 * official @pump-fun/pump-sdk rather than hand-rolled instruction bytes.
 *
 * TWO CLASSES, ON PURPOSE: the SDK splits RPC-reading (OnlinePumpSdk) from
 * pure offline instruction-building (PumpSdk, which takes no connection at
 * all) — confirmed against the actual installed package, not just its
 * docs, since the docs examples online mix versions where this wasn't
 * split yet.
 *
 * ASSUMPTION WORTH KNOWING: this assumes the mint is a standard SPL Token
 * (TOKEN_PROGRAM_ID), true for the overwhelming majority of pump.fun
 * launches. A Token-2022 mint (rare, used for some quote-control
 * configurations) would need dynamic detection this doesn't do.
 */

const onlineSdk = new OnlinePumpSdk(connection);
const offlineSdk = new PumpSdk();

// A stalled network call with no timeout blocks whatever awaits it
// indefinitely — confirmed this happening: /portfolio looped over
// positions sequentially, and one hung RPC/Jupiter call froze the whole
// command with no way out short of restarting. Every fetch-based call in
// this file goes through this wrapper now.
// 20s, not 10s — a call can legitimately sit in the RPC rate limiter's
// queue for a while under real combined load (active sniping + exit scans
// sharing one budget), and that's fine as long as it eventually resolves.
// The bug this fixes: a 10s timeout was shorter than realistic queue wait
// under load, so queued-but-fine calls got treated as failures — not the
// RPC actually being slow. Bounding each scan's own footprint (see
// exit/engine.js's maxPositionsPerScan) is the real fix for the demand
// side; this is headroom on the timeout side for whatever's left over.
const RPC_CALL_TIMEOUT_MS = 20_000;
function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${RPC_CALL_TIMEOUT_MS}ms`)), RPC_CALL_TIMEOUT_MS)
    ),
  ]);
}

// Global and FeeConfig are program-wide settings, not per-token — they
// almost never change and were being re-fetched on every single candidate,
// doubling the RPC calls each snipe attempt needed for no benefit. Cached
// with a short TTL so a real change (rare) still picks up within a minute,
// but the common case costs zero extra RPC calls.
const CACHE_TTL_MS = 60_000;
let globalCache = null;
let feeConfigCache = null;
let cachedAt = 0;

async function getCachedGlobalAndFeeConfig() {
  const age = Date.now() - cachedAt;
  if (globalCache && feeConfigCache && age < CACHE_TTL_MS) {
    return { global: globalCache, feeConfig: feeConfigCache };
  }
  const [global, feeConfig] = await Promise.all([
    withTimeout(onlineSdk.fetchGlobal(), "fetchGlobal"),
    withTimeout(onlineSdk.fetchFeeConfig(), "fetchFeeConfig"),
  ]);
  globalCache = global;
  feeConfigCache = feeConfig;
  cachedAt = Date.now();
  return { global, feeConfig };
}

/**
 * Builds the instructions for a bonding-curve buy, or reports that the
 * curve has already completed (graduated) — in which case the caller
 * should fall back to Jupiter instead, since a graduated token IS
 * routable there.
 *
 * Returns either { graduated: true } or
 * { graduated: false, instructions, expectedTokenAmount } where
 * expectedTokenAmount is a BN of raw token units, computed from the same
 * bonding-curve math the on-chain program uses — usable for paper-mode
 * simulation without needing a Jupiter quote at all.
 */
export async function getPumpFunBuyPlan({ mint, user, solLamports, slippageBps }) {
  const [{ global, feeConfig }, buyState] = await Promise.all([
    getCachedGlobalAndFeeConfig(),
    withTimeout(onlineSdk.fetchBuyState(mint, user, TOKEN_PROGRAM_ID), "fetchBuyState"),
  ]);

  if (buyState.bondingCurve.complete) {
    return { graduated: true };
  }

  const solAmountBN = new BN(solLamports.toString());

  const expectedTokenAmount = getBuyTokenAmountFromSolAmount({
    global,
    feeConfig,
    mintSupply: buyState.bondingCurve.tokenTotalSupply,
    bondingCurve: buyState.bondingCurve,
    amount: solAmountBN,
    quoteMint: buyState.quoteMint,
  });

  const instructions = await offlineSdk.buyInstructions({
    global,
    bondingCurveAccountInfo: buyState.bondingCurveAccountInfo,
    bondingCurve: buyState.bondingCurve,
    associatedUserAccountInfo: buyState.associatedUserAccountInfo,
    mint,
    user,
    amount: expectedTokenAmount,
    solAmount: solAmountBN,
    slippage: slippageBps / 100, // SDK takes a percent (e.g. 5 = 5%), we track bps
    tokenProgram: TOKEN_PROGRAM_ID,
  });

  return { graduated: false, instructions, expectedTokenAmount };
}

/**
 * Values a held position against the live bonding curve — "what would
 * selling this whole amount right now actually get", using the same math
 * the on-chain program uses. This is what /portfolio needs for unrealized
 * PnL on pre-graduation positions: Jupiter can't quote these (same reason
 * it can't route buys — see the top of this file), so pricing them via
 * Jupiter always returned "no route" for exactly the tokens this bot
 * actually holds. Returns { graduated: true } if the curve has completed
 * (caller should price it via Jupiter instead, since it's routable there
 * by then), or { graduated: false, solLamports } otherwise.
 */
export async function getPumpFunSellValue({ mint, user, tokenAmount }) {
  const [{ global, feeConfig }, sellState] = await Promise.all([
    getCachedGlobalAndFeeConfig(),
    withTimeout(onlineSdk.fetchSellState(mint, user, TOKEN_PROGRAM_ID), "fetchSellState"),
  ]);

  if (sellState.bondingCurve.complete) {
    return { graduated: true };
  }

  const solLamports = getSellSolAmountFromTokenAmount({
    global,
    feeConfig,
    mintSupply: sellState.bondingCurve.tokenTotalSupply,
    bondingCurve: sellState.bondingCurve,
    amount: new BN(tokenAmount.toString()),
  });

  return { graduated: false, solLamports };
}
