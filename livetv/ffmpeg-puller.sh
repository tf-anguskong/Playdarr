#!/bin/bash
# Pulls live TV from HDHomeRun into HLS segments.
# Watches /config/channel for channel changes and restarts ffmpeg.
# Stops transcoding when /config/heartbeat goes stale (no viewers).

HDHR_IP="${HDHR_IP:-192.168.1.1}"
HDHR_PORT="${HDHR_PORT:-5004}"
HLS_DIR="/hls"
CHANNEL_FILE="/config/channel"
HEARTBEAT_FILE="/config/heartbeat"
HEARTBEAT_TIMEOUT=60  # seconds of inactivity before pausing
SEGMENT_DURATION=2
SEGMENT_COUNT=10

FFMPEG_PID=""

stop_ffmpeg() {
    if [ -n "$FFMPEG_PID" ] && kill -0 "$FFMPEG_PID" 2>/dev/null; then
        echo "[puller] Stopping ffmpeg (pid=$FFMPEG_PID)"
        kill "$FFMPEG_PID" 2>/dev/null
        wait "$FFMPEG_PID" 2>/dev/null
    fi
    FFMPEG_PID=""
}

start_ffmpeg() {
    local channel="$1"
    stop_ffmpeg
    rm -f "${HLS_DIR}"/*.ts "${HLS_DIR}/index.m3u8"

    local url="http://${HDHR_IP}:${HDHR_PORT}/auto/v${channel}"
    echo "[puller] Starting ffmpeg for channel ${channel} from ${url}"

    ffmpeg -hide_banner -loglevel warning \
        -i "$url" \
        -c:v copy -c:a aac -b:a 128k \
        -f hls \
        -hls_time "$SEGMENT_DURATION" \
        -hls_list_size "$SEGMENT_COUNT" \
        -hls_flags delete_segments \
        -hls_segment_filename "${HLS_DIR}/seg%d.ts" \
        "${HLS_DIR}/index.m3u8" &
    FFMPEG_PID=$!
    echo "[puller] ffmpeg started (pid=$FFMPEG_PID)"
}

current_channel=""
streaming=false

while true; do
    # Read current channel
    if [ -f "$CHANNEL_FILE" ]; then
        new_channel=$(cat "$CHANNEL_FILE" | tr -d '[:space:]')
    else
        new_channel="${DEFAULT_CHANNEL:-7.1}"
    fi

    # Check heartbeat — stop streaming if no viewers
    now=$(date +%s)
    if [ -f "$HEARTBEAT_FILE" ]; then
        last_beat=$(cat "$HEARTBEAT_FILE" | tr -d '[:space:]')
        age=$((now - last_beat))
    else
        age=$((HEARTBEAT_TIMEOUT + 1))
    fi

    if [ "$age" -gt "$HEARTBEAT_TIMEOUT" ]; then
        if [ "$streaming" = true ]; then
            echo "[puller] No heartbeat for ${age}s — [stream paused]"
            stop_ffmpeg
            streaming=false
        fi
    else
        if [ "$streaming" = false ] || [ "$new_channel" != "$current_channel" ]; then
            current_channel="$new_channel"
            streaming=true
            start_ffmpeg "$current_channel"
        elif ! kill -0 "$FFMPEG_PID" 2>/dev/null; then
            echo "[puller] ffmpeg died unexpectedly — restarting"
            start_ffmpeg "$current_channel"
        fi
    fi

    sleep 5
done
