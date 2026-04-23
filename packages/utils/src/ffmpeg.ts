import { spawn } from "node:child_process";
import { createLogger } from "./logger.js";

const logger = createLogger("ffmpeg");

export interface VideoMetadata {
  duration: number;
  width: number;
  height: number;
  codec: string;
  bitrate: number;
  fps: number;
  format: string;
}

export interface ProcessingOptions {
  crf: number;
  preset: string;
  maxWidth: number;
  maxHeight: number;
}

/**
 * Probe a video file using ffprobe to extract metadata.
 */
export async function probe(filePath: string): Promise<VideoMetadata> {
  return new Promise((resolve, reject) => {
    const args = [
      "-v", "quiet",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      filePath,
    ];

    const proc = spawn("ffprobe", args);
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe exited with code ${code}: ${stderr}`));
        return;
      }

      try {
        const data = JSON.parse(stdout) as {
          streams: Array<{
            codec_type: string;
            codec_name: string;
            width?: number;
            height?: number;
            r_frame_rate?: string;
            bit_rate?: string;
          }>;
          format: {
            duration?: string;
            bit_rate?: string;
            format_name?: string;
          };
        };

        const videoStream = data.streams.find((s) => s.codec_type === "video");
        if (!videoStream) {
          reject(new Error("No video stream found in file"));
          return;
        }

        const fpsStr = videoStream.r_frame_rate ?? "30/1";
        const [num, den] = fpsStr.split("/").map(Number);
        const fps = den && den > 0 ? (num ?? 30) / den : 30;

        resolve({
          duration: parseFloat(data.format.duration ?? "0"),
          width: videoStream.width ?? 0,
          height: videoStream.height ?? 0,
          codec: videoStream.codec_name ?? "unknown",
          bitrate: parseInt(data.format.bit_rate ?? "0", 10),
          fps,
          format: data.format.format_name ?? "unknown",
        });
      } catch (err) {
        reject(new Error(`Failed to parse ffprobe output: ${err}`));
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn ffprobe: ${err.message}`));
    });
  });
}

/**
 * Parse FFmpeg progress from stderr line.
 * Returns progress percentage (0-100) or null if not a progress line.
 */
export function parseProgress(
  line: string,
  totalDuration: number
): number | null {
  if (totalDuration <= 0) return null;

  const timeMatch = /time=(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/.exec(line);
  if (!timeMatch) return null;

  const hours = parseInt(timeMatch[1] ?? "0", 10);
  const minutes = parseInt(timeMatch[2] ?? "0", 10);
  const seconds = parseInt(timeMatch[3] ?? "0", 10);
  const fractionRaw = timeMatch[4] ?? "";
  const fraction = fractionRaw.length > 0 ? Number(`0.${fractionRaw}`) : 0;

  const currentTime = hours * 3600 + minutes * 60 + seconds + fraction;
  const progress = Math.min(100, Math.round((currentTime / totalDuration) * 100));

  return progress;
}

/**
 * Compress a video file using FFmpeg.
 */
export async function compress(
  inputPath: string,
  outputPath: string,
  options: ProcessingOptions,
  onProgress?: (percent: number) => void,
  totalDuration?: number
): Promise<void> {
  const scaleFilter =
    options.maxWidth > 0 || options.maxHeight > 0
      ? `scale='min(${options.maxWidth},iw)':'min(${options.maxHeight},ih)':force_original_aspect_ratio=decrease`
      : null;

  const args = [
    "-i", inputPath,
    "-vcodec", "libx264",
    "-crf", String(options.crf),
    "-preset", options.preset,
    ...(scaleFilter ? ["-vf", scaleFilter] : []),
    "-movflags", "+faststart",
    "-y",
    outputPath,
  ];

  return runFFmpeg(args, onProgress, totalDuration);
}

/**
 * Generate a thumbnail image from a video.
 */
export async function generateThumbnail(
  inputPath: string,
  outputPath: string,
  timestamp = "00:00:01"
): Promise<void> {
  const args = [
    "-i", inputPath,
    "-ss", timestamp,
    "-vframes", "1",
    "-q:v", "2",
    "-y",
    outputPath,
  ];

  return runFFmpeg(args);
}

/**
 * Generate an animated GIF preview from a video.
 */
export async function generateGif(
  inputPath: string,
  outputPath: string,
  duration = 3,
  fps = 10,
  scale = 320
): Promise<void> {
  const args = [
    "-i", inputPath,
    "-t", String(duration),
    "-vf", `fps=${fps},scale=${scale}:-1:flags=lanczos`,
    "-y",
    outputPath,
  ];

  return runFFmpeg(args);
}

/**
 * Internal helper to run FFmpeg with optional progress tracking.
 */
function runFFmpeg(
  args: string[],
  onProgress?: (percent: number) => void,
  totalDuration?: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    logger.debug({ args }, "Spawning ffmpeg");

    const proc = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";

    proc.stderr?.on("data", (data: Buffer) => {
      const line = data.toString();
      stderr += line;

      if (onProgress && totalDuration && totalDuration > 0) {
        const progress = parseProgress(line, totalDuration);
        if (progress !== null) {
          onProgress(progress);
        }
      }
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        logger.error({ code, stderr: stderr.slice(-500) }, "FFmpeg failed");
        reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-500)}`));
        return;
      }
      resolve();
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn ffmpeg: ${err.message}`));
    });
  });
}
