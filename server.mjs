import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { assetsDir as DATA_DIR, caseDir, dataDir, host, jobsDir, jobDir, port, publicDir, sessionDir } from './lib/config.mjs';
import { httpError, readJson, serialize, writeJson } from './lib/store.mjs';
import { installTranscription, transcriptionReady } from './lib/setup.mjs';
import {
  createSession, discardSession, finishSession, isMedia, listSessions, processingSessions,
  regenerateSessionMd, sessionDetail, sessionStatus, uploadMedia,
} from './lib/sessions.mjs';
import { caseState, evaluate, evaluationStatus, feedbackDetail, feedbackInProgress, generateCases, prepareSample } from './lib/coaching.mjs';

process.umask(0o077);
const PRACTICE_ID = 'behavioral-practice';
const exists = fs.existsSync;
const slugify = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60).replace(/-$/, '') || 'job';
const qid = text => 'q_' + slugify(text).replace(/-/g, '_').slice(0, 40);
const daysSince = iso => {
  if (!iso) return 999;
  const ms = Date.now() - new Date(iso).getTime();
  return Number.isFinite(ms) ? Math.max(0, ms / 86_400_000) : 999;
};

function makeQuestion(text, { category = 'behavioral', tags = [], source = 'starter', mustAsk = false } = {}) {
  return {
    id: qid(text), text, category, tags, source, mustAsk,
    timesAsked: 0, timesSkipped: 0, lastAsked: null, lastSessionId: null,
    scores: [], status: 'new', needsRework: false, focus: null, history: [],
  };
}

function avgScore(q) {
  if (!q.scores || !q.scores.length) return 3;
  return q.scores.reduce((a, b) => a + b, 0) / q.scores.length;
}

function weightOf(q, latestSessionId) {
  let w = (5 - avgScore(q)) * 2 + q.timesSkipped * 3 + daysSince(q.lastAsked) / 7;
  // Never-asked questions all score identically, which makes the pick order
  // pure insertion order. A little jitter keeps sessions from repeating.
  if (!q.timesAsked) w += 3 + Math.random() * 3;
  if (q.lastSessionId && q.lastSessionId === latestSessionId && !q.timesSkipped && !q.needsRework) w -= 5;
  return w;
}

function tierOf(q) {
  if (q.mustAsk) return 0;
  if (q.status === 'skipped') return 1;
  if (q.needsRework) return 2;
  // Keep scripted questions near the top for the first two attempts.
  if (q.scripted && q.timesAsked < 2) return 3;
  return 4;
}

function reasonOf(q) {
  const skips = q.timesSkipped > 1 ? `skipped ${q.timesSkipped}x` : 'you skipped this';
  if (q.scripted && !q.timesSkipped && !q.needsRework && !q.mustAsk) return 'you have a script';
  if (q.mustAsk) return q.status === 'skipped' ? `must-ask · ${skips}` : 'must-ask';
  if (q.status === 'skipped') return skips;
  if (q.needsRework) return 'needs rework';
  if (!q.timesAsked) return 'new';
  return 'rotation';
}

/* Pull tag-matched questions out of the shared starter bank when a job's own
   bank is thin, so a brand-new job still has something to improvise with. */
/* The general practice job has no JD to match against, so it draws from the
   themed behavioral pool, honouring whichever themes are switched on. */
async function stockBehavioral(job, bank) {
  const src = await readJson(path.join(DATA_DIR, 'behavioral-bank.json'), { questions: [] });
  const themes = job.themes || [];
  const pool = src.questions.filter((q) => !themes.length || q.tags.some((t) => themes.includes(t)));
  const have = new Set(bank.questions.map((q) => q.id));
  let added = false;
  for (const q of pool) {
    if (have.has(qid(q.text))) continue;
    bank.questions.push(makeQuestion(q.text, { category: 'behavioral', tags: q.tags, source: 'behavioral' }));
    added = true;
  }
  return added;
}

/* Role-specific case questions live in the user's case-banks directory. Unlike the
   generic starter pool these are never capped -- they're the questions that
   actually sound like this job's interview. */
