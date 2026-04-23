import { Queue, QueueEvents } from "bullmq";
import Redis from "ioredis";
import { getConfig, createLogger } from "@repo/utils";

const logger = createLogger("queue");

let queue: Queue | null = null;
let queueEvents: QueueEvents | null = null;
let redisConnection: Redis | null = null;

export interface VideoJobPayload {
  jobId: string;
  inputKey: string;
  priority: number;
  payloadVersion: 1;
  userId?: string;
}

export const VIDEO_PROCESSING_QUEUE_NAME = "video-processing";

function getRedisConnection(): Redis {
  if (redisConnection) return redisConnection;
  const config = getConfig();

  redisConnection = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  redisConnection.on("error", (err) => {
    logger.error({ err }, "Redis connection error");
  });

  return redisConnection;
}

export function getQueue(): Queue<VideoJobPayload> {
  if (queue) return queue;

  const connection = getRedisConnection();
  const config = getConfig();

  queue = new Queue<VideoJobPayload>(VIDEO_PROCESSING_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 50 },
      attempts: config.WORKER_MAX_RETRIES,
      backoff: { type: "custom" },
    },
  });

  logger.info("BullMQ queue initialized");
  return queue;
}

export function getQueueEvents(): QueueEvents {
  if (queueEvents) return queueEvents;
  const connection = getRedisConnection();
  queueEvents = new QueueEvents(VIDEO_PROCESSING_QUEUE_NAME, { connection });
  queueEvents.on("completed", ({ jobId }) => {
    logger.info({ jobId }, "Queue job completed");
  });
  queueEvents.on("failed", ({ jobId, failedReason }) => {
    logger.warn({ jobId, failedReason }, "Queue job failed");
  });
  queueEvents.on("error", (err) => {
    logger.error({ err }, "Queue events error");
  });
  return queueEvents;
}

/**
 * Publish a progress update via Redis Pub/Sub.
 * The WebSocket server subscribes to this channel.
 */
export async function publishProgress(
  jobId: string,
  progress: number,
  status: string
): Promise<void> {
  const connection = getRedisConnection();
  await connection.publish(
    "job-progress",
    JSON.stringify({ jobId, progress, status })
  );
}

export async function closeQueue(): Promise<void> {
  if (queueEvents) {
    await queueEvents.close();
    queueEvents = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
  if (redisConnection) {
    redisConnection.disconnect();
    redisConnection = null;
  }
}
