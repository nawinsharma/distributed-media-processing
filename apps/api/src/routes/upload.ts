import { Router } from "express";
import type { Router as ExpressRouter } from "express";
import { randomUUID } from "node:crypto";
import {
  getConfig,
  getPresignedUploadUrl,
  uploadUrlRequestSchema,
  ALLOWED_MIME_TYPES,
} from "@repo/utils";
import { createLogger } from "@repo/utils";

const logger = createLogger("upload-route");

export const uploadRouter: ExpressRouter = Router();

/**
 * POST /api/upload-url
 *
 * Generates a pre-signed S3 URL for direct client upload.
 * This avoids routing large video files through the API server.
 */
uploadRouter.post("/upload-url", async (req, res, next) => {
  try {
    const config = getConfig();
    const maxFileSize = config.MAX_FILE_SIZE_MB * 1024 * 1024;

    const parsed = uploadUrlRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { fileName, contentType, fileSize } = parsed.data;

    // Enforce file size limit
    if (fileSize > maxFileSize) {
      res.status(400).json({
        error: `File size exceeds maximum of ${config.MAX_FILE_SIZE_MB}MB`,
      });
      return;
    }

    // Generate unique S3 key
    const extIndex = fileName.lastIndexOf(".");
    const ext = extIndex >= 0 ? fileName.slice(extIndex).toLowerCase() : ".mp4";
    const fileKey = `uploads/${randomUUID()}${ext}`;

    const { url, expiresIn } = await getPresignedUploadUrl(
      config.S3_BUCKET_RAW,
      fileKey,
      contentType,
      fileSize,
      config.MAX_PRESIGNED_URL_TTL_SECONDS
    );

    logger.info({ fileKey, contentType, fileSize }, "Generated upload URL");

    res.json({
      uploadUrl: url,
      fileKey,
      expiresIn,
      maxFileSize: maxFileSize,
      allowedTypes: ALLOWED_MIME_TYPES,
    });
  } catch (err) {
    next(err);
  }
});
