import os, requests, subprocess, threading, json, time, shutil, re, tempfile
from flask import Flask, render_template, jsonify, request, Response

app = Flask(__name__)

# --- CONFIG ---
SONARR = {"url": "http://localhost:8989", "key": "2f9899f6bf1445b68995c41dcbe0a973"}
RADARR = {"url": "http://localhost:7878", "key": "c6b56afaf2664b29aa3d741ec94556c6"}

LOG_FILE = "/opt/scripts/sonarr/transcode.log"
FFMPEG_LOG = "/opt/scripts/sonarr/ffmpeg_debug.log"  # <--- NEW DEBUG LOG
QUEUE_DB = "/opt/scripts/sonarr/web/queue.json"
HISTORY_DB = "/opt/scripts/sonarr/web/history.json"
STATS_DB = "/opt/scripts/sonarr/web/stats.json"
PID_FILE = "/opt/scripts/sonarr/web/current_ffmpeg.pid"
PROGRESS_FILE = "/tmp/ffmpeg_progress.txt"
CACHE_DIR = "/tmp/sonarr_transcode"

PROFILES = {
    "high": {"qp": 22, "name": "High (1080p QP 22)", "width": 1920},
    "medium": {"qp": 24, "name": "Medium (1080p QP 24)", "width": 1920},
    "low": {"qp": 30, "name": "Low (1080p QP 30)", "width": 1920},
    "lowres": {"qp": 26, "name": "LowRes (720p QP 26)", "width": 1280},
    "skip": {"qp": 0, "name": "Skipped (NOCONVERT)", "width": 0}
}

task_queue = []
history_list = []
stats = {"total_original_bytes": 0, "total_saved_bytes": 0, "files_processed": 0}
current_task = {"status": "Idle", "file": None, "full_path": None, "profile": None, "duration": 0}

def log(message):
    timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
    with open(LOG_FILE, 'a') as f: f.write(f"{timestamp} - {message}\n")

def load_data():
    global task_queue, history_list, stats
    task_queue, history_list = [], []
    stats = {"total_original_bytes": 0, "total_saved_bytes": 0, "files_processed": 0}
    try:
        if os.path.exists(QUEUE_DB):
            with open(QUEUE_DB, 'r') as f: task_queue = json.load(f)
        if os.path.exists(HISTORY_DB):
            with open(HISTORY_DB, 'r') as f: history_list = json.load(f)
        if os.path.exists(STATS_DB):
            with open(STATS_DB, 'r') as f: stats = json.load(f)
    except Exception as e:
        log(f"LOAD ERROR: {e}")

def save_data(db_path, data):
    try:
        dir_name = os.path.dirname(db_path)
        with tempfile.NamedTemporaryFile('w', dir=dir_name, delete=False) as tf:
            json.dump(data, tf)
            temp_name = tf.name
        os.replace(temp_name, db_path)
    except Exception as e:
        log(f"SAVE ERROR: {e}")

def add_to_history(path, profile, saved_bytes):
    saved_mb = round(saved_bytes / (1024**2), 1)
    entry = {
        "timestamp": time.strftime('%Y-%m-%d %H:%M'),
        "file": os.path.basename(path),
        "profile": PROFILES.get(profile, {"name": profile})["name"],
        "saved": f"{saved_mb} MB" if saved_mb >= 0 else f"+{abs(saved_mb)} MB (Grew)"
    }
    history_list.insert(0, entry)
    save_data(HISTORY_DB, history_list[:100])

def run_transcode(path, quality_key="medium"):
    filename = os.path.basename(path)
    if quality_key == "skip":
        log(f"SKIP: {filename}")
        add_to_history(path, "skip", 0)
        return True
    try:
        size_before = os.path.getsize(path)
        os.makedirs(CACHE_DIR, exist_ok=True)
        temp_file = os.path.join(CACHE_DIR, f"transcoding_{int(time.time())}.mkv")
        
        prof = PROFILES.get(quality_key, PROFILES["medium"])
        qp_val = str(prof["qp"])
        max_w = str(prof["width"])
        
        # --- FIX 1: Video Filter Chain ---
        # "format=nv12,hwupload" -> Ensures that if CPU decoding happens (native), 
        # we manually move the frames to the GPU before the scaler touches them.
        vf_chain = f"format=nv12,hwupload,scale_vaapi=w='min({max_w},iw)':h=-2:format=nv12"

        cmd = [
            "ffmpeg", 
            "-hwaccel", "vaapi", 
            "-hwaccel_device", "/dev/dri/renderD128", 
            # Removed "-hwaccel_output_format vaapi" to allow the filter to handle the upload explicitly
            "-i", path,
            "-vf", vf_chain,
            "-c:v", "hevc_vaapi", 
            "-qp", qp_val, 
            "-bf", "0", 
            # --- FIX 2: Audio Safety ---
            # "-ac 2" forces stereo. This fixes the "Unsupported channel layout" crash.
            "-c:a", "aac", "-b:a", "192k", "-ac", "2", 
            "-sn", 
            "-progress", PROGRESS_FILE, 
            "-y", temp_file
        ]

        log(f"STARTING: {filename} ({prof['name']})")
        
        # Capture full log for debugging
        with open(FFMPEG_LOG, "w") as err_log:
            process = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=err_log)
            with open(PID_FILE, 'w') as f: f.write(str(process.pid))
            process.wait()

        if process.returncode == 0 and os.path.exists(temp_file):
            res = subprocess.run(["sudo", "mv", "-f", temp_file, path], capture_output=True, text=True)
            if res.returncode == 0:
                size_after = os.path.getsize(path)
                saved = size_before - size_after
                stats["total_original_bytes"] += size_before
                stats["total_saved_bytes"] += saved
                stats["files_processed"] += 1
                save_data(STATS_DB, stats)
                add_to_history(path, quality_key, saved)
                log(f"DONE: {filename}")
                return True
            else:
                log(f"MOVE ERROR: {res.stderr}")
        else:
            log(f"FFMPEG FAILED. Exit Code: {process.returncode}. Check {FFMPEG_LOG}")
        return False
    except Exception as e:
        log(f"ERROR: {str(e)}")
        return False

