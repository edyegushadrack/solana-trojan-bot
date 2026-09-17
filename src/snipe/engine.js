import { listenForNewTokens } from "./pumpportal.js";
import { passesBasicFilter } from "./filters.js";
import { executeSnipeBuy } from "../execution/trade.js";

const engineConfig = {
  buySol: Number(process.env.SNIPE_BUY_SOL ?? 0.05),
  tipLamports: Number(process.env.SNIPE_TIP_LAMPORTS ?? 100_000), // 0.0001 SOL
  slippageBps: Number(process.env.SNIPE_SLIPPAGE_BPS ?? 500), // wide — new pools move fast
};

let listenerHandle = null;
let enabled = false;

async function handleCandidate(token, onEvent) {
  if (!passesBasicFilter(token)) return;

  // Mint/freeze authority checks, spend/slippage/price-impact limits, the
  // kill switch, and the deployer repeat-launch check (if Supabase is
  // configured) all run inside executeSnipeBuy -> risk/gate.js before any
  // spend happens. Same-block bundler/sniper detection is still not
  // available — see README for why.

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
