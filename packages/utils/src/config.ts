import { z } from "zod";

const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().url(),

  // Redis
  REDIS_URL: z.string().url(),

  // S3
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default("us-east-1"),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET_RAW: z.string().default("raw-videos"),
  S3_BUCKET_PROCESSED: z.string().default("processed-videos"),
  S3_FORCE_PATH_STYLE: z
    .string()
    .transform((v) => v === "true")
    .default("true"),

  // API
  API_PORT: z.coerce.number().default(3001),
  API_CORS_ORIGIN: z.string().default("http://localhost:3000"),

  // Worker
  WORKER_CONCURRENCY: z.coerce.number().default(2),
  WORKER_MAX_RETRIES: z.coerce.number().default(3),
  WORKER_JOB_TIMEOUT: z.coerce.number().default(300_000),

  // Rate limiting
  RATE_LIMIT_UPLOADS_PER_HOUR: z.coerce.number().default(10),
  RATE_LIMIT_UPLOADS_PER_DAY: z.coerce.number().default(50),
  RATE_LIMIT_CONCURRENT_JOBS: z.coerce.number().default(5),
  RATE_LIMIT_REQUESTS_PER_MINUTE: z.coerce.number().default(100),
  RATE_LIMIT_WS_CONNECTIONS_PER_IP: z.coerce.number().default(25),

  // Upload
  MAX_FILE_SIZE_MB: z.coerce.number().default(500),
  MAX_PRESIGNED_URL_TTL_SECONDS: z.coerce.number().default(900),
  RAW_VIDEO_RETENTION_DAYS: z.coerce.number().default(7),

  // Node env
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
});

export type Env = z.infer<typeof envSchema>;

let cachedConfig: Env | null = null;

export function getConfig(): Env {
  if (cachedConfig) return cachedConfig;
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const formatted = result.error.flatten().fieldErrors;
    const missing = Object.entries(formatted)
      .map(([key, errors]) => `  ${key}: ${errors?.join(", ")}`)
      .join("\n");
    throw new Error(`Invalid environment variables:\n${missing}`);
  }

  cachedConfig = result.data;
  return cachedConfig;
}

/** Reset cached config — useful for testing */
export function resetConfig(): void {
  cachedConfig = null;
}
