import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginHttpRouteHandler } from "openclaw/plugin-sdk/plugin-entry";
import type { EventBus } from "./event-bus.js";

export function createSseStreamHandler(params: {
  bus: EventBus;
  maxSubscribers: number;
  heartbeatMs: number;
}): OpenClawPluginHttpRouteHandler {
  return async (req: IncomingMessage, res: ServerResponse) => {
    // Atomic check-and-add via bus.subscribe — see event-bus.ts for why
    // we don't split into a size() + subscribe() pair anymore.
    const unsubscribe = params.bus.subscribe(({ event, capturedAt }) => {
      try {
        const payload = JSON.stringify({ capturedAt, event });
        res.write(`event: diagnostic\ndata: ${payload}\n\n`);
      } catch {
        // socket likely closed
      }
    });
    if (!unsubscribe) {
      res.statusCode = 503;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "too_many_subscribers" }));
      return true;
    }
    void params.maxSubscribers; // capacity enforced by bus itself now
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    res.write(`retry: 5000\n\n`);
    res.write(`: connected ${new Date().toISOString()}\n\n`);

    const heartbeat = setInterval(() => {
      try {
        res.write(`: heartbeat ${Date.now()}\n\n`);
      } catch {
        // client likely gone; cleanup runs on close
      }
    }, params.heartbeatMs);
    heartbeat.unref?.();

    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      try {
        res.end();
      } catch {
        // already ended
      }
    };

    req.on("close", close);
    req.on("error", close);

    return true;
  };
}
