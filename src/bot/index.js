import { Bot } from "grammy";
import { config } from "../config.js";
import { getKeypair } from "../wallet/keypair.js";
import { getSolBalance } from "../rpc/connection.js";
import { getTokenBalance } from "../wallet/balances.js";
import { executeSwap, SOL_MINT } from "../execution/jupiter.js";
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

bot.command("start", (ctx) =>
  ctx.reply(
    "Solana trading bot ready.\n\n" +
      "/balance — wallet SOL balance\n" +
      "/buy <mint> <sol_amount> [slippage_bps]\n" +
      "/sell <mint> <percent> [slippage_bps]"
  )
);

bot.command("balance", async (ctx) => {
  const pubkey = getKeypair().publicKey;
  const sol = await getSolBalance(pubkey);
  await ctx.reply(`${pubkey.toBase58()}\n${sol.toFixed(4)} SOL`);
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

  await ctx.reply(`Buying ${solAmount} SOL of ${mint} (slippage ${slippageBps} bps)...`);
  try {
    const { signature } = await executeSwap({
      inputMint: SOL_MINT,
      outputMint: mint,
      amount: lamports,
      slippageBps,
    });
    await ctx.reply(`Filled: https://solscan.io/tx/${signature}`);
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

  const pubkey = getKeypair().publicKey;
  const { amount, decimals } = await getTokenBalance(pubkey, mint);
  if (amount === 0n) {
    return ctx.reply(`No balance of ${mint} in this wallet`);
  }

  const sellAmount = (amount * BigInt(Math.round(percent * 100))) / 10000n;

  await ctx.reply(`Selling ${percent}% of ${mint} (slippage ${slippageBps} bps)...`);
  try {
    const { signature } = await executeSwap({
      inputMint: mint,
      outputMint: SOL_MINT,
      amount: Number(sellAmount),
      slippageBps,
    });
    await ctx.reply(`Filled: https://solscan.io/tx/${signature}`);
  } catch (err) {
    await ctx.reply(`Sell failed: ${err.message}`);
  }
  // decimals reserved for display formatting once we add position tracking
  void decimals;
});

bot.command("snipe", async (ctx) => {
  const arg = ctx.match.trim().toLowerCase();

  if (arg === "on") {
    if (isSnipeEngineRunning()) return ctx.reply("Already running.");
    startSnipeEngine((event) => {
      if (event.type === "candidate") {
        ctx.reply(`Candidate: ${event.token.mint} (${event.token.name ?? "?"})`);
      } else if (event.type === "bundle_sent") {
        ctx.reply(`Bundle sent for ${event.token.mint}: ${event.bundleId}`);
      } else if (event.type === "error") {
        ctx.reply(`Snipe error on ${event.token.mint}: ${event.error}`);
      }
    });
    return ctx.reply(
      "Snipe engine started. NOTE: Phase 4 rug checks are not wired in yet " +
        "— this fires on anything clearing the basic liquidity filter. " +
        "Only run with throwaway buy amounts until that's done."
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
console.log("Bot running. Wallet:", getKeypair().publicKey.toBase58());
