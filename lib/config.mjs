import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const host = '127.0.0.1';
export const port = Number(process.env.PORT ?? 5173);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer from 0 to 65535.');

const defaultData = process.platform === 'darwin'
  ? path.join(homedir(), 'Library', 'Application Support', 'Interview Desk')
  : path.join(process.env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share'), 'interview-desk');

export const dataDir = path.resolve(process.env.INTERVIEW_DESK_HOME || defaultData);
export const jobsDir = path.join(dataDir, 'jobs');
export const caseDir = path.join(dataDir, 'case-banks');
export const assetsDir = path.join(root, 'data');
export const publicDir = path.join(root, 'public');
export const venvDir = path.join(dataDir, 'python');
export const python = process.env.INTERVIEW_DESK_PYTHON || path.join(venvDir, 'bin', 'python3');
export const whisperModel = process.env.WHISPER_MODEL || 'base.en';
export const codex = process.env.CODEX_BIN || 'codex';
export const codexModel = process.env.CODEX_MODEL;

export const jobDir = id => path.join(jobsDir, id);
export const sessionDir = (id, sid) => path.join(jobDir(id), 'sessions', sid);
