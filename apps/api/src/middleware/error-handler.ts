import type { Request, Response, NextFunction } from "express";
import { createLogger } from "@repo/utils";

const logger = createLogger("error-handler");

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  logger.error({ err }, "Unhandled error");

  // Prisma known request error
  if (err.constructor.name === "PrismaClientKnownRequestError") {
    res.status(409).json({
      error: "Database conflict",
      message: "A resource with the same unique constraint already exists",
    });
    return;
  }

  // Zod validation error
  if (err.constructor.name === "ZodError") {
    res.status(400).json({
      error: "Validation error",
      message: err.message,
    });
    return;
  }

  // Default
  const statusCode = "statusCode" in err ? (err as { statusCode: number }).statusCode : 500;
  res.status(statusCode).json({
    error: "Internal server error",
    message:
      process.env["NODE_ENV"] === "production"
        ? "An unexpected error occurred"
        : err.message,
  });
}
