import express from "express";
import cors from "cors";
import helmet from "helmet";
import { createServer } from "node:http";
import { createLogger, getConfig } from "@repo/utils";
import Redis from "ioredis";
import { prisma } from "@repo/db";
import { uploadRouter } from "./routes/upload.js";
import { jobsRouter } from "./routes/jobs.js";
import { setupWebSocket } from "./services/websocket.js";
import { createRateLimiter } from "./middleware/rate-limiter.js";
import { getQueue, getQueueEvents } from "./services/queue.js";
import { errorHandler } from "./middleware/error-handler.js";

const logger = createLogger("api");

async function main() {
  const config = getConfig();
  const app = express();
  const httpServer = createServer(app);

  // --- Middleware ---
  app.use(helmet());
  app.use(cors({ origin: config.API_CORS_ORIGIN, credentials: true }));
  app.use(express.json({ limit: "1mb" }));
  app.use(createRateLimiter(config));

  // --- Health check ---
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.get("/ready", async (_req, res) => {
    const readiness = {
      database: false,
      redis: false,
      queue: false,
    };

    try {
      await prisma.$queryRaw`SELECT 1`;
      readiness.database = true;
    } catch {}

    try {
      const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1 });
      const pong = await redis.ping();
      readiness.redis = pong === "PONG";
      redis.disconnect();
    } catch {}

    try {
      const queue = getQueue();
      await queue.waitUntilReady();
      readiness.queue = true;
    } catch {}

    const isReady = readiness.database && readiness.redis && readiness.queue;
    res.status(isReady ? 200 : 503).json({ status: isReady ? "ready" : "degraded", readiness });
  });

  app.get("/metrics", async (_req, res, next) => {
    try {
      const queue = getQueue();
      const counts = await queue.getJobCounts(
        "waiting",
        "active",
        "delayed",
        "failed",
        "completed"
      );
      res.json({ queue: counts, timestamp: new Date().toISOString() });
    } catch (err) {
      next(err);
    }
  });

  // --- Routes ---
  app.use("/api", uploadRouter);
  app.use("/api", jobsRouter);

  // --- Error handler ---
  app.use(errorHandler);

  // --- WebSocket ---
  setupWebSocket(httpServer);
  getQueueEvents();

  // --- Start server ---
  httpServer.listen(config.API_PORT, () => {
    logger.info(`API server running on port ${config.API_PORT}`);
  });

  // --- Graceful shutdown ---
  const shutdown = async () => {
    logger.info("Shutting down gracefully...");
    httpServer.close(() => {
      logger.info("HTTP server closed");
      process.exit(0);
    });

    setTimeout(() => {
      logger.error("Forced shutdown after timeout");
      process.exit(1);
    }, 10_000);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  logger.error({ err }, "Failed to start API server");
  process.exit(1);
});
