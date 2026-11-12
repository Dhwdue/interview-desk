/* Interview Desk — camera, recording, question flow, review. */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const once = (t, ev) => new Promise((r) => t.addEventListener(ev, r, { once: true }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) {
    const error = await r.json().catch(() => ({}));
    throw new Error(error.error || `Request failed (${r.status}).`);
  }
  return r.json();
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

const clock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const S = {
  jobId: null, job: null, plan: [], idx: 0, busy: false,
  stream: null, videoRec: null, audioRec: null,
  videoChunks: [], audioChunks: [], videoExt: 'webm', audioExt: 'webm',
  sessionId: null, t0: 0, qStart: 0, segments: [],
  prep: 5, limit: 120, tick: null, meterRaf: null, audioCtx: null,
  testMode: false, inPrep: false, prepSkip: null, reviewSid: null, samplePoll: false, themes: null,
  settings: null, pendingSave: null, saveBusy: false,
};

function show(id) {
  $$('.view').forEach(view => { view.hidden = view.id !== id; });
  const recording = id === 'view-session';
  $('#home-btn').hidden = id === 'view-jobs' || recording || Boolean(S.pendingSave);
  $('#settings-btn').hidden = recording || Boolean(S.pendingSave);
  $('#app-error').hidden = true;
  $('#' + id).querySelector('h1')?.focus();
  window.scrollTo(0, 0);
}

function showError(message) {
  $('#app-error').textContent = message;
  $('#app-error').hidden = false;
}

function releaseCamera() {
  if (S.meterRaf) cancelAnimationFrame(S.meterRaf), (S.meterRaf = null);
  if (S.audioCtx) S.audioCtx.close().catch(() => {}), (S.audioCtx = null);
  if (S.stream) S.stream.getTracks().forEach((t) => t.stop()), (S.stream = null);
}

/* ─────────── jobs ─────────── */

function jobCard(job) {
  const button = el('button', 'job-card');
  const label = el('span', null, job.title);
  if (job.company) label.append(el('span', 'sub', job.company));
  button.append(label);
  if (job.flagged) button.append(el('span', 'sub flag', `${job.flagged} to revisit`));
  else if (job.sessionCount) button.append(el('span', 'sub', `${job.sessionCount} session${job.sessionCount === 1 ? '' : 's'}`));
  button.onclick = () => openJob(job.id);
  return button;
}

async function loadJobs() {
  const [all, settings] = await Promise.all([api('/api/jobs'), api('/api/settings')]);
  S.settings = settings;
  $('#first-run').hidden = settings.transcriptionReady;
  const practice = all.find(job => job.kind === 'behavioral');
  const tile = el('section', 'sheet practice');
  const intro = el('div');
  intro.append(el('h2', null, practice.title), el('p', 'hint', 'Practice questions for any role.'));
  const start = el('button', 'primary', 'Set up practice');
  start.onclick = () => openJob(practice.id);
  tile.append(intro, start);
  $('#practice-slot').replaceChildren(tile);
  const jobs = all.filter(job => job.kind !== 'behavioral');
  $('#job-list').replaceChildren(...(jobs.length
    ? jobs.map(jobCard) : [el('p', 'empty', 'Add a job to practice for a specific role.')]));
  show('view-jobs');
}

async function openSettings() {
  show('view-settings');
  await refreshSettings();
}

async function refreshSettings() {
  const settings = await api('/api/settings');
  S.settings = settings;
  $('#data-folder').textContent = settings.dataDir;
  $('#codex-enabled').checked = settings.codexEnabled;
  const installing = settings.setupState?.state === 'running';
  const error = settings.setupState?.state === 'error' && settings.setupState.error;
  $('#setup-status').textContent = settings.transcriptionReady ? 'Ready.'
    : installing ? 'Installing transcription…'
    : error || 'Install Whisper to transcribe recordings on this computer.';
  $('#install-transcription').hidden = settings.transcriptionReady || installing;
  if (installing && !$('#view-settings').hidden) setTimeout(refreshSettings, 1500);
}

async function openJob(id) {
  S.jobId = id;
  const d = await api(`/api/jobs/${id}`);
  S.job = d.job;
  $('#setup-title').textContent = d.job.title;

  $('#jobedit-box').hidden = d.job.kind === 'behavioral';
  $('#jobedit-box').open = false;
  $('#e-title').value = d.job.title || '';
  $('#e-company').value = d.job.company || '';
  $('#e-jd').value = d.job.jd || '';
  $('#e-saved').textContent = '';
  S.jdAtOpen = d.job.jd || '';
  $('#s-mustask').value = (d.job.mustAsk || []).join('\n');
  $('#mustask-count').textContent = `(${(d.job.mustAsk || []).length})`;
  $('#mustask-saved').textContent = '';
  $('#mustask-box').open = false;

  $('#theme-row').hidden = d.job.kind !== 'behavioral';
  $('#focus-wrap').hidden = d.job.kind === 'behavioral';
  $('#s-focus').value = d.job.focus || 'all';
  $('#casegen-row').hidden = d.job.kind === 'behavioral' || !S.settings.codexEnabled;
  paintCaseGen(d.caseGen);
  if (d.job.kind === 'behavioral') await renderThemes(d.job.themes || []);

  await refreshPlan();
  renderHistory(d.sessions);
  show('view-setup');
  if (d.caseGen === 'running') pollCaseGen(id);
}

/* ─────────── setup ─────────── */

async function renderThemes(active) {
  if (!S.themes) S.themes = await api('/api/themes');
  const box = $('#theme-chips');
  box.replaceChildren();
  const on = new Set(active);
  for (const t of S.themes) {
    const b = el('button', on.has(t.id) ? 'on' : null, t.label);
    b.setAttribute('aria-pressed', String(on.has(t.id)));
    b.onclick = async () => {
      on.has(t.id) ? on.delete(t.id) : on.add(t.id);
      b.classList.toggle('on');
      b.setAttribute('aria-pressed', String(on.has(t.id)));
      await api(`/api/jobs/${S.jobId}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ themes: [...on] }),
      });
      await refreshPlan();
    };
    box.append(b);
  }
}

async function refreshPlan() {
  const count = Number($('#s-count').value);
  const plan = await api(`/api/jobs/${S.jobId}/plan`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ count }),
  });
  S.plan = plan.questions || [];
  renderPlan();
  showPoolHint(plan);
}

function showPoolHint({ poolSize }) {
  const hint = $('#pool-hint');
  hint.hidden = poolSize > S.plan.length || !S.job.themes?.length;
  hint.textContent = 'Choose more themes to see more questions.';
}

function renderPlan() {
  const list = $('#q-preview');
  list.replaceChildren();
  S.plan.forEach((question, index) => {
    const item = el('li');
    const row = el('div', 'question-row');
    const text = el('div', 'qtxt', question.text);
    const reason = /skipped|rework|must-ask/.test(question.reason) ? question.reason : '';
    if (question.focus || reason) text.append(el('div', 'hint', question.focus || reason));
    const drop = el('button', 'quiet drop', '×');
    drop.setAttribute('aria-label', 'Remove question ' + (index + 1));
    drop.onclick = () => {
      S.plan.splice(index, 1);
      renderPlan();
      (list.querySelectorAll('.drop')[index] || list.querySelector('.drop') || $('#s-reshuffle')).focus();
    };
    row.append(text, drop);
    item.append(row);
    list.append(item);
  });
  $('#s-start').disabled = S.plan.length === 0;
}

function renderHistory(sessions) {
  $('#hist-title').hidden = !sessions.length;
  const box = $('#hist-list');
  box.replaceChildren();
  for (const s of sessions) {
    const b = el('button');
    b.append(el('span', 'when', s.id.replace('_', ' ')));
    const state = s.state === 'done' ? `${s.answered} answered${s.skipped ? `, ${s.skipped} skipped` : ''}`
      : s.state === 'transcribing' ? 'transcribing…'
      : s.state === 'error' ? 'transcription failed'
      : s.state === 'recording' ? 'Unsaved session' : s.state;
    b.append(el('span', 'tag', s.evaluated ? `${state} · evaluated` : state));
    b.onclick = () => openReview(s.id);
    box.append(b);
  }
}

function paintCaseGen(state) {
  const btn = $('#s-morecases');
  const note = $('#casegen-note');
  if (state === 'running') {
    btn.disabled = true;
    btn.textContent = 'Generating…';
    note.textContent = '';
    return true;
  }
  btn.disabled = false;
  btn.textContent = 'Generate case questions';
  note.textContent = state && state.error ? String(state.error).slice(0, 140) : '';
  return false;
}

async function pollCaseGen(id) {
  for (let i = 0; i < 70; i++) {
    await sleep(3000);
    if ($('#view-setup').hidden || S.jobId !== id) return;
    let d;
    try { d = await api(`/api/jobs/${id}`); } catch { continue; }
    if (!paintCaseGen(d.caseGen)) { await refreshPlan(); return; }
  }
}

/* ─────────── camera ─────────── */

async function openStream(videoId, audioId) {
  releaseCamera();
  $('#check-go').disabled = true;
  $('#check-hint').textContent = 'Speak to check your mic.';
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      deviceId: videoId ? { exact: videoId } : undefined,
      width: { ideal: 1280 }, height: { ideal: 720 },
    },
    audio: {
      deviceId: audioId ? { exact: audioId } : undefined,
      echoCancellation: true, noiseSuppression: true, autoGainControl: true,
    },
  });
  if ($('#view-check').hidden) {
    stream.getTracks().forEach(track => track.stop());
    return;
  }
  S.stream = stream;
  $('#check-video').srcObject = stream;
  startMeter();
  await fillDevices();
  $('#check-go').disabled = false;
}

async function fillDevices() {
  const devs = await navigator.mediaDevices.enumerateDevices();
  const cur = S.stream.getTracks();
  const fill = (sel, kind, active) => {
    const s = $(sel);
    s.replaceChildren();
    devs.filter((d) => d.kind === kind).forEach((d, i) => {
      const o = el('option', null, d.label || `${kind} ${i + 1}`);
      o.value = d.deviceId;
      if (d.label === active) o.selected = true;
      s.append(o);
    });
  };
  fill('#dev-video', 'videoinput', cur.find((t) => t.kind === 'video')?.label);
  fill('#dev-audio', 'audioinput', cur.find((t) => t.kind === 'audio')?.label);
}

function startMeter() {
  S.audioCtx = new AudioContext();
  const src = S.audioCtx.createMediaStreamSource(S.stream);
  const an = S.audioCtx.createAnalyser();
  an.fftSize = 512;
  src.connect(an);
  const buf = new Uint8Array(an.frequencyBinCount);
  let peak = 0;
  const loop = () => {
    an.getByteTimeDomainData(buf);
    let max = 0;
    for (const v of buf) max = Math.max(max, Math.abs(v - 128));
    const pct = Math.min(100, (max / 90) * 100);
    peak = Math.max(peak, pct);
    $('#meter-fill').style.width = pct + '%';
    if (peak > 12 && $('#check-hint').textContent === 'Speak to check your mic.') {
      $('#check-hint').textContent = 'Mic is picking you up.';
    }
    S.meterRaf = requestAnimationFrame(loop);
  };
  loop();
}

/* ─────────── session ─────────── */

const pickMime = (list) => list.find((t) => MediaRecorder.isTypeSupported(t)) || '';

async function beginSession() {
  $('#check-go').disabled = true;
  S.prep = Number($('#s-prep').value);
  S.limit = Number($('#s-limit').value);
  S.testMode = $('#s-test').checked;
  S.videoRec = null; S.audioRec = null; S.sessionId = null;
  // exitSession/finish leave these latched; a fresh run must clear them or
  // every control stays dead for the whole session.
  S.busy = false; S.inPrep = false; S.prepSkip = null;

  // A test run touches nothing on disk: no session folder, no recorders,
  // no counters. Everything else behaves exactly like the real thing.
  if (!S.testMode) {
    const r = await api(`/api/jobs/${S.jobId}/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ questions: S.plan }),
    });
    S.sessionId = r.sessionId;
  }

  $('#live-video').srcObject = S.stream;
  $('#rec-pill').classList.toggle('test', S.testMode);
  $('#rec-pill').classList.toggle('rec', !S.testMode);
  $('#rec-dot').textContent = S.testMode ? 'test run ·' : '\u25cf';
  show('view-session');

  if (!S.testMode) {
    const vm = pickMime(['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']);
    const am = pickMime(['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']);
    S.videoExt = vm.includes('mp4') ? 'mp4' : 'webm';
    S.audioExt = am.includes('mp4') ? 'mp4' : 'webm';
    S.videoChunks = []; S.audioChunks = [];

    S.videoRec = new MediaRecorder(S.stream, vm ? { mimeType: vm, videoBitsPerSecond: 2500000 } : undefined);
    S.audioRec = new MediaRecorder(new MediaStream(S.stream.getAudioTracks()), am ? { mimeType: am } : undefined);
    S.videoRec.ondataavailable = (e) => { if (e.data.size) S.videoChunks.push(e.data); };
    S.audioRec.ondataavailable = (e) => { if (e.data.size) S.audioChunks.push(e.data); };
  }

  // Show question one and let the lead-in run BEFORE anything records, so the
  // recording opens on you answering rather than on you reading and waiting.
  S.idx = 0; S.segments = [];
  renderQuestion();
  if (S.prep > 0) await runPrep(S.prep);
  if (S.busy || $('#view-session').hidden) return;

  if (!S.testMode) { S.videoRec.start(1000); S.audioRec.start(1000); }
  S.t0 = performance.now();
  S.qStart = 0;
  startTick();
}

