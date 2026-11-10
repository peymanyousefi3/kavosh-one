"""Bounded full-video decode observation,not antivirus,playback or serving.

Only stdin bytes enter;no user filename,URL,filter,command or output path.
Requires a pinned network-disabled FFmpeg build and independent OS isolation.
Probe metadata is insufficient:all selected video/audio packets must decode.
"""
import hashlib
import json
import math
import os
import re
import resource
import selectors
import subprocess
import sys
import time

MAX_BYTES, MAX_DURATION, MAX_PIXELS, MAX_FRAMES = 134217728, 300, 12000000000, 18000
if len(sys.argv) != 5 or any(not os.path.isabs(p) for p in sys.argv[1:3]):
    sys.exit(1)
FFMPEG, FFPROBE, MIME, INPUT_DIRECTORY = sys.argv[1:]
directory_stat = os.lstat(INPUT_DIRECTORY)
if os.path.realpath(INPUT_DIRECTORY) != INPUT_DIRECTORY or not os.path.isdir(INPUT_DIRECTORY) or directory_stat.st_uid != os.getuid() or directory_stat.st_mode & 0o777 != 0o700:
    sys.exit(1)
if MIME not in ("video/mp4", "video/quicktime", "video/webm"):
    sys.exit(1)
# Fixed allocator limit,not inherited caller configuration. A many-core glibc
# host otherwise reserves multiple large arenas inside the512MiB address cap.
# https://sourceware.org/glibc/manual/latest/html_node/Malloc-Tunable-Parameters.html
ENV = {"TZ": "UTC", "LC_ALL": "C", "PATH": "/usr/bin:/bin", "MALLOC_ARENA_MAX": "2"}
STAGE = "runtime"


class Rejected(Exception):
    pass


def reject(reason):
    raise Rejected(reason)


def limits():
    if sys.platform == "linux":
        resource.setrlimit(resource.RLIMIT_AS, (536870912, 536870912))
        resource.setrlimit(resource.RLIMIT_CPU, (60, 60))
        resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))
        resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def run(args, maximum=1048576):
    # No shell. Children inherit the Node-owned process group so a caller
    # timeout/cancellation kills the broker AND native decoder,not just Python.
    with subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, env=ENV, cwd=INPUT_DIRECTORY, preexec_fn=limits) as child:
        output, size, errors = [], 0, 0
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ, True)
            selector.register(child.stderr, selectors.EVENT_READ, False)
            deadline = time.monotonic() + 60
            try:
                while selector.get_map():
                    if time.monotonic() >= deadline:
                        reject("RESOURCE_LIMIT")
                    for key, _ in selector.select(0.1):
                        chunk = os.read(key.fileobj.fileno(), 65536)
                        if not chunk:
                            selector.unregister(key.fileobj)
                        elif key.data:
                            size += len(chunk)
                            if size > maximum:
                                reject("RESOURCE_LIMIT")
                            output.append(chunk)
                        else:
                            errors += len(chunk)
                            if errors > 1048576:
                                reject("RESOURCE_LIMIT")
                code = child.wait(timeout=max(0.01, deadline - time.monotonic()))
                if code != 0:
                    # FFmpeg propagates AVERROR(EAGAIN) as Unix exit245. Native
                    # thread/resource admission failure is not bad-file proof.
                    if code == 245:
                        raise RuntimeError("VIDEO_NATIVE_RESOURCE_UNAVAILABLE")
                    failure = Rejected("DECODER_REJECTED")
                    failure.native_exit_code = code
                    raise failure
                return b"".join(output)
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait()


