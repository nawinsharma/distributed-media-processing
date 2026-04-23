FROM oven/bun:1.3.8-alpine AS base

# Install FFmpeg
RUN apk add --no-cache ffmpeg

# Install dependencies
FROM base AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/worker/package.json ./apps/worker/
COPY packages/db/package.json ./packages/db/
COPY packages/utils/package.json ./packages/utils/
COPY packages/typescript-config/package.json ./packages/typescript-config/
RUN bun install --frozen-lockfile

# Build
FROM base AS runner
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /app/packages/utils/node_modules ./packages/utils/node_modules
COPY . .

# Generate Prisma client
RUN cd packages/db && bunx prisma generate

# Verify FFmpeg is available
RUN ffmpeg -version && ffprobe -version

USER bun

CMD ["bun", "run", "apps/worker/src/index.ts"]