/* The lead-in runs once, before question one only. Hitting next/skip/space
   during it means "I'm ready now", so it resolves early instead of blocking. */
async function runPrep(seconds) {
  const ov = $('#prep-overlay');
  ov.hidden = false;
  S.inPrep = true;
  for (let n = seconds; n > 0; n--) {
    $('#prep-num').textContent = n;
    const cutShort = await new Promise((resolve) => {
      S.prepSkip = () => resolve(true);
      setTimeout(() => resolve(false), 1000);
    });
    if (cutShort) break;
  }
  S.prepSkip = null;
  S.inPrep = false;
  ov.hidden = true;
}

function renderQuestion() {
  const q = S.plan[S.idx];
  $('#q-pos').textContent = `Question ${S.idx + 1} of ${S.plan.length}`;
  $('#q-text').textContent = q.text;
  $('#q-text').focus();
  $('#answer-time').textContent = '0:00';
  $('#limit-label').textContent = S.limit ? clock(S.limit * 1000) : '';
  $('.limitbar').hidden = !S.limit;

  $('#limit-fill').style.width = '0%';
  $('#limit-fill').classList.remove('over');
  $('#btn-next').textContent = S.idx === S.plan.length - 1 ? 'Finish' : 'Next question';
}

function commit(skipped) {
  const q = S.plan[S.idx];
  S.segments.push({
    questionId: q.id, question: q.text, category: q.category,
    attempt: q.attempt, reason: q.reason,
    startMs: Math.round(S.qStart),
    endMs: Math.round(performance.now() - S.t0),
    skipped,
  });
}

