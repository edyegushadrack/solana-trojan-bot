import { Bot } from "grammy";
import { config } from "../config.js";
import { getKeypair } from "../wallet/keypair.js";
import { getSolBalance } from "../rpc/connection.js";
import { getTokenBalance } from "../wallet/balances.js";
import { SOL_MINT } from "../execution/jupiter.js";
import { executeManualTrade, getPaperPortfolioReport } from "../execution/trade.js";
import { getSolBalanceLamports, getTokenHolding, resetPortfolio } from "../paper/portfolio.js";
import {
  startSnipeEngine,
  stopSnipeEngine,
  isSnipeEngineRunning,
} from "../snipe/engine.js";
import { activateKillSwitch, deactivateKillSwitch, getKillSwitchState } from "../risk/killswitch.js";
import { riskConfig } from "../risk/limits.js";
import { deployerHistoryConfig } from "../risk/deployerHistory.js";
import { startExitEngine, stopExitEngine, isExitEngineRunning, exitConfig } from "../exit/engine.js";

const bot = new Bot(config.telegramBotToken);

// --- crash safety net --------------------------------------------------
// A rejected promise anywhere with no .catch() is an unhandled rejection,
// and modern Node kills the whole process for those by default. That's
// what was actually happening: fire-and-forget ctx.reply() calls from the
// snipe engine's event callback, with no .catch(), rejecting once Telegram
// rate-limited the chat. This is the last line of defense — queueReply
// below is the actual fix (paces sends so we don't hit that rate limit in
// the first place), but this stays regardless, since some other
// unanticipated rejection could otherwise crash the whole bot the same way.
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection (process kept alive):", err);
});

// --- paced, crash-proof Telegram sends ----------------------------------
// Telegram rate-limits messages to a single chat to roughly 1/sec
// sustained. At real pump.fun volume, sending a message per event blows
// through that fast. This queues sends and paces them, and swallows any
// send failure instead of letting it become an unhandled rejection —
// dropping a notification is fine; crashing the whole bot over one isn't.
const MIN_SEND_INTERVAL_MS = 1100;
let sendQueue = Promise.resolve();

function queueReply(ctx, text) {
  sendQueue = sendQueue
    .then(() => new Promise((resolve) => setTimeout(resolve, MIN_SEND_INTERVAL_MS)))
    .then(() => ctx.reply(text))
    .catch((err) => console.error("Telegram send failed (dropped):", err.message));
}

// --- owner-only gate -------------------------------------------------
// Single-user v1: refuse every command that isn't from your own Telegram
// account. Comes before command handlers below.
bot.use(async (ctx, next) => {
  const senderId = String(ctx.from?.id ?? "");
  if (senderId !== String(config.telegramOwnerId)) {
    return; // silently ignore — don't confirm the bot exists to anyone else
  }
  await next();
});

function modeTag() {
  return config.paperTrading ? "[PAPER]" : "[LIVE]";
}

bot.command("start", (ctx) =>
  ctx.reply(
    `Solana trading bot ready. Mode: ${modeTag()}${getKillSwitchState().active ? " ⚠️ KILL SWITCH ACTIVE" : ""}\n\n` +
      "/balance — SOL balance (paper or real, depending on mode)\n" +
      "/buy <mint> <sol_amount> [slippage_bps]\n" +
      "/sell <mint> <percent> [slippage_bps]\n" +
      "/snipe on | off\n" +
      "/exits on | off — auto take-profit/stop-loss/max-hold on open positions\n" +
      "/portfolio — paper trading positions + trade count\n" +
      "/resetpaper — wipe paper portfolio back to starting balance\n" +
      "/paper on | off — toggle simulate-only mode\n" +
      "/killswitch on | off | status — block/unblock new buys\n" +
      "/risk — show current risk limits"
  )
);

