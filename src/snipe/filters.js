export const snipeConfig = {
  minLiquiditySol: Number(process.env.SNIPE_MIN_LIQUIDITY_SOL ?? 5),
};

/**
 * Cheap, synchronous pre-check only — filters out launches too thin to be
 * worth reacting to at all. This is deliberately NOT the rug/forensics
 * layer (Phase 4): mint/freeze authority checks, bundler/sniper detection,
 * and deployer rug history live in the meme-scanner repo and MUST gate
 * every buy here before this touches real money. Wire that in before you
 * flip /snipe on with anything more than test amounts.
 */
export function passesBasicFilter(token) {
  const liquiditySol = Number(token.vSolInBondingCurve ?? 0);
  return liquiditySol >= snipeConfig.minLiquiditySol;
}