function advance(skipped) {
  if (S.inPrep) return S.prepSkip?.();   // still in the lead-in: just start now
  if (S.busy) return;
  commit(skipped);
  S.idx++;
  if (S.idx >= S.plan.length) return finish();
  renderQuestion();
  S.qStart = performance.now() - S.t0;   // next question starts immediately
}

/* Stop early but keep everything recorded so far. */
function endAndSave() {
  if (S.inPrep) return S.prepSkip?.();
  if (S.busy) return;
  if (!confirm(`End the session here and save ${S.idx + 1} of ${S.plan.length} questions?`)) return;
  commit(false);
  finish();
}

function repeatQuestion() {
  if (S.inPrep || S.busy) return;
  S.qStart = performance.now() - S.t0;
  const c = $('.qcard');
  c.style.borderColor = 'var(--accent)';
  setTimeout(() => { c.style.borderColor = ''; }, 400);
}

/* Leave mid-session and throw the recording away. The bank is only ever
   updated by /finish, so bailing here leaves no trace beyond the empty
   session folder, which we delete on the way out. */
async function exitSession() {
  const msg = S.testMode
    ? 'End this test run?'
    : 'Exit and delete this recording? Nothing will be saved.';
  if (!confirm(msg)) return;

  S.busy = true;
  S.prepSkip?.();
  stopTick();
  try {
    if (S.videoRec && S.videoRec.state !== 'inactive') S.videoRec.stop();
    if (S.audioRec && S.audioRec.state !== 'inactive') S.audioRec.stop();
  } catch { /* recorder already torn down */ }
  releaseCamera();

  if (!S.testMode && S.sessionId) {
    try {
      await api(`/api/jobs/${S.jobId}/sessions/${S.sessionId}`, { method: 'DELETE' });
    } catch { /* folder stays empty and harmless if this fails */ }
  }
  S.sessionId = null;
  S.videoRec = S.audioRec = null;
  openJob(S.jobId);
}