bot.command("risk", (ctx) =>
  ctx.reply(
    `Risk limits (edit via .env, restart to change):\n` +
      `  Max spend per trade: ${riskConfig.maxSpendSol} SOL\n` +
      `  Max slippage: ${riskConfig.maxSlippageBps} bps\n` +
      `  Max price impact: ${riskConfig.maxPriceImpactPct}%\n\n` +
      `Kill switch: ${getKillSwitchState().active ? "ACTIVE (buys blocked)" : "off"}\n\n` +
      `Buys also require: mint authority renounced, freeze authority renounced.\n` +
      `Deployer history: ${config.supabaseUrl ? `ON (flags >${deployerHistoryConfig.maxPriorLaunches} prior pump.fun launches from the same wallet)` : "OFF (SUPABASE_URL not set)"}\n\n` +
      `Bundler/same-block detection is not available — the meme-scanner's ` +
      `table for it is empty in production, there's nothing real to check yet.`
  )
);

bot.command("killswitch", (ctx) => {
  const arg = ctx.match.trim().toLowerCase();

  if (arg === "on") {
    activateKillSwitch("manual");
    return ctx.reply("🛑 Kill switch ACTIVE. All new buys (manual and sniped) are blocked. Sells still work.");
  }

  if (arg === "off") {
    deactivateKillSwitch();
    return ctx.reply("Kill switch cleared. Buys are allowed again.");
  }

  const state = getKillSwitchState();
  return ctx.reply(
    state.active
      ? `Kill switch is ACTIVE (reason: ${state.reason}, since ${state.at}).\nUsage: /killswitch on | off`
      : "Kill switch is off.\nUsage: /killswitch on | off"
  );
});

bot.command("balance", async (ctx) => {
  const pubkey = getKeypair().publicKey;

  if (config.paperTrading) {
    const sol = Number(getSolBalanceLamports()) / 1e9;
    return ctx.reply(`${modeTag()} ${pubkey.toBase58()}\n${sol.toFixed(4)} SOL (simulated)`);
  }

  const sol = await getSolBalance(pubkey);
  await ctx.reply(`${modeTag()} ${pubkey.toBase58()}\n${sol.toFixed(4)} SOL`);
});

bot.command("buy", async (ctx) => {
  const args = ctx.match.trim().split(/\s+/).filter(Boolean);
  const [mint, solAmountStr, slippageStr] = args;

  if (!mint || !solAmountStr) {
    return ctx.reply("Usage: /buy <mint> <sol_amount> [slippage_bps]");
  }

  const solAmount = Number(solAmountStr);
  const slippageBps = slippageStr ? Number(slippageStr) : config.defaultSlippageBps;
  if (!Number.isFinite(solAmount) || solAmount <= 0) {
    return ctx.reply("sol_amount must be a positive number");
  }

  const lamports = Math.round(solAmount * 1e9);

  await ctx.reply(`${modeTag()} Buying ${solAmount} SOL of ${mint} (slippage ${slippageBps} bps)...`);
  try {
    const result = await executeManualTrade({
      inputMint: SOL_MINT,
      outputMint: mint,
      amount: lamports,
      slippageBps,
    });
    if (result.paper) {
      await ctx.reply(`Simulated fill: received ${result.quote.outAmount} raw units of ${mint}`);
    } else {
      await ctx.reply(`Filled: https://solscan.io/tx/${result.signature}`);
    }
  } catch (err) {
    await ctx.reply(`Buy failed: ${err.message}`);
  }
});

