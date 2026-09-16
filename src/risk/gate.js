import { getMintAuthorities } from "./authorities.js";
import { isKillSwitchActive } from "./killswitch.js";
import { checkDeployerHistory } from "./deployerHistory.js";

/**
 * The single choke point every BUY (manual /buy or sniped) passes through
 * before spending. Sells never go through this — see killswitch.js for why.
 *
 * Pass deployerAddress when known (the snipe engine has it from PumpPortal's
 * traderPublicKey field on every "create" event) to also run the deployer
 * repeat-launch check. Manual /buy on an arbitrary mint won't have this
 * unless the deployer is looked up separately, so that check is skipped —
 * gate still runs the on-chain authority check either way.
 *
 * Returns { passed: boolean, reasons: string[] }.
 *
 * WHAT THIS DOES NOT COVER: bundler/same-block-buy detection. The
 * meme-scanner's `token_early_buyers` table (meant to hold this) has 0 rows
 * in production — that detection isn't actually running there yet either,
 * so there's nothing real to port for that piece. See README.
 */
export async function runRiskGate(mint, { deployerAddress } = {}) {
  const reasons = [];

  if (isKillSwitchActive()) {
    reasons.push("Kill switch is active — no new buys until it's cleared");
    return { passed: false, reasons };
  }

  try {
    const { mintAuthority, freezeAuthority } = await getMintAuthorities(mint);
    if (mintAuthority !== null) {
      reasons.push(`Mint authority not renounced (${mintAuthority}) — supply can be diluted at will`);
    }
    if (freezeAuthority !== null) {
      reasons.push(`Freeze authority present (${freezeAuthority}) — deployer can block your account from selling`);
    }
  } catch (err) {
    // A failed check is treated as a block, not a pass — "couldn't verify"
    // should never be silently treated the same as "verified safe."
    reasons.push(`Could not verify mint authorities: ${err.message}`);
  }

  if (deployerAddress) {
    const history = await checkDeployerHistory(deployerAddress);
    reasons.push(...history.reasons);
  }

  return { passed: reasons.length === 0, reasons };
}