async function stockCases(id, bank) {
  const src = await readJson(path.join(caseDir, `${id}.json`), null);
  if (!src) return false;
  const have = new Set(bank.questions.map((q) => q.id));
  let added = false;
  for (const q of src.questions) {
    if (have.has(qid(q.text))) continue;
    const nq = makeQuestion(q.text, {
      category: 'case', tags: q.tags || [], source: q.scripted ? 'user' : 'codex',
    });
    nq.scripted = !!q.scripted;
    bank.questions.push(nq);
    added = true;
  }
  return added;
}

async function stockBank(id, job, bank) {
  if (job.kind === 'behavioral') return stockBehavioral(job, bank);
  const addedCases = await stockCases(id, bank);
  const target = 30;
  if (bank.questions.length >= target) return addedCases;
  const starter = await readJson(path.join(DATA_DIR, 'starter-bank.json'), { tagKeywords: {}, questions: [] });
  const jd = `${job.title} ${job.company} ${job.jd}`.toLowerCase();
  const hitTags = new Set();
  for (const [tag, words] of Object.entries(starter.tagKeywords || {})) {
    if (words.some((w) => jd.includes(w.toLowerCase()))) hitTags.add(tag);
  }
  const have = new Set(bank.questions.map((q) => q.id));
  const scored = starter.questions
    .filter((q) => !have.has(qid(q.text)))
    .map((q) => ({ q, score: (q.tags || []).filter((t) => hitTags.has(t)).length + Math.random() * 0.5 }))
    .sort((a, b) => b.score - a.score);
  let added = addedCases;
  for (const { q } of scored) {
    if (bank.questions.length >= target) break;
    bank.questions.push(makeQuestion(q.text, { category: q.category, tags: q.tags, source: 'starter' }));
    added = true;
  }
  return added;
}

/* One always-present job with no JD attached, for behavioural drilling.
   It is a normal job folder underneath, so sessions, transcription, scoring
   and skip-memory all work exactly the same way. */
async function ensurePractice() {
  const dir = jobDir(PRACTICE_ID);
  if (exists(path.join(dir, 'job.json'))) return readJson(path.join(dir, 'job.json'));
  await fsp.mkdir(path.join(dir, 'sessions'), { recursive: true });
  const mustAsk = [
    'Tell me about yourself.',
    'Tell me about a time you disagreed with a teammate. How did it resolve?',
  ];
  const job = {
    id: PRACTICE_ID, kind: 'behavioral',
    title: 'Behavioral practice', company: '', jd: '',
    themes: [], mustAsk, createdAt: new Date().toISOString(),
  };
  await writeJson(path.join(dir, 'job.json'), job);
  await writeJson(path.join(dir, 'question-bank.json'), {
    questions: mustAsk.map((t) => makeQuestion(t, { category: 'must-ask', source: 'user', mustAsk: true })),
  });
  return job;
}

/* Editing the must-ask list has to reconcile against the bank rather than
   rebuild it, or every question's score history is thrown away. */
async function updateJob(id, patch) {
  const jobPath = path.join(jobDir(id), 'job.json');
  const bankPath = path.join(jobDir(id), 'question-bank.json');
  const job = await readJson(jobPath);
  const bank = await readJson(bankPath, { questions: [] });

  // The folder id is fixed at creation and deliberately never changes here --
  // sessions and history live under it, so a rename must not move them.
  if (typeof patch.title === 'string' && patch.title.trim()) job.title = patch.title.trim();
  if (typeof patch.company === 'string') job.company = patch.company.trim();
  if (typeof patch.jd === 'string') job.jd = patch.jd.trim();

  if (patch.themes !== undefined) job.themes = patch.themes;
  if (['all', 'case', 'behavioral'].includes(patch.focus)) job.focus = patch.focus;
  if (patch.mustAsk !== undefined) {
    job.mustAsk = patch.mustAsk.map((t) => t.trim()).filter(Boolean);
    const wanted = new Map(job.mustAsk.map((t) => [qid(t), t]));
    for (const q of bank.questions) q.mustAsk = wanted.has(q.id);
    for (const [id2, text] of wanted) {
      if (!bank.questions.some((q) => q.id === id2)) {
        bank.questions.push(makeQuestion(text, { category: 'must-ask', source: 'user', mustAsk: true }));
      }
    }
  }
  await writeJson(jobPath, job);
  await writeJson(bankPath, bank);
  return job;
}

