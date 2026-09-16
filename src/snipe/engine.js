import { getKeypair } from "../wallet/keypair.js";
import { getSignedSwapTransaction, SOL_MINT } from "../execution/jupiter.js";
import { listenForNewTokens } from "./pumpportal.js";
import { passesBasicFilter } from "./filters.js";
import { buildTipTransaction, getRandomTipAccount, sendBundle } from "./jito.js";

const engineConfig = {
  buySol: Number(process.env.SNIPE_BUY_SOL ?? 0.05),
  tipLamports: Number(process.env.SNIPE_TIP_LAMPORTS ?? 100_000), // 0.0001 SOL
  slippageBps: Number(process.env.SNIPE_SLIPPAGE_BPS ?? 500), // wide — new pools move fast
};

let listenerHandle = null;
let enabled = false;

async function handleCandidate(token, onEvent) {
  if (!passesBasicFilter(token)) return;

  // NOTE: this is the point where Phase 4's rug/forensics checks belong —
  // mint/freeze authority, bundler/sniper detection, deployer rug history.
  // Right now this fires on anything that clears the basic liquidity bar.
  // Do not raise buySol above throwaway-test amounts until that's wired in.

  onEvent?.({ type: "candidate", token });

  try {
    const keypair = getKeypair();
    const lamports = Math.round(engineConfig.buySol * 1e9);

    const { tx: swapTx } = await getSignedSwapTransaction({
      inputMint: SOL_MINT,
      outputMint: token.mint,
      amount: lamports,
      slippageBps: engineConfig.slippageBps,
      skipPriorityFee: true, // Jito tip replaces this
    });

    const tipAccount = await getRandomTipAccount();
    const tipTx = await buildTipTransaction(
      keypair,
      tipAccount,
      engineConfig.tipLamports
    );

    const bundleId = await sendBundle([swapTx, tipTx]);
    onEvent?.({ type: "bundle_sent", token, bundleId });
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