def number(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{1,6}(?:\.[0-9]{1,9})?", value):
        reject("METADATA_REJECTED")
    return float(value)


def screen(path):
    global STAGE
    for executable, name in ((FFMPEG, "ffmpeg"), (FFPROBE, "ffprobe")):
        version = run([executable, "-version"], 65536).decode("ascii", "strict")
        if not version.startswith(name + " version 9.0.2 ") or "--disable-network" not in version:
            raise RuntimeError("UNPINNED_VIDEO_RUNTIME")
        protocols = run([executable, "-v", "error", "-protocols"], 65536).decode("ascii", "strict")
        if "file" not in protocols.split() or any(line.strip() not in ("", "Supported file protocols:", "Input:", "Output:", "file", "pipe") for line in protocols.splitlines()):
            raise RuntimeError("NETWORK_CAPABLE_VIDEO_RUNTIME")
    container = "matroska" if MIME == "video/webm" else "mov"
    source = ["-protocol_whitelist", "file,pipe", "-f", container]
    if container == "mov":
        source += ["-enable_drefs", "0", "-use_absolute_path", "0"]
    STAGE = "probe"
    probe = json.loads(run([FFPROBE, "-cpucount", "2", "-v", "error", "-max_alloc", "67108864", "-threads", "1"] + source + [
        "-show_entries", "stream=index,codec_type,codec_name,width,height,avg_frame_rate,duration,channels,sample_rate:format=format_name,duration",
        "-of", "json", path]))
    STAGE = "stream_policy"
    streams, fmt = probe.get("streams"), probe.get("format")
    if not isinstance(streams, list) or not 1 <= len(streams) <= 2 or not isinstance(fmt, dict):
        reject("STREAM_POLICY")
    videos = [s for s in streams if s.get("codec_type") == "video"]
    audios = [s for s in streams if s.get("codec_type") == "audio"]
    if len(videos) != 1 or len(audios) > 1 or len(videos) + len(audios) != len(streams):
        reject("STREAM_POLICY")
    video = videos[0]
    if video.get("codec_name") not in ("h264", "hevc", "mpeg4", "vp8", "vp9", "av1"):
        reject("STREAM_POLICY")
    width, height = video.get("width"), video.get("height")
    if type(width) is not int or type(height) is not int or not 1 <= width <= 3840 or not 1 <= height <= 3840 or width * height > 8294400:
        reject("RESOURCE_LIMIT")
    rate = video.get("avg_frame_rate", "")
    if not re.fullmatch(r"[0-9]{1,9}/[1-9][0-9]{0,8}", rate):
        reject("METADATA_REJECTED")
    numerator, denominator = map(int, rate.split("/"))
    fps = numerator / denominator
    duration = max([number(fmt.get("duration"))] + [number(s["duration"]) for s in streams if s.get("duration") not in (None, "N/A")])
    if not 0 < fps <= 120 or not 0 < duration <= MAX_DURATION or fps * duration > MAX_FRAMES or width * height * fps * duration > MAX_PIXELS:
        reject("RESOURCE_LIMIT")
    audio = None
    if audios:
        a = audios[0]
        if a.get("codec_name") not in ("aac", "opus", "vorbis", "pcm_s16le") or type(a.get("channels")) is not int or not 1 <= a["channels"] <= 2:
            reject("STREAM_POLICY")
        sample_rate = a.get("sample_rate", "")
        if not re.fullmatch(r"[0-9]{4,6}", sample_rate) or not 8000 <= int(sample_rate) <= 192000:
            reject("STREAM_POLICY")
        audio = {"codec": a["codec_name"], "channels": a["channels"], "sampleRate": int(sample_rate)}
    STAGE = "decode"
    decoded = run([FFMPEG, "-cpucount", "2", "-hide_banner", "-loglevel", "error", "-xerror", "-max_error_rate", "0", "-max_alloc", "67108864",
                   "-threads", "1", "-filter_threads", "1", "-filter_complex_threads", "1", "-err_detect", "explode"] + source + [
        "-noautorotate", "-i", path, "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "rawvideo", "-pix_fmt", "yuv420p",
        "-fps_mode:v", "passthrough", "-c:a", "pcm_s16le", "-threads", "1", "-f", "framehash", "-hash", "sha256", "pipe:1"], 8388608)
    STAGE = "frame_evidence"
    frames, audio_frames, decoded_bytes = 0, 0, 0
    timebases, starts, ends, previous_pts = {}, {}, {}, {}
    digest = hashlib.sha256()
    video_bytes = width * height + 2 * ((width + 1) // 2) * ((height + 1) // 2)
    for line in decoded.decode("ascii", "strict").splitlines():
        if line.startswith("#"):
            timebase = re.fullmatch(r"#tb ([01]): ([1-9][0-9]{0,8})/([1-9][0-9]{0,8})", line)
            if timebase:
                index, numerator, denominator = map(int, timebase.groups())
                timebases[index] = numerator / denominator
            continue
        fields = [part.strip() for part in line.split(",")]
        if len(fields) != 6 or not all(re.fullmatch(r"-?[0-9]{1,18}", p) for p in fields[:5]) or not re.fullmatch(r"[0-9a-f]{64}", fields[5]):
            reject("DECODER_REJECTED")
        index, size = int(fields[0]), int(fields[4])
        pts, ticks = int(fields[2]), int(fields[3])
        if index not in timebases or ticks <= 0 or pts < previous_pts.get(index, pts):
            reject("METADATA_REJECTED")
        previous_pts[index] = pts
        starts[index] = min(starts.get(index, pts * timebases[index]), pts * timebases[index])
        ends[index] = max(ends.get(index, (pts + ticks) * timebases[index]), (pts + ticks) * timebases[index])
        if max(ends.values()) - min(starts.values()) > MAX_DURATION:
            reject("RESOURCE_LIMIT")
        if index == 0 and size == video_bytes:
            frames += 1
        elif index == 1 and audio and 0 < size <= 1048576:
            audio_frames += 1
        else:
            reject("DECODER_REJECTED")
        decoded_bytes += size
        if frames > MAX_FRAMES or audio_frames > 100000 or width * height * frames > MAX_PIXELS or decoded_bytes > 24000000000:
            reject("RESOURCE_LIMIT")
        digest.update(line.encode("ascii") + b"\n")
    if frames == 0 or audio is not None and audio_frames == 0:
        reject("DECODER_REJECTED")
    return {"outcome": "decoded", "mime": MIME, "container": container, "codec": video["codec_name"],
            "width": width, "height": height, "durationMs": math.ceil(max(duration, max(ends.values()) - min(starts.values())) * 1000), "videoFrames": frames,
            "audioFrames": audio_frames, "audio": audio, "decodedBytes": decoded_bytes, "frameHashSha256": digest.hexdigest()}


data = sys.stdin.buffer.read(MAX_BYTES + 1)
if not 1 <= len(data) <= MAX_BYTES:
    sys.exit(1)
result = {"validator": "ffmpeg@9.0.2", "policyVersion": 1, "inputBytes": len(data), "inputSha256": hashlib.sha256(data).hexdigest(),
          "maximumInputBytes": MAX_BYTES, "maximumDurationSeconds": MAX_DURATION, "maximumVideoFrames": MAX_FRAMES, "maximumVideoPixels": MAX_PIXELS}
try:
    # The Node broker owns and always removes this exact private directory,
    # including after SIGKILL. Python-only finally cleanup cannot survive kill.
    path = os.path.join(INPUT_DIRECTORY, "source.bin")
    with open(path, "xb") as stream:
        os.chmod(path, 0o600)
        stream.write(data)
    result.update(screen(path))
except Rejected as error:
    result.update(outcome="rejected", reason=str(error), stage=STAGE)
    if hasattr(error, "native_exit_code"):
        result["nativeExitCode"] = error.native_exit_code
except Exception:
    sys.exit(1)
usage, children = resource.getrusage(resource.RUSAGE_SELF), resource.getrusage(resource.RUSAGE_CHILDREN)
result["resources"] = {"peakRssKiB": max(1, math.ceil(max(usage.ru_maxrss, children.ru_maxrss) / (1024 if sys.platform == "darwin" else 1))),
                       "userCpuMicros": int((usage.ru_utime + children.ru_utime) * 1000000), "systemCpuMicros": int((usage.ru_stime + children.ru_stime) * 1000000)}
sys.stdout.write(json.dumps(result, allow_nan=False, separators=(",", ":")))
