#!/bin/bash

# Configuration
SOURCE_DIR="/opt/scripts/sonarr"
BACKUP_DEST="/mnt/media/transcoder-manager"
DATE=$(date +%Y-%m-%d)
FILENAME="transcoder_backup_$DATE.tar.gz"

# Create destination if it doesn't exist
mkdir -p "$BACKUP_DEST"

# Create the backup
# --exclude avoids backing up the temp cache files which could be huge
tar -czf "$BACKUP_DEST/$FILENAME" \
    --exclude='web/current_ffmpeg.pid' \
    --exclude='/tmp/sonarr_transcode/*' \
    "$SOURCE_DIR"

# Keep only the last 4 backups (1 month) to save space
ls -dt "$BACKUP_DEST"/transcoder_backup_* | tail -n +5 | xargs -d '\n' rm -f --

echo "Backup completed: $FILENAME"
