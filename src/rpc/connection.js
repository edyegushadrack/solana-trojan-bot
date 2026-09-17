import { Connection } from "@solana/web3.js";
import { config } from "../config.js";

// Max sustained requests/sec to the RPC endpoint, across EVERY call this
// Connection makes — ours (getMintAuthorities, getSolBalance, etc.) and the
// pump-sdk's (OnlinePumpSdk was built with this same connection). Set below
// Helius's free-tier ceiling (10/s) to leave headroom, since a 429 storm
// happened even with SNIPE_MAX_CONCURRENT capping concurrent candidates —
// concurrency limits how many candidate-processing chains run at once, but
// each chain fires several RPC calls, so it's a proxy for request rate, not
// a direct bound on it. This IS a direct bound: every single RPC call from
// any code path is paced through one choke point (fetchMiddleware, which
// @solana/web3.js calls before every request) so the actual ceiling can't
// be exceeded regardless of how many things want to call the RPC at once.
const MAX_REQUESTS_PER_SECOND = Number(process.env.RPC_MAX_REQUESTS_PER_SECOND ?? 8);
const MIN_INTERVAL_MS = 1000 / MAX_REQUESTS_PER_SECOND;

let nextAllowedTime = 0;

function rateLimitedFetchMiddleware(info, init, fetch) {
  const now = Date.now();
  const scheduledTime = Math.max(now, nextAllowedTime);
  nextAllowedTime = scheduledTime + MIN_INTERVAL_MS;

  const delay = scheduledTime - now;
  if (delay <= 0) {
    fetch(info, init);
  } else {
    setTimeout(() => fetch(info, init), delay);
  }
}

// Single shared connection. "confirmed" is the right default for trading —
// "finalized" is too slow, "processed" is too easy to build on a dropped tx.
export const connection = new Connection(config.rpcUrl, {
  commitment: "confirmed",
  fetchMiddleware: rateLimitedFetchMiddleware,
});

export async function getSolBalance(publicKey) {
  const lamports = await connection.getBalance(publicKey);
  return lamports / 1e9;
}
