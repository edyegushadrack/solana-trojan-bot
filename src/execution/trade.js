import { config } from "../config.js";
import { getQuote, getSignedSwapTransaction, executeSwap, SOL_MINT } from "./jupiter.js";
import { simulateFill, getPortfolioSnapshot } from "../paper/portfolio.js";
import { buildTipTransaction, getRandomTipAccount, sendBundle } from "../snipe/jito.js";
import { getPumpFunBuyPlan } from "../snipe/pumpfunCurve.js";
import { getKeypair } from "../wallet/keypair.js";
import { runRiskGate } from "../risk/gate.js";
import { enforceSpendLimit, enforceSlippageLimit, enforcePriceImpact } from "../risk/limits.js";
import { connection } from "../rpc/connection.js";
import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

/**
 * Manual buy/sell path (/buy, /sell). One quote is fetched up front and
 * reused for the risk checks AND the actual fill/send, so the checks see
 * exactly the trade that's about to happen. Buys go through the full risk
 * gate (limits + mint/freeze authority + kill switch); sells don't — see
 * risk/killswitch.js for why sells are never blocked.
 */
export async function executeManualTrade({ inputMint, outputMint, amount, slippageBps }) {
  const isBuy = inputMint === SOL_MINT;
  const mint = isBuy ? outputMint : inputMint;

  if (isBuy) enforceSpendLimit(amount / 1e9);
  enforceSlippageLimit(slippageBps);

  const quote = await getQuote({ inputMint, outputMint, amount, slippageBps });
  if (!quote || quote.error) {
    throw new Error(`No route: ${quote?.error ?? "unknown error"}`);
  }
  enforcePriceImpact(quote);

  if (isBuy) {
    const gate = await runRiskGate(mint);
    if (!gate.passed) {
      throw new Error(`Risk gate blocked buy: ${gate.reasons.join("; ")}`);
    }
  }

  if (config.paperTrading) {
    const { isBuy: filledBuy, tokenMint } = simulateFill({
      inputMint,
      outputMint,
      inAmount: BigInt(quote.inAmount),
      outAmount: BigInt(quote.outAmount),
      solMint: SOL_MINT,
    });
    return { paper: true, signature: null, quote, isBuy: filledBuy, tokenMint };
  }

  const { signature } = await executeSwap({ inputMint, outputMint, amount, slippageBps, quote });
  return { paper: false, signature, quote, isBuy, tokenMint: mint };
}

/**
 * Snipe-engine buy path — always a buy, so always goes through the full
 * risk gate. Pass deployerAddress (PumpPortal's traderPublicKey on the
 * create event) to also run the deployer repeat-launch check.
 *
 * Tries the pump.fun bonding-curve program directly FIRST (see
 * snipe/pumpfunCurve.js for why: Jupiter doesn't index fresh launches).
 * Only falls back to Jupiter if the curve has already completed
 * (graduated) — at that point it's the same as any other established
 * token and Jupiter is the right tool again.
 */
