import { getMintAuthorities } from "./authorities.js";
import { isKillSwitchActive } from "./killswitch.js";

/**
 * The single choke point every BUY (manual /buy or sniped) passes through
 * before spending. Sells never go through this — see killswitch.js for why.
 *
 * Returns { passed: boolean, reasons: string[] }.
 *
 * WHAT THIS DOES NOT COVER YET: deployer rug-history and bundler/sniper
 * same-block detection. That logic already exists in the meme-scanner
 * repo (fetchOnChainSignals.js there), backed by its Supabase project —
 * it tracks patterns across many launches over time, which is exactly the
 * kind of thing that shouldn't be rebuilt from scratch here. Wiring it in
 * needs either Supabase read credentials for that project or a pulled
 * copy of that detection code. Until then, this gate only catches what's
 * checkable from the mint account alone — real, but partial, coverage.
 */
export async function runRiskGate(mint) {
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

  return { passed: reasons.length === 0, reasons };
}
