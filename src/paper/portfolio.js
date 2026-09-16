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
    // mint -> { amount: raw token units held, costBasisLamports: SOL spent
    // acquiring the currently-held amount, weighted-average style }
    holdings: {},
    realizedPnlLamports: "0", // cumulative, from closed portions of trades
    trades: [], // append-only log for /portfolio and later review
  };
}

function load() {
  if (!fs.existsSync(PORTFOLIO_FILE)) return freshState();
  try {
    const parsed = JSON.parse(fs.readFileSync(PORTFOLIO_FILE, "utf8"));
    // migrate old shape (holdings[mint] was a plain amount string) if present
    for (const [mint, value] of Object.entries(parsed.holdings ?? {})) {
      if (typeof value === "string") {
        parsed.holdings[mint] = { amount: value, costBasisLamports: "0" };
      }
    }
    parsed.realizedPnlLamports ??= "0";
    return parsed;
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

function getPosition(mint) {
  return state.holdings[mint] ?? { amount: "0", costBasisLamports: "0" };
}

export function getSolBalanceLamports() {
  return BigInt(state.solLamports);
}

export function getTokenHolding(mint) {
  return BigInt(getPosition(mint).amount);
}

export function getRealizedPnlLamports() {
  return BigInt(state.realizedPnlLamports);
}

/**
 * Records a simulated fill using real Jupiter quote amounts, so the
 * simulated price/slippage matches what a real trade would have gotten.
 * One of inputMint/outputMint must be SOL. Tracks weighted-average cost
 * basis per mint and realizes PnL on the portion sold.
 */
export function simulateFill({ inputMint, outputMint, inAmount, outAmount, solMint }) {
  const isBuy = inputMint === solMint;
  const tokenMint = isBuy ? outputMint : inputMint;
  const pos = getPosition(tokenMint);
  let realizedThisTrade = 0n;

  if (isBuy) {
    const sol = getSolBalanceLamports();
    if (sol < inAmount) {
      throw new Error(`Simulated balance too low: have ${sol}, need ${inAmount} lamports`);
    }
    state.solLamports = String(sol - inAmount);
    state.holdings[tokenMint] = {
      amount: String(BigInt(pos.amount) + outAmount),
      costBasisLamports: String(BigInt(pos.costBasisLamports) + inAmount),
    };
  } else {
    const held = BigInt(pos.amount);
    if (held < inAmount) {
      throw new Error(`Simulated holding too low: have ${held}, need ${inAmount} of ${tokenMint}`);
    }
    const costBasis = BigInt(pos.costBasisLamports);
    // Weighted-average cost basis attributable to the portion being sold.
    const costBasisSold = held === 0n ? 0n : (costBasis * inAmount) / held;
    realizedThisTrade = outAmount - costBasisSold;

    state.holdings[tokenMint] = {
      amount: String(held - inAmount),
      costBasisLamports: String(costBasis - costBasisSold),
    };
    state.solLamports = String(getSolBalanceLamports() + outAmount);
    state.realizedPnlLamports = String(getRealizedPnlLamports() + realizedThisTrade);
  }

  state.trades.push({
    at: new Date().toISOString(),
    side: isBuy ? "buy" : "sell",
    mint: tokenMint,
    inAmount: String(inAmount),
    outAmount: String(outAmount),
    realizedPnlLamports: isBuy ? null : String(realizedThisTrade),
  });

  persist();
  return { isBuy, tokenMint, realizedPnlLamports: realizedThisTrade };
}

export function resetPortfolio() {
  state = freshState();
  persist();
}

/**
 * Raw snapshot — no network calls, no current pricing. holdings[mint] has
 * amount + costBasisLamports but NOT current value or unrealized PnL; see
 * getPaperPortfolioReport in execution/trade.js for that (it needs a live
 * quote per holding).
 */
export function getPortfolioSnapshot() {
  return {
    solLamports: state.solLamports,
    holdings: JSON.parse(JSON.stringify(state.holdings)),
    realizedPnlLamports: state.realizedPnlLamports,
    tradeCount: state.trades.length,
  };
}
