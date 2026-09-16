import { getSupabaseClient } from "./supabaseClient.js";

export const deployerHistoryConfig = {
  // p90 of prior-launch-count across the actual meme-scanner dataset is 5,
  // p99 is 46 — a wallet with dozens+ of prior pump.fun launches is
  // overwhelmingly a mass-deployer / farm pattern, not an individual
  // project. Default set above p90 so normal repeat creators (small
  // studios, serial memers) aren't flagged, only clear outliers.
  maxPriorLaunches: Number(process.env.RISK_MAX_DEPLOYER_PRIOR_LAUNCHES ?? 15),
};

/**
 * Checks how many prior pump.fun tokens this wallet has created, per the
 * meme-scanner's launches table. Returns { available, priorLaunchCount,
 * reasons }. `available: false` means Supabase isn't configured or the
 * query failed — callers should treat that as "couldn't check", not "clean".
 *
 * WHY THIS CHECK AND NOT OTHERS: querying the actual data showed
 * mint_authority_renounced, freeze_authority_renounced, and
 * lp_locked_or_burned are true on effectively 100% of pump.fun launches
 * (56,716 / 56,716 in the current dataset) — pump.fun's program enforces
 * this at creation, so they don't differentiate one launch from another.
 * dev_holder_pct is never populated. top10_holder_pct averages ~99% at
 * creation time since the bonding curve itself holds the supply pre-buys.
 * None of those are usable signals at the instant of a snipe. Prior-launch
 * count is the one field in this dataset that actually varies in a way
 * that means something (median 1, but some wallets have 900+).
 */
export async function checkDeployerHistory(deployerAddress) {
  const client = getSupabaseClient();
  if (!client || !deployerAddress) {
    return { available: false, priorLaunchCount: null, reasons: [] };
  }

  const { data, error } = await client
    .from("launches")
    .select("mint_address", { count: "exact", head: false })
    .eq("raw_payload->>traderPublicKey", deployerAddress)
    .limit(1000);

  if (error) {
    return { available: false, priorLaunchCount: null, reasons: [`Deployer history query failed: ${error.message}`] };
  }

  const priorLaunchCount = data.length;
  const reasons = [];

  if (priorLaunchCount > deployerHistoryConfig.maxPriorLaunches) {
    reasons.push(
      `Deployer wallet has ${priorLaunchCount} prior pump.fun launches on record ` +
        `(threshold ${deployerHistoryConfig.maxPriorLaunches}) — mass-deployer pattern, not an individual project`
    );
  }

  return { available: true, priorLaunchCount, reasons };
}
