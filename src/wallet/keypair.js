import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "../config.js";

let cachedKeypair = null;

/**
 * Loads the hot wallet keypair from PRIVATE_KEY (base58, Phantom export
 * format). Cached after first load so we don't re-decode on every call.
 */
export function getKeypair() {
  if (cachedKeypair) return cachedKeypair;

  const secretKey = bs58.decode(config.privateKey);
  cachedKeypair = Keypair.fromSecretKey(secretKey);
  return cachedKeypair;
}

export function getPublicKey() {
  return getKeypair().publicKey;
}
