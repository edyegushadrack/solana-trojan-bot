import WebSocket from "ws";

const PUMPPORTAL_WS = "wss://pumpportal.fun/api/data";

/**
 * Subscribes to PumpPortal's new-token-creation feed and calls onToken for
 * every launch. Auto-reconnects on close since this needs to stay up
 * indefinitely while sniping is on.
 *
 * Same feed the meme-scanner already listens to — if you extract a shared
 * package later, this file is the one to delete in favor of that.
 */
export function listenForNewTokens(onToken) {
  const ws = new WebSocket(PUMPPORTAL_WS);

  ws.on("open", () => {
    ws.send(JSON.stringify({ method: "subscribeNewToken" }));
    console.log("PumpPortal: subscribed to new token feed");
  });

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch (err) {
      console.error("PumpPortal: failed to parse message", err);
      return;
    }
    if (data.txType === "create" && data.mint) {
      onToken(data);
    }
  });

  ws.on("close", () => {
    console.warn("PumpPortal: connection closed, reconnecting in 3s");
    setTimeout(() => listenForNewTokens(onToken), 3000);
  });

  ws.on("error", (err) => {
    console.error("PumpPortal: websocket error", err.message);
  });

  return ws;
}