export async function executeSnipeBuy({ mint, solLamports, slippageBps, tipLamports, deployerAddress }) {
  enforceSpendLimit(solLamports / 1e9);
  enforceSlippageLimit(slippageBps);

  const gate = await runRiskGate(mint, { deployerAddress });
  if (!gate.passed) {
    throw new Error(`Risk gate blocked snipe: ${gate.reasons.join("; ")}`);
  }

  const keypair = getKeypair();
  const mintPubkey = new PublicKey(mint);

  const plan = await getPumpFunBuyPlan({
    mint: mintPubkey,
    user: keypair.publicKey,
    solLamports,
    slippageBps,
  });

  if (!plan.graduated) {
    // --- Curve-native path: pre-graduation, buy directly against pump.fun ---
    // A synthetic quote-shaped object (matching Jupiter's inAmount/outAmount
    // fields) so callers displaying event.quote don't need a separate code
    // path for curve-native fills — the numbers are still real, just from
    // bonding-curve math instead of a Jupiter quote.
    const syntheticQuote = {
      inAmount: String(solLamports),
      outAmount: plan.expectedTokenAmount.toString(),
    };

    if (config.paperTrading) {
      simulateFill({
        inputMint: SOL_MINT,
        outputMint: mint,
        inAmount: BigInt(solLamports),
        outAmount: BigInt(plan.expectedTokenAmount.toString()),
        solMint: SOL_MINT,
      });
      return { paper: true, bundleId: null, quote: syntheticQuote, curveNative: true };
    }

    const { blockhash } = await connection.getLatestBlockhash();
    const message = new TransactionMessage({
      payerKey: keypair.publicKey,
      recentBlockhash: blockhash,
      instructions: [
        // Curve buys + first-time ATA creation need more than the 200k
        // default compute limit; 300k covers it with headroom.
        ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
        ...plan.instructions,
      ],
    }).compileToV0Message();
    const swapTx = new VersionedTransaction(message);
    swapTx.sign([keypair]);

    const tipAccount = await getRandomTipAccount();
    const tipTx = await buildTipTransaction(keypair, tipAccount, tipLamports);
    const bundleId = await sendBundle([swapTx, tipTx]);

    return { paper: false, bundleId, quote: syntheticQuote, curveNative: true };
  }

  // --- Fallback: curve already graduated, this is now an ordinary Jupiter-routable token ---
  const quote = await getQuote({
    inputMint: SOL_MINT,
    outputMint: mint,
    amount: solLamports,
    slippageBps,
  });
  if (!quote || quote.error) {
    throw new Error(`No route: ${quote?.error ?? "unknown error"}`);
  }
  enforcePriceImpact(quote);

  if (config.paperTrading) {
    simulateFill({
      inputMint: SOL_MINT,
      outputMint: mint,
      inAmount: BigInt(quote.inAmount),
      outAmount: BigInt(quote.outAmount),
      solMint: SOL_MINT,
    });
    return { paper: true, bundleId: null, quote, curveNative: false };
  }

  const { tx: swapTx } = await getSignedSwapTransaction({
    inputMint: SOL_MINT,
    outputMint: mint,
    amount: solLamports,
    slippageBps,
    skipPriorityFee: true,
    quote,
  });

  const tipAccount = await getRandomTipAccount();
  const tipTx = await buildTipTransaction(keypair, tipAccount, tipLamports);
  const bundleId = await sendBundle([swapTx, tipTx]);

  return { paper: false, bundleId, quote, curveNative: false };
}

/**
 * Full paper portfolio report including unrealized PnL — for each open
 * position, gets a fresh Jupiter quote for "sell it all right now" and
 * compares that to cost basis. This is a live estimate, not the price
 * you'd actually get selling that exact amount (slippage on the real sell
 * may differ slightly), but it's the same mechanism a real sell would use.
 */
export async function getPaperPortfolioReport() {
  const snap = getPortfolioSnapshot();
  const positions = [];

  for (const [mint, pos] of Object.entries(snap.holdings)) {
    if (pos.amount === "0") continue;

    let currentValueLamports = null;
    try {
      const quote = await getQuote({
        inputMint: mint,
        outputMint: SOL_MINT,
        amount: pos.amount,
        slippageBps: 100,
      });
      if (quote && !quote.error) currentValueLamports = BigInt(quote.outAmount);
    } catch {
      // no route right now — likely too illiquid or too new; leave null
    }

    const costBasisLamports = BigInt(pos.costBasisLamports);
    positions.push({
      mint,
      amount: pos.amount,
      costBasisLamports: pos.costBasisLamports,
      currentValueLamports: currentValueLamports?.toString() ?? null,
      unrealizedPnlLamports:
        currentValueLamports === null ? null : String(currentValueLamports - costBasisLamports),
    });
  }

  return {
    solLamports: snap.solLamports,
    realizedPnlLamports: snap.realizedPnlLamports,
    tradeCount: snap.tradeCount,
    positions,
  };
}
