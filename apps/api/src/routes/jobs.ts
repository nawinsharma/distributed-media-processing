import { Router } from "express";
import type { Router as ExpressRouter } from "express";
import {
  getConfig,
  createJobSchema,
  jobsListQuerySchema,
  headObject,
  getPresignedDownloadUrl,
  createLogger,
  ALLOWED_MIME_TYPES,
} from "@repo/utils";
import { prisma, JobStatusEnum } from "@repo/db";
import { getQueue } from "../services/queue.js";

const logger = createLogger("jobs-route");

export const jobsRouter: ExpressRouter = Router();

/**
 * POST /api/job
 *
 * Creates a processing job for an uploaded video.
 * Validates the S3 key exists, creates a DB record, and enqueues the job.
 */
jobsRouter.post("/job", async (req, res, next) => {
  try {
    const config = getConfig();

    const parsed = createJobSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { inputKey, requestId, userId, priority } = parsed.data;

    // Idempotency check
    const existing = await prisma.videoJob.findUnique({
      where: { requestId },
    });
    if (existing) {
      res.status(200).json({
        jobId: existing.id,
        status: existing.status,
        message: "Job already exists",
      });
      return;
    }

    // Check concurrent job limit per user
    if (userId) {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const uploadsToday = await prisma.videoJob.count({
        where: {
          userId,
          createdAt: { gte: startOfDay },
        },
      });
      if (uploadsToday >= config.RATE_LIMIT_UPLOADS_PER_DAY) {
        res.status(429).json({
          error: "Daily upload quota exceeded",
          maxUploadsPerDay: config.RATE_LIMIT_UPLOADS_PER_DAY,
          uploadsToday,
        });
        return;
      }

      const activeJobs = await prisma.videoJob.count({
        where: {
          userId,
          status: {
            in: [
              JobStatusEnum.CREATED,
              JobStatusEnum.QUEUED,
              JobStatusEnum.PROCESSING,
              JobStatusEnum.RETRYING,
            ],
          },
        },
      });

      if (activeJobs >= config.RATE_LIMIT_CONCURRENT_JOBS) {
        res.status(429).json({
          error: "Too many concurrent jobs",
          maxConcurrent: config.RATE_LIMIT_CONCURRENT_JOBS,
          activeJobs,
        });
        return;
      }
    }

    // Verify file exists in S3
    const headResult = await headObject(config.S3_BUCKET_RAW, inputKey);
    if (!headResult.exists) {
      res.status(404).json({ error: "File not found in storage" });
      return;
    }
    if (
      !headResult.contentType ||
      !(ALLOWED_MIME_TYPES as readonly string[]).includes(headResult.contentType)
    ) {
      res.status(400).json({ error: "Unsupported or missing content type in storage object" });
      return;
    }

    // Create job record
    const job = await prisma.videoJob.create({
      data: {
        requestId,
        inputKey,
        userId,
        priority,
        payloadVersion: 1,
        status: JobStatusEnum.QUEUED,
        fileSize: headResult.contentLength,
        mimeType: headResult.contentType,
      },
    });

    // Enqueue to BullMQ
    const queue = getQueue();
    await queue.add(
      "process-video",
      {
        jobId: job.id,
        inputKey: job.inputKey,
        priority: job.priority,
        payloadVersion: 1,
        userId: job.userId ?? undefined,
      },
      {
        jobId: job.id,
        priority: job.priority,
      }
    );

    logger.info({ jobId: job.id, inputKey }, "Job created and enqueued");

    res.status(201).json({
      jobId: job.id,
      status: job.status,
      createdAt: job.createdAt.toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/job/:id
 *
 * Returns job status, progress, and output URLs.
 */
jobsRouter.get("/job/:id", async (req, res, next) => {
  try {
    const config = getConfig();
    const job = await prisma.videoJob.findUnique({
      where: { id: req.params["id"] },
    });

    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    // Generate download URLs for outputs
    let outputUrls: Record<string, string> | null = null;
    if (job.outputKeys && job.status === JobStatusEnum.COMPLETED) {
      const keys = job.outputKeys as Record<string, string>;
      outputUrls = {};
      for (const [type, key] of Object.entries(keys)) {
        if (key) {
          outputUrls[type] = await getPresignedDownloadUrl(
            config.S3_BUCKET_PROCESSED,
            key
          );
        }
      }
    }

    res.json({
      id: job.id,
      status: job.status,
      progress: job.progress,
      attempts: job.attempts,
      duration: job.duration,
      resolution: job.resolution,
      codec: job.codec,
      fileSize: job.fileSize,
      outputUrls,
      errorMessage: job.errorMessage,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
      startedAt: job.startedAt?.toISOString() ?? null,
      completedAt: job.completedAt?.toISOString() ?? null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/jobs
 *
 * Lists jobs with pagination and optional filtering.
 */
jobsRouter.get("/jobs", async (req, res, next) => {
  try {
    const parsed = jobsListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid query parameters",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { page, limit, status, userId } = parsed.data;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};
    if (status) where["status"] = status;
    if (userId) where["userId"] = userId;

    const [jobs, total] = await Promise.all([
      prisma.videoJob.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          status: true,
          progress: true,
          attempts: true,
          duration: true,
          resolution: true,
          fileSize: true,
          errorMessage: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.videoJob.count({ where }),
    ]);

    res.json({
      jobs,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/job/:id/cancel
 *
 * Cancels a pending or queued job.
 */
jobsRouter.post("/job/:id/cancel", async (req, res, next) => {
  try {
    const job = await prisma.videoJob.findUnique({
      where: { id: req.params["id"] },
    });

    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    const cancellableStatuses: Set<typeof job.status> = new Set([
      JobStatusEnum.CREATED,
      JobStatusEnum.QUEUED,
    ]);

    if (!cancellableStatuses.has(job.status)) {
      res.status(409).json({
        error: "Job cannot be cancelled in its current state",
        currentStatus: job.status,
      });
      return;
    }

    // Remove from queue
    const queue = getQueue();
    const bullJob = await queue.getJob(job.id);
    if (bullJob) {
      await bullJob.remove();
    }

    // Update DB
    await prisma.videoJob.update({
      where: { id: job.id },
      data: { status: JobStatusEnum.CANCELLED },
    });

    logger.info({ jobId: job.id }, "Job cancelled");

    res.json({ id: job.id, status: "CANCELLED" });
  } catch (err) {
    next(err);
  }
});