function startTick() {
  stopTick();
  S.tick = setInterval(() => {
    const total = performance.now() - S.t0;
    $('#rec-time').textContent = clock(total);
    if (S.busy) return;
    const ans = total - S.qStart;
    $('#answer-time').textContent = clock(ans);
    if (S.limit > 0) {
      const pct = Math.min(100, (ans / (S.limit * 1000)) * 100);
      const bar = $('#limit-fill');
      bar.style.width = pct + '%';
      bar.classList.toggle('over', pct >= 100);
    }
  }, 250);
}
const stopTick = () => { if (S.tick) clearInterval(S.tick), (S.tick = null); };

async function finish() {
  S.busy = true;
  stopTick();

  if (S.testMode) {
    releaseCamera();
    await openJob(S.jobId);
    return;
  }

  const durationMs = Math.round(performance.now() - S.t0);
  $('#proc-title').textContent = 'Saving session';
  $('#proc-msg').textContent = 'Saving recording…';
  $('#proc-meter').hidden = false;
  $('#proc-home').hidden = true;
  $('#proc-retry').hidden = true;
  $('#proc-discard').hidden = true;
  show('view-processing');
  $('#home-btn').hidden = true;
  $('#settings-btn').hidden = true;

  const stopped = Promise.all([once(S.videoRec, 'stop'), once(S.audioRec, 'stop')]);
  S.videoRec.stop();
  S.audioRec.stop();
  await stopped;

  S.pendingSave = {
    jobId: S.jobId, sid: S.sessionId,
    media: [
      [`recording.${S.videoExt}`, new Blob(S.videoChunks, { type: S.videoRec.mimeType })],
      [`audio.${S.audioExt}`, new Blob(S.audioChunks, { type: S.audioRec.mimeType })],
    ],
    segments: S.segments, durationMs, uploaded: false,
  };
  releaseCamera();
  S.videoRec = S.audioRec = null;
  S.videoChunks = S.audioChunks = [];
  await saveRecording();
}

