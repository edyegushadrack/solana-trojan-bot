import { PublicKey } from "@solana/web3.js";
import { connection } from "../rpc/connection.js";

const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);

/**
 * Returns the raw (smallest-unit) balance of `mint` held by `owner`, and the
 * token's decimals. Returns { amount: 0n, decimals: 0 } if no account exists.
 */
export async function getTokenBalance(owner, mint) {
  const accounts = await connection.getParsedTokenAccountsByOwner(owner, {
    mint: new PublicKey(mint),
    programId: TOKEN_PROGRAM_ID,
  });

  if (accounts.value.length === 0) {
    return { amount: 0n, decimals: 0 };
  }

  const info = accounts.value[0].account.data.parsed.info.tokenAmount;
  return { amount: BigInt(info.amount), decimals: info.decimals };
}
