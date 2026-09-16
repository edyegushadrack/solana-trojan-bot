export const riskConfig = {
  maxSpendSol: Number(process.env.RISK_MAX_SPEND_SOL ?? 0.1),
  maxSlippageBps: Number(process.env.RISK_MAX_SLIPPAGE_BPS ?? 1000), // 10%
  maxPriceImpactPct: Number(process.env.RISK_MAX_PRICE_IMPACT_PCT ?? 15),
};

/**
 * Hard ceiling on SOL spent in a single trade, independent of whatever
 * amount a command or the snipe engine asked for. This is the backstop
 * against a typo'd extra zero in /buy or a config mistake in
 * SNIPE_BUY_SOL — it does not care why the amount is too big.
 */
export function enforceSpendLimit(solAmount) {
  if (solAmount > riskConfig.maxSpendSol) {
    throw new Error(
      `Blocked: ${solAmount} SOL exceeds max spend per trade ` +
        `(${riskConfig.maxSpendSol} SOL). Raise RISK_MAX_SPEND_SOL in .env to override.`
    );
  }
}

export function enforceSlippageLimit(slippageBps) {
  if (slippageBps > riskConfig.maxSlippageBps) {
    throw new Error(
      `Blocked: slippage ${slippageBps}bps exceeds max allowed ` +
        `(${riskConfig.maxSlippageBps}bps). Raise RISK_MAX_SLIPPAGE_BPS in .env to override.`
    );
  }
}

/**
 * priceImpactPct from Jupiter is already a plain percentage string (e.g.
 * "0" = 0%, "12.4" = 12.4%) — not a fraction, don't multiply by 100.
 */
export function enforcePriceImpact(quote) {
  const impact = Number(quote.priceImpactPct ?? 0);
  if (impact > riskConfig.maxPriceImpactPct) {
    throw new Error(
      `Blocked: price impact ${impact.toFixed(2)}% exceeds max allowed ` +
        `(${riskConfig.maxPriceImpactPct}%). This usually means the pool is too thin for this size.`
    );
  }
}
