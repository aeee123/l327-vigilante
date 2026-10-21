export const DAY = 86400000;
export const normalize = (s = '') => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
export const CIRCUIT = /\b(?:sis\s*[-_]?\s*)?l\s*[-_]?\s*327\b|\b(?:linea|circuito)\s*327\b/i;
export function unrelatedPost(text) {
  const t = normalize(text);
  return !CIRCUIT.test(t) && !/corte|interrupcion|mantenimiento|apagon|sin luz|sin energia|falla|alivio de carga|racionamiento/.test(t) && /cancer|octubre rosa|deteccion temprana salva vidas|capacitacion|riesgos ocupacionales|seguridad laboral|medalla|condecoracion|cooperacion|acto protocolario/.test(t);
}
const MONTHS = 'enero febrero marzo abril mayo junio julio agosto septiembre octubre noviembre diciembre'.split(' ');
const DATE_RE = /\b(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(?:\s+(?:de(?:l)?\s+)?(20\d{2}))?\b/g;
const EVENT = /sin (?:luz|energia|suministro|servicio electrico)|apag[oó]n|interrupcion|corte(?:s)? (?:de )?(?:luz|energia|electrico)|mantenimiento|alivio de carga|racionamiento|falla|deficit de generacion/;
export function localDay(now = Date.now()) {
  const d = new Date(now - 6 * 3600000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
export function dates(text, now = Date.now(), published = null) {
  const today = localDay(now), year = new Date(today).getUTCFullYear();
  const matches = [...normalize(text).matchAll(DATE_RE)];
  const result = [];
  for (const m of matches) {
    const month = m[2] === 'setiembre' ? 9 : MONTHS.indexOf(m[2]) + 1;
    // A year at the end of a date range applies to its earlier dates too.
    const nearbyYear = normalize(text).slice(m.index + m[0].length, m.index + m[0].length + 90).match(/\b(20\d{2})\b/);
    let y = Number(m[3] || nearbyYear?.[1] || (published ? new Date(localDay(published)).getUTCFullYear() : year));
    if (!m[3] && !nearbyYear) {
      const referenceMonth = new Date(published ? localDay(published) : today).getUTCMonth();
      if (referenceMonth === 11 && month === 1) y++;
      if (referenceMonth === 0 && month === 12) y--;
    }
    const t = Date.UTC(y, month - 1, Number(m[1]));
    const d = new Date(t);
    if (d.getUTCFullYear() !== y || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== Number(m[1])) continue;
    if (!result.some(x => x.iso === d.toISOString().slice(0, 10))) result.push({ iso: d.toISOString().slice(0, 10), days: Math.round((t - today) / DAY) });
  }
  for (const m of normalize(text).matchAll(/\b(?:(20\d{2})-(\d{2})-(\d{2})|(\d{1,2})\/(\d{1,2})\/(20\d{2}))\b/g)) {
    const y = Number(m[1] || m[6]), month = Number(m[2] || m[5]), day = Number(m[3] || m[4]);
    const t = Date.UTC(y, month - 1, day), d = new Date(t);
    if (d.getUTCFullYear() === y && d.getUTCMonth() === month - 1 && d.getUTCDate() === day && !result.some(x => x.iso === d.toISOString().slice(0, 10))) result.push({ iso: d.toISOString().slice(0, 10), days: Math.round((t - today) / DAY) });
  }
  return result;
}
export function phase(text) {
  const t = normalize(text);
  if (/cancelad[oa]|no se realizara|suspendido el mantenimiento|no habra cortes?\b/.test(t)) return 'CANCELACIÓN';
  if (/restablecid|normalizad|restaurad|servicio (?:ha sido )?restablecido/.test(t)) return 'RESTABLECIMIENTO REPORTADO';
  if (/programad|mantenimiento|no habra|no contaran/.test(t)) return 'CORTE PROGRAMADO';
  return 'REPORTE DE INTERRUPCIÓN';
}
export function classify(candidate, now = Date.now()) {
  const text = normalize(candidate.text);
  if (!CIRCUIT.test(text) || (!EVENT.test(text) && phase(text) === 'REPORTE DE INTERRUPCIÓN')) return { relevant: false, reason: 'sin coincidencia exacta de circuito y evento' };
  const published = candidate.published ? Date.parse(candidate.published) : null;
  if (candidate.published && !Number.isFinite(published)) return { relevant: false, reason: 'fecha de publicación inválida' };
  if (published && published > now + 3600000) return { relevant: false, reason: 'publicación futura' };
  const ds = dates(text, now, published);
  const upcoming = ds.filter(d => d.days >= 0 && d.days <= 30);
  if (ds.length && !upcoming.length) return { relevant: false, reason: 'aviso vencido o fuera de 30 días' };
  if (published && now - published > 7 * DAY && !upcoming.length) return { relevant: false, reason: 'publicación antigua' };
  // Undated material is unsafe on first discovery of an archive page.
  if (!ds.length && !published) return { relevant: false, reason: 'sin fecha verificable' };
  if (phase(text) === 'REPORTE DE INTERRUPCIÓN' && !ds.length && published && now - published > DAY) return { relevant: false, reason: 'reporte sin fecha del evento con más de 24 horas' };
  const codes = [...text.matchAll(/\bl\s*[-_]?\s*(\d{2,4})\b/g)].map(m => m[1]);
  const multiple = codes.some(code => code !== '327');
  return { relevant: true, phase: multiple ? 'AVISO MULTICIRCUITO: VER ORIGINAL' : phase(text), dates: upcoming, multiple };
}
export function decode(s = '') {
  return String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n) => {
    const cp = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
  }).replace(/&(nbsp|amp|lt|gt|quot|apos|aacute|eacute|iacute|oacute|uacute|ntilde);/gi, (m, e) => ({nbsp:' ',amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",aacute:'á',eacute:'é',iacute:'í',oacute:'ó',uacute:'ú',ntilde:'ñ'})[e.toLowerCase()] ?? m);
}
export function clean(html = '') { return decode(html.replace(/<(script|style|nav|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(); }
export function safeUrl(url, base) { try { const u = new URL(decode(url), base); return u.protocol === 'https:' && !u.username && !u.password ? u.href.split('#')[0] : null; } catch { return null; } }
export function official(url) { try { const h = new URL(url).hostname; return ['eneeutcd.hn', 'enee.hn', 'sen.hn', 'cree.gob.hn', 'ods.org.hn'].some(d => h === d || h.endsWith('.' + d)); } catch { return false; } }
export async function digest(s) { const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join(''); }
export function articleLinks(html, base) {
  const links = new Map();
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = safeUrl(m[1], base), title = clean(m[2]);
    if (!url || new URL(url).hostname !== new URL(base).hostname) continue;
    if (/mantenimiento|interrupcion|corte|apag[oó]n|l\s*-?\s*327|energia/i.test(normalize(title)) && /-NT\d+|\/\d{4}\/|\/noticia[s]?\//i.test(url)) links.set(url, { url, title });
  }
  return [...links.values()].slice(0, 40);
}
function jsonScripts(html) {
  const objects = [];
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) { try { objects.push(JSON.parse(m[1])); } catch {} }
  return objects;
}
export function article(html, url) {
  const data = jsonScripts(html).flatMap(x => Array.isArray(x) ? x : x['@graph'] || [x]).find(x => /Article|Posting/.test(x['@type']));
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] || html;
  const body = main.split(/<table\b|<div[^>]*class=["'][^"']*(?:faq|related)/i)[0];
  const title = data?.headline || clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || 'Aviso ENEE');
  const media = [];
  for (const m of body.matchAll(/<img\b[^>]*src=["']([^"']+)["'][^>]*>/gi)) {
    const image = safeUrl(m[1], url), alt = clean(m[0].match(/\balt=["']([^"']*)["']/i)?.[1] || '');
    if (image && !/logo|icon|avatar/i.test(image)) media.push({ url: image, type: 'image' });
    if (alt) media.push({ alt });
  }
  for (const m of body.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)) {
    const link = safeUrl(m[1], url);
    if (link && /\.pdf(?:\?|$)/i.test(link)) media.push({ url: link, type: 'pdf' });
    else if (link && /^(?:goo\.su|bit\.ly|drive\.google\.com)$/.test(new URL(link).hostname)) media.push({ url: link, type: 'linked-document' });
  }
  return { url, title, text: `${clean(body)} ${media.filter(x => x.alt).map(x => x.alt).join(' ')}`.slice(0, 30000), published: data?.datePublished || null, media: media.filter(x => x.url).slice(0, 12), source: 'ENEE WEB' };
}
export function rss(html) {
  const entries = [];
  const tag = (s, name) => decode(s.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1] || '').trim();
  for (const m of html.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const b = m[2], title = clean(tag(b, 'title')), desc = clean(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content'));
    const url = safeUrl(tag(b, 'link') || b.match(/<link[^>]*href=["']([^"']+)["']/i)?.[1]);
    const published = tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated');
    if (url && published) entries.push({ title, text: `${title} ${desc}`, url, published, media: [], source: 'RSS' });
  }
  return entries.slice(0, 40);
}
// Parse data as JSON only. Never execute scripts downloaded from X.
export function tweets(html, handle) {
  const roots = jsonScripts(html), out = new Map();
  for (const m of html.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
    if (!m[0].includes('full_text') && !m[0].includes('tweet_results')) continue;
    try { const decoded = JSON.parse(m[0]); if (typeof decoded === 'string' && decoded.startsWith('{')) roots.push(JSON.parse(decoded)); } catch {}
  }
  let nodes = 0;
  function visit(o, inheritedId = null, depth = 0) {
    if (!o || typeof o !== 'object' || depth > 70 || ++nodes > 50000) return;
    const id = o.rest_id || o.id_str || inheritedId;
    const details = o.details || o.legacy;
    const author = o.core?.user_results?.result?.core?.screen_name || o.core?.user_results?.result?.legacy?.screen_name;
    if (details?.full_text && /^\d{15,25}$/.test(id || '') && author?.toLowerCase() === handle.toLowerCase()) {
      const publishedMs = Number(details.created_at_ms) || Date.parse(details.created_at);
      if (Number.isFinite(publishedMs)) {
        const media = o.media_entities2 || details.extended_entities?.media || details.entities?.media || [];
        const text = o.note_tweet?.note_tweet_results?.result?.text || details.full_text;
        out.set(id, { url: `https://x.com/${handle}/status/${id}`, title: text.slice(0, 160), text, published: new Date(publishedMs).toISOString(), source: 'X (EXPERIMENTAL)', media: media.filter(x => x.type === 'photo').map(x => ({ url: safeUrl(x.media_url_https), type: 'image' })).filter(x => x.url) });
      }
    }
    for (const [key, value] of Object.entries(o)) if (!/retweeted_status|quoted_status/.test(key)) visit(value, id, depth + 1);
  }
  roots.forEach(x => visit(x));
  return [...out.values()].sort((a, b) => Date.parse(b.published) - Date.parse(a.published));
}
export function message(c, result = classify(c)) {
  const ds = result.dates || [], when = ds.map(d => `${d.iso}${d.days === 0 ? ' (HOY)' : d.days === 1 ? ' (MAÑANA)' : ''}`).join(', ');
  const index = normalize(c.text).search(CIRCUIT);
  const excerpt = c.text.slice(Math.max(0, index - 250), Math.max(0, index - 250) + 1800);
  return [`⚡ ${result.phase || 'AVISO'} — CIRCUITO L-327`, when && `Fechas encontradas: ${when}`, c.ocr && 'Lectura automática de imagen/PDF: verificar el original.', result.multiple && 'Este documento menciona varios circuitos. Confirmar la fecha y el alcance de L-327 en la fuente.', '', c.title.slice(0, 180), excerpt, '', `Fuente: ${c.source}${official(c.url) ? ' · oficial' : ''}`, c.url, `Detectado: ${new Date(Date.now() - 6 * 3600000).toISOString().slice(0, 16).replace('T', ' ')} HN`].filter(Boolean).join('\n').slice(0, 3900);
}
