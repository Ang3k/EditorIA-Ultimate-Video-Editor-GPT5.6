import argparse
import json
import logging
import os
from pathlib import Path
import sys


def prepare_cuda_dlls():
    if sys.platform != "win32":
        return []

    import importlib

    handles = []
    for package_name in ("nvidia.cublas", "nvidia.cudnn", "nvidia.cuda_nvrtc"):
        try:
            package = importlib.import_module(package_name)
            bin_path = Path(package.__path__[0]) / "bin"
            if bin_path.exists():
                handles.append(os.add_dll_directory(str(bin_path)))
                os.environ["PATH"] = f"{bin_path};{os.environ.get('PATH', '')}"
        except Exception:
            continue

    return handles


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("audio")
    parser.add_argument("--model", default="large-v3-turbo")
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--compute-type", default="float16")
    args = parser.parse_args()

    prepare_cuda_dlls()
    from faster_whisper import WhisperModel

    logging.getLogger("faster_whisper").setLevel(logging.ERROR)
    try:
        model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
    except Exception:
        if args.device != "cuda":
            raise
        print("CUDA indisponível; usando CPU int8.", file=sys.stderr)
        model = WhisperModel(args.model, device="cpu", compute_type="int8")
    segments, info = model.transcribe(
        args.audio,
        language=None,
        beam_size=5,
        word_timestamps=True,
        vad_filter=True,
    )

    transcript_segments = []
    words = []
    for index, segment in enumerate(segments):
        text = (segment.text or "").strip()
        start = float(segment.start or 0)
        end = float(segment.end or start)
        if text:
            transcript_segments.append({
                "id": index,
                "start": start,
                "end": max(end, start + 0.01),
                "text": text,
            })
        for word in segment.words or []:
            word_text = (word.word or "").strip()
            if word_text:
                words.append({
                    "word": word_text,
                    "start": float(word.start or 0),
                    "end": float(word.end or word.start or 0),
                })

    duration = float(getattr(info, "duration", 0) or 0)
    if transcript_segments:
        duration = max(duration, transcript_segments[-1]["end"])

    result = {
        "text": " ".join(segment["text"] for segment in transcript_segments),
        "duration": duration,
        "language": str(getattr(info, "language", "") or ""),
        "segments": transcript_segments,
        "words": words,
    }
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"local transcription failed: {error}", file=sys.stderr)
        raise
