import fs from 'node:fs/promises';
import path from 'node:path';
import { caseDir, jobDir, sessionDir } from './config.mjs';
import { generate } from './feedback.mjs';
import { httpError, readJson, serialize, writeJson, writeText } from './store.mjs';

const evaluating = new Set();
const cases = new Map();
const samples = new Map();

export const caseState = id => cases.get(id) || null;
export const feedbackInProgress = () => evaluating.size > 0
  || [...cases.values(), ...samples.values()].includes('running');

export function evaluationStatus(id, sid, status) {
  if (evaluating.has(id + '/' + sid)) return { ...status, evalState: 'running' };
  if (status.evalState === 'running') {
    return { ...status, evalState: 'error', evalError: 'Feedback was interrupted. Request it again.' };
  }
  return status;
}

export async function evaluate(id, sid) {
  const key = id + '/' + sid;
  if (evaluating.has(key)) return;
  evaluating.add(key);
  const dir = sessionDir(id, sid);
  const statusFile = path.join(dir, 'status.json');
  const setState = async (evalState, evalError) => {
    const status = await readJson(statusFile);
    await writeJson(statusFile, { ...status, evalState, evalError });
  };
  try {
    await setState('running');
    const [job, meta, stats] = await Promise.all([
      readJson(path.join(jobDir(id), 'job.json')),
      readJson(path.join(dir, 'meta.json')),
      readJson(path.join(dir, 'stats.json')),
    ]);
    const answers = stats.answers.filter(answer => !answer.skipped && answer.text)
      .map(({ index, question, text, wpm, pauses, approxFillers }) => ({ index, question, text, wpm, pauses, approxFillers }));
    const result = answers.length
      ? await generate('evaluation', {
        role: job.title, company: job.company, description: job.jd, notes: meta.notes || '', answers,
      })
      : { overview: 'No spoken answers were available to review.', answers: [] };

    const scored = new Map(result.answers.map(answer => [answer.index, answer]));
    if (result.answers.length !== answers.length || scored.size !== answers.length
        || answers.some(({ index }) => !scored.has(index) || scored.get(index).score < 1 || scored.get(index).score > 5)) {
      throw new Error('Codex returned invalid or incomplete scores. Request feedback again.');
    }

    const bankFile = path.join(jobDir(id), 'question-bank.json');
    await serialize(id, async () => {
      const bank = await readJson(bankFile, { questions: [] });
      for (const { index, score, focus, needsRework } of scored.values()) {
        const question = bank.questions.find(q => q.id === stats.answers[index].questionId);
        if (!question) continue;
        const history = question.history || [];
        const oldScores = question.scores || [];
        const scoredEntries = history.filter(entry => Number.isFinite(entry.score)).length;
        const entry = { session: sid, score, skipped: false, note: focus };
        const previous = history.findIndex(item => item.session === sid);
        if (previous === -1) history.push(entry);
        else history[previous] = entry;
        question.history = history;
        question.scores = oldScores.slice(0, Math.max(0, oldScores.length - scoredEntries))
          .concat(history.filter(item => Number.isFinite(item.score)).map(item => item.score));
        if (!question.lastSessionId || question.lastSessionId === sid) {
          const average = question.scores.reduce((sum, item) => sum + item, 0) / question.scores.length;
          question.status = average < 3 ? 'weak' : average <= 4 ? 'ok' : 'strong';
          question.focus = focus;
          question.needsRework = needsRework;
        }
      }
      if (scored.size) await writeJson(bankFile, bank);
    });

    const lines = [result.overview];
    for (const { index, score, feedback, focus } of scored.values()) {
      lines.push(`### Question ${index + 1} (${score}/5)`, feedback, `Next attempt: ${focus}`);
    }
    await writeText(path.join(dir, 'evaluation.md'), lines.join('\n\n') + '\n');
    await setState('done');
  } catch (error) {
    await setState('error', error.message);
  } finally {
    evaluating.delete(key);
  }
}

export async function generateCases(id) {
  if (cases.get(id) === 'running') return;
  cases.set(id, 'running');
  try {
    const job = await readJson(path.join(jobDir(id), 'job.json'));
    if (!job.jd.trim()) throw new Error('Add a job description first.');
    const file = path.join(caseDir, id + '.json');
    const existing = await readJson(file, { questions: [] });
    const { questions } = await generate('cases', {
      role: job.title, company: job.company, description: job.jd,
      existingQuestions: existing.questions.map(question => question.text),
    });
    const seen = new Set(existing.questions.map(question => question.text.trim().toLowerCase()));
    for (const question of questions.slice(0, 12)) {
      const text = question.text.trim();
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      existing.questions.push({ text, tags: question.tags });
      seen.add(key);
    }
    if (!existing.questions.length) throw new Error('Codex returned no case questions.');
    await writeJson(file, existing);
    cases.delete(id);
  } catch (error) {
    cases.set(id, { error: error.message });
  }
}

export async function prepareSample(id, sid, index) {
  const dir = sessionDir(id, sid);
  const stats = await readJson(path.join(dir, 'stats.json'));
  const answer = stats?.answers[index];
  if (!answer || answer.skipped || !answer.text) throw httpError(400, 'There is no spoken answer to rewrite.');
  const key = id + '/' + sid + '/' + index;
  if (samples.get(key) === 'running') return;
  samples.set(key, 'running');
  (async () => {
    try {
      const result = await generate('sample', { question: answer.question, answer: answer.text });
      const folder = path.join(dir, 'samples');
      await fs.mkdir(folder, { recursive: true });
      await writeText(path.join(folder, `q${index + 1}.md`), result.changes + '\n---\n' + result.answer + '\n');
      samples.delete(key);
    } catch (error) {
      samples.set(key, { error: error.message });
    }
  })();
}

export async function feedbackDetail(id, sid) {
  const dir = sessionDir(id, sid);
  const folder = path.join(dir, 'samples');
  const prefix = id + '/' + sid + '/';
  const files = await fs.readdir(folder).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const entries = await Promise.all(files.filter(file => /^q\d+\.md$/.test(file)).map(async file =>
    [Number(file.slice(1, -3)) - 1, await fs.readFile(path.join(folder, file), 'utf8')]));
  const evaluation = await fs.readFile(path.join(dir, 'evaluation.md'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  return {
    evaluation, samples: Object.fromEntries(entries),
    sampleStates: Object.fromEntries([...samples]
      .filter(([key]) => key.startsWith(prefix)).map(([key, state]) => [key.slice(prefix.length), state])),
  };
}
