# Interview Desk

Record interview practice, replay your answers, and read a local transcript.

## Install

Requires Node.js 22+, Python 3.11–3.13, and Chrome.

**macOS.** Download the [disk image](https://github.com/Dhwdue/interview-desk/releases/latest), drag Interview Desk into Applications, and select **Install transcription** in Settings. If Gatekeeper blocks the app, run from source.

**Source.** In the project folder, run:

```sh
./setup.sh
./run.sh
```

Open the local address printed by the server. The first recording downloads the Whisper model.

## Practice

Choose **Behavioral practice** or add a job. Pick your questions, check your camera and mic, then start. **Test run** saves no recording.

Settings shows your data folder. On macOS it defaults to `~/Library/Application Support/Interview Desk`. Set `INTERVIEW_DESK_HOME` to use a different folder.

[Example session](examples/sample-session.md) · [Architecture](docs/architecture.md) · [MIT License](LICENSE)
