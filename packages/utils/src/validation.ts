import { z } from "zod";

/** Allowed video MIME types for upload */
export const ALLOWED_MIME_TYPES = [
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-msvideo",
  "video/x-matroska",
] as const;

export const ALLOWED_EXTENSIONS = [
  ".mp4",
  ".webm",
  ".mov",
  ".avi",
  ".mkv",
] as const;

// --- Upload URL Request ---
export const uploadUrlRequestSchema = z.object({
  fileName: z
    .string()
    .min(1, "File name is required")
    .max(255, "File name too long")
    .refine(
      (name) => {
        const ext = name.toLowerCase().slice(name.lastIndexOf("."));
        return (ALLOWED_EXTENSIONS as readonly string[]).includes(ext);
      },
      { message: "Unsupported file extension" }
    ),
  contentType: z.enum(ALLOWED_MIME_TYPES, {
    errorMap: () => ({ message: "Unsupported video format" }),
  }),
  fileSize: z
    .number()
    .int()
    .positive("File size must be positive"),
});

export type UploadUrlRequest = z.infer<typeof uploadUrlRequestSchema>;

// --- Create Job Request ---
export const createJobSchema = z.object({
  inputKey: z
    .string()
    .min(1, "Input key is required")
    .max(1024, "Input key too long")
    .refine(
      (key) =>
        !key.includes("..") &&
        !key.startsWith("/") &&
        key.startsWith("uploads/"),
      { message: "Invalid S3 key — must be inside uploads/ namespace" }
    ),
  requestId: z
    .string()
    .uuid("Request ID must be a valid UUID"),
  userId: z.string().optional(),
  priority: z
    .number()
    .int()
    .min(0)
    .max(10)
    .default(0),
});

export type CreateJobRequest = z.infer<typeof createJobSchema>;

// --- Job Response ---
export const jobResponseSchema = z.object({
  id: z.string().uuid(),
  status: z.enum([
    "CREATED",
    "QUEUED",
    "PROCESSING",
    "RETRYING",
    "COMPLETED",
    "FAILED",
    "CANCELLED",
  ]),
  progress: z.number().int().min(0).max(100),
  attempts: z.number().int(),
  duration: z.number().nullable(),
  resolution: z.string().nullable(),
  outputKeys: z
    .object({
      video: z.string().optional(),
      thumbnail: z.string().optional(),
      gif: z.string().optional(),
    })
    .nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type JobResponse = z.infer<typeof jobResponseSchema>;

// --- Jobs List Query ---
export const jobsListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z
    .enum([
      "CREATED",
      "QUEUED",
      "PROCESSING",
      "RETRYING",
      "COMPLETED",
      "FAILED",
      "CANCELLED",
    ])
    .optional(),
  userId: z.string().optional(),
});

export type JobsListQuery = z.infer<typeof jobsListQuerySchema>;

export const websocketMessageSchema = z.object({
  type: z.enum(["subscribe", "unsubscribe"]),
  jobId: z.string().uuid(),
  userId: z.string().optional(),
});
