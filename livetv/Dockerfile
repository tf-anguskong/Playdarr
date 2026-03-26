FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install flask requests

WORKDIR /app
COPY entrypoint.sh ffmpeg-puller.sh channel-api.py ./
RUN chmod +x entrypoint.sh ffmpeg-puller.sh

RUN mkdir -p /hls /config

EXPOSE 8080

CMD ["/app/entrypoint.sh"]
