import { config } from "../config.js";
import { getPaperPortfolioReport, executeManualTrade } from "../execution/trade.js";
import { getPortfolioSnapshot } from "../paper/portfolio.js";
import { SOL_MINT } from "../execution/jupiter.js";

/**
 * Sells are never gated by risk checks or the kill switch — you already
 * hold the token, and the whole point of this engine is getting OUT of
 * positions. See risk/killswitch.js for the same reasoning applied there.
 *
 * REAL-MODE GAP, STATED PLAINLY: this only manages paper positions right
 * now. Managing real holdings would need enumerating actual SPL token
 * accounts in the wallet (connection.getParsedTokenAccountsByOwner) rather
 * than reading the paper portfolio file, and that path has had zero live
 * testing — unlike everything else in this bot, which was verified against
 * real chain data before shipping. Don't turn /exits on expecting it to
 * manage real positions until that's built and tested; right now it's a
 * no-op in live mode, not partially-working. Build it when you're actually
 * that close to going live, not before.
 */
export const exitConfig = {
  takeProfitPct: Number(process.env.EXIT_TAKE_PROFIT_PCT ?? 60),
  stopLossPct: Number(process.env.EXIT_STOP_LOSS_PCT ?? 35),
  // Pump.fun moves fast in the first minutes — this is a backstop for
  // "neither target hit, but don't just hold forever," not a claim that
  // 5 minutes is the right number. Tune it once you have real data on how
  // your positions actually move over time; this is a starting point.
  maxHoldSeconds: Number(process.env.EXIT_MAX_HOLD_SECONDS ?? 300),
  checkIntervalSeconds: Number(process.env.EXIT_CHECK_INTERVAL_SECONDS ?? 15),
  sellSlippageBps: Number(process.env.EXIT_SLIPPAGE_BPS ?? 500),
};

let enabled = false;
let intervalHandle = null;
let scanning = false; // prevents overlapping scans if one run takes longer than the interval

function decideExit(position, openedAt) {
  if (position.unrealizedPnlLamports === null) return null; // no route this cycle — try again next scan

  const costBasis = Number(position.costBasisLamports);
  if (costBasis === 0) return null;
  const pnlPct = (Number(position.unrealizedPnlLamports) / costBasis) * 100;
  const ageSeconds = openedAt ? (Date.now() - openedAt) / 1000 : 0;

  if (pnlPct >= exitConfig.takeProfitPct) {
    return { reason: "take-profit", pnlPct };
  }
  if (pnlPct <= -exitConfig.stopLossPct) {
    return { reason: "stop-loss", pnlPct };
  }
  if (ageSeconds >= exitConfig.maxHoldSeconds) {
    return { reason: "max-hold-time", pnlPct };
  }
  return null;
}

async function scanOnce(onEvent) {
  if (scanning) return; // last scan still running (e.g. many positions, or a slow RPC) — skip, don't stack up
  scanning = true;
  try {
    if (!config.paperTrading) return; // see REAL-MODE GAP above

    const report = await getPaperPortfolioReport();
    const snap = getPortfolioSnapshot(); // for openedAt, not included in the report itself

    for (const position of report.positions) {
      const openedAt = snap.holdings[position.mint]?.openedAt ?? null;
      const exit = decideExit(position, openedAt);
      if (!exit) continue;

      try {
        const result = await executeManualTrade({
          inputMint: position.mint,
          outputMint: SOL_MINT,
          amount: Number(position.amount),
          slippageBps: exitConfig.sellSlippageBps,
        });
        onEvent?.({ type: "exit", mint: position.mint, reason: exit.reason, pnlPct: exit.pnlPct, result });
      } catch (err) {
        onEvent?.({ type: "exit_error", mint: position.mint, reason: exit.reason, error: err.message });
      }
    }
  } catch (err) {
    onEvent?.({ type: "scan_error", error: err.message });
  } finally {
    scanning = false;
  }
}

export function startExitEngine(onEvent) {
  if (enabled) return;
  enabled = true;
  intervalHandle = setInterval(() => scanOnce(onEvent), exitConfig.checkIntervalSeconds * 1000);
  scanOnce(onEvent); // don't wait a full interval for the first check
}

export function stopExitEngine() {
  enabled = false;
  clearInterval(intervalHandle);
  intervalHandle = null;
}

export function isExitEngineRunning() {
  return enabled;
}
