import axios from "axios";
import {
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { connection } from "../rpc/connection.js";

// Global front-door; swap for a region-pinned URL (ams/nyc/tyo/etc, see
// Jito's docs) once you know where your bot actually runs — latency to the
// block engine directly affects whether your bundle wins the auction.
const BLOCK_ENGINE = "https://mainnet.block-engine.jito.wtf";

async function jitoRpc(method, params = []) {
  const { data } = await axios.post(`${BLOCK_ENGINE}/api/v1/bundles`, {
    jsonrpc: "2.0",
    id: 1,
    method,
    params,
  });
  if (data.error) throw new Error(`Jito ${method} error: ${data.error.message}`);
  return data.result;
}

/**
 * Fetches the current list of Jito tip accounts and returns one at random,
 * as Jito's docs recommend, to spread load across accounts.
 */
export async function getRandomTipAccount() {
  const accounts = await jitoRpc("getTipAccounts");
  return accounts[Math.floor(Math.random() * accounts.length)];
}

/**
 * Builds and signs a SOL transfer to a Jito tip account. This is what buys
 * bundle inclusion — without a tip, the bundle is simply ignored.
 */
export async function buildTipTransaction(keypair, tipAccount, lamports) {
  const { blockhash } = await connection.getLatestBlockhash();

  const message = new TransactionMessage({
    payerKey: keypair.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: new PublicKey(tipAccount),
        lamports,
      }),
    ],
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.sign([keypair]);
  return tx;
}

/**
 * Submits a bundle of up to 5 signed VersionedTransactions atomically.
 * Returns the bundle id (a UUID string) — use getBundleStatus to check
 * whether it actually landed.
 */
export async function sendBundle(signedTxs) {
  const encoded = signedTxs.map((tx) =>
    Buffer.from(tx.serialize()).toString("base64")
  );
  return jitoRpc("sendBundle", [encoded, { encoding: "base64" }]);
}

export async function getBundleStatus(bundleId) {
  const result = await jitoRpc("getBundleStatuses", [[bundleId]]);
  return result?.value?.[0] ?? null;
}
