import { config } from "../config.js";
import { valuePosition, executeManualTrade } from "../execution/trade.js";
import { getPortfolioSnapshot } from "../paper/portfolio.js";
import { getKeypair } from "../wallet/keypair.js";
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
  // Caps this engine's own RPC footprint to a small constant per scan,
  // REGARDLESS of how many positions the portfolio has grown to. Without
  // this, every position sniping adds also adds to what every single exit
  // scan has to check — unbounded growth against a fixed RPC budget. This
  // was confirmed as the actual cause of a 100%-"no route" /portfolio
  // report: 23 positions all valued at once, competing with active
  // sniping for the same rate-limited connection, queued long enough to
  // exceed the per-call timeout before ever reaching the network — not a
  // real RPC failure, a self-inflicted one from unbounded demand. Positions
  // are checked in rotation, a bounded number per scan, so every position
  // still gets evaluated regularly even as the portfolio grows — it just
  // takes more scan cycles to cycle through all of them.
  maxPositionsPerScan: Number(process.env.EXIT_MAX_POSITIONS_PER_SCAN ?? 6),
};

let enabled = false;
let intervalHandle = null;
let scanning = false; // prevents overlapping scans if one run takes longer than the interval
let rotationCursor = 0; // where the next scan resumes in the position list

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

/** Picks up to maxPositionsPerScan entries starting at the rotation cursor, wrapping around. */
function pickNextBatch(mints) {
  if (mints.length === 0) return [];
  if (rotationCursor >= mints.length) rotationCursor = 0;

  const batch = [];
  let i = rotationCursor;
  for (let count = 0; count < Math.min(exitConfig.maxPositionsPerScan, mints.length); count++) {
    batch.push(mints[i]);
    i = (i + 1) % mints.length;
  }
  rotationCursor = i;
  return batch;
}

async function scanOnce(onEvent) {
  if (scanning) return; // last scan still running — skip, don't stack up
  scanning = true;
  try {
    if (!config.paperTrading) return; // see REAL-MODE GAP above

    const snap = getPortfolioSnapshot();
    const openMints = Object.keys(snap.holdings).filter((m) => snap.holdings[m].amount !== "0");
    const batch = pickNextBatch(openMints);
    if (batch.length === 0) return;

    const userPubkey = getKeypair().publicKey;
    const valued = await Promise.all(
      batch.map((mint) => valuePosition(mint, snap.holdings[mint], userPubkey))
    );

    for (const position of valued) {
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
  rotationCursor = 0;
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
