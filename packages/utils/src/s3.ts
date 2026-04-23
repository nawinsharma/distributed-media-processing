import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createWriteStream } from "node:fs";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { getConfig } from "./config.js";

let s3Client: S3Client | null = null;

export function getS3Client(): S3Client {
  if (s3Client) return s3Client;
  const config = getConfig();

  s3Client = new S3Client({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    credentials: {
      accessKeyId: config.S3_ACCESS_KEY,
      secretAccessKey: config.S3_SECRET_KEY,
    },
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
  });

  return s3Client;
}

export async function getPresignedUploadUrl(
  bucket: string,
  key: string,
  contentType: string,
  maxSizeBytes: number,
  expiresIn = 3600
): Promise<{ url: string; key: string; expiresIn: number }> {
  const client = getS3Client();
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
    ContentLength: maxSizeBytes,
  });

  const url = await getSignedUrl(client, command, { expiresIn });
  return { url, key, expiresIn };
}

export async function getPresignedDownloadUrl(
  bucket: string,
  key: string,
  expiresIn = 3600
): Promise<string> {
  const client = getS3Client();
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  return getSignedUrl(client, command, { expiresIn });
}

export async function headObject(
  bucket: string,
  key: string
): Promise<{ exists: boolean; contentLength?: number; contentType?: string }> {
  const client = getS3Client();
  try {
    const response = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key })
    );
    return {
      exists: true,
      contentLength: response.ContentLength,
      contentType: response.ContentType,
    };
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      "name" in error &&
      error.name === "NotFound"
    ) {
      return { exists: false };
    }
    throw error;
  }
}

export async function downloadFile(
  bucket: string,
  key: string,
  destPath: string
): Promise<void> {
  const client = getS3Client();
  const response = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key })
  );

  if (!response.Body) {
    throw new Error(`Empty response body for s3://${bucket}/${key}`);
  }

  const writeStream = createWriteStream(destPath);
  await pipeline(response.Body as Readable, writeStream);
}

export async function uploadFile(
  bucket: string,
  key: string,
  body: Buffer | Readable,
  contentType?: string
): Promise<void> {
  const client = getS3Client();
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
}

export async function uploadFileFromPath(
  bucket: string,
  key: string,
  path: string,
  contentType?: string
): Promise<void> {
  await uploadFile(bucket, key, createReadStream(path), contentType);
}

export async function deleteFile(
  bucket: string,
  key: string
): Promise<void> {
  const client = getS3Client();
  await client.send(
    new DeleteObjectCommand({ Bucket: bucket, Key: key })
  );
}
