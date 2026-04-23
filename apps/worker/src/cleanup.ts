import { getConfig, createLogger, deleteFile } from "@repo/utils";
import { prisma, JobStatusEnum } from "@repo/db";

const logger = createLogger("cleanup");

/**
 * Clean up old raw uploads and failed job outputs.
 *
 * Run as a scheduled task (e.g., daily cron):
 *   bun run apps/worker/src/cleanup.ts
 */
async function runCleanup() {
  const config = getConfig();
  logger.info("Starting cleanup...");

  const retentionDays = Math.max(1, config.RAW_VIDEO_RETENTION_DAYS);
  const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  const oldJobs = await prisma.videoJob.findMany({
    where: {
      createdAt: { lt: cutoffDate },
      status: {
        in: [JobStatusEnum.COMPLETED, JobStatusEnum.FAILED, JobStatusEnum.CANCELLED],
      },
    },
    select: {
      id: true,
      inputKey: true,
      status: true,
      outputKeys: true,
    },
  });

  logger.info({ count: oldJobs.length }, "Found old jobs to clean up");

  let cleaned = 0;
  let errors = 0;

  for (const job of oldJobs) {
    try {
      // Delete raw input (idempotent if object already removed).
      await deleteFile(config.S3_BUCKET_RAW, job.inputKey);

      // Delete failed job outputs
      if (job.status === JobStatusEnum.FAILED && job.outputKeys) {
        const keys = job.outputKeys as Record<string, string>;
        for (const key of Object.values(keys)) {
          if (key) {
            await deleteFile(config.S3_BUCKET_PROCESSED, key);
          }
        }
      }

      cleaned++;
    } catch (err) {
      errors++;
      logger.warn({ jobId: job.id, err }, "Failed to clean up job files");
    }
  }

  logger.info({ cleaned, errors, total: oldJobs.length }, "Cleanup complete");
}

runCleanup().catch((err) => {
  logger.error({ err }, "Cleanup failed");
  process.exit(1);
});
