import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const token = process.env.OBSCURA_SERVICE_TOKEN;
if (!token || token.length < 32) throw new Error('Configura OBSCURA_SERVICE_TOKEN');
const authorization = Buffer.from('Bearer ' + token);
const accounts = new Map([['cnd', 'CNDHonduras'], ['enee', 'EneeHnOficial']]);
const busy = new Set();

async function evaluate(url, expression) {
  const { stdout } = await run(process.env.OBSCURA_BIN || 'obscura', [
    'fetch', url, '--wait-until', 'domcontentloaded', '--timeout', '25', '--eval', expression,
  ], { timeout: 29000, maxBuffer: 256 * 1024, windowsHide: true });
  const value = JSON.parse(stdout);
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function profileLinks(handle) {
  return Array.from(document.querySelectorAll('article a[href]'), a => a.getAttribute('href'))
    .filter(path => new RegExp('^/' + handle + '/status/[0-9]{15,25}$', 'i').test(path));
}

function readPost() {
  const article = document.querySelector('article');
  return {
    published: document.querySelector('meta[property="article:published_time"]')?.content,
    text: article?.innerText,
    photos: Array.from(article?.querySelectorAll('img') || [], image => image.src)
      .filter(url => url.startsWith('https://pbs.twimg.com/media/')),
  };
}

createServer(async (request, response) => {
  function reply(code, data) {
    response.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(data));
  }
  const url = new URL(request.url, 'http://localhost');
  if (request.method !== 'GET') return reply(405, { error: 'method' });
  if (url.pathname === '/health') return reply(200, { ok: true });
  const header = Buffer.from(request.headers.authorization || '');
  if (header.length !== authorization.length || !timingSafeEqual(header, authorization)) {
    return reply(401, { error: 'unauthorized' });
  }
  const handle = accounts.get(url.searchParams.get('account'));
  if (!handle) return reply(400, { error: 'account' });
  const id = url.searchParams.get('id');
  if (url.pathname !== '/profile' && url.pathname !== '/post') return reply(404, { error: 'route' });
  if (url.pathname === '/post' && !/^[0-9]{15,25}$/.test(id || '')) return reply(400, { error: 'id' });
  if (busy.has(handle)) return reply(503, { error: 'busy' });
  busy.add(handle);
  try {
    const profile = 'https://x.com/' + handle;
    if (url.pathname === '/profile') {
      const paths = await evaluate(profile, `JSON.stringify((${profileLinks})(${JSON.stringify(handle)}))`);
      const ids = [...new Set(paths.map(path => path.split('/').at(-1)))].sort((a, b) => b.localeCompare(a));
      return reply(ids.length ? 200 : 502, { ids });
    }
    const post = await evaluate(profile + '/status/' + id, `JSON.stringify((${readPost})())`);
    if (!post.text || !Number.isFinite(Date.parse(post.published))) return reply(502, { error: 'post unavailable' });
    return reply(200, { id, ...post });
  } catch (error) {
    const reason = error.killed || /timed? out|timeout/i.test(error.stderr || '')
      ? 'browser timeout' : 'browser read failed';
    console.warn(handle, url.pathname, reason);
    return reply(502, { error: reason });
  } finally {
    busy.delete(handle);
  }
}).listen(Number(process.env.PORT || 10000), '0.0.0.0');
