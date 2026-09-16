export const snipeConfig = {
  minLiquiditySol: Number(process.env.SNIPE_MIN_LIQUIDITY_SOL ?? 5),
};

/**
 * Cheap, synchronous pre-check only — filters out launches too thin to be
 * worth reacting to at all, before spending an RPC/Jupiter call on them.
 * The real risk checks (mint/freeze authority, spend/slippage/impact
 * limits, kill switch) run afterward in risk/gate.js and risk/limits.js
 * for anything that passes this. Deployer rug-history and bundler
 * detection from the meme-scanner repo still aren't wired in — see README.
 */
export function passesBasicFilter(token) {
  const liquiditySol = Number(token.vSolInBondingCurve ?? 0);
  return liquiditySol >= snipeConfig.minLiquiditySol;
}
