import "dotenv/config";

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name} (check your .env)`);
  }
  return value;
}

// Two-key safety switch for real trades. The env var is the physical key —
// it must be explicitly set to disable paper mode before anything else
// matters. The runtime flag is the second key — the bot ALWAYS starts in
// paper mode regardless of env, so arming real trades takes both an .env
// change (restart required) and a deliberate /paper off in the bot itself.
const envAllowsRealTrades = (process.env.PAPER_TRADING ?? "true").toLowerCase() === "false";

export const config = {
  rpcUrl: required("RPC_URL"),
  privateKey: required("PRIVATE_KEY"),
  telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
  telegramOwnerId: required("TELEGRAM_OWNER_ID"),
  defaultSlippageBps: Number(process.env.DEFAULT_SLIPPAGE_BPS ?? 100),
  paperTradingLocked: !envAllowsRealTrades, // true = /paper off is refused
  paperTrading: true, // runtime flag — always starts true, see above
  paperStartingSol: Number(process.env.PAPER_STARTING_SOL ?? 10),
  // Optional — deployer-history check (risk/deployerHistory.js) no-ops if unset
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
};
