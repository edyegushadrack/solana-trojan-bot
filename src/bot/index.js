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

const bot = new Bot(config.telegramBotToken);

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
    `Solana trading bot ready. Mode: ${modeTag()}\n\n` +
      "/balance — SOL balance (paper or real, depending on mode)\n" +
      "/buy <mint> <sol_amount> [slippage_bps]\n" +
      "/sell <mint> <percent> [slippage_bps]\n" +
      "/snipe on | off\n" +
      "/portfolio — paper trading positions + trade count\n" +
      "/resetpaper — wipe paper portfolio back to starting balance\n" +
      "/paper on | off — toggle simulate-only mode"
  )
);

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
      if (event.type === "candidate") {
        ctx.reply(`Candidate: ${event.token.mint} (${event.token.name ?? "?"})`);
      } else if (event.type === "bundle_sent") {
        const tag = event.paper ? "[PAPER] Simulated buy" : "Bundle sent";
        const detail = event.paper
          ? `received ${event.quote?.outAmount ?? "?"} raw units`
          : event.bundleId;
        ctx.reply(`${tag} for ${event.token.mint}: ${detail}`);
      } else if (event.type === "error") {
        ctx.reply(`Snipe error on ${event.token.mint}: ${event.error}`);
      }
    });
    return ctx.reply(
      `${modeTag()} Snipe engine started. NOTE: Phase 4 rug checks are not wired in yet ` +
        "— this fires on anything clearing the basic liquidity filter."
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

bot.catch((err) => {
  console.error("Bot error:", err);
});

bot.start();
console.log(`Bot running in ${config.paperTrading ? "PAPER" : "LIVE"} mode. Wallet:`, getKeypair().publicKey.toBase58());