async function saveRecording() {
  const pending = S.pendingSave;
  if (!pending || S.saveBusy) return;
  S.saveBusy = true;
  const base = `/api/jobs/${pending.jobId}/sessions/${pending.sid}`;
  $('#proc-retry').hidden = true;
  $('#proc-discard').hidden = true;
  $('#proc-meter').hidden = false;
  $('#proc-msg').textContent = 'Saving recording…';
  try {
    if (!pending.uploaded) {
      for (const [name, blob] of pending.media) await api(`${base}/media/${name}`, { method: 'PUT', body: blob });
      pending.uploaded = true;
    }
    await api(base + '/finish', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ segments: pending.segments, durationMs: pending.durationMs }),
    });
    S.pendingSave = null;
    showProcessing(pending.jobId, pending.sid);
  } catch (error) {
    $('#proc-msg').textContent = `${error.message} Keep this tab open to retry.`;
    $('#proc-retry').hidden = false;
    $('#proc-discard').hidden = false;
    $('#proc-meter').hidden = true;
  } finally {
    S.saveBusy = false;
  }
}

function showProcessing(id, sid) {
  $('#proc-title').textContent = 'Transcribing';
  $('#proc-msg').textContent = 'Recording saved. You can leave while transcription finishes.';
  $('#proc-meter').hidden = false;
  $('#proc-home').hidden = false;
  $('#proc-retry').hidden = true;
  $('#proc-discard').hidden = true;
  show('view-processing');
  pollStatus(id, sid);
}

async function pollStatus(id, sid) {
  for (let i = 0; i < 900; i++) {
    if ($('#view-processing').hidden || S.jobId !== id || S.sessionId !== sid) return;
    let status;
    try { status = await api(`/api/jobs/${id}/sessions/${sid}/status`); } catch { /* retry polling */ }
    if ($('#view-processing').hidden || S.jobId !== id || S.sessionId !== sid) return;
    if (status && ['done', 'error'].includes(status.state)) return openReview(sid);
    await sleep(2000);
  }
  $('#proc-meter').hidden = true;
  $('#proc-msg').textContent = 'Check Past sessions for the transcription status.';
}

/* ─────────── review ─────────── */

/* evaluation.md is plain markdown; render just enough of it to read cleanly. */
function renderMd(md, into) {
  into.replaceChildren();
  for (const block of md.split(/\n{2,}/)) {
    const t = block.trim();
    if (!t) continue;
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { into.append(el('hr')); continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(t);
    if (h) { into.append(el('h4', null, h[2])); continue; }
    if (/^\|.*\|/.test(t) && t.includes('\n')) { into.append(mdTable(t)); continue; }
    const lines = t.split('\n').filter((l) => l.trim());
    const bullet = lines.every((l) => /^\s*[-*]\s+/.test(l));
    const numbered = lines.every((l) => /^\s*\d+[.)]\s+/.test(l));
    if (bullet || numbered) {
      const list = el(numbered ? 'ol' : 'ul');
      lines.forEach((l) => {
        const li = el('li');
        inlineMd(l.replace(/^\s*(?:[-*]|\d+[.)])\s+/, ''), li);
        list.append(li);
      });
      into.append(list);
      continue;
    }
    const p = el('p');
    inlineMd(t, p);
    into.append(p);
  }
}

/* Evaluations lean on small tables for per-dimension scores. */
function mdTable(block) {
  const rows = block.split('\n').filter((l) => l.trim().startsWith('|'));
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const wrap = el('div', 'tablewrap');
  const table = el('table', 'evaltable');
  rows.forEach((line, i) => {
    const vals = cells(line);
    if (i === 1 && vals.every((v) => /^:?-{2,}:?$/.test(v))) return;   // separator
    const tr = el('tr');
    vals.forEach((v) => {
      const cell = el(i === 0 ? 'th' : 'td');
      inlineMd(v, cell);
      tr.append(cell);
    });
    table.append(tr);
  });
  wrap.append(table);
  return wrap;
}

function inlineMd(text, into) {
  for (const part of text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)) {
    if (!part) continue;
    if (part.startsWith('**')) into.append(el('strong', null, part.slice(2, -2)));
    else if (part.startsWith('`')) into.append(el('code', null, part.slice(1, -1)));
    else into.append(document.createTextNode(part));
  }
}

function paintEvaluation(detail) {
  const box = $('#rev-eval');
  const note = $('#eval-note');
  const state = detail.status?.evalState;
  const ready = detail.status?.state === 'done';
  $('#rev-reeval').hidden = !ready || !S.settings.codexEnabled;
  $('#rev-reeval').disabled = state === 'running';
  $('#rev-reeval').textContent = detail.evaluation ? 'Re-evaluate' : 'Get feedback';
  if (detail.evaluation) renderMd(detail.evaluation, box);
  else {
    const message = !ready ? 'Available after transcription.'
      : state === 'running' ? 'Preparing feedback…'
      : S.settings.codexEnabled ? '' : 'Enable Codex feedback in Settings.';
    box.replaceChildren(...(message ? [el('p', 'hint', message)] : []));
  }
  note.textContent = state === 'error' ? detail.status.evalError
    : state === 'running' && detail.evaluation ? 'Updating feedback…' : '';
  return state;
}

