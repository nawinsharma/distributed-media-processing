import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import Redis from "ioredis";
import { getConfig, createLogger, websocketMessageSchema } from "@repo/utils";
import { prisma } from "@repo/db";

const logger = createLogger("websocket");

/** Map of jobId → Set of WebSocket clients watching that job */
const subscriptions = new Map<string, Set<WebSocket>>();
const connectionsByIp = new Map<string, number>();

/**
 * Set up WebSocket server for real-time job progress updates.
 *
 * Protocol:
 *   Client sends:  { "type": "subscribe", "jobId": "..." }
 *   Client sends:  { "type": "unsubscribe", "jobId": "..." }
 *   Server sends:  { "type": "progress", "jobId": "...", "progress": N, "status": "..." }
 */
export function setupWebSocket(httpServer: Server): void {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  // Subscribe to Redis Pub/Sub for progress updates from workers
  const config = getConfig();
  const subscriber = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
  });

  subscriber.subscribe("job-progress", (err) => {
    if (err) {
      logger.error({ err }, "Failed to subscribe to job-progress channel");
    } else {
      logger.info("Subscribed to job-progress Redis channel");
    }
  });

  subscriber.on("message", (_channel: string, message: string) => {
    try {
      const data = JSON.parse(message) as {
        jobId: string;
        progress: number;
        status: string;
      };

      const watchers = subscriptions.get(data.jobId);
      if (!watchers || watchers.size === 0) return;

      const payload = JSON.stringify({
        type: "progress",
        jobId: data.jobId,
        progress: data.progress,
        status: data.status,
      });

      for (const client of watchers) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(payload);
        }
      }
    } catch (err) {
      logger.error({ err }, "Failed to parse progress message");
    }
  });

  wss.on("connection", (ws, request) => {
    const socket = ws as WebSocket & { _ip?: string };
    const ip = request.socket.remoteAddress ?? "unknown";
    socket._ip = ip;
    const totalConnectionsForIp = (connectionsByIp.get(ip) ?? 0) + 1;
    connectionsByIp.set(ip, totalConnectionsForIp);
    if (totalConnectionsForIp > config.RATE_LIMIT_WS_CONNECTIONS_PER_IP) {
      socket.close(1008, "Connection limit exceeded");
      return;
    }

    logger.debug("WebSocket client connected");

    ws.on("message", (raw) => {
      void (async () => {
        const parsedMessage = websocketMessageSchema.safeParse(
          JSON.parse(raw.toString())
        );
        if (!parsedMessage.success) {
          ws.send(JSON.stringify({ type: "error", message: "Invalid message format" }));
          return;
        }

        const msg = parsedMessage.data;
        if (msg.type === "subscribe") {
          const dbJob = await prisma.videoJob.findUnique({
            where: { id: msg.jobId },
            select: { id: true, userId: true },
          });
          if (!dbJob) {
            ws.send(JSON.stringify({ type: "error", message: "Job not found" }));
            return;
          }
          if (dbJob.userId && dbJob.userId !== msg.userId) {
            ws.send(JSON.stringify({ type: "error", message: "Unauthorized subscription" }));
            return;
          }

          let watchers = subscriptions.get(msg.jobId);
          if (!watchers) {
            watchers = new Set();
            subscriptions.set(msg.jobId, watchers);
          }
          watchers.add(ws);
          logger.debug({ jobId: msg.jobId }, "Client subscribed to job");
        }

        if (msg.type === "unsubscribe") {
          const watchers = subscriptions.get(msg.jobId);
          if (watchers) {
            watchers.delete(ws);
            if (watchers.size === 0) {
              subscriptions.delete(msg.jobId);
            }
          }
        }
      })().catch(() => {
        ws.send(JSON.stringify({ type: "error", message: "Failed to process message" }));
      });
    });

    ws.on("close", () => {
      // Clean up all subscriptions for this client
      for (const [jobId, watchers] of subscriptions.entries()) {
        watchers.delete(ws);
        if (watchers.size === 0) {
          subscriptions.delete(jobId);
        }
      }
      const currentIp = socket._ip ?? "unknown";
      const currentCount = connectionsByIp.get(currentIp) ?? 0;
      if (currentCount <= 1) {
        connectionsByIp.delete(currentIp);
      } else {
        connectionsByIp.set(currentIp, currentCount - 1);
      }
    });

    // Send initial connection confirmation
    ws.send(JSON.stringify({ type: "connected" }));
  });

  logger.info("WebSocket server initialized on /ws");
}
