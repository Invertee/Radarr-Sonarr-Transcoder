# Transcode Manager: Installation & Usage Guide

A hardware-accelerated Flask application designed to manage and automate media transcoding. This tool integrates with Sonarr/Radarr to downscale 4K/high-bitrate content to 1080p (or 720p) HEVC using Intel VAAPI. 

## 1. Quick Install (Prerequisites)
Run this command to install all necessary system drivers, Python libraries, and media tools:

```bash
sudo apt update && sudo apt install -y ffmpeg python3-flask python3-requests cifs-utils intel-media-va-driver-non-free vainfo

```

## 2. Directory Structure

The application expects the following setup:

```bash
sudo mkdir -p /opt/scripts/sonarr/web /opt/scripts/sonarr/templates
sudo touch /opt/scripts/sonarr/transcode.log /opt/scripts/sonarr/ffmpeg_debug.log
sudo chown -R $USER:$USER /opt/scripts/sonarr

```

* **app.py**: Place in `/opt/scripts/sonarr/`
* **templates/index.html**: Place in `/opt/scripts/sonarr/templates/`
* **web/**: Holds the JSON databases (`queue.json`, `history.json`, `stats.json`)

## 3. Permissions

The app needs to move files on SMB shares and manage processes. Add the following to your sudoers file:

1. Run `sudo visudo`.
2. Add this line at the end:
```text
sam ALL=(ALL) NOPASSWD: /usr/bin/mv, /usr/bin/rm, /usr/bin/kill

```



## 4. Hardware Acceleration Profile

The transcoder uses a "Universal Upload" pipeline to ensure 4K files downscale reliably even if hardware decoding falls back to CPU.

### Transcode Specs:

* **Video**: HEVC VAAPI (`-c:v hevc_vaapi`)
* **Scaling**: Dynamic downscale (Max 1920px width) using `scale_vaapi`.
* **Audio**: Standardized Stereo AAC (`-ac 2`) to prevent channel layout crashes.
* **Data Integrity**: Uses **Atomic Saves** (writing to a temp file before overwriting) to prevent JSON corruption during system reboots.

## 5. Automation (Sonarr/Radarr)

Go to **Settings > Connect** and add a **Webhook**:

* **URL**: `http://<SERVER_IP>:5000/api/webhook`
* **Method**: `POST`
* **Triggers**: On Download, On Upgrade
* **LowRes Trigger**: Any item tagged with `lowres` in Sonarr/Radarr will automatically use the 720p profile.

## 6. Deployment

To run the app as a background service:

1. Create `/etc/systemd/system/transcoder.service`:

```ini
[Unit]
Description=Transcode Manager
After=network.target

[Service]
User=sam
WorkingDirectory=/opt/scripts/sonarr
ExecStart=/usr/bin/python3 /opt/scripts/sonarr/app.py
Restart=always

[Install]
WantedBy=multi-user.target

```

2. Enable and Start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable transcoder.service
sudo systemctl start transcoder.service

```

## 7. Maintenance & Debugging

* **Live Logs**: View via the Web UI or `tail -f /opt/scripts/sonarr/transcode.log`.
* **FFmpeg Debugging**: If a file fails, check `http://<SERVER_IP>:5000/api/debug_log` for the raw FFmpeg output.
* **Manual Cache Clear**: `sudo rm -rf /tmp/sonarr_transcode/*`


