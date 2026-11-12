import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const source = fileURLToPath(new URL('../', import.meta.url));

async function startDesk(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'interview-desk-test-'));
  const app = path.join(temp, 'Installed source');
  const data = path.join(temp, 'Practice data');
  await fs.mkdir(app);
  for (const name of ['server.mjs', 'lib', 'public', 'data', 'transcribe.py']) {
    await fs.cp(path.join(source, name), path.join(app, name), { recursive: true });
  }
  const python = path.join(temp, 'python-mock.mjs');
  const codex = path.join(temp, 'codex-mock.mjs');
  await fs.writeFile(python, `#!/usr/bin/env node
import fs from 'node:fs';
const [, audio, output] = process.argv.slice(2);
if (fs.readFileSync(audio, 'utf8') === 'fail once' && !fs.existsSync(output + '.attempt')) {
  fs.writeFileSync(output + '.attempt', '');
  process.exit(1);
}
fs.writeFileSync(output, JSON.stringify({segments: [{words: [
  {start:0.2,end:0.5,word:' I'}, {start:0.6,end:0.8,word:' compared'}, {start:1.1,end:1.3,word:' routes.'}
]}]}));
`, { mode: 0o700 });
  await fs.writeFile(codex, `#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
const args = process.argv.slice(2);
assert(args.includes('read-only') && args.includes('--ephemeral') && args.includes('shell_tool') && args.includes('--output-schema'));
assert(!fs.existsSync('jobs'));
const input = JSON.parse(fs.readFileSync(0, 'utf8').split('\\n').at(-1));
const schema = JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema') + 1], 'utf8'));
let result;
if (schema.properties.questions) {
  result = { questions: [{ text: 'How would you investigate missed stops?', tags: ['delivery'] }] };
} else if (schema.properties.answers) {
  const score = input.notes === 'invalid score' ? 9 : input.notes ? 4 : 3;
  result = { overview: 'Good structure.', answers: input.answers.map(({index}) => ({
    index, score, feedback:'You gave an example.', focus:'Say what changed.', needsRework:score<4
  })) };
} else {
  result = { changes:'Removed a false start.', answer:'I compared two delivery routes.' };
}
fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify(result));
`, { mode: 0o700 });

  const env = { ...process.env, PORT: '0', INTERVIEW_DESK_HOME: data, CODEX_BIN: codex, INTERVIEW_DESK_PYTHON: python };
  const server = spawn(process.execPath, [path.join(app, 'server.mjs')], { cwd: temp, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(server, 'exit');
  t.after(async () => {
    server.kill();
    await exited;
    await fs.rm(temp, { recursive: true, force: true });
  });
  let log = '';
  server.stdout.on('data', chunk => { log += chunk; });
  server.stderr.on('data', chunk => { log += chunk; });

  async function until(check) {
    for (let i = 0; i < 150; i++) {
      const result = await check();
      if (result) return result;
      if (server.exitCode !== null) assert.fail(log);
      await wait(40);
    }
    assert.fail('Timed out waiting for Interview Desk.\n' + log);
  }
  const base = await until(() => log.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]);
  async function request(route, { method = 'GET', body, headers, status = 200 } = {}) {
    const response = await fetch(base + route, {
      method, headers: typeof body === 'object' ? { 'content-type': 'application/json', ...headers } : headers,
      body: typeof body === 'object' ? JSON.stringify(body) : body,
    });
    assert.equal(response.status, status, `${method} ${route}: ${response.status === status ? '' : await response.text()}`);
    return response;
  }
  const json = async (...args) => (await request(...args)).json();
  return { app, base, data, json, request, until };
}

