import type { ProcessingOptions, VideoMetadata } from "@repo/utils";

/**
 * Determine adaptive FFmpeg processing settings based on video metadata.
 *
 * Rules:
 * - Resolution > 1080p → scale down to 1080p
 * - Duration > 10 min → higher CRF (more compression)
 * - Default: CRF 28, preset "fast"
 */
export function getAdaptiveSettings(metadata: VideoMetadata): ProcessingOptions {
  let crf = 28;
  let maxWidth = 0;
  let maxHeight = 0;
  let preset = "fast";

  // Scale down large resolutions
  if (metadata.height > 1080 || metadata.width > 1920) {
    maxWidth = 1920;
    maxHeight = 1080;
  }

  // Increase compression for longer videos
  if (metadata.duration > 600) {
    // > 10 minutes
    crf = 32;
    preset = "veryfast";
  } else if (metadata.duration > 300) {
    // > 5 minutes
    crf = 30;
  }

  if (metadata.bitrate > 8_000_000) {
    crf = Math.min(34, crf + 2);
  }

  return { crf, preset, maxWidth, maxHeight };
}

/**
 * Determine the best thumbnail timestamp.
 * Tries to use 10% of the video duration (at least 1 second).
 */
export function getThumbnailTimestamp(duration: number): string {
  const seconds = Math.max(1, Math.floor(duration * 0.1));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}
