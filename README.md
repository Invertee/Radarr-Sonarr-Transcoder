# Transcode Manager 2.0.1

A local Node.js application for standardising media imported by Sonarr and Radarr. Download webhooks add files to a persistent SQLite queue, and a single FFmpeg worker converts them with VAAPI hardware acceleration.

The browser interface provides:

- A reorderable one-at-a-time conversion queue.
- Current FFmpeg progress, frame rate and speed.
- Sonarr and Radarr media browsers with file size, duration, resolution and conversion state.
- Manual conversion jobs.
- Persistent history and space-saving statistics.
- Application and FFmpeg logs.

Media metadata returned by Sonarr and Radarr is cached in SQLite as it is browsed. Episode-file and movie views can fall back to the cached records after a temporary API failure, and the **Probe** action reads exact size, duration, resolution, codec and audio-language information directly with `ffprobe`.

The service intentionally has no user authentication. Deploy it only on a trusted local network or restrict access with a firewall or reverse proxy.

## Design

```text
Sonarr / Radarr webhook
          |
          v
Express API on port 5000
          |
          v
SQLite queue and conversion records
          |
          v
Single FFmpeg VAAPI worker
          |
          v
Verified temporary output -> atomic media-file replacement
```

Queue state, history, converted-file records, browser media items and statistics are stored in SQLite. JSON database files and separate transcoding scripts are no longer used. The application uses the SQLite module included with Node.js, so it does not require a native SQLite npm package.

## Important security action

The previous Flask application committed live Sonarr and Radarr API keys in `web/app.py`. Rotate both keys in Sonarr and Radarr before deploying this version. The replacement application reads keys from `/etc/transcode-manager.env`, which is created with root-only permissions and is not stored in Git.

## Installation

The installer supports Debian and Ubuntu systems using `apt`. It installs Node.js when required, FFmpeg, VAAPI tools, the application service and an automatic update timer.

```bash
git clone https://github.com/Invertee/Radarr-Sonarr-Transcoder.git
cd Radarr-Sonarr-Transcoder
sudo ./install.sh --user sam
```

Use the account that already has read/write access to the mounted media library. The installer adds that account to the local `video` and `render` groups when those groups exist.

Common options:

```bash
sudo ./install.sh \
  --user sam \
  --port 5000 \
  --cache-dir /var/cache/transcode-manager
```

Run `./install.sh --help` for the complete option list.

### Installed locations

| Purpose | Default path |
|---|---|
| Application checkout | `/opt/transcode-manager` |
| Configuration | `/etc/transcode-manager.env` |
| SQLite database | `/var/lib/transcode-manager/transcode-manager.sqlite` |
| Temporary FFmpeg output | `/var/cache/transcode-manager` |
| Application logs | `/var/log/transcode-manager` |
| Systemd service | `transcode-manager.service` |
| Update timer | `transcode-manager-update.timer` |

The legacy `transcoder.service` is stopped and disabled during installation so the new application can continue using port `5000`. The old `/opt/scripts/sonarr` directory is not deleted automatically.

## Configuration

Edit the environment file after installation:

```bash
sudo nano /etc/transcode-manager.env
```

Set at least the two API keys:

```ini
SONARR_URL=http://127.0.0.1:8989
SONARR_API_KEY=replace-with-new-key
RADARR_URL=http://127.0.0.1:7878
RADARR_API_KEY=replace-with-new-key
```

Then restart the service:

```bash
sudo systemctl restart transcode-manager.service
```

Open the interface at:

```text
http://<transcoder-vm-address>:5000/
```

### Path translation

Sonarr, Radarr and the transcoder VM must refer to the same media file. Configure prefix translation when the paths differ.

Example: Sonarr reports `/tv/Show/file.mkv`, but the transcoder VM mounts the same share at `/mnt/media/tv/Show/file.mkv`:

```ini
SONARR_PATH_FROM=/tv
SONARR_PATH_TO=/mnt/media/tv
```

A separate mapping is available for Radarr:

```ini
RADARR_PATH_FROM=/movies
RADARR_PATH_TO=/mnt/media/movies
```

Windows-style paths are normalised before mapping.

## Sonarr and Radarr webhooks

In each application, open **Settings > Connect**, add a webhook, and enable the download/import and upgrade triggers.

Use these endpoints:

| Service | URL |
|---|---|
| Sonarr | `http://<transcoder-vm-address>:5000/api/webhook/sonarr` |
| Radarr | `http://<transcoder-vm-address>:5000/api/webhook/radarr` |
| Generic auto-detection | `http://<transcoder-vm-address>:5000/api/webhook` |

A test webhook returns immediately and does not create a job. Download and upgrade events are queued. Other event types are ignored.

## Tag-controlled profiles

Tags are read from the Sonarr series or Radarr movie. Numeric tag IDs in webhook payloads are resolved through the relevant API.

| Profile | Recognised tags | Video settings |
|---|---|---|
| High | `high`, `transcode-high`, `transcode:high` | HEVC VAAPI, 1920px maximum width, QP 22 |
| Medium | `medium`, `transcode-medium`, `transcode:medium` | HEVC VAAPI, 1920px maximum width, QP 24 |
| Low | `low`, `transcode-low`, `transcode:low` | HEVC VAAPI, 1920px maximum width, QP 30 |
| LowRes | `lowres`, `720p`, `transcode-lowres`, `transcode:lowres` | HEVC VAAPI, 1280px maximum width, QP 26 |
| Skip | `skip`, `noconvert`, `no-convert`, `transcode-skip`, `transcode:skip` | Webhook is acknowledged without queuing a conversion |

Media with no recognised tag uses `DEFAULT_PROFILE`, which defaults to `medium`.