/* MediaRecorder webm carries no duration in its header, so Chrome reports
   Infinity and refuses to seek. Scrubbing to the far end forces it to index
   the file, after which currentTime works normally. */
function forceDuration(v) {
  if (!v.src || (v.duration !== Infinity && !Number.isNaN(v.duration))) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { v.removeEventListener('timeupdate', done); v.currentTime = 0; resolve(); };
    v.addEventListener('timeupdate', done);
    v.currentTime = 1e101;
    setTimeout(resolve, 1500);
  });
}

async function openReview(sid) {
  const d = await api(`/api/jobs/${S.jobId}/sessions/${sid}`);
  if (d.status.state === 'transcribing') {
    S.sessionId = sid;
    showProcessing(S.jobId, sid);
    return;
  }
  $('#rev-title').textContent = `Session ${sid.replace('_', ' ')}`;
  $('#rev-transcribe').hidden = !['error', 'transcribing'].includes(d.status.state);
  $('#rev-transcribe-note').textContent = d.status.error || 'Transcribing…';
  $('#rev-retry').hidden = d.status.state !== 'error' || !d.videoFile;
  $('#rev-stage').hidden = !d.videoFile;

  const v = $('#rev-video');
  v.pause();
  if (d.videoFile) {
    v.src = `/media/${S.jobId}/${sid}/${d.videoFile}`;
    v.addEventListener('loadedmetadata', () => forceDuration(v), { once: true });
  } else {
    v.removeAttribute('src');
    v.load();
  }

  const chapters = $('#rev-chapters');
  const answers = $('#rev-answers');
  chapters.replaceChildren();
  answers.replaceChildren();

  const rows = d.stats?.answers || (d.meta.segments || []).map((s, i) => ({ ...s, index: i, text: null }));

  $('#rev-answers-box').hidden = !rows.length;
  rows.forEach((a, i) => {
    const jump = el('button', null, `Q${i + 1}${a.skipped ? ' (skipped)' : ''}`);
    jump.onclick = async () => {
      await forceDuration(v);
      v.currentTime = a.startMs / 1000;
      await v.play().catch(() => {});
    };
    if (d.videoFile) chapters.append(jump);

    const box = el('div', 'answer');
    box.append(el('h3', null, a.question));
    const st = el('div', 'stats');
    const bits = [`${clock(a.durationMs)}`];
    if (a.wpm) bits.push(`${a.wpm} wpm`);
    if (a.pauses) bits.push(`${a.pauses} pauses · longest ${(a.longestPauseMs / 1000).toFixed(1)}s`);
    if (a.approxFillers) bits.push(`~${a.approxFillers} fillers`);
    if (a.attempt > 1) bits.push(`attempt ${a.attempt}`);
    bits.forEach((b) => st.append(el('span', null, b)));
    box.append(st);
    const said = el('div', 'said', a.skipped ? 'Skipped without answering.' : (a.text || 'No speech detected.'));
    if (a.skipped || !a.text) said.classList.add('none');
    box.append(said);

    const bar = el('div', 'samplebar');
    const btn = el('button', 'ghost small');
    btn.dataset.sample = String(i);
    if (a.skipped || !a.text) {
      btn.textContent = 'Write a sample answer';
      btn.disabled = true;
      btn.dataset.noContent = '1';        // paintSamples must not re-enable this
      btn.title = 'Nothing was said here to work from';
    } else {
      btn.textContent = 'Write a sample answer';
      btn.onclick = () => requestSample(i, btn);
    }
    bar.append(btn);
    if (S.settings.codexEnabled && !a.skipped && a.text) box.append(bar);

    const holder = el('div', 'sample');
    holder.dataset.sampleFor = String(i);
    holder.hidden = true;
    box.append(holder);

    answers.append(box);
  });

  S.reviewSid = sid;
  paintSamples(d);
  $('#rev-notes').value = d.meta?.notes || '';
  $('#notes-saved').textContent = '';
  const state = paintEvaluation(d);

  show('view-review');
  if (state === 'running') pollEvaluation(sid);
}

/* Samples are per-question; repaint them all from one detail fetch. */
function paintSamples(d) {
  let anyRunning = false;
  document.querySelectorAll('[data-sample-for]').forEach((holder) => {
    const i = holder.dataset.sampleFor;
    const btn = document.querySelector(`[data-sample="${i}"]`);
    const text = d.samples?.[i];
    const state = d.sampleStates?.[i];

    if (btn && btn.dataset.noContent) return;   // nothing was said here

    if (state === 'running') {
      anyRunning = true;
      if (btn && !btn.disabled) { btn.textContent = 'Writing…'; btn.disabled = true; }
      if (!text) {
        holder.hidden = false;
        holder.replaceChildren(el('p', 'hint', 'Rewriting in your own words…'));
      }
      return;
    }

    if (btn) {
      btn.disabled = false;
      btn.textContent = text ? 'Rewrite it again' : 'Write a sample answer';
    }

    if (state && state.error) {
      holder.hidden = false;
      holder.replaceChildren(el('p', 'hint', `Could not write a sample: ${String(state.error).slice(0, 160)}`));
      return;
    }
    if (text) {
      holder.hidden = false;
      renderMd(text, holder);
    } else {
      holder.hidden = true;
      holder.replaceChildren();
    }
  });
  return anyRunning;
}

