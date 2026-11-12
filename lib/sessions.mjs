import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { jobDir, sessionDir, root, python, whisperModel } from './config.mjs';
import { httpError, readJson, writeJson, writeText, serialize } from './store.mjs';
import { transcriptionReady } from './setup.mjs';

const exec = promisify(execFile);
const FILLERS = /\b(um+|uh+|er+|ah+|like|you know|i mean|sort of|kind of|basically|actually|literally|honestly|right)\b/gi;
const PAUSE_MS = 2000;

const fmtDur = ms => {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
};

function segmentTranscript(meta, transcript) {
  const words = [];
  for (const seg of transcript.segments || []) {
    for (const w of seg.words || []) words.push(w);
  }
  return (meta.segments || []).map((s, i) => {
    const mine = words.filter((w) => {
      const mid = ((w.start + w.end) / 2) * 1000;
      return mid >= s.startMs && mid < s.endMs;
    });
    const text = mine.map((w) => w.word).join('').replace(/\s+/g, ' ').trim();
    const durationMs = Math.max(0, s.endMs - s.startMs);
    const minutes = durationMs / 60000;
    const wordCount = mine.length;

    let pauses = 0, longestPauseMs = 0;
    for (let k = 1; k < mine.length; k++) {
      const gap = (mine[k].start - mine[k - 1].end) * 1000;
      if (gap > PAUSE_MS) pauses++;
      if (gap > longestPauseMs) longestPauseMs = gap;
    }

    return {
      index: i, questionId: s.questionId, question: s.question, category: s.category,
      attempt: s.attempt, reason: s.reason, skipped: !!s.skipped,
      startMs: s.startMs, endMs: s.endMs, durationMs, text, wordCount,
      wpm: minutes > 0.05 ? Math.round(wordCount / minutes) : null,
      pauses, longestPauseMs: Math.round(longestPauseMs),
      approxFillers: (text.match(FILLERS) || []).length,
    };
  });
}

function renderSessionMd(job, meta, stats) {
  const L = [];
  L.push(`# ${job.title}${job.company ? ` — ${job.company}` : ''}`);
  L.push('');
  L.push(`Session \`${meta.sessionId}\` · started ${meta.startedAt}`);
  L.push('');
  L.push('## Job description');
  L.push('');
  L.push(job.jd?.trim() || '_none recorded_');
  L.push('');
  L.push('---');
  L.push('');

  stats.forEach((s, i) => {
    const bits = [`Q${i + 1}`, s.category, `attempt ${s.attempt}`, fmtDur(s.durationMs)];
    if (s.wpm) bits.push(`${s.wpm} wpm`);
    if (s.pauses) bits.push(`${s.pauses} pauses (longest ${(s.longestPauseMs / 1000).toFixed(1)}s)`);
    if (s.approxFillers) bits.push(`~${s.approxFillers} fillers`);
    L.push(`## ${bits.join(' · ')}${s.skipped ? ' · **SKIPPED**' : ''}`);
    L.push('');
    L.push(`**${s.question}**`);
    L.push('');
    L.push(s.skipped ? '_Skipped without answering._' : (s.text || '_no speech detected_'));
    L.push('');
  });

  if (meta.notes && meta.notes.trim()) {
    L.push('---');
    L.push('');
    L.push('## My own notes');
    L.push('');
    L.push(meta.notes.trim());
    L.push('');
  }

  return L.join('\n');
}

const active = new Set();
export const processingSessions = () => active.size > 0;
export const isMedia = name => /^(recording|audio)\.(webm|mp4)$/.test(name);
const mediaFile = (dir, type) => ['webm', 'mp4']
  .map(extension => type + '.' + extension)
  .find(name => fs.existsSync(path.join(dir, name)));

