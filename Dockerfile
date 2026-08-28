FROM node:22-bookworm-slim

# better-sqlite3 ships prebuilt binaries; python3/make/g++ cover the fallback.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY scripts ./scripts

# Conversation data and WhatsApp credentials live here; mount a volume.
ENV DATA_DIR=/data
ENV HOST=0.0.0.0
ENV PORT=3000
RUN mkdir -p /data && chown -R node:node /data /app

USER node
EXPOSE 3000
CMD ["node", "src/index.js"]
