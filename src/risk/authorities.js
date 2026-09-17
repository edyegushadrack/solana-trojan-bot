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
 *
 * Retries briefly on a "not found" result before giving up. A mint that's
 * a few hundred ms old can genuinely not exist yet on whichever RPC node a
 * load-balanced public endpoint happens to route this call to — that's a
 * propagation-lag false negative, not proof the mint is invalid. This is
 * the exact failure mode a paid, dedicated RPC provider avoids; retrying
 * here just buys a little slack on top of that, not a substitute for it.
 */
export async function getMintAuthorities(mint, { retries = 2, retryDelayMs = 250 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const info = await connection.getParsedAccountInfo(new PublicKey(mint));
    const parsed = info.value?.data?.parsed;

    if (parsed && parsed.type === "mint") {
      return {
        mintAuthority: parsed.info.mintAuthority ?? null,
        freezeAuthority: parsed.info.freezeAuthority ?? null,
      };
    }

    if (attempt < retries) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  throw new Error(`${mint} is not a valid SPL mint account (after ${retries + 1} attempts)`);
}