async function planSession(id, count) {
  const job = await readJson(path.join(jobDir(id), 'job.json'));
  if (!job) return null;
  const bankPath = path.join(jobDir(id), 'question-bank.json');
  const bank = await readJson(bankPath, { questions: [] });
  if (await stockBank(id, job, bank)) await writeJson(bankPath, bank);

  const sessions = await listSessions(id);
  const latest = sessions[0]?.id || null;

  const themes = (job.kind === 'behavioral' && job.themes) || [];
  const focus = job.focus || 'all';
  const matchesFocus = (q) => {
    if (focus === 'case') return q.category === 'case';
    if (focus === 'behavioral') return q.category !== 'case';
    return true;
  };
  const inScope = (q) => q.mustAsk
    || ((!themes.length || (q.tags || []).some((t) => themes.includes(t))) && matchesFocus(q));

  const ranked = bank.questions
    .filter(inScope)
    .map((q) => ({ q, tier: tierOf(q), w: weightOf(q, latest) }))
    .sort((a, b) => a.tier - b.tier || b.w - a.w);

  const picked = [];
  for (const { q } of ranked) {
    if (q.mustAsk) picked.push(q);
  }
  for (const { q } of ranked) {
    if (picked.length >= count) break;
    if (!q.mustAsk) picked.push(q);
  }

  const questions = picked
    .slice(0, Math.max(count, picked.filter((q) => q.mustAsk).length))
    .map((q) => ({
      id: q.id, text: q.text, category: q.category,
      reason: reasonOf(q), attempt: q.timesAsked + 1,
      timesSkipped: q.timesSkipped, focus: q.focus, scripted: !!q.scripted,
    }));

  // How much room reshuffle actually has. With one theme on and a small pool,
  // redrawing looks broken even though it works, so the UI says the numbers.
  return {
    questions,
    poolSize: ranked.length,
    pinned: ranked.filter(({ q }) => q.mustAsk).length,
  };
}

async function recordAttempts(id, sid, segments) {
  await serialize(id, async () => {
    const file = path.join(jobDir(id), 'question-bank.json');
    const bank = await readJson(file, { questions: [] });
    bank.countedSessions ||= [];
    if (bank.countedSessions.includes(sid)) return;
    for (const segment of segments) {
      const question = bank.questions.find(q => q.id === segment.questionId);
      if (!question) continue;
      question.timesAsked++;
      question.lastAsked = new Date().toISOString();
      question.lastSessionId = sid;
      if (segment.skipped) {
        question.timesSkipped++;
        question.needsRework = true;
        question.status = 'skipped';
      }
    }
    bank.countedSessions.push(sid);
    await writeJson(file, bank);
  });
}

const settingsFile = path.join(dataDir, 'settings.json');
let settings = await readJson(settingsFile, { codexEnabled: false });
let setupState = null;
await Promise.all([jobsDir, caseDir].map(dir => fsp.mkdir(dir, { recursive: true, mode: 0o700 })));
await ensurePractice();

const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.webm': 'video/webm', '.mp4': 'video/mp4',
};
const jobId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const sessionId = /^\d{4}-\d{2}-\d{2}_\d{4}(?:-\d+)?$/;
const staticFiles = new Set(['/','/app.js','/styles.css']);

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_048_576) throw httpError(413, 'Request is too large.');
    chunks.push(chunk);
  }
  if (!size) return {};
  let data;
  try {
    data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'Expected a JSON object.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw httpError(400, 'Expected a JSON object.');
  return data;
}

