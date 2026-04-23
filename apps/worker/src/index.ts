import { Worker } from "bullmq";
import Redis from "ioredis";
import { getConfig, createLogger } from "@repo/utils";
import { processVideoJob } from "./processor.js";

import type { VideoJobPayload } from "./types.js";

const logger = createLogger("worker");
const VIDEO_PROCESSING_QUEUE_NAME = "video-processing";

async function main() {
  const config = getConfig();

  const connection = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  connection.on("error", (err) => {
    logger.error({ err }, "Redis connection error");
  });

  const worker = new Worker<VideoJobPayload>(
    VIDEO_PROCESSING_QUEUE_NAME,
    async (job) => {
      logger.info(
        { jobId: job.data.jobId, attempt: job.attemptsMade + 1 },
        "Processing job"
      );
      await processVideoJob(job);
    },
    {
      connection,
      concurrency: config.WORKER_CONCURRENCY,
      lockDuration: config.WORKER_JOB_TIMEOUT,
      settings: {
        backoffStrategy: (attemptsMade: number) => {
          // Attempt 1 → 0ms, Attempt 2 → 5s, Attempt 3 → 30s
          const delays = [0, 5000, 30000];
          return delays[attemptsMade] ?? 30000;
        },
      },
    }
  );

  worker.on("completed", (job) => {
    logger.info({ jobId: job?.data.jobId }, "Job completed successfully");
  });

  worker.on("failed", (job, err) => {
    logger.error(
      { jobId: job?.data.jobId, err, attempts: job?.attemptsMade },
      "Job failed"
    );
  });

  worker.on("error", (err) => {
    logger.error({ err }, "Worker error");
  });

  worker.on("stalled", (jobId) => {
    logger.warn({ jobId }, "Job stalled — another worker may pick it up");
  });

  logger.info(
    { concurrency: config.WORKER_CONCURRENCY },
    "Worker started and listening for jobs"
  );

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down worker...");
    await worker.close();
    connection.disconnect();
    logger.info("Worker shut down");
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  logger.error({ err }, "Failed to start worker");
  process.exit(1);
});