def worker():
    global current_task
    while True:
        if task_queue:
            task = task_queue.pop(0)
            save_data(QUEUE_DB, task_queue)
            try:
                probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", task['path']], capture_output=True, text=True)
                dur = float(probe.stdout.strip()) if probe.stdout.strip() else 0
            except: dur = 0
            current_task = {"status": "Processing", "file": os.path.basename(task['path']), "full_path": task['path'], "profile": PROFILES.get(task.get('quality'), PROFILES['medium'])["name"], "duration": dur, "fps": 0, "speed": "0x", "time": "00:00:00"}
            run_transcode(task['path'], task.get('quality', 'medium'))
            current_task = {"status": "Idle", "file": None, "full_path": None, "profile": None, "duration": 0}
        time.sleep(2)

load_data()
threading.Thread(target=worker, daemon=True).start()

# --- ROUTES ---
@app.route('/')
def index(): return render_template('index.html')

@app.route('/api/status')
def get_status():
    prog = 0
    if os.path.exists(PROGRESS_FILE) and current_task["status"] == "Processing":
        try:
            with open(PROGRESS_FILE, 'r') as f:
                content = f.read()
                f_mic = re.findall(r'out_time_us=(\d+)', content)
                if f_mic and current_task["duration"] > 0:
                    prog = round((int(f_mic[-1]) / (current_task["duration"] * 1000000)) * 100, 1)
                for key in ['fps', 'speed', 'time']:
                    match = re.findall(rf'{key if key != "time" else "out_time"}=([^ \n]+)', content)
                    if match: current_task[key] = match[-1].split('.')[0] if key == 'time' else match[-1]
        except: pass
    return jsonify({"current": current_task, "progress": min(prog, 100), "queue": task_queue, "history": history_list, "stats": {"saved_gb": round(stats["total_saved_bytes"] / (1024**3), 2), "count": stats["files_processed"], "percent": round((stats["total_saved_bytes"] / stats["total_original_bytes"] * 100), 1) if stats["total_original_bytes"] > 0 else 0}})

@app.route('/api/debug_log')
def get_debug_log():
    """View the last FFmpeg crash log directly in browser"""
    if os.path.exists(FFMPEG_LOG):
        with open(FFMPEG_LOG, 'r') as f: return Response(f.read(), mimetype='text/plain')
    return "No debug log found."

@app.route('/api/webhook', methods=['POST'])
def webhook():
    data = request.json
    path = data.get('movieFile', {}).get('path') if 'movieFile' in data else data.get('episodeFile', {}).get('path')
    tags = data.get('remoteProfile', {}).get('tags', [])
    selected_quality = "lowres" if "lowres" in tags else "medium"
    if path and data.get('eventType') in ['Download', 'Grab']:
        task_queue.append({"path": path, "quality": selected_quality})
        save_data(QUEUE_DB, task_queue)
        log(f"WEBHOOK: Queued {os.path.basename(path)} as {selected_quality}")
    return jsonify({"status": "received"})

# ... API ROUTES (Shows, Movies, Episodes, Queue, Stop, Logs) ...
@app.route('/api/shows')
def get_shows(): return jsonify(requests.get(f"{SONARR['url']}/api/v3/series", headers={"X-Api-Key": SONARR['key']}).json())
@app.route('/api/movies')
def get_movies():
    movies = requests.get(f"{RADARR['url']}/api/v3/movie", headers={"X-Api-Key": RADARR['key']}).json()
    for m in movies:
        size = m.get('sizeOnDisk') or (m.get('movieFile') or {}).get('size') or 0
        m['displaySize'] = round(size / (1024**3), 2)
    return jsonify(movies)
@app.route('/api/episodes/<series_id>')
def get_episodes(series_id):
    files = requests.get(f"{SONARR['url']}/api/v3/episodefile?seriesId={series_id}", headers={"X-Api-Key": SONARR['key']}).json()
    for f in files: f['displaySize'] = round(f.get('size', 0) / (1024**2), 1)
    return jsonify(files)
@app.route('/api/transcode_file', methods=['POST'])
def transcode_file():
    task_queue.append(request.json)
    save_data(QUEUE_DB, task_queue)
    return jsonify({"status": "Queued"})
@app.route('/api/queue_all', methods=['POST'])
def queue_all():
    data = request.json
    for f in data.get('files', []): task_queue.append({"path": f['path'], "seriesId": data.get('seriesId'), "quality": data.get('quality', 'medium')})
    save_data(QUEUE_DB, task_queue)
    return jsonify({"status": "Bulk Queued"})
@app.route('/api/queue/clear', methods=['POST'])
def clear_queue():
    global task_queue
    task_queue = []
    save_data(QUEUE_DB, task_queue)
    return jsonify({"status": "Cleared"})
@app.route('/api/stop', methods=['POST'])
def stop_process():
    if os.path.exists(PID_FILE):
        with open(PID_FILE, 'r') as f: pid = f.read().strip()
        subprocess.run(["sudo", "kill", "-9", pid])
    return jsonify({"status": "Killed"})
@app.route('/stream-logs')
def stream_logs():
    def generate():
        with open(LOG_FILE, 'r') as f:
            f.seek(0, 2)
            while True:
                line = f.readline()
                if not line: time.sleep(0.5); continue
                yield f"data: {line}\n\n"
    return Response(generate(), mimetype='text/event-stream')

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
