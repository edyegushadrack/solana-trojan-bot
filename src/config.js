import "dotenv/config";

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name} (check your .env)`);
  }
  return value;
}

export const config = {
  rpcUrl: required("RPC_URL"),
  privateKey: required("PRIVATE_KEY"),
  telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
  telegramOwnerId: required("TELEGRAM_OWNER_ID"),
  defaultSlippageBps: Number(process.env.DEFAULT_SLIPPAGE_BPS ?? 100),
};
