import { config } from "../config.js";
import { getQuote, getSignedSwapTransaction, executeSwap, SOL_MINT } from "./jupiter.js";
import { simulateFill, getPortfolioSnapshot } from "../paper/portfolio.js";
import { buildTipTransaction, getRandomTipAccount, sendBundle } from "../snipe/jito.js";
import { getPumpFunBuyPlan, getPumpFunSellValue } from "../snipe/pumpfunCurve.js";
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
 * Values one held position: current sale value + unrealized PnL vs cost
 * basis. Pulled out of getPaperPortfolioReport so positions can be valued
 * in parallel rather than one at a time — the RPC rate limiter is already
 * the real throughput ceiling (see rpc/connection.js), so serializing on
 * top of it in this loop was just adding wait time for nothing. Each
 * network call inside here has its own timeout (jupiter.js, pumpfunCurve.js)
 * so one stuck lookup can't block the others or hang the whole report.
 */
async function valuePosition(mint, pos, userPubkey) {
  let currentValueLamports = null;

  // Try the bonding curve directly first — this is what actually holds
  // for everything bought via the curve-native snipe path, and Jupiter
  // will reliably return "no route" for all of them until graduation
  // (same reason it can't route buys). Only fall back to Jupiter if the
  // curve reports graduated, or if the curve lookup itself fails for
  // some other reason (e.g. dust amount too small to matter).
  try {
    const mintPubkey = new PublicKey(mint);
    const curveValue = await getPumpFunSellValue({
      mint: mintPubkey,
      user: userPubkey,
      tokenAmount: BigInt(pos.amount),
    });

    if (curveValue.graduated) {
      // Graduated — it's an ordinary Raydium/PumpSwap token now, Jupiter routes it fine.
      const quote = await getQuote({
        inputMint: mint,
        outputMint: SOL_MINT,
        amount: pos.amount,
        slippageBps: 100,
      });
      if (quote && !quote.error) currentValueLamports = BigInt(quote.outAmount);
    } else {
      currentValueLamports = BigInt(curveValue.solLamports.toString());
    }
  } catch {
    // Curve lookup failed outright (not just "graduated") — try Jupiter
    // as a last resort in case this position somehow is routable there.
    try {
      const quote = await getQuote({
        inputMint: mint,
        outputMint: SOL_MINT,
        amount: pos.amount,
        slippageBps: 100,
      });
      if (quote && !quote.error) currentValueLamports = BigInt(quote.outAmount);
    } catch {
      // genuinely no route either way — leave null, shown as "no route"
    }
  }

  const costBasisLamports = BigInt(pos.costBasisLamports);
  return {
    mint,
    amount: pos.amount,
    costBasisLamports: pos.costBasisLamports,
    currentValueLamports: currentValueLamports?.toString() ?? null,
    unrealizedPnlLamports:
      currentValueLamports === null ? null : String(currentValueLamports - costBasisLamports),
  };
}

/**
 * Full paper portfolio report including unrealized PnL. Values every open
 * position in parallel (see valuePosition above for why) and returns once
 * they've all settled — a position whose lookup fails or times out shows
 * as "no route" rather than blocking the rest of the report.
 */
export async function getPaperPortfolioReport() {
  const snap = getPortfolioSnapshot();
  const userPubkey = getKeypair().publicKey;

  const openHoldings = Object.entries(snap.holdings).filter(([, pos]) => pos.amount !== "0");
  const positions = await Promise.all(
    openHoldings.map(([mint, pos]) => valuePosition(mint, pos, userPubkey))
  );

  return {
    solLamports: snap.solLamports,
    realizedPnlLamports: snap.realizedPnlLamports,
    tradeCount: snap.tradeCount,
    positions,
  };
}
