
#!/bin/bash
# --- CONFIGURATION ---
API_KEY="2f9899f6bf1445b68995c41dcbe0a973"
SONARR_URL="http://localhost:8989"
LOG_FILE="/opt/scripts/sonarr/transcode.log"
CACHE_DIR="/tmp/sonarr_transcode"
LOCK_FILE="/var/lock/sonarr_transcode.lock"
PID_FILE="/opt/scripts/sonarr/web/current_ffmpeg.pid"
MAX_SIZE=700000

touch "$LOG_FILE"

# Log Rotation
if [ -f "$LOG_FILE" ] && [ $(stat -c%s "$LOG_FILE") -gt $MAX_SIZE ]; then
    tail -c $MAX_SIZE "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
fi

# File Locking and Cache Setup
exec 200>"$LOCK_FILE"
flock -x 200
mkdir -p "$CACHE_DIR"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') - $1" >> "$LOG_FILE"; }

# 1. Variable Capture
if [[ -n "$sonarr_episodefile_path" ]]; then
    INPUT_FILE="$sonarr_episodefile_path"
    log "STATUS: Manual Trigger - $INPUT_FILE"
elif [[ -n "$sonarr_episodefile_paths" ]]; then
    INPUT_FILE=$(echo "$sonarr_episodefile_paths" | cut -d'|' -f1)
else
    INPUT_FILE="$sonarr_episode_path"
fi

[ -z "$INPUT_FILE" ] && exit 0
SERIES_ID="$sonarr_series_id"

# 2. Extract Subs (External SRT)
SRT_FILE="${INPUT_FILE%.*}.en.srt"
ffmpeg -i "$INPUT_FILE" -map 0:m:language:eng? -c:s srt "$SRT_FILE" -y >> "$LOG_FILE" 2>&1

# 3. Detection
HEIGHT=$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of default=noprint_wrappers=1:nokey=1 "$INPUT_FILE")
SCALE_OPTS=$([ "$HEIGHT" -gt 1080 ] && echo "-vf scale_vaapi=w=-2:h=1080:format=nv12" || echo "")
TEMP_FILE="$CACHE_DIR/transcoding_$(date +%s).mkv"

log "START H.265: $INPUT_FILE"

# 4. Stabilized H.265 (PID Capture Logic Added)
# We run ffmpeg in the background (&) so we can grab the PID immediately ($!)
ffmpeg -hwaccel vaapi -hwaccel_device /dev/dri/renderD128 -hwaccel_output_format vaapi \
    -i "$INPUT_FILE" \
    $SCALE_OPTS \
    -c:v hevc_vaapi -qp 24 -bf 0 -async_depth 1 -compression_level 1 \
    -c:a aac -b:a 256k -ac 2 \
    -sn -y "$TEMP_FILE" >> "$LOG_FILE" 2>&1 &

FF_PID=$!
echo $FF_PID > "$PID_FILE"

# Wait for this specific background process to finish
FF_PID=$!
echo $FF_PID > "$PID_FILE"
wait $FF_PID
EXIT_STATUS=$?

# 5. Result Handling
if [ $EXIT_STATUS -eq 0 ]; then
    mv "$TEMP_FILE" "$INPUT_FILE"
    log "SUCCESS: $INPUT_FILE"
    # Notify Sonarr to scan the new file
    curl -s "$SONARR_URL/api/v3/command" -H "X-Api-Key: $API_KEY" -H "Content-Type: application/json" -d "{\"name\": \"RescanSeries\", \"seriesId\": $SERIES_ID}" > /dev/null
else
    log "ERROR or KILLED: Status $EXIT_STATUS. Cleaning up temp file."
    rm -f "$TEMP_FILE"
fi

# Cleanup PID file so the Web App knows we are idle
rm -f "$PID_FILE"
