import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { Job } from "bullmq";
import Redis from "ioredis";
import {
  getConfig,
  createLogger,
  downloadFile,
  uploadFileFromPath,
  probe,
  compress,
  generateThumbnail,
  generateGif,
} from "@repo/utils";
import { prisma, JobStatusEnum } from "@repo/db";
import { getAdaptiveSettings, getThumbnailTimestamp } from "./adaptive.js";
import type { VideoJobPayload } from "./types.js";

const logger = createLogger("processor");

let redisPublisher: Redis | null = null;

function getPublisher(): Redis {
  if (redisPublisher) return redisPublisher;
  const config = getConfig();
  redisPublisher = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
  });
  return redisPublisher;
}

async function publishProgress(
  jobId: string,
  progress: number,
  status: string
): Promise<void> {
  const publisher = getPublisher();
  await publisher.publish(
    "job-progress",
    JSON.stringify({ jobId, progress, status })
  );
}

async function updateJobProgress(
  jobId: string,
  progress: number,
  status?: JobStatus
): Promise<void> {
  const data: Record<string, unknown> = { progress };
  if (status) data["status"] = status;

  await prisma.videoJob.update({ where: { id: jobId }, data });
  await publishProgress(jobId, progress, status ?? "PROCESSING");
}

function createProgressUpdater(jobId: string) {
  let lastProgress = -1;
  let lastSentAt = 0;
  const minGapMs = 1000;
  return async (progress: number, status?: JobStatus) => {
    const now = Date.now();
    if (progress === lastProgress && now - lastSentAt < minGapMs) {
      return;
    }
    if (now - lastSentAt < minGapMs && progress < 100) {
      return;
    }
    lastProgress = progress;
    lastSentAt = now;
    await updateJobProgress(jobId, progress, status);
  };
}

type JobStatus = typeof JobStatusEnum[keyof typeof JobStatusEnum];

/**
 * Main video processing pipeline.
 *
 * Steps:
 * 1. Download raw video from S3
 * 2. Probe with ffprobe (validate + extract metadata)
 * 3. Determine adaptive settings
 * 4. Compress video with progress tracking
 * 5. Generate thumbnail
 * 6. Generate GIF preview
 * 7. Upload all outputs to S3
 * 8. Update DB with output keys + COMPLETED
 * 9. Cleanup temp files
 */
