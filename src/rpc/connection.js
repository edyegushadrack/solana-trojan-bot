import { Connection } from "@solana/web3.js";
import { config } from "../config.js";

// Single shared connection. "confirmed" is the right default for trading —
// "finalized" is too slow, "processed" is too easy to build on a dropped tx.
export const connection = new Connection(config.rpcUrl, "confirmed");

export async function getSolBalance(publicKey) {
  const lamports = await connection.getBalance(publicKey);
  return lamports / 1e9;
}
