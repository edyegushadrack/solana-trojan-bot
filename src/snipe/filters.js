export const snipeConfig = {
  minLiquiditySol: Number(process.env.SNIPE_MIN_LIQUIDITY_SOL ?? 5),
};

/**
 * IMPORTANT — CONFIRMED VIA RESEARCH, NOT ASSUMED: every pump.fun token
 * starts with the same virtual reserves (~30 SOL, ~1.073B tokens) — that's
 * a protocol-wide constant, not something that varies per launch. On a
 * "create" event specifically, vSolInBondingCurve is that constant, not a
 * measure of real interest (real SOL reserves are 0 until someone actually
 * buys). So this filter, checked against a "create" event, passes
 * virtually every single launch — it isn't currently discriminating
 * anything at this stage, which is why so much volume was reaching the
 * per-candidate RPC calls downstream (that's what was actually exceeding
 * Helius's free-tier rate limit — see engine.js's maxConcurrent for the
 * real fix). It's left in place because it protects against a malformed
 * or unusual event missing the field entirely (Number(undefined) → NaN,
 * comparison fails safely), and it'll start meaning something if a
 * different creation source with genuinely variable initial liquidity is
 * ever added — just don't expect it to reduce pump.fun snipe volume today.
 */
export function passesBasicFilter(token) {
  const liquiditySol = Number(token.vSolInBondingCurve ?? 0);
  return liquiditySol >= snipeConfig.minLiquiditySol;
}
