import axios from "axios";
import { VersionedTransaction } from "@solana/web3.js";
import { connection } from "../rpc/connection.js";
import { getKeypair } from "../wallet/keypair.js";

// Jupiter's free public endpoint. Swap for your own paid tier / self-hosted
// instance once you're sniping — the public one will rate-limit you under
// load and every extra hundred ms matters when racing a new pool.
const JUPITER_BASE = "https://lite-api.jup.ag";
export const SOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Gets a swap quote. amount is in the input token's smallest unit
 * (lamports for SOL). slippageBps: 100 = 1%.
 */
export async function getQuote({ inputMint, outputMint, amount, slippageBps }) {
  try {
    const { data } = await axios.get(`${JUPITER_BASE}/swap/v1/quote`, {
      params: {
        inputMint,
        outputMint,
        amount,
        slippageBps,
        restrictIntermediateTokens: true,
      },
    });
    return data;
  } catch (err) {
    // Jupiter puts the actual reason in the response body on 4xx/5xx, but
    // axios's default error just says "Request failed with status code
    // 400" and throws away that body. Surface the real message instead —
    // "status code 400" alone isn't actionable.
    const detail = err.response?.data?.error ?? err.response?.data ?? err.message;
    throw new Error(`Jupiter quote failed (${err.response?.status ?? "network"}): ${JSON.stringify(detail)}`);
  }
}

/**
 * Builds the swap transaction for a given quote, ready to sign.
 * skipPriorityFee: pass true when this tx is going into a Jito bundle —
 * the bundle tip is what buys inclusion there, so Jupiter's own priority
 * fee would just be money paid twice for the same thing.
 */
async function buildSwapTransaction(quoteResponse, userPublicKey, { skipPriorityFee = false } = {}) {
  try {
    const { data } = await axios.post(`${JUPITER_BASE}/swap/v1/swap`, {
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      ...(skipPriorityFee ? {} : { prioritizationFeeLamports: "auto" }),
    });
    return data.swapTransaction; // base64-encoded VersionedTransaction
  } catch (err) {
    const detail = err.response?.data?.error ?? err.response?.data ?? err.message;
    throw new Error(`Jupiter swap-build failed (${err.response?.status ?? "network"}): ${JSON.stringify(detail)}`);
  }
}

/**
 * Quote -> build -> sign. Does NOT send — used both by the normal RPC path
 * below and by the snipe engine's Jito bundle path, which needs a signed
 * tx to bundle alongside a tip transfer rather than send directly.
 * Returns { tx, quote } where tx is a signed VersionedTransaction.
 */
export async function getSignedSwapTransaction({
  inputMint,
  outputMint,
  amount,
  slippageBps,
  skipPriorityFee = false,
  quote: providedQuote,
}) {
  const keypair = getKeypair();

  const quote = providedQuote ?? (await getQuote({ inputMint, outputMint, amount, slippageBps }));
  if (!quote || quote.error) {
    throw new Error(`No route: ${quote?.error ?? "unknown error"}`);
  }

  const swapTransactionB64 = await buildSwapTransaction(
    quote,
    keypair.publicKey.toBase58(),
    { skipPriorityFee }
  );

  const tx = VersionedTransaction.deserialize(
    Buffer.from(swapTransactionB64, "base64")
  );
  tx.sign([keypair]);

  return { tx, quote };
}

/**
 * Full swap flow over normal RPC: quote -> build -> sign -> send -> confirm.
 * Use this for manual /buy and /sell. For the snipe engine's Jito bundle
 * path, use getSignedSwapTransaction directly instead.
 * Pass `quote` if you already fetched one (e.g. for a risk check) to skip
 * re-fetching.
 * Returns { signature, quote }.
 */
export async function executeSwap({ inputMint, outputMint, amount, slippageBps, quote: providedQuote }) {
  const { tx, quote } = await getSignedSwapTransaction({
    inputMint,
    outputMint,
    amount,
    slippageBps,
    quote: providedQuote,
  });

  const signature = await connection.sendTransaction(tx, {
    skipPreflight: true,
    maxRetries: 3,
  });

  const latestBlockhash = await connection.getLatestBlockhash();
  await connection.confirmTransaction(
    { signature, ...latestBlockhash },
    "confirmed"
  );

  return { signature, quote };
}