bot.command("sell", async (ctx) => {
  const args = ctx.match.trim().split(/\s+/).filter(Boolean);
  const [mint, percentStr, slippageStr] = args;

  if (!mint || !percentStr) {
    return ctx.reply("Usage: /sell <mint> <percent> [slippage_bps]");
  }

  const percent = Number(percentStr);
  const slippageBps = slippageStr ? Number(slippageStr) : config.defaultSlippageBps;
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
    return ctx.reply("percent must be between 0 and 100");
  }

  let amount;
  if (config.paperTrading) {
    amount = getTokenHolding(mint);
  } else {
    const pubkey = getKeypair().publicKey;
    ({ amount } = await getTokenBalance(pubkey, mint));
  }

  if (amount === 0n) {
    return ctx.reply(`${modeTag()} No balance of ${mint} to sell`);
  }

  const sellAmount = (amount * BigInt(Math.round(percent * 100))) / 10000n;

  await ctx.reply(`${modeTag()} Selling ${percent}% of ${mint} (slippage ${slippageBps} bps)...`);
  try {
    const result = await executeManualTrade({
      inputMint: mint,
      outputMint: SOL_MINT,
      amount: Number(sellAmount),
      slippageBps,
    });
    if (result.paper) {
      await ctx.reply(`Simulated fill: received ${result.quote.outAmount} lamports SOL`);
    } else {
      await ctx.reply(`Filled: https://solscan.io/tx/${result.signature}`);
    }
  } catch (err) {
    await ctx.reply(`Sell failed: ${err.message}`);
  }
});

bot.command("portfolio", async (ctx) => {
  if (!config.paperTrading) {
    return ctx.reply("Not in paper mode — use /balance for real wallet balance.");
  }

  await ctx.reply("Pulling current prices for open positions...");
  const report = await getPaperPortfolioReport();

  const sol = Number(report.solLamports) / 1e9;
  const realizedPnl = Number(report.realizedPnlLamports) / 1e9;

  let unrealizedTotal = 0;
  let unrealizedUnknown = false;
  const lines = report.positions.map((p) => {
    const costSol = Number(p.costBasisLamports) / 1e9;
    if (p.unrealizedPnlLamports === null) {
      unrealizedUnknown = true;
      return `  ${p.mint}\n    amount: ${p.amount} raw, cost basis: ${costSol.toFixed(4)} SOL, current value: no route`;
    }
    const valueSol = Number(p.currentValueLamports) / 1e9;
    const pnlSol = Number(p.unrealizedPnlLamports) / 1e9;
    unrealizedTotal += pnlSol;
    const sign = pnlSol >= 0 ? "+" : "";
    return `  ${p.mint}\n    amount: ${p.amount} raw, cost: ${costSol.toFixed(4)} SOL, value: ${valueSol.toFixed(4)} SOL, PnL: ${sign}${pnlSol.toFixed(4)} SOL`;
  });

  await ctx.reply(
    `${modeTag()} Portfolio\n` +
      `SOL: ${sol.toFixed(4)}\n` +
      `Realized PnL: ${realizedPnl >= 0 ? "+" : ""}${realizedPnl.toFixed(4)} SOL\n` +
      `Unrealized PnL: ${unrealizedTotal >= 0 ? "+" : ""}${unrealizedTotal.toFixed(4)} SOL` +
      (unrealizedUnknown ? " (some positions have no current route)" : "") +
      "\n" +
      (lines.length ? `Positions:\n${lines.join("\n")}\n` : "Positions: none\n") +
      `Trades recorded: ${report.tradeCount}`
  );
});

bot.command("resetpaper", async (ctx) => {
  if (!config.paperTrading) {
    return ctx.reply("Not in paper mode — nothing to reset.");
  }
  resetPortfolio();
  await ctx.reply(`Paper portfolio reset to ${config.paperStartingSol} SOL.`);
});

bot.command("paper", async (ctx) => {
  const arg = ctx.match.trim().toLowerCase();

  if (arg === "on") {
    config.paperTrading = true;
    return ctx.reply("Paper trading ON. Nothing will touch the real wallet.");
  }

  if (arg === "off") {
    if (config.paperTradingLocked) {
      return ctx.reply(
        "Refused: PAPER_TRADING is not set to \"false\" in .env. " +
          "Set PAPER_TRADING=false there and restart the bot before /paper off will work — " +
          "this is deliberate, it's a two-step switch."
      );
    }
    config.paperTrading = false;
    return ctx.reply("⚠️ Paper trading OFF. Real trades will now sign and send with real funds.");
  }

  return ctx.reply(`Usage: /paper on | off (currently ${modeTag()})`);
});

