#!/bin/bash
set -e

# Write default channel if not already set
if [ ! -f /config/channel ]; then
    echo "${DEFAULT_CHANNEL:-7.1}" > /config/channel
fi

# Start ffmpeg puller in background
/app/ffmpeg-puller.sh &
PULLER_PID=$!

# Start channel API
python3 /app/channel-api.py &
API_PID=$!

echo "[entrypoint] ffmpeg-puller pid=$PULLER_PID, channel-api pid=$API_PID"

# Wait for either to exit
wait -n
echo "[entrypoint] A subprocess exited — shutting down"
kill $PULLER_PID $API_PID 2>/dev/null || true
