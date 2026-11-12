#!/usr/bin/env python3
"""Turn a session's audio into word-level JSON. Runs entirely offline once the
model is cached. Called by server.mjs as: transcribe.py <audio> <out.json> <model>"""

import json
import sys

# Nudges Whisper toward a verbatim transcript. It still strips many
# disfluencies -- filler counts downstream are a floor, not a measurement.
VERBATIM_HINT = "Um, uh, so, like, you know, I mean, basically, right, sort of."


def main():
    if len(sys.argv) < 3:
        print("usage: transcribe.py <audio> <out.json> [model]", file=sys.stderr)
        return 2

    audio_path, out_path = sys.argv[1], sys.argv[2]
    model_size = sys.argv[3] if len(sys.argv) > 3 else "base.en"

    from faster_whisper import WhisperModel

    print(f"loading {model_size}...", file=sys.stderr)
    model = WhisperModel(model_size, device="cpu", compute_type="int8")

    print("transcribing audio", file=sys.stderr)
    segments, info = model.transcribe(
        audio_path,
        word_timestamps=True,
        vad_filter=False,          # keep the silence; pauses are real data here
        condition_on_previous_text=False,
        initial_prompt=VERBATIM_HINT,
        beam_size=5,
    )

    out = {
        "language": info.language,
        "duration": info.duration,
        "model": model_size,
        "segments": [],
    }

    for seg in segments:
        out["segments"].append({
            "start": seg.start,
            "end": seg.end,
            "text": seg.text,
            "words": [
                {"start": w.start, "end": w.end, "word": w.word}
                for w in (seg.words or [])
            ],
        })

    with open(out_path, "w") as fh:
        json.dump(out, fh, indent=2)

    words = sum(len(s["words"]) for s in out["segments"])
    print(f"done: {len(out['segments'])} segments, {words} words", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
