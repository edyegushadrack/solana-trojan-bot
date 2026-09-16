import { PublicKey } from "@solana/web3.js";
import { connection } from "../rpc/connection.js";

/**
 * Reads a mint's authorities directly from the SPL Token program account —
 * no off-chain data needed, this is ground truth from the chain itself.
 *
 * mintAuthority !== null: the deployer can mint more supply whenever they
 * want. Dilutes every holder without warning — the single most common
 * pump.fun rug mechanic outside of the bonding curve itself.
 *
 * freezeAuthority !== null: the deployer can freeze your token account,
 * which blocks you from selling while the price is dumped elsewhere.
 *
 * Both null ("renounced") is what a token you'd trust looks like. Neither
 * being null does NOT prove the token is legitimate — it only rules out
 * these two specific mechanics.
 */
export async function getMintAuthorities(mint) {
  const info = await connection.getParsedAccountInfo(new PublicKey(mint));
  const parsed = info.value?.data?.parsed;

  if (!parsed || parsed.type !== "mint") {
    throw new Error(`${mint} is not a valid SPL mint account`);
  }

  return {
    mintAuthority: parsed.info.mintAuthority ?? null,
    freezeAuthority: parsed.info.freezeAuthority ?? null,
  };
}