export async function createSession(id, questions) {
  if (!Array.isArray(questions) || !questions.length || questions.length > 100
      || questions.some(q => !q || typeof q.id !== 'string' || typeof q.text !== 'string')) {
    throw httpError(400, 'Choose at least one question before recording.');
  }
  if (!await transcriptionReady()) throw httpError(409, 'Set up transcription in Settings before recording, or use Test run.');
  return serialize(id, async () => {
    const now = new Date();
    const p = number => String(number).padStart(2, '0');
    const base = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}`;
    let sid = base;
    let suffix = 2;
    while (fs.existsSync(sessionDir(id, sid))) sid = base + '-' + suffix++;
    const dir = sessionDir(id, sid);
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    await writeJson(path.join(dir, 'meta.json'), {
      sessionId: sid, jobId: id, startedAt: now.toISOString(), questions, segments: [],
    });
    await writeJson(path.join(dir, 'status.json'), { state: 'recording' });
    return sid;
  });
}

export function uploadMedia(id, sid, name, request) {
  if (!isMedia(name)) throw httpError(400, 'Unsupported media file.');
  return serialize(id + '/' + sid, async () => {
    const dir = sessionDir(id, sid);
    const meta = await readJson(path.join(dir, 'meta.json'));
    if (meta.endedAt) throw httpError(409, 'The recording is already saved.');
    const destination = path.join(dir, name);
    const partial = destination + '.part';
    try {
      await pipeline(request, fs.createWriteStream(partial, { mode: 0o600 }));
      if (!(await fsp.stat(partial)).size) throw httpError(400, 'The recording file was empty. Retry the upload.');
      await fsp.rename(partial, destination);
    } finally {
      await fsp.rm(partial, { force: true });
    }
  });
}

export async function regenerateSessionMd(id, sid) {
  const dir = sessionDir(id, sid);
  const [job, meta, stats] = await Promise.all([
    readJson(path.join(jobDir(id), 'job.json')),
    readJson(path.join(dir, 'meta.json')),
    readJson(path.join(dir, 'stats.json')),
  ]);
  if (stats) await writeText(path.join(dir, 'session.md'), renderSessionMd(job, meta, stats.answers));
}

export function finishSession(id, sid, payload, { recordAttempts, onTranscript }) {
  const key = id + '/' + sid;
  return serialize(key, async () => {
    const dir = sessionDir(id, sid);
    const statusFile = path.join(dir, 'status.json');
    const status = await readJson(statusFile, { state: 'recording' });
    if (active.has(key) || status.state === 'done') return;
    const audio = mediaFile(dir, 'audio');
    if (!audio || !mediaFile(dir, 'recording')) throw httpError(409, 'Both the video and audio must be uploaded first.');
    const meta = await readJson(path.join(dir, 'meta.json'));
    if (!meta.endedAt) {
      const { segments, durationMs } = payload;
      if (!Array.isArray(segments) || !segments.length || segments.length > meta.questions.length
          || !Number.isFinite(durationMs) || durationMs < 0) {
        throw httpError(400, 'Invalid session timing.');
      }
      let previousEnd = 0;
      meta.segments = segments.map((segment, index) => {
        const question = meta.questions[index];
        if (!segment || segment.questionId !== question.id || !Number.isFinite(segment.startMs)
            || !Number.isFinite(segment.endMs) || segment.startMs < previousEnd
            || segment.endMs < segment.startMs || segment.endMs > durationMs) {
          throw httpError(400, 'Invalid answer timing.');
        }
        previousEnd = segment.endMs;
        return {
          questionId: question.id, question: question.text, category: question.category,
          attempt: question.attempt, reason: question.reason, skipped: Boolean(segment.skipped),
          startMs: segment.startMs, endMs: segment.endMs,
        };
      });
      meta.endedAt = new Date().toISOString();
      meta.durationMs = durationMs;
      await writeJson(path.join(dir, 'meta.json'), meta);
    }
    if (!meta.counted) await recordAttempts(id, sid, meta.segments);
    active.add(key);
    try {
      await writeJson(statusFile, { state: 'transcribing' });
    } catch (error) {
      active.delete(key);
      throw error;
    }
    (async () => {
      try {
        if (!await transcriptionReady()) throw new Error('Set up transcription in Settings, then retry.');
        const transcriptFile = path.join(dir, 'transcript.json');
        await exec(python, [path.join(root, 'transcribe.py'), path.join(dir, audio), transcriptFile, whisperModel],
          { timeout: 1_800_000, maxBuffer: 1_000_000 }).catch(error => {
          if (error.code === 'ENOENT' || error.code === 'EACCES') throw new Error('Could not start Python. Check transcription setup in Settings.');
          if (error.killed) throw new Error('Transcription timed out. Try again.');
          throw new Error('Whisper could not transcribe this recording. Check the model and internet access for the first download, then retry.');
        });
        const transcript = await readJson(transcriptFile);
        await writeJson(path.join(dir, 'stats.json'), { sessionId: sid, answers: segmentTranscript(meta, transcript) });
        await regenerateSessionMd(id, sid);
        await writeJson(statusFile, { state: 'done', finishedAt: new Date().toISOString() });
      } catch (error) {
        await writeJson(statusFile, { state: 'error', error: error.message });
        return;
      }
      await onTranscript(id, sid);
    })().catch(error => console.error('Could not update session status:', error.code || error.message))
      .finally(() => active.delete(key));
  });
}

export async function sessionStatus(id, sid) {
  const dir = sessionDir(id, sid);
  const status = await readJson(path.join(dir, 'status.json'), { state: 'unknown' });
  if (status.state === 'transcribing' && !active.has(id + '/' + sid)) {
    return { state: 'error', error: 'Transcription was interrupted. Retry from the saved recording.' };
  }
  if (status.state === 'recording' && (await readJson(path.join(dir, 'meta.json')))?.endedAt) {
    return { state: 'error', error: 'Saving was interrupted. Retry from the saved recording.' };
  }
  return status;
}

export async function listSessions(id) {
  const dir = path.join(jobDir(id), 'sessions');
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const names = entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort().reverse();
  return Promise.all(names.map(async sid => {
    const folder = sessionDir(id, sid);
    const meta = await readJson(path.join(folder, 'meta.json'), {});
    const status = await sessionStatus(id, sid);
    return {
      id: sid, startedAt: meta.startedAt || null,
      answered: (meta.segments || []).filter(segment => !segment.skipped).length,
      skipped: (meta.segments || []).filter(segment => segment.skipped).length,
      state: status.state, evaluated: fs.existsSync(path.join(folder, 'evaluation.md')),
    };
  }));
}

export async function sessionDetail(id, sid) {
  const dir = sessionDir(id, sid);
  const [meta, stats, status] = await Promise.all([
    readJson(path.join(dir, 'meta.json')),
    readJson(path.join(dir, 'stats.json')),
    sessionStatus(id, sid),
  ]);
  return { meta, stats, status, videoFile: mediaFile(dir, 'recording') || null };
}

export function discardSession(id, sid) {
  return serialize(id + '/' + sid, async () => {
    const dir = sessionDir(id, sid);
    const meta = await readJson(path.join(dir, 'meta.json'), {});
    if (meta.endedAt || meta.counted) throw httpError(409, 'The recording is already saved.');
    await fsp.rm(dir, { recursive: true, force: true });
  });
}
