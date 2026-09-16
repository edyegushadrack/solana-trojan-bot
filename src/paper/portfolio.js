import fs from "fs";
import path from "path";
import { config } from "../config.js";

const DATA_DIR = path.resolve("data");
const PORTFOLIO_FILE = path.join(DATA_DIR, "paper-portfolio.json");

// All amounts stored/passed as strings-of-bigints to survive JSON
// round-tripping without precision loss. Convert to BigInt at the call site.

function freshState() {
  return {
    solLamports: String(Math.round(config.paperStartingSol * 1e9)),
    holdings: {}, // mint -> raw token amount (string)
    trades: [], // append-only log for /portfolio and later review
  };
}

function load() {
  if (!fs.existsSync(PORTFOLIO_FILE)) return freshState();
  try {
    return JSON.parse(fs.readFileSync(PORTFOLIO_FILE, "utf8"));
  } catch (err) {
    console.error("paper-portfolio.json unreadable, starting fresh:", err.message);
    return freshState();
  }
}

let state = load();

function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PORTFOLIO_FILE, JSON.stringify(state, null, 2));
}

export function getSolBalanceLamports() {
  return BigInt(state.solLamports);
}

export function getTokenHolding(mint) {
  return BigInt(state.holdings[mint] ?? "0");
}

/**
 * Records a simulated fill using real Jupiter quote amounts, so the
 * simulated price/slippage matches what a real trade would have gotten.
 * One of inputMint/outputMint must be SOL.
 */
export function simulateFill({ inputMint, outputMint, inAmount, outAmount, solMint }) {
  const isBuy = inputMint === solMint;
  const tokenMint = isBuy ? outputMint : inputMint;

  if (isBuy) {
    const sol = getSolBalanceLamports();
    if (sol < inAmount) {
      throw new Error(
        `Simulated balance too low: have ${sol}, need ${inAmount} lamports`
      );
    }
    state.solLamports = String(sol - inAmount);
    state.holdings[tokenMint] = String(getTokenHolding(tokenMint) + outAmount);
  } else {
    const held = getTokenHolding(tokenMint);
    if (held < inAmount) {
      throw new Error(
        `Simulated holding too low: have ${held}, need ${inAmount} of ${tokenMint}`
      );
    }
    state.holdings[tokenMint] = String(held - inAmount);
    state.solLamports = String(getSolBalanceLamports() + outAmount);
  }

  state.trades.push({
    at: new Date().toISOString(),
    side: isBuy ? "buy" : "sell",
    mint: tokenMint,
    inAmount: String(inAmount),
    outAmount: String(outAmount),
  });

  persist();
  return { isBuy, tokenMint };
}

export function resetPortfolio() {
  state = freshState();
  persist();
}

export function getPortfolioSnapshot() {
  return {
    solLamports: state.solLamports,
    holdings: { ...state.holdings },
    tradeCount: state.trades.length,
  };
}