test('relocated source serves the app and stores only private runtime files in the configured directory', async t => {
  const { app, base, data, json, request } = await startDesk(t);
  assert.match(await (await request('/')).text(), /Interview Desk/);
  assert.deepEqual(await json('/api/health'), { app: 'interview-desk', dataDir: data });
  assert.equal((await json('/api/jobs'))[0].title, 'Behavioral practice');
  assert.equal((await json('/api/settings')).codexEnabled, false);
  assert.deepEqual((await fs.readdir(app)).sort(), ['data', 'lib', 'public', 'server.mjs', 'transcribe.py']);
  assert.deepEqual((await fs.readdir(data)).sort(), ['case-banks', 'jobs']);
  const status = await new Promise((resolve, reject) => {
    http.get(base + '/api/jobs', { headers: { host: 'foreign.invalid' } }, response => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(status, 403);
  await request('/api/shutdown', { method: 'POST', headers: { origin: 'https://foreign.invalid' }, status: 403 });
  await request('/api/jobs', { method: 'POST', body: [], status: 400 });
});

test('recording retries keep one attempt, and feedback replaces one score', async t => {
  const { data, json, request, until } = await startDesk(t);
  const job = await json('/api/jobs', { method: 'POST', body: {
    title: 'Product Analyst', company: 'Alder Parcel', jd: 'Investigate fictional delivery routes.',
    mustAsk: 'Tell me about a time you found a problem.',
  } });
  const root = '/api/jobs/' + job.id;
  await request(root + '/cases', { method: 'POST', status: 409 });
  assert.deepEqual(await fs.readdir(path.join(data, 'case-banks')), []);
  await json('/api/settings', { method: 'PUT', body: { codexEnabled: true } });
  await request(root + '/cases', { method: 'POST', status: 202 });
  await until(async () => (await json(root)).caseGen === null);

  const { questions } = await json(root + '/plan', { method: 'POST', body: { count: 2 } });
  const bankPath = path.join(data, 'jobs', job.id, 'question-bank.json');
  const bank = async () => JSON.parse(await fs.readFile(bankPath, 'utf8'));
  assert((await bank()).questions.some(question => question.source === 'codex'));
  const { sessionId } = await json(root + '/sessions', { method: 'POST', body: { questions } });
  const session = root + '/sessions/' + sessionId;
  const media = '/media/' + job.id + '/' + sessionId;
  const finish = { method: 'POST', body: {
    durationMs: 2000,
    segments: [{ questionId: questions[0].id, startMs: 0, endMs: 2000, skipped: false }],
  } };

  await request(session + '/media/audio.webm', { method: 'PUT', body: 'fail once' });
  await request(session + '/finish', { ...finish, status: 409 });
  await request(session + '/media/recording.webm', { method: 'PUT', body: '', status: 400 });
  await request(session + '/media/recording.webm', { method: 'PUT', body: 'video bytes' });
  await request(session + '/finish', finish);
  await until(async () => (await json(session + '/status')).state === 'error');
  assert.equal((await bank()).questions[0].timesAsked, 1);

  await Promise.all([request(session + '/finish', finish), request(session + '/finish', finish)]);
  await until(async () => (await json(session + '/status')).evalState === 'done');
  let detail = await json(session);
  assert.equal(detail.stats.answers[0].text, 'I compared routes.');
  assert.match(detail.evaluation, /Good structure/);
  assert.equal(detail.videoFile, 'recording.webm');
  assert.equal((await bank()).questions[0].timesAsked, 1);
  assert.deepEqual((await bank()).questions[0].scores, [3]);
  await request(session + '/media/recording.webm', { method: 'PUT', body: 'replace?', status: 409 });
  await request(session, { method: 'DELETE', status: 409 });

  const tail = await request(media + '/recording.webm', { headers: { range: 'bytes=-5' }, status: 206 });
  assert.equal(await tail.text(), 'bytes');
  await request(media + '/recording.webm', { headers: { range: 'bytes=8-3' }, status: 416 });
  await request(media + '/session.md', { status: 404 });

  await json(session + '/notes', { method: 'POST', body: { text: 'invalid score' } });
  await request(session + '/evaluate', { method: 'POST', status: 202 });
  await until(async () => (await json(session + '/status')).evalState === 'error');
  assert.deepEqual((await bank()).questions[0].scores, [3]);
  await json(session + '/notes', { method: 'POST', body: { text: 'I wanted to practice specificity.' } });
  await request(session + '/evaluate', { method: 'POST', status: 202 });
  await until(async () => (await json(session + '/status')).evalState === 'done');
  const question = (await bank()).questions[0];
  assert.deepEqual(question.scores, [4]);
  assert.deepEqual(question.history.map(item => item.session), [sessionId]);

  await request(session + '/sample', { method: 'POST', body: { index: 0 }, status: 202 });
  detail = await until(async () => {
    const detail = await json(session);
    return detail.samples[0] && detail;
  });
  assert.match(detail.samples[0], /delivery routes/);
});