async function serveFile(req, res, file) {
  const stat = await fsp.stat(file).catch(error => {
    if (error.code === 'ENOENT') throw httpError(404, 'File not found.');
    throw error;
  });
  if (!stat.isFile()) throw httpError(404, 'File not found.');
  const headers = { 'content-type': mime[path.extname(file)] || 'application/octet-stream', 'accept-ranges': 'bytes' };
  const range = req.headers.range;
  let start = 0;
  let end = stat.size - 1;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match && (match[1] || match[2])) {
      if (match[1]) {
        start = Number(match[1]);
        if (match[2]) end = Math.min(end, Number(match[2]));
      } else {
        start = Math.max(0, stat.size - Number(match[2]));
      }
    }
    if (!match || !(match[1] || match[2]) || start >= stat.size || start > end) {
      res.writeHead(416, { ...headers, 'content-range': `bytes */${stat.size}` });
      return res.end();
    }
    headers['content-range'] = `bytes ${start}-${end}/${stat.size}`;
  }
  res.writeHead(range ? 206 : 200, { ...headers, 'content-length': end - start + 1 });
  if (req.method === 'HEAD' || !stat.size) return res.end();
  await pipeline(fs.createReadStream(file, { start, end }), res);
}

const requireCodex = () => {
  if (!settings.codexEnabled) throw httpError(409, 'Enable Codex feedback in Settings first.');
};

const feedbackAfterTranscription = (id, sid) => settings.codexEnabled ? evaluate(id, sid) : undefined;