async function requestSample(index, btn) {
  btn.disabled = true;
  btn.textContent = 'Writing…';
  const holder = document.querySelector(`[data-sample-for="${index}"]`);
  holder.hidden = false;
  holder.replaceChildren(el('p', 'hint', 'Rewriting in your own words…'));
  try {
    await api(`/api/jobs/${S.jobId}/sessions/${S.reviewSid}/sample`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ index }),
    });
  } catch (e) {
    holder.replaceChildren(el('p', 'hint', `Could not start: ${e.message}`));
    btn.disabled = false;
    btn.textContent = 'Write a sample answer';
    return;
  }
  pollSamples(S.reviewSid);
}

async function pollSamples(sid) {
  const id = S.jobId;
  if (S.samplePoll) return;
  S.samplePoll = true;
  try {
    for (let i = 0; i < 80; i++) {
      await sleep(3000);
      if (S.jobId !== id || S.reviewSid !== sid || $('#view-review').hidden) return;
      let d;
      try { d = await api(`/api/jobs/${id}/sessions/${sid}`); } catch { continue; }
      if (!paintSamples(d)) return;
    }
  } finally { S.samplePoll = false; }
}

async function pollEvaluation(sid) {
  const id = S.jobId;
  for (let i = 0; i < 90; i++) {
    await sleep(3000);
    if (S.jobId !== id || S.reviewSid !== sid || $('#view-review').hidden) return;
    let d;
    try { d = await api(`/api/jobs/${id}/sessions/${sid}`); } catch { continue; }
    const state = paintEvaluation(d);
    if (state !== 'running') return;
  }
}

/* ─────────── wiring ─────────── */

$('#quit-btn').onclick = async () => {
  if (S.pendingSave) return showError('Retry or discard the unsaved recording before quitting.');
  if (!$('#view-session').hidden || !$('#view-processing').hidden) {
    return showError('Finish or discard the session before quitting.');
  }
  if (!confirm('Close Interview Desk?')) return;
  await api('/api/shutdown', { method: 'POST' });
  releaseCamera();
  $$('.view').forEach(view => { view.hidden = true; });
  $('#app-error').hidden = true;
  $('#topbar').hidden = true;
  $('#stopped').hidden = false;
};

$('#home-btn').onclick = () => { releaseCamera(); $('#rev-video').pause(); return loadJobs(); };
$('#settings-btn').onclick = () => { releaseCamera(); $('#rev-video').pause(); return openSettings(); };
$('#first-run-settings').onclick = openSettings;
$('#install-transcription').onclick = async () => {
  $('#install-transcription').disabled = true;
  try {
    await api('/api/settings/transcription', { method: 'POST' });
    await refreshSettings();
  } finally {
    $('#install-transcription').disabled = false;
  }
};
$('#codex-enabled').onchange = async event => {
  const field = event.target;
  field.disabled = true;
  try {
    const settings = await api('/api/settings', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ codexEnabled: field.checked }),
    });
    S.settings.codexEnabled = settings.codexEnabled;
    $('#settings-status').textContent = 'Saved.';
    $('#settings-status').hidden = false;
  } finally {
    field.checked = S.settings.codexEnabled;
    field.disabled = false;
  }
};

$('#new-job-btn').onclick = () => show('view-newjob');
$('#nj-cancel').onclick = () => show('view-jobs');
$('#new-job-form').onsubmit = async event => {
  event.preventDefault();
  const title = $('#nj-title').value.trim();
  if (!title) return $('#nj-title').focus();
  $('#nj-save').disabled = true;
  try {
    const job = await api('/api/jobs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title, company: $('#nj-company').value, jd: $('#nj-jd').value, mustAsk: $('#nj-must').value,
      }),
    });
    event.target.reset();
    await openJob(job.id);
  } finally {
    $('#nj-save').disabled = false;
  }
};

$('#s-save-mustask').onclick = async () => {
  const lines = $('#s-mustask').value.split('\n').map((l) => l.trim()).filter(Boolean);
  await api(`/api/jobs/${S.jobId}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mustAsk: lines }),
  });
  $('#mustask-count').textContent = `(${lines.length})`;
  $('#mustask-saved').textContent = 'Saved.';
  await refreshPlan();
};

$('#s-count').onchange = refreshPlan;
$('#e-save').onclick = async () => {
  const title = $('#e-title').value.trim();
  if (!title) { $('#e-saved').textContent = 'A title is required.'; return; }
  const jd = $('#e-jd').value;
  await api(`/api/jobs/${S.jobId}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, company: $('#e-company').value, jd }),
  });
  // Case questions were written from the old description, so say so rather
  // than silently leaving them stale.
  const jdChanged = jd.trim() !== (S.jdAtOpen || '').trim();
  S.jdAtOpen = jd;
  $('#e-saved').textContent = jdChanged && S.settings.codexEnabled
    ? 'Saved. Generate new case questions for the revised description.' : 'Saved.';
  $('#setup-title').textContent = title;
};

