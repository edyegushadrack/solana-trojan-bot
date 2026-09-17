import WebSocket from "ws";

const PUMPPORTAL_WS = "wss://pumpportal.fun/api/data";

/**
 * Subscribes to PumpPortal's new-token-creation feed and calls onToken for
 * every launch. Auto-reconnects on an unexpected close, but NOT after an
 * intentional one (see the bug this fixes, below) — it needs to stay up
 * indefinitely while sniping is on, and go away cleanly when it's not.
 *
 * BUG THIS FIXES: the previous version reconnected on every close
 * unconditionally, with no way to know the caller had intentionally closed
 * it (e.g. via stopSnipeEngine). Every /snipe off -> /snipe on cycle left
 * the OLD connection's scheduled reconnect still pending; it would fire 3s
 * later, creating a new connection nobody was tracking anymore, forever
 * calling the same onToken callback. Repeated on/off cycles compounded
 * this into several orphaned connections all firing for the same events —
 * which is why the same mint was getting bought twice (or more) in
 * testing. In real (non-paper) mode this would have meant actually
 * double-spending real SOL on the same token.
 *
 * Same feed the meme-scanner already listens to — if you extract a shared
 * package later, this file is the one to delete in favor of that.
 */
export function listenForNewTokens(onToken) {
  let intentionallyClosed = false;
  let currentWs = null;
  let pendingReconnect = null;

  function connect() {
    const ws = new WebSocket(PUMPPORTAL_WS);
    currentWs = ws;

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
      if (intentionallyClosed) return; // asked for this — don't reconnect
      console.warn("PumpPortal: connection closed, reconnecting in 3s");
      pendingReconnect = setTimeout(connect, 3000);
    });

    ws.on("error", (err) => {
      console.error("PumpPortal: websocket error", err.message);
    });
  }

  connect();

  return {
    close() {
      intentionallyClosed = true;
      clearTimeout(pendingReconnect); // in case close() lands during the 3s reconnect delay
      currentWs?.close();
    },
  };
}
