FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache ffmpeg python3 make g++ linux-headers

COPY package*.json ./
RUN npm install --omit=dev

COPY src/ ./src/

RUN mkdir -p /data

EXPOSE 3000

CMD ["node", "src/server.js"]