$('#s-morecases').onclick = async () => {
  paintCaseGen('running');
  try {
    await api(`/api/jobs/${S.jobId}/cases`, { method: 'POST' });
  } catch (e) {
    paintCaseGen({ error: e.message });
    return;
  }
  pollCaseGen(S.jobId);
};

$('#s-focus').onchange = async () => {
  await api(`/api/jobs/${S.jobId}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ focus: $('#s-focus').value }),
  });
  await refreshPlan();
};
$('#s-reshuffle').onclick = refreshPlan;

$('#s-start').onclick = async () => {
  const notice = $('#start-note');
  notice.hidden = true;
  if (!S.settings.transcriptionReady && !$('#s-test').checked) {
    notice.textContent = 'Set up transcription in Settings, or use Test run.';
    notice.hidden = false;
    return;
  }
  show('view-check');
  try {
    await openStream();
  } catch (e) {
    $('#check-hint').textContent = `Camera blocked: ${e.message}. Allow access for localhost in Chrome, then reload.`;
  }
};
$('#dev-video').onchange = () => openStream($('#dev-video').value, $('#dev-audio').value);
$('#dev-audio').onchange = () => openStream($('#dev-video').value, $('#dev-audio').value);
$('#check-back').onclick = () => { releaseCamera(); show('view-setup'); };
$('#check-go').onclick = async () => {
  try {
    await beginSession();
  } catch (error) {
    if (S.sessionId) {
      await api(`/api/jobs/${S.jobId}/sessions/${S.sessionId}`, { method: 'DELETE' }).catch(() => {});
      S.sessionId = null;
    }
    show('view-check');
    $('#check-go').disabled = false;
    $('#check-hint').textContent = error.message;
  }
};

$('#btn-next').onclick = () => advance(false);
$('#btn-skip').onclick = () => advance(true);
$('#btn-repeat').onclick = repeatQuestion;
$('#btn-exit').onclick = exitSession;
$('#btn-end').onclick = endAndSave;

$('#rev-save-notes').onclick = async () => {
  await api(`/api/jobs/${S.jobId}/sessions/${S.reviewSid}/notes`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: $('#rev-notes').value }),
  });
  $('#notes-saved').textContent = 'Saved.';
};

$('#rev-reeval').onclick = async () => {
  const id = S.jobId;
  const sid = S.reviewSid;
  $('#rev-reeval').disabled = true;
  try {
    await api(`/api/jobs/${id}/sessions/${sid}/notes`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: $('#rev-notes').value }),
    });
    await api(`/api/jobs/${id}/sessions/${sid}/evaluate`, { method: 'POST' });
    $('#eval-note').textContent = 'Preparing feedback…';
    await pollEvaluation(sid);
  } finally {
    if (S.jobId === id && S.reviewSid === sid) $('#rev-reeval').disabled = false;
  }
};
$('#rev-retry').onclick = async () => {
  const id = S.jobId;
  const sid = S.reviewSid;
  await api(`/api/jobs/${id}/sessions/${sid}/finish`, { method: 'POST' });
  S.sessionId = sid;
  showProcessing(id, sid);
};
$('#s-test').onchange = () => {
  $('#test-hint').hidden = !$('#s-test').checked;
  $('#start-note').hidden = true;
};
$('#proc-retry').onclick = saveRecording;
$('#proc-discard').onclick = async () => {
  if (!confirm('Discard this recording?')) return;
  const { jobId, sid } = S.pendingSave;
  await api(`/api/jobs/${jobId}/sessions/${sid}`, { method: 'DELETE' });
  S.pendingSave = null;
  await openJob(jobId);
};
$('#proc-home').onclick = loadJobs;
$('#rev-back').onclick = () => { $('#rev-video').pause(); return openJob(S.jobId); };

document.addEventListener('keydown', event => {
  if ($('#view-session').hidden || event.repeat || event.defaultPrevented
      || event.target.closest('input, textarea, select, [contenteditable=true]')) return;
  if (event.code === 'Space' && event.target.closest('button, summary')) return;
  const action = {
    Space: () => advance(false), KeyS: () => advance(true),
    KeyR: repeatQuestion, KeyE: endAndSave, Escape: exitSession,
  }[event.code];
  if (!action || event.altKey || event.metaKey || event.ctrlKey) return;
  event.preventDefault();
  action();
});

window.addEventListener('beforeunload', event => {
  if (S.pendingSave || S.videoRec || S.saveBusy) event.preventDefault();
});
window.addEventListener('unhandledrejection', event => {
  showError(event.reason?.message || 'Something went wrong.');
});

loadJobs();