When conflicting tags are present, priority is: `skip`, `lowres`, `low`, `medium`, `high`. Use one transcoder profile tag per series or movie.

## Audio and container handling

The old application forced a single stereo track. This version instead:

- Maps every audio stream with `-map 0:a?`.
- Converts every mapped audio stream to AAC.
- Does not force `-ac 2`, so the original channel count is retained where supported by FFmpeg's AAC encoder.
- Retains stream order and normal FFmpeg stream metadata, including language metadata.
- Verifies that the output contains the same number of audio streams as the input before replacing the source file.

`AUDIO_BITRATE=192k` applies to each output audio stream and can be changed in the environment file.

Supported source/output containers are MKV, MP4, M4V and MOV. MKV subtitle and attachment streams are copied. MP4-family files omit subtitle and attachment streams because formats commonly present in downloaded media, such as PGS and ASS, cannot be copied safely into those containers.

## Safe replacement process

For each job, the worker:

1. Probes the original file with `ffprobe`.
2. Writes FFmpeg output to the configured cache directory.
3. Probes and validates the completed output.
4. Confirms that video exists, duration is within tolerance and the audio-stream count matches.
5. Copies the validated output to a hidden sidecar file in the original media directory.
6. Flushes the sidecar to disk and atomically renames it over the original file.
7. Updates SQLite statistics and conversion records.
8. Requests a Sonarr or Radarr rescan when source identifiers are available.

The original file remains untouched if encoding or output verification fails. The media filesystem must have enough free space for the sidecar copy during the final replacement.

## Queue behaviour

Only one worker is created. A process lock also prevents a second application instance from starting against the same data directory.

- Pending jobs can be moved up or down in the web interface.
- Duplicate active paths are not added twice.
- Pending jobs survive restarts.
- A job active during a controlled shutdown is cancelled safely and returned to the queue.
- A job left in `processing` after an unexpected process failure is requeued on the next start.
- Stopping an active job deletes only its temporary output; it does not modify the source media.

## Initial statistics

A new database is seeded with the requested historical baseline:

| Statistic | Baseline |
|---|---:|
| Space saved | 1023.21 GiB |
| Efficiency | 56.3% |
| Files processed | 805 |

The exact seed values are:

```text
total_original_bytes = 1951444710009
total_saved_bytes    = 1098663371735
files_processed      = 805
```

Every successful conversion is added to those totals. Failed, cancelled and skipped jobs do not increase the processed count.

## Automatic deployment

`transcode-manager-update.timer` checks the configured Git branch every five minutes.

When a new commit is found, the updater:

1. Defers deployment if a conversion is active.
2. Resets the application checkout to the new remote commit.
3. Installs production dependencies.
4. Runs JavaScript and installer syntax checks, unit tests and the SQLite smoke test.
5. Restarts the systemd service.
6. Checks `/health` for up to 30 seconds.
7. Rolls back to the previous commit if validation or the health check fails.

Useful commands:

```bash
systemctl status transcode-manager-update.timer
sudo systemctl start transcode-manager-update.service
journalctl -u transcode-manager-update.service -n 100 --no-pager
```

Disable automatic deployment with:

```bash
sudo systemctl disable --now transcode-manager-update.timer
```

Or install without it:

```bash
sudo ./install.sh --user sam --no-auto-update
```

## VAAPI checks

Confirm the render device and HEVC encoder before submitting real jobs:

```bash
ls -l /dev/dri/renderD128
vainfo --display drm --device /dev/dri/renderD128
ffmpeg -hide_banner -encoders | grep hevc_vaapi
```

Check that the service account can access the device and media files:

```bash
id sam
sudo -u sam test -r /dev/dri/renderD128 && echo readable
sudo -u sam test -w /mnt/media && echo media-writable
```

Change `VAAPI_DEVICE` when the render node is different.

## Service operations

```bash
sudo systemctl status transcode-manager.service
sudo systemctl restart transcode-manager.service
sudo systemctl stop transcode-manager.service
journalctl -u transcode-manager.service -f
```

Application logs:

```bash
tail -f /var/log/transcode-manager/transcode-manager.log
tail -f /var/log/transcode-manager/ffmpeg-last.log
```

The most recent FFmpeg log is also available at `/api/debug_log`.

## Database backup

Stop the service before copying the SQLite database so the database, WAL and shared-memory state are consistent:

```bash
sudo systemctl stop transcode-manager.service
sudo cp -a /var/lib/transcode-manager /var/lib/transcode-manager.backup
sudo systemctl start transcode-manager.service
```

## Development

Node.js 24.15 or newer is required. The installer supplies the current Node.js 24 LTS release when the installed version is older.

```bash
cp .env.example .env
npm install
npm run check
npm test
npm run smoke
npm run start:env
```

The main API endpoints are:

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/health` | Service health |
| `GET` | `/api/status?compact=1` | Current job, queue and statistics |
| `GET` | `/api/profiles` | Available quality profiles |
| `POST` | `/api/queue` | Add a manual job |
| `POST` | `/api/queue/reorder` | Replace pending queue order |
| `DELETE` | `/api/queue/:id` | Remove a pending job |
| `POST` | `/api/active/cancel` | Stop the active FFmpeg job |
| `GET` | `/api/history` | Persistent job history |
| `GET` | `/api/media/sonarr/series` | Sonarr series browser data |
| `GET` | `/api/media/sonarr/series/:id/files` | Sonarr episode-file data |
| `GET` | `/api/media/radarr/movies` | Radarr movie browser data |
| `POST` | `/api/media/probe` | Read exact file metadata with ffprobe and update the SQLite media cache |
| `POST` | `/api/webhook/sonarr` | Sonarr webhook |
| `POST` | `/api/webhook/radarr` | Radarr webhook |
