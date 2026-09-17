import { listenForNewTokens } from "./pumpportal.js";
import { passesBasicFilter } from "./filters.js";
import { executeSnipeBuy } from "../execution/trade.js";

const engineConfig = {
  buySol: Number(process.env.SNIPE_BUY_SOL ?? 0.05),
  tipLamports: Number(process.env.SNIPE_TIP_LAMPORTS ?? 100_000), // 0.0001 SOL
  slippageBps: Number(process.env.SNIPE_SLIPPAGE_BPS ?? 500), // wide — new pools move fast
  // Max candidates processed concurrently. Each one fires several RPC calls
  // (mint authority check, bonding-curve state fetch). PumpPortal can push
  // many creates within the same second, and with no cap here every single
  // one spawned its own concurrent chain of RPC calls — that's what was
  // actually blowing through Helius's free-tier 10 req/s limit, not the
  // limit being too low. A candidate arriving while we're at capacity is
  // dropped, not queued: by the time a queued candidate's turn came up, the
  // snipe window would already be gone, so queueing would just mean
  // spending RPC budget on stale opportunities instead of live ones.
  maxConcurrent: Number(process.env.SNIPE_MAX_CONCURRENT ?? 2),
};

let listenerHandle = null;
let enabled = false;
let inFlight = 0;
let droppedWhileBusy = 0;

async function handleCandidate(token, onEvent) {
  if (!passesBasicFilter(token)) return;

  if (inFlight >= engineConfig.maxConcurrent) {
    droppedWhileBusy++;
    return;
  }

  // Mint/freeze authority checks, spend/slippage/price-impact limits, the
  // kill switch, and the deployer repeat-launch check (if Supabase is
  // configured) all run inside executeSnipeBuy -> risk/gate.js before any
  // spend happens. Same-block bundler/sniper detection is still not
  // available — see README for why.

  inFlight++;
  onEvent?.({ type: "candidate", token });

  try {
    const lamports = Math.round(engineConfig.buySol * 1e9);

    const { paper, bundleId, quote, curveNative } = await executeSnipeBuy({
      mint: token.mint,
      solLamports: lamports,
      slippageBps: engineConfig.slippageBps,
      tipLamports: engineConfig.tipLamports,
      deployerAddress: token.traderPublicKey,
    });

    onEvent?.({ type: "bundle_sent", token, bundleId, paper, quote, curveNative });
  } catch (err) {
    onEvent?.({ type: "error", token, error: err.message });
  } finally {
    inFlight--;
  }
}

/**
 * Starts the snipe engine. onEvent gets called with candidate/bundle_sent/
 * error events so the bot layer can relay them to Telegram. No-op if
 * already running.
 */
export function startSnipeEngine(onEvent) {
  if (enabled) return;
  enabled = true;
  inFlight = 0;
  droppedWhileBusy = 0;
  listenerHandle = listenForNewTokens((token) => {
    if (!enabled) return; // stopped between subscribe and message arriving
    handleCandidate(token, onEvent);
  });
}

export function stopSnipeEngine() {
  enabled = false;
  listenerHandle?.close();
  listenerHandle = null;
}

export function isSnipeEngineRunning() {
  return enabled;
}

/** How many candidates were skipped because maxConcurrent was already busy. */
export function getDroppedWhileBusyCount() {
  return droppedWhileBusy;
}
