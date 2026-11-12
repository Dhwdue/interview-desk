import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';

export async function readJson(file, fallback = null) {
  const text = await fs.readFile(file, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  return text === undefined ? fallback : JSON.parse(text);
}

export async function writeText(file, text) {
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(temp, text, { mode: 0o600 });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

export const writeJson = (file, value) => writeText(file, JSON.stringify(value, null, 2) + '\n');

const pending = new Map();

// Planning, editing, and feedback can all change the same question bank.
export async function serialize(id, update) {
  const next = (pending.get(id) || Promise.resolve()).then(update);
  const settled = next.catch(() => {});
  pending.set(id, settled);
  try {
    return await next;
  } finally {
    if (pending.get(id) === settled) pending.delete(id);
  }
}

export const httpError = (status, message) => Object.assign(new Error(message), { status });
