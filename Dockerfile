FROM node:20-slim

# Set by `docker buildx build --platform …` (amd64 / arm64); empty for a plain `docker build`
ARG TARGETARCH
# Set by scripts/release.sh; shown in the image labels
ARG VERSION=dev
ARG REVISION=unknown

LABEL org.opencontainers.image.title="Playdarr" \
      org.opencontainers.image.description="Synchronized movie, TV and Live TV watching from Plex" \
      org.opencontainers.image.source="https://github.com/tf-anguskong/Playdarr" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="$VERSION" \
      org.opencontainers.image.revision="$REVISION"

WORKDIR /app

# ffmpeg turns the HDHomeRun's MPEG-2/AC3 transport stream into browser-playable H.264/AAC.
# The VAAPI drivers plus vainfo are only used when LIVETV_HWACCEL=vaapi (iGPU encode, needs /dev/dri passed in —
# see docker-compose.vaapi.yml); otherwise ffmpeg encodes in software. AMD's (Mesa radeonsi) driver exists for
# every architecture; Intel's (media-driver / i965) only for x86-64, so ARM images skip them.
RUN sed -i 's/^Components: main$/Components: main non-free non-free-firmware/' /etc/apt/sources.list.d/debian.sources \
  && arch="${TARGETARCH:-$(dpkg --print-architecture)}" \
  && intel="" && if [ "$arch" = "amd64" ]; then intel="intel-media-va-driver-non-free i965-va-driver"; fi \
  && apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg vainfo mesa-va-drivers $intel \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src/ ./src/

RUN mkdir -p /data

EXPOSE 3000

CMD ["node", "src/server.js"]