export async function processVideoJob(
  job: Job<VideoJobPayload>
): Promise<void> {
  const { jobId, inputKey } = job.data;
  const config = getConfig();
  let tempDir: string | null = null;

  try {
    // Mark as PROCESSING
    const transitionResult = await prisma.videoJob.updateMany({
      where: {
        id: jobId,
        status: { in: [JobStatusEnum.QUEUED, JobStatusEnum.RETRYING] },
      },
      data: {
        status: JobStatusEnum.PROCESSING,
        attempts: job.attemptsMade + 1,
        startedAt: new Date(),
      },
    });
    if (transitionResult.count === 0) {
      throw new Error("Job is not in a processable state");
    }
    await publishProgress(jobId, 0, "PROCESSING");
    const sendProgress = createProgressUpdater(jobId);

    // Step 1: Create temp directory and download
    tempDir = await mkdtemp(join(tmpdir(), `dmp-${jobId}-`));
    const inputPath = join(tempDir, `input${getExtension(inputKey)}`);

    logger.info({ jobId, inputKey, tempDir }, "Downloading from S3");
    await downloadFile(config.S3_BUCKET_RAW, inputKey, inputPath);
    await sendProgress(10);

    // Step 2: Probe video
    logger.info({ jobId }, "Probing video metadata");
    const metadata = await probe(inputPath);
    logger.info({ jobId, metadata }, "Video metadata extracted");

    if (metadata.duration <= 0) {
      throw new Error("Invalid video: duration is 0 or negative");
    }

    // Update metadata in DB
    await prisma.videoJob.update({
      where: { id: jobId },
      data: {
        duration: metadata.duration,
        resolution: `${metadata.width}x${metadata.height}`,
        codec: metadata.codec,
      },
    });
    await sendProgress(15);

    // Step 3: Determine adaptive settings
    const settings = getAdaptiveSettings(metadata);
    logger.info({ jobId, settings }, "Adaptive settings determined");

    // Step 4: Compress video (progress: 15 → 70)
    const outputVideoPath = join(tempDir, "output.mp4");
    logger.info({ jobId }, "Starting video compression");

    await compress(
      inputPath,
      outputVideoPath,
      settings,
      async (percent) => {
        // Map FFmpeg progress (0–100) to our range (15–70)
        const mappedProgress = 15 + Math.round(percent * 0.55);
        await sendProgress(mappedProgress);
      },
      metadata.duration
    );
    await sendProgress(70);

    // Step 5: Generate thumbnail (progress: 70 → 80)
    const thumbnailPath = join(tempDir, "thumbnail.jpg");
    const thumbTimestamp = getThumbnailTimestamp(metadata.duration);
    logger.info({ jobId, timestamp: thumbTimestamp }, "Generating thumbnail");

    await generateThumbnail(inputPath, thumbnailPath, thumbTimestamp);
    await sendProgress(80);

    // Step 6: Generate GIF preview (progress: 80 → 90)
    const gifPath = join(tempDir, "preview.gif");
    logger.info({ jobId }, "Generating GIF preview");

    await generateGif(inputPath, gifPath);
    await sendProgress(90);

    // Step 7: Upload outputs to S3
    const outputId = randomUUID();
    const outputKeys = {
      video: `processed/${outputId}/video.mp4`,
      thumbnail: `processed/${outputId}/thumbnail.jpg`,
      gif: `processed/${outputId}/preview.gif`,
    };

    logger.info({ jobId, outputKeys }, "Uploading outputs to S3");

    await Promise.all([
      uploadFileFromPath(
        config.S3_BUCKET_PROCESSED,
        outputKeys.video,
        outputVideoPath,
        "video/mp4"
      ),
      uploadFileFromPath(
        config.S3_BUCKET_PROCESSED,
        outputKeys.thumbnail,
        thumbnailPath,
        "image/jpeg"
      ),
      uploadFileFromPath(
        config.S3_BUCKET_PROCESSED,
        outputKeys.gif,
        gifPath,
        "image/gif"
      ),
    ]);
    await sendProgress(95);

    // Step 8: Update DB with final status
    await prisma.videoJob.update({
      where: { id: jobId },
      data: {
        status: JobStatusEnum.COMPLETED,
        progress: 100,
        outputKeys,
        completedAt: new Date(),
      },
    });
    await publishProgress(jobId, 100, "COMPLETED");

    logger.info({ jobId }, "Job completed successfully");
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    logger.error({ jobId, error: errorMessage }, "Job processing failed");

    // Determine if we should retry
    const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 3);
    const status = isLastAttempt
      ? JobStatusEnum.FAILED
      : JobStatusEnum.RETRYING;

    await prisma.videoJob.update({
      where: { id: jobId },
      data: {
        status,
        errorMessage,
        attempts: job.attemptsMade + 1,
      },
    });
    await publishProgress(jobId, -1, status);

    throw error; // Re-throw so BullMQ handles retry
  } finally {
    // Step 9: Cleanup temp files
    if (tempDir) {
      try {
        await rm(tempDir, { recursive: true, force: true });
        logger.debug({ jobId, tempDir }, "Temp directory cleaned up");
      } catch (cleanupErr) {
        logger.warn({ jobId, cleanupErr }, "Failed to clean temp directory");
      }
    }
  }
}

function getExtension(key: string): string {
  const lastDot = key.lastIndexOf(".");
  return lastDot >= 0 ? key.slice(lastDot) : ".mp4";
}