const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const address = `${host}:${server.address().port}`;
  const hostHeader = req.headers.host;
  const permittedHost = hostHeader === address || hostHeader === `localhost:${server.address().port}`;
  if (!permittedHost || (req.headers.origin && req.headers.origin !== 'http://' + hostHeader)
      || req.headers['sec-fetch-site'] === 'cross-site') {
    return json(res, 403, { error: 'Open Interview Desk on this computer.' });
  }

  try {
    const pathname = new URL(req.url, 'http://' + address).pathname;
    const seg = pathname.split('/').filter(Boolean);
    const method = req.method;
    const reading = method === 'GET' || method === 'HEAD';
    if (reading && staticFiles.has(pathname)) {
      return await serveFile(req, res, path.join(publicDir, pathname === '/' ? 'index.html' : pathname.slice(1)));
    }

    if (seg[0] === 'media' && reading && seg.length === 4) {
      const [, id, sid, file] = seg;
      if (!jobId.test(id) || !sessionId.test(sid) || !isMedia(file)) throw httpError(404, 'Recording not found.');
      return await serveFile(req, res, path.join(sessionDir(id, sid), file));
    }

    if (pathname === '/api/health' && method === 'GET') return json(res, 200, { app: 'interview-desk', dataDir });
    if (pathname === '/api/themes' && method === 'GET') {
      const bank = await readJson(path.join(DATA_DIR, 'behavioral-bank.json'));
      return json(res, 200, bank.themes);
    }

    if (pathname === '/api/settings' && method === 'GET') {
      return json(res, 200, { ...settings, dataDir, transcriptionReady: await transcriptionReady(), setupState });
    }
    if (pathname === '/api/settings' && method === 'PUT') {
      const { codexEnabled } = await readBody(req);
      if (typeof codexEnabled !== 'boolean') throw httpError(400, 'Choose whether to use Codex feedback.');
      const next = { codexEnabled };
      await writeJson(settingsFile, next);
      settings = next;
      return json(res, 200, settings);
    }
    if (pathname === '/api/settings/transcription' && method === 'POST') {
      if (setupState?.state !== 'running') {
        setupState = { state: 'running' };
        installTranscription().then(
          () => { setupState = { state: 'done' }; },
          error => { setupState = { state: 'error', error: error.stderr?.trim().split('\n').at(-1) || error.message }; },
        );
      }
      return json(res, 202, { setupState });
    }
    if (pathname === '/api/shutdown' && method === 'POST') {
      if (processingSessions() || feedbackInProgress() || setupState?.state === 'running') {
        throw httpError(409, 'Wait for processing to finish before quitting.');
      }
      json(res, 200, { ok: true });
      server.close();
      return;
    }

    if (pathname === '/api/jobs' && method === 'GET') {
      const entries = await fsp.readdir(jobsDir, { withFileTypes: true });
      const jobs = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || !jobId.test(entry.name)) continue;
        const id = entry.name;
        const job = await readJson(path.join(jobDir(id), 'job.json'));
        if (!job) continue;
        const bank = await readJson(path.join(jobDir(id), 'question-bank.json'), { questions: [] });
        const sessions = await listSessions(id);
        jobs.push({
          id, title: job.title, company: job.company, kind: job.kind || 'job', sessionCount: sessions.length,
          lastSession: sessions[0]?.startedAt || null,
          flagged: bank.questions.filter(q => q.needsRework || q.status === 'skipped').length,
        });
      }
      jobs.sort((a, b) => (b.lastSession || '').localeCompare(a.lastSession || ''));
      return json(res, 200, jobs);
    }
    if (pathname === '/api/jobs' && method === 'POST') {
      const { title, company = '', jd = '', mustAsk: rawQuestions = '' } = await readBody(req);
      if (typeof title !== 'string' || !title.trim() || typeof company !== 'string'
          || typeof jd !== 'string' || typeof rawQuestions !== 'string') {
        throw httpError(400, 'Enter a role title and use text for the job details.');
      }
      const mustAsk = rawQuestions.split('\n').map(line => line.trim()).filter(Boolean);
      if (mustAsk.length > 100) throw httpError(400, 'Use up to 100 must-ask questions.');
      const base = slugify(company + ' ' + title);
      const job = await serialize('/new-job', async () => {
        let id = base;
        let suffix = 2;
        while (exists(jobDir(id))) id = base + '-' + suffix++;
        const value = { id, title: title.trim(), company: company.trim(), jd: jd.trim(), mustAsk, createdAt: new Date().toISOString() };
        await fsp.mkdir(path.join(jobDir(id), 'sessions'), { recursive: true });
        await writeJson(path.join(jobDir(id), 'question-bank.json'), {
          questions: mustAsk.map(text => makeQuestion(text, { category: 'must-ask', source: 'user', mustAsk: true })),
        });
        await writeJson(path.join(jobDir(id), 'job.json'), value);
        return value;
      });
      if (settings.codexEnabled && job.jd) void generateCases(job.id);
      return json(res, 200, job);
    }

    if (seg[0] === 'api' && seg[1] === 'jobs' && jobId.test(seg[2] || '')) {
      const [, , id, resource, sid, action, name] = seg;
      if (!exists(path.join(jobDir(id), 'job.json'))) throw httpError(404, 'Job not found.');
      if (seg.length === 3 && method === 'GET') {
        const [job, sessions] = await Promise.all([readJson(path.join(jobDir(id), 'job.json')), listSessions(id)]);
        return json(res, 200, { job, sessions, caseGen: caseState(id) });
      }
      if (seg.length === 3 && method === 'PUT') {
        const patch = await readBody(req);
        for (const field of ['mustAsk', 'themes']) {
          if (patch[field] !== undefined && (!Array.isArray(patch[field]) || patch[field].length > 100
              || patch[field].some(item => typeof item !== 'string'))) {
            throw httpError(400, 'Expected a list of text values for ' + field + '.');
          }
        }
        return json(res, 200, await serialize(id, () => updateJob(id, patch)));
      }
      if (seg.length === 4 && resource === 'cases' && method === 'POST') {
        requireCodex();
        void generateCases(id);
        return json(res, 202, { ok: true });
      }
      if (seg.length === 4 && resource === 'plan' && method === 'POST') {
        const body = await readBody(req);
        const count = Math.max(1, Math.min(20, Math.trunc(Number(body.count)) || 6));
        return json(res, 200, await serialize(id, () => planSession(id, count)));
      }
      if (resource === 'sessions') {
        if (seg.length === 4 && method === 'GET') return json(res, 200, await listSessions(id));
        if (seg.length === 4 && method === 'POST') {
          const { questions } = await readBody(req);
          return json(res, 200, { sessionId: await createSession(id, questions) });
        }
        if (!sessionId.test(sid || '') || !exists(path.join(sessionDir(id, sid), 'meta.json'))) {
          throw httpError(404, 'Session not found.');
        }
        const dir = sessionDir(id, sid);
        if (seg.length === 7 && action === 'media' && method === 'PUT') {
          await uploadMedia(id, sid, name, req);
          return json(res, 200, { ok: true });
        }
        if (seg.length === 6 && action === 'finish' && method === 'POST') {
          await finishSession(id, sid, await readBody(req), { recordAttempts, onTranscript: feedbackAfterTranscription });
          return json(res, 200, { ok: true });
        }
        if (seg.length === 6 && action === 'notes' && method === 'POST') {
          const { text } = await readBody(req);
          if (typeof text !== 'string') throw httpError(400, 'Notes must be text.');
          await serialize(id + '/' + sid, async () => {
            const file = path.join(dir, 'meta.json');
            const meta = await readJson(file);
            await writeJson(file, { ...meta, notes: text });
            await regenerateSessionMd(id, sid);
          });
          return json(res, 200, { ok: true });
        }
        if (seg.length === 6 && action === 'evaluate' && method === 'POST') {
          requireCodex();
          if (!exists(path.join(dir, 'stats.json'))) throw httpError(409, 'Wait for transcription to finish first.');
          void evaluate(id, sid).catch(error => console.error('Could not save feedback:', error.code || error.message));
          return json(res, 202, { ok: true });
        }
        if (seg.length === 6 && action === 'sample' && method === 'POST') {
          requireCodex();
          const { index } = await readBody(req);
          if (!Number.isInteger(index) || index < 0) throw httpError(400, 'Choose an answer to rewrite.');
          await prepareSample(id, sid, index);
          return json(res, 202, { ok: true });
        }
        if (seg.length === 6 && action === 'status' && method === 'GET') {
          return json(res, 200, evaluationStatus(id, sid, await sessionStatus(id, sid)));
        }
        if (seg.length === 5 && method === 'DELETE') {
          await discardSession(id, sid);
          return json(res, 200, { ok: true });
        }
        if (seg.length === 5 && method === 'GET') {
          const detail = await sessionDetail(id, sid);
          detail.status = evaluationStatus(id, sid, detail.status);
          return json(res, 200, { ...detail, ...await feedbackDetail(id, sid) });
        }
      }
    }
    return json(res, 404, { error: 'Not found.' });
  } catch (error) {
    if (res.headersSent || res.destroyed) return;
    if (!error.status) console.error('Request failed:', error.code || error.name);
    return json(res, error.status || 500, { error: error.status ? error.message : 'Interview Desk could not complete the request.' });
  }
});

function openBrowser(url) {
  const chrome = spawn('/usr/bin/open', ['-a', 'Google Chrome', url], { stdio: 'ignore' });
  chrome.on('close', code => {
    if (code !== 0) spawn('/usr/bin/open', [url], { stdio: 'ignore' })
      .on('error', () => console.log('Open ' + url + ' in your browser.'));
  });
  chrome.on('error', () => console.log('Open ' + url + ' in your browser.'));
}
const shouldOpen = process.platform === 'darwin' && process.argv.includes('--open');
server.on('error', async error => {
  if (error.code === 'EADDRINUSE' && shouldOpen) {
    const url = `http://${host}:${port}`;
    const health = await fetch(url + '/api/health', { signal: AbortSignal.timeout(1500) })
      .then(response => response.json()).catch(() => null);
    if (health?.app === 'interview-desk' && health.dataDir === dataDir) {
      openBrowser(url);
      return;
    }
  }
  console.error('Could not start Interview Desk:', error.code || error.message);
  process.exitCode = 1;
});
server.listen(port, host, () => {
  const url = `http://${host}:${server.address().port}`;
  console.log('Interview Desk: ' + url);
  if (shouldOpen) openBrowser(url);
});
