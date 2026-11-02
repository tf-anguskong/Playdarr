FROM node:20-slim

WORKDIR /app

# ffmpeg turns the HDHomeRun's MPEG-2/AC3 transport stream into browser-playable H.264/AAC.
# The Intel (media-driver / i965) and AMD (Mesa radeonsi) VAAPI drivers plus vainfo are only used
# when LIVETV_HWACCEL=vaapi (iGPU encode, needs /dev/dri passed in — see docker-compose.vaapi.yml);
# otherwise ffmpeg encodes in software.
RUN sed -i 's/^Components: main$/Components: main non-free non-free-firmware/' /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg vainfo intel-media-va-driver-non-free i965-va-driver mesa-va-drivers \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY src/ ./src/

RUN mkdir -p /data

EXPOSE 3000

CMD ["node", "src/server.js"]
