# Architecture

Interview Desk is a single-user local web app. The browser handles camera and microphone capture. Node serves the UI and coordinates saved sessions. A Python worker runs faster-whisper on the saved audio. An optional Codex CLI process produces feedback.

```text
Chrome → video and audio uploads → saved session → local Whisper
                                                       ↓
                                                  transcript
                                                       ↓ if enabled
                                                   Codex CLI
                                                       ↓
                                           feedback and score history
```

## Startup and data

- `lib/config.mjs` resolves the app's bundled files and the writable user data directory. `INTERVIEW_DESK_HOME` changes the data directory for a portable install or test. The server binds to `127.0.0.1` and checks the request host and origin.
- `lib/setup.mjs` builds the transcription environment in the data directory. Settings and `./setup.sh` use the same installer. The macOS bundle opens the browser after the server starts.
- The bundled banks in `data/` are read-only inputs. The app writes job metadata, question history, and recordings under `jobs/` in the data directory. Generated case questions live under `case-banks/`. Writes to JSON and Markdown use a temporary file and rename. Changes to the same job's question bank are serialized in the server.

## Recording and retry

`public/app.js` records video and audio separately using MediaRecorder. A test run uses the camera and mic without creating a session. For a saved run, the browser checks both uploads before it calls finish. A failed upload leaves the recording available to retry in that tab.

`lib/sessions.mjs` owns the session files and processing states. It checks that both media files exist, saves the question timings, and counts the attempt once. It then runs Whisper and builds the transcript, answer metrics, and readable Markdown. A transcription failure keeps the recording and can be retried from review.

## Feedback and data sent to Codex

Codex starts disabled. With feedback enabled, evaluation uses the job description, spoken answer text, answer metrics, and candidate notes. Case generation uses the role and existing questions. Sample answers use the selected question and its transcript. The CLI receives those text inputs via stdin in a temporary working directory with its shell tool disabled. The app keeps media files and session storage out of that directory.

`lib/feedback.mjs` requests structured results from the CLI. `lib/coaching.mjs` applies them to the question bank and writes feedback files. Re-evaluation replaces the existing score for the same session. Transcription and local review work with feedback disabled.

## Verification

Run `node --test` for the HTTP integration tests. For a release, also use a fresh data folder, complete a Chrome recording with synthetic input, confirm that Whisper transcribes it, and check feedback with the logged-in CLI if available.
