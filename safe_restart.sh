#!/bin/bash

API_URL="http://localhost:5000/api/status"
LOG_FILE="/opt/scripts/sonarr/transcode.log"

# Try to get status, timeout after 10 seconds
RESPONSE=$(curl -s --max-time 10 $API_URL)

# Check if the response contains "Idle"
if [[ "$RESPONSE" == *"\"status\":\"Idle\""* ]]; then
    echo "$(date) - Maintenance: Verified Idle. Rebooting." >> $LOG_FILE
    # We DON'T rm -rf the whole directory, just the temp files
    sudo rm -f /tmp/sonarr_transcode/*
    sudo reboot
else
    echo "$(date) - Maintenance: System BUSY or API UNREACHABLE. Aborting reboot." >> $LOG_FILE
fi
