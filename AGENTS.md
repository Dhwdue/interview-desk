# Working on Interview Desk

- Run `node --test` after changing server, storage, or feedback behavior. The tests use temporary data and fake Python and Codex executables.
- Keep source and writable data separate. Use a temporary `INTERVIEW_DESK_HOME` for smoke tests and package checks.
- Commit only source and fictional examples. Keep recordings, transcripts, session notes, generated case banks, and credentials out of Git and release archives.
- Validate external input where it enters. Reuse the validated values and keep changes with the module that owns the behavior.
- Read [the architecture](docs/architecture.md) when changing recording, storage, setup, or what goes to Codex.
