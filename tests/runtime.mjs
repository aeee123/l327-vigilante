import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
const mf = new Miniflare(convertV4MiniflareOptions({
  name: 'l327',
  modules: [
    { type: 'ESModule', path: 'worker/l327-worker.js' },
    { type: 'ESModule', path: 'worker/core.js' },
  ],
  compatibilityDate: '2026-10-01',
  durableObjects: { VIGILANTE: { className: 'Vigilante', useSQLite: true } },
  bindings: { ADMIN_TOKEN: 'local-test-only' },
}));
try {
  const base = 'https://bot.example';
  assert.equal((await mf.dispatchFetch(base + '/status')).status, 401);
  const headers = { authorization: 'Bearer local-test-only' };
  const status = await mf.dispatchFetch(base + '/status', { headers });
  assert.equal(status.status, 200);
  assert.equal((await status.json()).circuit, 'L-327 / SIS-L327');
  assert.equal((await mf.dispatchFetch(base + '/test-alert', { headers })).status, 405);
  const media = await mf.dispatchFetch(base + '/media', { headers });
  assert.deepEqual((await media.json()).items, []);
  const ingest = await mf.dispatchFetch(base + '/ingest', { method: 'POST', headers, body: JSON.stringify({ id: 'missing', text: 'L327', confidence: 100 }) });
  assert.equal(ingest.status, 400);
  const empty = await mf.dispatchFetch(base + '/test-alert', { method: 'POST', headers });
  assert.equal((await empty.json()).ok, false);
  const retry = await mf.dispatchFetch(base + '/test-alert', { method: 'POST', headers });
  assert.equal(retry.status, 429); // State is stored through the actual SQLite-backed object.
  console.log('Runtime Cloudflare: autorización, enrutamiento, SQLite y límites verificados. Sin envíos externos.');
} finally { await mf.dispose(); }
