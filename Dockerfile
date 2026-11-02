FROM node:20-slim

WORKDIR /app

# ffmpeg turns the HDHomeRun's MPEG-2/AC3 transport stream into browser-playable H.264/AAC
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY src/ ./src/

RUN mkdir -p /data

EXPOSE 3000

CMD ["node", "src/server.js"]
