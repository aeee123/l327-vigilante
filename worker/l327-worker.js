import { DAY, normalize, classify, digest, articleLinks, article, tweets, fxTweets, message, safeUrl, unrelatedPost } from './core.js';
import { dates, CIRCUIT } from './core.js';
import { evaluateGemini } from './gemini.js';

const UA = 'L327-Vigilante/2.0 (+monitor de avisos publicos ENEE)';
const MAX_BODY = 2 * 1024 * 1024;
export const SOURCES = [
  { id: 'enee-1', type: 'html', url: 'https://www.eneeutcd.hn/es/inoticias/listar/G2/249/1/mantenimientos-programados/', interval: 60000 },
  { id: 'enee-2', type: 'html', url: 'https://www.eneeutcd.hn/es/inoticias/listar/G2/249/2/mantenimientos-programados/', interval: 300000 },
  // The cron runs once a minute. Allow modest scheduling jitter.
  { id: 'x-cnd', type: 'x', handle: 'CNDHonduras', url: 'https://api.fxtwitter.com/2/profile/CNDHonduras/statuses?count=5', interval: 45000 },
  { id: 'x-enee', type: 'x', handle: 'eneehnoficial', url: 'https://api.fxtwitter.com/2/profile/EneeHnOficial/statuses?count=10', interval: 45000 },
];
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const blank = () => ({ version: 2, sent: {}, queue: {}, media: {}, sources: {}, articles: {}, warnings: {}, lastRun: 0, telegram: {} });
const canReadMedia = m => !m.done && m.parent.unrelated !== true && (m.nextOcr || 0) <= Date.now();
function retryMedia(m) {
  m.attempts = (m.attempts || 0) + 1;
  const minutes = [5, 30, 120, 360, 720];
  m.nextOcr = Date.now() + minutes[Math.min(m.attempts - 1, minutes.length - 1)] * 60000;
}
const urgent = text => /\b(?:interrupcion(?:es)?|mantenimientos?|circuitos?|cortes?|suspension)\b/.test(normalize(text));
export async function readText(response, max = MAX_BODY) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  let size = 0, text = '', decoder = new TextDecoder();
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > max) throw Error('respuesta demasiado grande'); text += decoder.decode(value, { stream: true }); }
    return text + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); }
}
async function download(url, previous = {}) {
  const headers = { 'user-agent': UA, 'accept-language': 'es-HN,es;q=0.9' };
  if (previous.etag) headers['if-none-match'] = previous.etag;
  if (previous.modified) headers['if-modified-since'] = previous.modified;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12000);
  try {
    // Avoid cacheEverything: an extra cached response delays urgent announcements.
    let target = url;
    for (let redirects = 0; redirects <= 3; redirects++) {
      const r = await fetch(target, { headers, signal: controller.signal, redirect: 'manual' });
      if (r.status >= 300 && r.status < 400 && r.status !== 304) {
        const next = safeUrl(r.headers.get('location'), target);
        await r.body?.cancel();
        if (!next || new URL(next).hostname !== new URL(url).hostname || redirects === 3) throw Error('redirección no permitida');
        target = next; continue;
      }
      if (r.status === 304) return { unchanged: true };
      if (!r.ok) { await r.body?.cancel(); throw Error(`HTTP ${r.status}`); }
      return { text: await readText(r), etag: r.headers.get('etag'), modified: r.headers.get('last-modified') };
    }
  } finally { clearTimeout(timer); }
}
async function downloadObscura(source, previous, token) {
  const account = source.id === 'x-cnd' ? 'cnd' : 'enee';
  const signal = AbortSignal.timeout(32000);
  async function read(path) {
    const response = await fetch('https://l327-vigilante.onrender.com' + path, {
      headers: { authorization: `Bearer ${token}` }, redirect: 'manual', signal,
    });
    const body = await readText(response, 100000);
    if (!response.ok) {
      const reason = body.includes('"browser timeout"') ? ' (tiempo de espera)' : '';
      throw Error(`HTTP ${response.status}${reason}`);
    }
    return JSON.parse(body);
  }
  const { ids } = await read(`/profile?account=${account}`);
  if (!Array.isArray(ids) || !ids.length || !ids.every(id => typeof id === 'string' && /^\d{15,25}$/.test(id))) {
    throw Error('sin publicaciones válidas');
  }
  const seen = previous?.obscuraSeen || [];
  const unseen = ids.filter(id => !seen.includes(id));
  // The profile and detail requests share a time budget. Use the fast
  // sources to cover a burst, and read the newest missing detail next.
  const id = unseen[0];
  const candidates = [];
  if (id) {
    const post = await read(`/post?account=${account}&id=${id}`);
    const published = Date.parse(post.published);
    if (post.id !== id || !Number.isFinite(published) || published > Date.now() + 3600000 || typeof post.text !== 'string' || !post.text.trim()) {
      throw Error('publicación incompleta');
    }
    const media = (Array.isArray(post.photos) ? post.photos : []).filter(url =>
      typeof url === 'string' && url.startsWith('https://pbs.twimg.com/media/')).map(url => {
      const photo = new URL(url);
      photo.searchParams.delete('name');
      return { url: photo.href, type: 'image' };
    });
    candidates.push({ url: `https://x.com/${source.handle}/status/${id}`, title: post.text.slice(0, 160),
      text: post.text, published: new Date(published).toISOString(), source: 'X (Obscura)', media });
  }
  return { candidates, obscuraSeen: id ? [id, ...seen].slice(0, 40) : seen };
}
async function downloadTimeline(source) {
  const read = async (url, parse) => {
    const response = await download(url);
    const candidates = parse(response.text, source.handle);
    if (!candidates.length) throw Error('sin publicaciones legibles');
    return candidates;
  };
  const [fx, direct] = await Promise.allSettled([
    read(source.url, fxTweets),
    read(`https://x.com/${source.handle}`, tweets),
  ]);
  if (fx.status === 'rejected' && direct.status === 'rejected') {
    throw Error(`FxTwitter: ${fx.reason.message}; X directo: ${direct.reason.message}`);
  }
  const candidates = new Map();
  for (const post of [...(fx.value || []), ...(direct.value || [])]) {
    const id = post.url.split('/').at(-1);
    const previous = candidates.get(id);
    if (!previous || post.text.length > previous.text.length) candidates.set(id, post);
  }
  const fallbackReason = fx.status === 'rejected' ? `FxTwitter: ${fx.reason.message}` : undefined;
  const reader = fx.value && direct.value ? 'x-directo + fxtwitter' : fx.value ? 'fxtwitter' : 'x-directo';
  return { response: {}, candidates: [...candidates.values()].sort((a, b) => Date.parse(b.published) - Date.parse(a.published)), fallbackReason, reader };
}
export async function sendTelegram(env, text) {
  if (!env.TELEGRAM_TOKEN || !env.TELEGRAM_CHAT_ID) return { ok: false, error: 'faltan secretos de Telegram', retry: 300 };
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, link_preview_options: { is_disabled: true } }),
    });
    const data = JSON.parse(await readText(r, 64000));
    return r.ok && data.ok === true ? { ok: true, messageId: data.result?.message_id } : { ok: false, error: `Telegram ${data.error_code || r.status}`, retry: Math.min(86400, Math.max(60, Number(data.parameters?.retry_after) || 60)) };
  } catch { return { ok: false, error: 'red o respuesta inválida de Telegram', retry: 60, uncertain: true }; }
  finally { clearTimeout(timer); }
}
export class Vigilante {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.busy = false; }
  async load() {
    const state = (await this.ctx.storage.get('state-v2')) || blank();
    state.obscuraSample = await this.ctx.storage.get('obscura-sample') || state.obscuraSample;
    const active = new Set(SOURCES.map(s => s.id));
    for (const id of Object.keys(state.sources)) if (!active.has(id)) delete state.sources[id];
    return state;
  }
  async save(state) { await this.ctx.storage.put('state-v2', state); }
  async enqueue(state, candidate) {
    if (this.env.GEMINI_API_KEY) return this.enqueueGemini(state, candidate);
    const result = classify(candidate);
    if (!result.relevant) return { accepted: false, reason: result.reason };
    const key = candidate.probeId || await digest(normalize(candidate.text));
    if (state.sent[key] || state.queue[key]) return { accepted: false, reason: 'duplicado' };
    state.queue[key] = { candidate, attempts: 0, next: 0, created: Date.now() };
    return { accepted: true };
  }
  async enqueueGemini(state, candidate) {
    const now = Date.now();
    const published = Date.parse(candidate.published);
    state.geminiSince ??= now;
    if (!Number.isFinite(published) || published < state.geminiSince || published > now + 60000 || now - published > DAY)
      return { accepted: false, reason: 'fuera de la ventana de publicaciones nuevas' };
    const text = normalize(candidate.text);
    if (!CIRCUIT.test(text) && !/\btoronjal (?:ii|2)\b/.test(text)) return { accepted: false, reason: 'sin objetivo legible' };
    const key = candidate.probeId || await digest(text);
    if (state.sent[key] || state.queue[key]) return { accepted: false, reason: 'duplicado' };
    state.gemini ??= {};
    const seen = state.gemini[key];
    if (seen && (!seen.retry || seen.retry > now)) return { accepted: false, reason: seen.decision };
    let verdict;
    try {
      verdict = await evaluateGemini([{text: candidate.text}], candidate.text, this.env.GEMINI_API_KEY);
    } catch (error) {
      state.gemini[key] = { at: now, decision: 'pendiente', retry: now + 5 * 60000, candidate };
      state.geminiError = String(error.message).slice(0,100);
      return { accepted: false, reason: 'reintento Gemini pendiente' };
    }
    state.geminiError = null;
    state.gemini[key] = { at: now, decision: verdict.decision, url: candidate.url, evidencia: verdict.evidencia };
    if (verdict.decision !== 'alertar') return { accepted: false, reason: verdict.decision };
    const eventDates = dates(candidate.text, now, published);
    if (eventDates.length && eventDates.every(d => d.days < 0 || d.days > 30)) return { accepted: false, reason: 'fuera de vigencia' };
    state.queue[key] = { candidate, evidence: verdict.evidencia, attempts: 0, next: 0, created: now };
    return { accepted: true };
  }
  async consider(state, c) {
    const pub = Date.parse(c.published || '');
    const validDate = Number.isFinite(pub) && pub <= Date.now() + 3600000 && pub >= Date.now() - 7 * DAY;
    const unrelated = unrelatedPost(c.text);
    for (const media of c.media || []) {
      const id = await digest(c.url + '\n' + media.url);
      if (state.media[id]) { state.media[id].parent.unrelated = unrelated; state.media[id].priority ||= urgent(c.text); }
    }
    // PDFs/images are separate units; never attach another circuit's text to them.
    if (!unrelated && (validDate || classify(c).relevant) && c.media?.length) {
      for (const m of c.media) {
        const id = await digest(c.url + '\n' + m.url);
        if (!state.media[id]) state.media[id] = { id, ...m, priority: urgent(c.text), parent: { url: c.url, title: c.title, published: c.published, source: c.source, unrelated: false }, created: Date.now(), done: false };
      }
    }
    return this.enqueue(state, c);
  }
  async collect(state) {
    const now = Date.now();
    const due = SOURCES.filter(s => now - (state.sources[s.id]?.checked || 0) >= s.interval);
    const responses = await Promise.all(due.map(async source => {
      const previous = state.sources[source.id];
      try {
        if (source.type === 'x') return { source, ...await downloadTimeline(source) };
        return { source, response: await download(source.url, previous) };
      }
      catch (e) { return { source, error: e.message }; }
    }));
    for (const { source, response, error, candidates = [], fallbackReason, reader } of responses) {
      const previous = state.sources[source.id] || {};
      if (error) { state.sources[source.id] = { ...previous, checked: now, error, failures: (previous.failures || 0) + 1 }; continue; }
      if (response.unchanged) { state.sources[source.id] = { ...previous, checked: now, error: previous.error || null }; continue; }
      try {
        if (source.type === 'html') {
          const links = articleLinks(response.text, source.url);
          if (!links.length) throw Error('sin enlaces de avisos: revisar estructura HTML');
          for (const c of links) if (!state.articles[c.url]) state.articles[c.url] = { ...c, checked: 0 };
        }
        for (const c of candidates) await this.consider(state, c);
        state.sources[source.id] = { url: source.url, checked: now, success: now, etag: response.etag, modified: response.modified, count: candidates.length, failures: 0, error: null, newest: [previous.newest, candidates[0]?.published].filter(Boolean).sort().at(-1) || null, fallbackReason, reader: reader || 'html' };
      } catch (e) { state.sources[source.id] = { ...previous, checked: now, failures: (previous.failures || 0) + 1, error: e.message }; }
    }
    // Four articles/run, oldest checked first. Rotation prevents starvation.
    const pages = Object.values(state.articles).filter(a => now - a.checked >= 300000).sort((a, b) => a.checked - b.checked).slice(0, 4);
    for (const a of pages) {
      try {
        const r = await download(a.url, a);
        if (!r.unchanged) {
          const c = article(r.text, a.url);
          await this.consider(state, c);
          a.etag = r.etag; a.modified = r.modified; a.published = c.published;
          a.mediaCount = c.media.length;
        }
        a.error = null;
      } catch (e) { a.error = e.message; }
      a.checked = now;
    }
  }
  health(state) {
    const issues = [];
    for (const source of SOURCES) {
      const s = state.sources[source.id];
      if (s?.failures >= 3) issues.push(`${source.id}: ${s.error}`);
      if (source.type === 'x' && s?.newest && Date.now() - Date.parse(s.newest) > 3 * DAY) issues.push(`${source.id}: la publicación visible más reciente tiene más de 72 horas; la frescura de X no está verificada.`);
    }
    const pending = Object.values(state.media).filter(canReadMedia);
    if (pending.some(m => Date.now() - m.created > 15 * 60000)) issues.push('Hay imágenes/PDF pendientes: el lector OCR no está completando los avisos. Consultar /media y /status.');
    if (Object.values(state.articles).some(a => a.error)) issues.push('Hay artículos oficiales que no se pudieron descargar.');
    return issues;
  }
  async dispatchOcr(state) {
    const token = this.env.EBNMZ_OCR_TOKEN;
    const now = Date.now();
    if (!token || !Object.values(state.media).some(canReadMedia)) return;
    const lastActivity = state.ocrDispatch?.attempted || 0;
    const fresh = Object.values(state.media).some(m => canReadMedia(m) && m.created > lastActivity);
    if (now - lastActivity < (fresh ? 1 : 10) * 60000) return;
    state.ocrDispatch = { attempted: now, error: null };
    await this.save(state);
    try {
      const response = await fetch('https://api.github.com/repos/aeee123/l327-vigilante/actions/workflows/ocr.yml/dispatches', {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(8000),
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': UA },
        body: JSON.stringify({ ref: 'main' }),
      });
      if (!response.ok) state.ocrDispatch.error = `GitHub HTTP ${response.status}`;
      await response.body?.cancel();
    } catch {
      state.ocrDispatch.error = 'no se pudo iniciar el lector en GitHub';
    }
    await this.save(state);
  }
  async deliver(state) {
    const now = Date.now();
    if (state.telegram.next > now) return;
    for (const [key, item] of Object.entries(state.queue).sort((a, b) => a[1].created - b[1].created)) {
      if (item.candidate.system && this.env.NOTIFY_DIAGNOSTICS !== 'true') { delete state.queue[key]; continue; }
      const result = item.candidate.system || item.evidence ? null : classify(item.candidate);
      if (item.evidence && now - Date.parse(item.candidate.published) > DAY) { delete state.queue[key]; continue; }
      if (now - item.created > 7 * DAY || (result && !result.relevant)) { delete state.queue[key]; continue; }
      if (item.next > now) continue;
      // Persist the outbox before external side effects; an acknowledged send is saved immediately.
      await this.save(state);
      const alertText = item.evidence && ['⚡ Aviso oficial · ' + (CIRCUIT.test(normalize(item.evidence)) ? 'L-327' : 'El Toronjal II'), item.evidence.slice(0, 2500), item.candidate.url].join('\n');
      const sent = await sendTelegram(this.env, item.candidate.probeId?.startsWith('gemini-probe-') ? 'PRUEBA EBNMZ: Gemini confirmó el aviso simulado de El Toronjal II.' : item.candidate.probeId ? 'PRUEBA EBNMZ: imagen L-327 procesada correctamente. Este mensaje es una prueba.' : item.candidate.system || alertText || message(item.candidate, result));
      state.telegram = { lastAttempt: now, error: sent.ok ? null : sent.error, next: sent.ok ? now + 1100 : now + sent.retry * 1000 };
      if (sent.ok) { state.sent[key] = { at: Date.now(), published: item.candidate.published, detected: item.candidate.detected ?? item.created, ocrFinished: item.candidate.ocrFinished, probe: Boolean(item.candidate.probeId), url: item.candidate.url, messageId: sent.messageId }; delete state.queue[key]; }
      else { item.attempts++; item.uncertain = !!sent.uncertain; item.next = Math.max(state.telegram.next, now + Math.min(3600000, 60000 * 2 ** Math.min(item.attempts, 6))); }
      await this.save(state);
      break; // A single chat never receives a burst of messages.
    }
  }
  prune(state) {
    const now = Date.now();
    for (const [key, entry] of Object.entries(state.gemini || {})) if (now - (Date.parse(entry.candidate?.published) || entry.at) > DAY * 2) delete state.gemini[key];
    for (const m of Object.values(state.media)) if (!m.done && (m.parent.unrelated === true || (m.parent.unrelated === undefined && unrelatedPost(m.parent.title)))) {
      m.done = true; m.processed = now; m.reviewRequired = false; m.result = { accepted: false, reason: 'publicación institucional sin aviso de corte eléctrico' }; delete m.error;
    }
    for (const [k, v] of Object.entries(state.sent)) if (now - v.at > 90 * DAY) delete state.sent[k];
    for (const [k, v] of Object.entries(state.media)) if (now - v.created > 8 * DAY) delete state.media[k];
    const articles = Object.entries(state.articles).sort((a, b) => b[1].checked - a[1].checked);
    if (articles.length > 100) for (const [k] of articles.slice(100)) delete state.articles[k];
  }
  async sampleObscura(state) {
    const token = this.env.OBSCURA_SERVICE_TOKEN;
    const checked = Date.now();
    if (!token || checked - (state.obscuraSample?.checked || 0) < 5 * 60000) return null;
    const snapshots = { ...state.obscuraSample?.sources };
    const source = SOURCES.filter(s => s.type === 'x').sort((a, b) => (snapshots[a.id]?.checked || 0) - (snapshots[b.id]?.checked || 0))[0];
    {
      const previous = state.obscuraSample?.sources[source.id];
      const start = Date.now();
      try {
        const sample = await downloadObscura(source, previous, token);
        snapshots[source.id] = { checked, ms: Date.now() - start, obscuraSeen: sample.obscuraSeen,
          newest: [previous?.newest, sample.candidates[0]?.published].filter(Boolean).sort().at(-1) || null };
      } catch (error) {
        snapshots[source.id] = { ...previous, checked, ms: Date.now() - start, error: error.message };
      }
    }
    return { checked, sources: snapshots };
  }
  async run(state) {
    if (Date.now() - state.lastRun < 45000) return { skipped: 'revisión reciente' };
    state.lastRun = Date.now();
    if (this.env.GEMINI_API_KEY) state.geminiSince ??= state.lastRun;
    await this.save(state);
    try { await this.collect(state); state.lastError = null; }
    catch { state.lastError = 'falló la recolección; revisar estado de fuentes'; }
    this.prune(state);
    const retry = Object.values(state.gemini || {}).find(e => e.retry <= Date.now() && Date.now() - Date.parse(e.candidate.published) <= DAY);
    if (retry) await this.enqueueGemini(state, retry.candidate);
    const overdue = Object.values(state.media).filter(m => !m.probe && canReadMedia(m) && (m.priority ?? urgent(m.parent.title)) && Date.now() - m.created >= 600000);
    if (!overdue.length) state.ocrDelayNotified = false;
    if (overdue.length && !state.ocrDelayNotified && /^[1-9]\d*$/.test(this.env.TELEGRAM_CHAT_ID || '')) {
      const notice = await sendTelegram(this.env, 'EBNMZ: una imagen prioritaria lleva al menos 10 minutos esperando lectura.');
      state.ocrDelayNotified = notice.ok || Boolean(notice.uncertain);
    }
    const issues = this.health(state);
    const signature = issues.join('\n');
    const diagnosticsEnabled = this.env.NOTIFY_DIAGNOSTICS === 'true';
    if (!diagnosticsEnabled) {
      for (const [key, item] of Object.entries(state.queue)) if (item.candidate.system) delete state.queue[key];
    }
    if (signature !== state.warnings.signature) {
      for (const [key, item] of Object.entries(state.queue)) if (item.candidate.system) delete state.queue[key];
      if (signature && diagnosticsEnabled) {
        const key = 'health-' + await digest(signature + Date.now());
        if (!state.sent[key]) state.queue[key] = { candidate: { system: `⚠️ BOT L-327: COBERTURA INCOMPLETA\n${signature}\nNo se puede asegurar la detección de todos los avisos.` }, created: Date.now(), attempts: 0, next: 0 };
      }
      state.warnings = { signature, since: Date.now() };
    }
    await this.save(state);
    await this.deliver(state);
    await this.dispatchOcr(state);
    return this.status(state);
  }
  status(state) {
    const media = Object.values(state.media);
    return { circuit: 'L-327 / SIS-L327', diagnosticNotifications: this.env.NOTIFY_DIAGNOSTICS === 'true', recentDeliveries: Object.entries(state.sent).sort((a,b)=>b[1].at-a[1].at).slice(0,20).map(([key,v])=>({ published: v.published, detected: v.detected, ocrFinished: v.ocrFinished, type: v.probe ? 'test' : key.startsWith('health-') ? 'diagnostic' : 'outage', at: new Date(v.at).toISOString(), url: v.url || null })), lastRun: state.lastRun ? new Date(state.lastRun).toISOString() : null, sources: state.sources, obscuraSample: state.obscuraSample || null, pending: Object.keys(state.queue).length, mediaPending: media.filter(canReadMedia).length, mediaRetryScheduled: media.filter(m => !m.done && m.nextOcr > Date.now()).length, mediaReview: media.filter(m => !m.done && (m.attempts || 0) >= 3).length, mediaErrors: Object.values(state.media).filter(m => m.error && !m.done).slice(0, 12).map(m => ({ id: m.id, url: m.url, error: m.error, attempts: m.attempts })), sent: Object.keys(state.sent).length, telegram: state.telegram, issues: this.health(state), lastError: state.lastError || null, ocrLastSeen: state.ocrLastSeen || null, ocrDispatch: { enabled: Boolean(this.env.EBNMZ_OCR_TOKEN), ...state.ocrDispatch }, articles: Object.values(state.articles).map(a => ({ url: a.url, error: a.error || null, published: a.published || null, checked: a.checked })) };
  }
  async fetch(request) {
    const { pathname: path, searchParams } = new URL(request.url);
    // Read-only diagnostics must remain available while a collection is running.
    if (path === '/sample') {
      const sample = await this.sampleObscura(await this.load());
      if (sample) await this.ctx.storage.put('obscura-sample', sample);
      return json({ checked: sample?.checked });
    }
    if (path === '/status') return json(this.status(await this.load()));
    if (path === '/media') {
      const state = await this.load();
      const limit = Math.min(48, Math.max(1, Number(searchParams.get('limit')) || 12));
      const items = Object.values(state.media).filter(canReadMedia)
        .sort((a, b) => Number(Boolean(a.attempts)) - Number(Boolean(b.attempts)) || Number(Boolean(b.priority ?? urgent(b.parent.title))) - Number(Boolean(a.priority ?? urgent(a.parent.title))) || (a.attempts || 0) - (b.attempts || 0) || a.created - b.created);
      return json({ items: items.slice(0, limit) });
    }
    if (this.busy) return json({ error: 'revisión en curso' }, 409);
    this.busy = true;
    try {
      const state = await this.load();
      if (path === '/run') return json(await this.run(state));
      if (path === '/test-gemini') {
        if (!this.env.GEMINI_API_KEY) return json({ error: 'Gemini sin configurar' }, 503);
        const now = Date.now();
        if (now - (state.lastGeminiProbe || 0) < 600000) return json({ error: 'prueba reciente' }, 429);
        state.lastGeminiProbe = now;
        state.geminiSince ??= now;
        const id = 'gemini-probe-' + now;
        const result = await this.enqueueGemini(state, { probeId: id, text: 'El Toronjal II quedará sin energía de 8 a 12 por mantenimiento.', published: new Date(now).toISOString(), detected: now });
        await this.save(state);
        await this.deliver(state);
        return json({ id, result, sent: Boolean(state.sent[id]) });
      }
      if (path === '/ingest') {
        const data = JSON.parse(await readText(request, 200000));
        const units = Array.isArray(data.units) ? data.units : [{ text: data.text, confidence: data.confidence ?? 100 }];
        if (!data.id || !state.media[data.id] || units.length > 20 || (!data.error && units.some(u => typeof u.text !== 'string' || u.text.length > 60000 || !Number.isFinite(u.confidence)))) return json({ error: 'resultado OCR inválido' }, 400);
        const m = state.media[data.id];
        if (m.done) return json({ accepted: false, reason: 'ya procesado' });
        state.ocrLastSeen = new Date().toISOString();
        if (data.error) { m.error = String(data.error).slice(0, 120); retryMedia(m); await this.save(state); return json({ accepted: false, reason: 'OCR pendiente' }); }
        // No title concatenation: a broad weekly heading must not supply another image's circuit/date.
        if (!units.length || units.every(u => u.confidence < 55 || u.text.trim().length < 10)) {
          m.error = 'OCR vacío o de baja confianza; requiere revisión'; m.reviewRequired = true; retryMedia(m);
          await this.save(state); return json({ accepted: false, needs_review: true, reason: m.error });
        }
        const results = [];
        let unreadable = 0;
        for (const u of units) {
          if (u.confidence < 55 || u.text.trim().length < 10) { unreadable++; results.push({ accepted: false, reason: 'página ilegible' }); continue; }
          results.push(await this.enqueue(state, { ...m.parent, detected: m.created, ocrFinished: Date.now(), text: u.text, ocr: true, media: [] }));
        }
        const result = { accepted: results.some(r => r.accepted), pages: results };
        if (unreadable) { m.error = `OCR parcial: ${unreadable} páginas requieren revisión`; retryMedia(m); result.reason = m.error; result.needs_review = true; }
        m.reviewRequired = unreadable > 0;
        m.done = unreadable === 0; m.result = result; m.processed = Date.now();
        await this.save(state);
        await this.deliver(state);
        return json(result);
      }
      if (path === '/test-ocr') {
        const now = Date.now();
        if (now - (state.lastProbe || 0) < 600000) return json({ error: 'prueba reciente' }, 429);
        const id = 'probe-' + now;
        state.lastProbe = now;
        state.media[id] = { id, probe: true, priority: true, created: now, done: false, parent: { probeId: id, published: new Date(now).toISOString(), title: 'Prueba OCR', source: 'prueba' } };
        await this.save(state);
        await this.dispatchOcr(state);
        return json({ id, dispatch: state.ocrDispatch });
      }
      if (path === '/test-alert') {
        if (Date.now() - (state.lastTest || 0) < 60000) return json({ error: 'esperá un minuto' }, 429);
        state.lastTest = Date.now(); await this.save(state);
        return json(await sendTelegram(this.env, '✅ PRUEBA DEL BOT L-327. Este mensaje no anuncia un corte de energía.'));
      }
      return json({ error: 'ruta inexistente' }, 404);
    } catch { return json({ error: 'operación fallida; revisar configuración y almacenamiento' }, 500); }
    finally { this.busy = false; }
  }
}
function stub(env) { return env.VIGILANTE.get(env.VIGILANTE.idFromName('L327-v2')); }
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(stub(env).fetch('https://internal/sample', { method: 'POST' }));
    ctx.waitUntil(stub(env).fetch('https://internal/run', { method: 'POST' }).then(async r => { if (!r.ok && r.status !== 409) throw Error(`revisión ${r.status}`); console.log('L327', await r.text()); }));
  },
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/' && request.method === 'GET') return json({ service: 'L327-vigilante', version: 2 });
    if (!env.ADMIN_TOKEN || request.headers.get('authorization') !== `Bearer ${env.ADMIN_TOKEN}`) return json({ error: 'no autorizado' }, 401);
    if (!env.VIGILANTE) return json({ error: 'falta binding VIGILANTE' }, 503);
    const routes = { '/status': 'GET', '/media': 'GET', '/run': 'POST', '/ingest': 'POST', '/test-alert': 'POST', '/test-ocr': 'POST' };
    routes['/test-gemini'] = 'POST';
    if (!routes[path]) return json({ error: 'ruta inexistente' }, 404);
    if (request.method !== routes[path]) return json({ error: 'método no permitido' }, 405);
    if (Number(request.headers.get('content-length') || 0) > 200000) return json({ error: 'cuerpo demasiado grande' }, 413);
    return stub(env).fetch(request);
  },
};
