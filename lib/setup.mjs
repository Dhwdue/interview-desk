import { execFile } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { python, venvDir } from './config.mjs';

const exec = promisify(execFile);
const whisperVersion = '1.2.1';
const avVersion = '18.1.0';
const marker = path.join(venvDir, `.faster-whisper-${whisperVersion}-av-${avVersion}`);

export async function transcriptionReady() {
  return fs.access(python, constants.X_OK)
    .then(() => process.env.INTERVIEW_DESK_PYTHON ? undefined : fs.access(marker))
    .then(() => true, () => false);
}

let installing;
export function installTranscription() {
  installing ||= (async () => {
    if (await transcriptionReady()) return;
    if (process.env.INTERVIEW_DESK_PYTHON) throw new Error('INTERVIEW_DESK_PYTHON points to an unavailable executable.');

    const pathDirs = (process.env.PATH || '').split(path.delimiter);
    const systemPython = process.env.PYTHON_BIN
      || ['python3.13', 'python3.12', 'python3.11'].find(name => pathDirs.some(dir => existsSync(path.join(dir, name))))
      || 'python3';
    await exec(systemPython, ['-c', 'import sys; assert (3, 11) <= sys.version_info[:2] <= (3, 13), "Python 3.11–3.13 is required"'])
      .catch(() => { throw new Error('Install Python 3.11–3.13, or set PYTHON_BIN to its executable.'); });
    await exec(systemPython, ['-m', 'venv', venvDir]);
    await exec(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input',
      'faster-whisper==' + whisperVersion, 'av==' + avVersion],
      { timeout: 600_000, maxBuffer: 2_000_000 });
    await exec(python, ['-c', `
import io, wave
from faster_whisper.audio import decode_audio

sample = io.BytesIO()
with wave.open(sample, "wb") as output:
    output.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
    output.writeframes(bytes(320))
sample.seek(0)
assert len(decode_audio(sample)) == 160
`]);
    await fs.writeFile(marker, '');
  })().finally(() => { installing = undefined; });
  return installing;
}
