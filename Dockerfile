# Bounty-bot Service - Dockerfile
# GitHub bounty validation service, controlled by Atlas via REST API

FROM node:22-slim

# Install system dependencies for better-sqlite3 native module and health checks
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    sqlite3 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files first for better Docker layer caching
COPY package*.json ./

# Install dependencies with native build flags
RUN npm ci --unsafe-perm || npm install --unsafe-perm

# Copy TypeScript config and source
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# Create required directories
RUN mkdir -p /app/data

# Environment defaults
ENV NODE_ENV=production
ENV PORT=3235
ENV DATA_DIR=/app/data

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3235/health || exit 1

# Run the service
CMD ["node", "dist/index.js"]
