# Interview Desk

Practice interview answers on camera, replay each question, and read a local transcript. Interview Desk can also use Codex for feedback, sample answers, and role-specific case questions.

## Install on macOS

You’ll need **Node.js 22 or newer**, **Python 3.11–3.13**, and **Chrome**. Install Node and Python first. With Homebrew, you can use `brew install node python@3.13`.

1. Download **Interview-Desk-macOS.dmg** from [Releases](https://github.com/Dhwdue/interview-desk/releases).
2. Open the disk image, drag **Interview Desk** into **Applications**, and open the app.
3. In **Settings**, select **Install transcription**. The first recording also downloads the Whisper model. After that, transcription works offline.

The app bundle is ad-hoc signed and is not notarized. If macOS blocks the downloaded app, use the source launch below.

## Run from source

Download the source from Releases or clone this repository. In the project folder, run:

```sh
./setup.sh
./run.sh
```

Open the local address printed by the server. On macOS, `./run.sh --open` also opens the browser. You can skip `./setup.sh` and install transcription in Settings instead. **Test run** works before transcription is installed and saves no recording.

## Practice

- Open **Behavioral practice** for general questions, or add a job to practice for a role. Try the [fictional job](examples/job.json) and [sample session](examples/sample-session.md).
- Choose the questions, prep time, and answer limit. Check your camera and mic, then start. The prep timer runs before the first answer.
- Use **Next question**, **Skip**, or **Restart answer** while recording. Use **End and save** to finish early. You can review the transcript and jump to individual answers in the video.
- If an upload fails, keep the tab open and select **Retry save**. If transcription fails after the video saves, use **Retry transcription** in the session review.

## Optional Codex feedback

Install the [Codex CLI](https://developers.openai.com/codex/cli), run `codex login`, and enable **Use Codex for feedback and case questions** in Settings. Interview Desk uses your signed-in CLI account and the CLI’s default model. It sends text from the relevant answers, job descriptions, or notes to Codex. Recordings stay on your computer. See [Architecture](docs/architecture.md) for the data flow.

Feedback is off on a fresh install. You can still record, transcribe, and review answers. When enabled, feedback runs after transcription. You can also request a rewrite for an individual answer or re-evaluate after adding notes.

## Data and configuration

Settings shows your data folder. On macOS the default is `~/Library/Application Support/Interview Desk`. Back up that folder to keep your sessions, question history, and settings. It is separate from the app and source folder.

| Variable | Use |
| --- | --- |
| `INTERVIEW_DESK_HOME` | Choose a different data folder. |
| `PORT` | Use another local port. The default is 5173. |
| `PYTHON_BIN` | Choose the Python executable used to install Whisper. |
| `WHISPER_MODEL` | Change the default `base.en` model. |
| `CODEX_BIN` | Choose a Codex CLI executable. |
| `CODEX_MODEL` | Use a different model available to your CLI account. |

Example for a separate practice folder:

```sh
INTERVIEW_DESK_HOME="$HOME/Interview Desk Practice" ./run.sh
```

## Develop

Run `node --test`. On macOS, `./scripts/build-macos.sh` builds the disk image in `dist/`. See [AGENTS.md](AGENTS.md) for contributor notes and [Architecture](docs/architecture.md) for code ownership.

Released under the [MIT License](LICENSE).
