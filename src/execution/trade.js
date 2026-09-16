import { config } from "../config.js";
import { getQuote, getSignedSwapTransaction, executeSwap, SOL_MINT } from "./jupiter.js";
import { simulateFill } from "../paper/portfolio.js";
import { buildTipTransaction, getRandomTipAccount, sendBundle } from "../snipe/jito.js";
import { getKeypair } from "../wallet/keypair.js";

/**
 * Manual buy/sell path (/buy, /sell). Paper mode: quote + simulate, no
 * signing. Real mode: normal RPC send via executeSwap.
 */
export async function executeManualTrade({ inputMint, outputMint, amount, slippageBps }) {
  if (config.paperTrading) {
    const quote = await getQuote({ inputMint, outputMint, amount, slippageBps });
    if (!quote || quote.error) {
      throw new Error(`No route: ${quote?.error ?? "unknown error"}`);
    }
    const { isBuy, tokenMint } = simulateFill({
      inputMint,
      outputMint,
      inAmount: BigInt(quote.inAmount),
      outAmount: BigInt(quote.outAmount),
      solMint: SOL_MINT,
    });
    return { paper: true, signature: null, quote, isBuy, tokenMint };
  }

  const { signature, quote } = await executeSwap({ inputMint, outputMint, amount, slippageBps });
  return { paper: false, signature, quote, isBuy: inputMint === SOL_MINT, tokenMint: inputMint === SOL_MINT ? outputMint : inputMint };
}

/**
 * Snipe-engine buy path. Paper mode: same simulation as manual trades, no
 * websocket-to-wallet latency to worry about since nothing is actually
 * signed. Real mode: signed swap tx + Jito tip bundled together, as before.
 */
export async function executeSnipeBuy({ mint, solLamports, slippageBps, tipLamports }) {
  if (config.paperTrading) {
    const quote = await getQuote({
      inputMint: SOL_MINT,
      outputMint: mint,
      amount: solLamports,
      slippageBps,
    });
    if (!quote || quote.error) {
      throw new Error(`No route: ${quote?.error ?? "unknown error"}`);
    }
    simulateFill({
      inputMint: SOL_MINT,
      outputMint: mint,
      inAmount: BigInt(quote.inAmount),
      outAmount: BigInt(quote.outAmount),
      solMint: SOL_MINT,
    });
    return { paper: true, bundleId: null, quote };
  }

  const keypair = getKeypair();
  const { tx: swapTx, quote } = await getSignedSwapTransaction({
    inputMint: SOL_MINT,
    outputMint: mint,
    amount: solLamports,
    slippageBps,
    skipPriorityFee: true,
  });

  const tipAccount = await getRandomTipAccount();
  const tipTx = await buildTipTransaction(keypair, tipAccount, tipLamports);
  const bundleId = await sendBundle([swapTx, tipTx]);

  return { paper: false, bundleId, quote };
}