bot.command("snipe", async (ctx) => {
  const arg = ctx.match.trim().toLowerCase();

  if (arg === "on") {
    if (isSnipeEngineRunning()) return ctx.reply("Already running.");
    startSnipeEngine((event) => {
      // "candidate" events are deliberately not sent to Telegram — we
      // confirmed almost every pump.fun launch passes the basic filter, so
      // this fired a message for nearly every single one. At real volume
      // that's several messages/sec to one chat, which Telegram's Bot API
      // rate-limits — and every send here is fire-and-forget, so a
      // rejected send became an unhandled promise rejection that crashed
      // the whole process. queueReply (below) fixes the crash risk
      // structurally; dropping this specific event fixes the actual noise
      // that was triggering it in the first place.
      if (event.type === "bundle_sent") {
        const route = event.curveNative ? "curve" : "Jupiter";
        const tag = event.paper ? `[PAPER] Simulated buy (${route})` : `Bundle sent (${route})`;
        const detail = event.paper
          ? `received ${event.quote?.outAmount ?? "?"} raw units`
          : event.bundleId;
        queueReply(ctx, `${tag} for ${event.token.mint}: ${detail}`);
      } else if (event.type === "error") {
        queueReply(ctx, `Snipe error on ${event.token.mint}: ${event.error}`);
      }
    });
    return ctx.reply(
      `${modeTag()} Snipe engine started. Phase 4 checks active: mint/freeze ` +
        "authority, deployer repeat-launch history, max spend/slippage/price-impact, " +
        "kill switch. Same-block bundler/sniper detection is still not available " +
        "(the scanner's data for it is empty in production). Candidate-level " +
        "messages are suppressed — pump.fun volume is too high for one message " +
        "per launch. See /risk."
    );
  }

  if (arg === "off") {
    stopSnipeEngine();
    return ctx.reply("Snipe engine stopped.");
  }

  return ctx.reply(
    `Usage: /snipe on | off (currently ${isSnipeEngineRunning() ? "on" : "off"})`
  );
});

bot.command("exits", (ctx) => {
  const arg = ctx.match.trim().toLowerCase();

  if (arg === "on") {
    if (isExitEngineRunning()) return ctx.reply("Already running.");
    if (!config.paperTrading) {
      return ctx.reply(
        "Refused: exit management only handles paper positions right now — " +
          "real-mode position enumeration hasn't been built or tested. " +
          "See snipe/exit/engine.js for why. Nothing will happen in live mode."
      );
    }
    startExitEngine((event) => {
      if (event.type === "exit") {
        const sign = event.pnlPct >= 0 ? "+" : "";
        const detail = event.result.paper
          ? `received ${event.result.quote?.outAmount ?? "?"} lamports SOL`
          : event.result.signature;
        queueReply(
          ctx,
          `[EXIT: ${event.reason}] ${event.mint} (${sign}${event.pnlPct.toFixed(1)}%): ${detail}`
        );
      } else if (event.type === "exit_error") {
        queueReply(ctx, `Exit failed on ${event.mint} (${event.reason}): ${event.error}`);
      } else if (event.type === "scan_error") {
        queueReply(ctx, `Exit scan error: ${event.error}`);
      }
    });
    return ctx.reply(
      `Exit engine started. Take-profit +${exitConfig.takeProfitPct}%, ` +
        `stop-loss -${exitConfig.stopLossPct}%, max hold ${exitConfig.maxHoldSeconds}s, ` +
        `checking every ${exitConfig.checkIntervalSeconds}s. Paper positions only — see /start.`
    );
  }

  if (arg === "off") {
    stopExitEngine();
    return ctx.reply("Exit engine stopped.");
  }

  return ctx.reply(
    `Usage: /exits on | off (currently ${isExitEngineRunning() ? "on" : "off"})`
  );
});

bot.catch((err) => {
  console.error("Bot error:", err);
});

bot.start();
console.log(`Bot running in ${config.paperTrading ? "PAPER" : "LIVE"} mode. Wallet:`, getKeypair().publicKey.toBase58());
