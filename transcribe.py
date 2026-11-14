"""Generate a resumable transcript checkpoint for one WeChat Chats to Files export."""

import hashlib
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"

MODEL = "faster-whisper-small@536b066"
VOICE_MESSAGE_TYPE = 34


def decode_wav(filename):
    import av
    import numpy as np

    resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
    samples = []
    with av.open(str(filename), mode="r") as container:
        for frame in container.decode(audio=0):
            frame.pts = None
            for chunk in resampler.resample(frame):
                samples.append(chunk.to_ndarray().reshape(-1))
        for chunk in resampler.resample(None):
            samples.append(chunk.to_ndarray().reshape(-1))
    if not samples:
        raise ValueError("Empty audio")
    return np.concatenate(samples).astype(np.float32) / 32768.0


def read_audio(directory):
    document = json.loads((directory / "聊天记录.json").read_text(encoding="utf-8"))
    voices = {}
    media = directory / "media"
    for message in document["messages"]:
        if message.get("localType") != VOICE_MESSAGE_TYPE:
            continue
        name = str(message.get("content", "")).replace("\\", "/")
        if not name.startswith("media/") or not name.lower().endswith(".wav"):
            continue
        file = (directory / name).resolve()
        if file.is_relative_to(media) and file.is_file() and file.stat().st_size > 44:
            voices[name] = file
    return voices


def load_checkpoint(file, language):
    try:
        previous = json.loads(file.read_text(encoding="utf-8"))
        if previous.get("model") == MODEL and previous.get("language") == language:
            return {item["audio"]: item for item in previous["items"] if item["status"] == "ok"}
    except (OSError, ValueError, AttributeError, TypeError, KeyError):
        pass
    return {}


def write_checkpoint(file, language, results):
    payload = {"model": MODEL, "language": language, "items": list(results.values())}
    temporary = file.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(file)


def main(directory, model_directory, language):
    directory = Path(directory).resolve(strict=True)
    voices = read_audio(directory)
    if not voices:
        raise ValueError("No WAV files")
    checkpoint = directory / "voice-transcripts.json"
    previous = load_checkpoint(checkpoint, language)
    results = {}
    pending = []
    for name, file in voices.items():
        try:
            with file.open("rb") as audio:
                digest = hashlib.file_digest(audio, "sha256").hexdigest()
        except OSError:
            results[name] = {"audio": name, "status": "error"}
            continue
        cached = previous.get(name)
        if cached and cached.get("sha256") == digest:
            results[name] = cached
        else:
            pending.append((name, file, digest))

    if pending:
        from faster_whisper import WhisperModel

        cpus = os.cpu_count() or 4
        workers = min(len(pending), 4, max(1, cpus // 4))
        threads = min(4, max(1, cpus // workers))
        model = WhisperModel(model_directory, device="cpu", compute_type="int8",
                             local_files_only=True, cpu_threads=threads, num_workers=workers)

        def recognize(task):
            name, file, digest = task
            result = {"audio": name, "sha256": digest}
            try:
                segments, info = model.transcribe(
                    decode_wav(file), language=None if language == "auto" else language,
                    task="transcribe", beam_size=5, condition_on_previous_text=False,
                )
                text = "".join(segment.text for segment in segments).strip()
                return dict(result, status="ok" if text else "empty", text=text, language=info.language)
            except Exception:
                return dict(result, status="error")

        with ThreadPoolExecutor(max_workers=workers) as pool:
            for result in pool.map(recognize, pending):
                results[result["audio"]] = result
                done = len(results)
                if done % 8 == 0:
                    write_checkpoint(checkpoint, language, results)
                    print(f"progress {done}/{len(voices)}", file=sys.stderr, flush=True)

    write_checkpoint(checkpoint, language, results)
    print(f"progress {len(results)}/{len(voices)}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main(*sys.argv[1:])
