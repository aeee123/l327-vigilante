import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { Vigilante, sendTelegram, readText } from '../worker/l327-worker.js';
function instance(env = {}) {
  const db = new Map();
  const storage = { get: async key => structuredClone(db.get(key)), put: async (key, val) => { db.set(key, structuredClone(val)); } };
  return { bot: new Vigilante({ storage }, env), db };
}
const candidate = () => ({ text: 'L-327: interrupción de energía por falla.', title: 'Aviso de falla', url: 'https://x.com/CNDHonduras/status/2110932649590038780', published: new Date().toISOString(), source: 'X' });
test('rutas que envían exigen autorización y método', async () => {
  let calls = 0;
  const env = { ADMIN_TOKEN: 'test-secret', VIGILANTE: { idFromName: () => 'id', get: () => ({ fetch: async () => { calls++; return new Response('{}'); } }) } };
  for (const path of ['/test-texto', '/test-alert', '/run', '/status', '/media', '/ingest']) assert.equal((await worker.fetch(new Request('https://bot.example' + path), env)).status, 401);
  const get = new Request('https://bot.example/test-alert', { headers: { authorization: 'Bearer test-secret' } });
  assert.equal((await worker.fetch(get, env)).status, 405);
  assert.equal(calls, 0);
});
test('sin ADMIN_TOKEN falla cerrado', async () => { assert.equal((await worker.fetch(new Request('https://bot.example/run', {method:'POST'}), {})).status, 401); });
test('cola deduplica y conserva avisos si Telegram falla', async t => {
  const { bot, db } = instance({ TELEGRAM_TOKEN: 'fake', TELEGRAM_CHAT_ID: 'fake' });
  const state = await bot.load();
  assert.equal((await bot.enqueue(state, candidate())).accepted, true);
  assert.equal((await bot.enqueue(state, candidate())).accepted, false);
  t.mock.method(globalThis, 'fetch', async () => { throw Error('network'); });
  await bot.deliver(state);
  assert.equal(Object.keys(state.queue).length, 1); assert.equal(Object.keys(state.sent).length, 0);
  assert.equal(Object.keys(db.get('state-v2').queue).length, 1);
  assert.equal(Object.values(state.queue)[0].uncertain, true);
});
test('envío exitoso se persiste inmediatamente y sobrevive al reinicio', async t => {
  const { bot, db } = instance({ TELEGRAM_TOKEN: 'fake', TELEGRAM_CHAT_ID: 'fake' });
  const state = await bot.load(); await bot.enqueue(state, candidate());
  t.mock.method(globalThis, 'fetch', async () => Response.json({ok:true,result:{message_id:7}}));
  await bot.deliver(state);
  assert.equal(Object.keys(state.queue).length, 0); assert.equal(Object.keys(db.get('state-v2').sent).length, 1);
  const reloaded = await bot.load(); assert.equal((await bot.enqueue(reloaded, candidate())).accepted, false);
});
test('respuesta HTTP 200 con ok=false no cuenta como envío', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ok:false,error_code:400}));
  assert.equal((await sendTelegram({TELEGRAM_TOKEN:'fake',TELEGRAM_CHAT_ID:'fake'}, 'hola')).ok, false);
});
test('429 respeta retry_after de Telegram', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ok:false,error_code:429,parameters:{retry_after:120}}, {status:429}));
  assert.equal((await sendTelegram({TELEGRAM_TOKEN:'fake',TELEGRAM_CHAT_ID:'fake'}, 'hola')).retry, 120);
});
test('un ciclo no envía una ráfaga al mismo chat', async t => {
  const { bot } = instance({TELEGRAM_TOKEN:'fake',TELEGRAM_CHAT_ID:'fake'}); const state = await bot.load();
  await bot.enqueue(state, candidate()); await bot.enqueue(state, {...candidate(),text:'L-327: falla e interrupción en otro sector.'});
  let calls = 0; t.mock.method(globalThis, 'fetch', async () => {calls++;return Response.json({ok:true,result:{message_id:1}});});
  await bot.deliver(state); assert.equal(calls, 1); assert.equal(Object.keys(state.queue).length, 1);
});
test('estado compartido rechaza revisión concurrente', async () => {
  const { bot } = instance(); bot.busy = true;
  assert.equal((await bot.fetch(new Request('https://internal/run', {method:'POST'}))).status, 409);
});
test('diagnósticos siguen disponibles durante una revisión', async () => {
  const { bot } = instance(); bot.busy = true;
  assert.equal((await bot.fetch(new Request('https://internal/status'))).status,200);
  assert.equal((await bot.fetch(new Request('https://internal/media'))).status,200);
});
test('OCR no mezcla circuito de un título con texto de otra página', async () => {
  const { bot } = instance(); const state = await bot.load();
  state.media.a = {id:'a',url:'https://pbs.twimg.com/a.jpg',created:Date.now(),parent:{...candidate(),title:'Aviso L-327',text:undefined}};
  await bot.save(state);
  const request = new Request('https://internal/ingest',{method:'POST',body:JSON.stringify({id:'a',units:[{text:'L-328 corte de energía',confidence:95}]})});
  const response = await bot.fetch(request);
  assert.equal((await response.json()).accepted, false); assert.equal(Object.keys((await bot.load()).queue).length,0);
});
test('OCR con poca confianza queda pendiente para revisión', async () => {
  const { bot } = instance(); const state = await bot.load();
  state.media.a = {id:'a',created:Date.now(),parent:candidate()}; await bot.save(state);
  const response = await bot.fetch(new Request('https://internal/ingest',{method:'POST',body:JSON.stringify({id:'a',units:[{text:'L-327 corte de energía',confidence:15}]})}));
  const result = await response.json();
  assert.match(result.reason,/baja confianza/); assert.equal(result.needs_review,true); assert.equal((await bot.load()).media.a.done, undefined);
});
test('fuentes rotas no se presentan como sanas', async () => {
  const { bot } = instance(); const state = await bot.load();
  state.sources['x-cnd'] = {failures:3,error:'HTTP 403'};
  assert.match(bot.health(state).join(' '),/HTTP 403/);
});
test('campañas de salud sin aviso eléctrico no entran en la cola OCR', async () => {
  const {bot}=instance();const state=await bot.load();
  await bot.consider(state,{...candidate(),text:'Octubre Rosa: lucha contra el cáncer de mama.',media:[{url:'https://pbs.twimg.com/a.jpg',type:'image'}]});
  assert.equal(Object.keys(state.media).length,0);
  await bot.consider(state,{...candidate(),text:'Octubre Rosa: corte de energía en L-327.',media:[{url:'https://pbs.twimg.com/b.jpg',type:'image'}]});
  assert.equal(Object.keys(state.media).length,1);
});
test('fotos institucionales se retiran sin declararlas leídas por OCR', async () => {
  const {bot}=instance();const state=await bot.load();
  for (const [id,title] of [['award','Entrega de medalla y cooperación internacional'],['training','Prevención y seguridad laboral: capacitación']]) {
    state.media[id]={parent:{title},created:Date.now(),done:false,error:'OCR vacío'};
  }
  bot.prune(state);
  assert.equal(state.media.award.done,true);assert.equal(state.media.training.done,true);
  assert.match(state.media.award.result.reason,/institucional/);assert.equal(state.media.award.error,undefined);
});
test('un aviso de circuito en el cuerpo conserva su OCR pese al título institucional', async () => {
  const {bot}=instance();const state=await bot.load();
  await bot.consider(state,{...candidate(),title:'Capacitación',text:'Capacitación. '+ 'Información '.repeat(30)+' L-327 corte de energía.',media:[{url:'https://pbs.twimg.com/a.jpg',type:'image'}]});
  bot.prune(state);
  assert.equal(Object.values(state.media).length,1);assert.equal(Object.values(state.media)[0].done,false);
});
test('las advertencias técnicas no se envían al chat por defecto', async () => {
  const { bot } = instance(); const state = await bot.load();
  state.sources['enee-1'] = {failures:3,error:'HTTP 503'};
  state.queue['health-old']={candidate:{system:'Advertencia técnica'},created:Date.now(),attempts:0,next:0};
  bot.collect=async()=>{};
  const result=await bot.run(state);
  assert.equal(result.diagnosticNotifications,false);
  assert.match(result.issues.join(' '),/503/);
  assert.equal(Object.keys(state.queue).length,0);
});
test('una página OCR ilegible no impide procesar las otras páginas', async () => {
  const { bot } = instance(); const state = await bot.load();
  state.media.a = {id:'a',created:Date.now(),parent:candidate()}; await bot.save(state);
  const response = await bot.fetch(new Request('https://internal/ingest',{method:'POST',body:JSON.stringify({id:'a',units:[{text:'',confidence:0},{text:'L-327: falla e interrupción de energía.',confidence:90}]})}));
  const result = await response.json();
  assert.equal(result.accepted,true); assert.match(result.reason,/OCR parcial/);
  const saved = await bot.load();assert.equal(Object.keys(saved.queue).length,1);assert.equal(saved.media.a.done,false);
});
test('lector limita bytes antes de parsear contenido externo', async () => {
  await assert.rejects(readText(new Response('demasiado grande'), 5), /grande/);
});
test('recolección completa guarda foto de X, envía una vez y conserva la deduplicación', async t => {
  const { bot } = instance({TELEGRAM_TOKEN:'fake',TELEGRAM_CHAT_ID:'fake'});
  let sends = 0;
  const tweet = {rest_id:'2110932649590038780',result:{core:{user_results:{result:{core:{screen_name:'CNDHonduras'}}}},details:{full_text:'L-327: interrupción por falla de energía.',created_at_ms:Date.now()},media_entities2:[{type:'photo',media_url_https:'https://pbs.twimg.com/media/notice.jpg'}]}};
  const x = `<script>stream({value:${JSON.stringify(JSON.stringify({data:tweet}))}})</script>`;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('api.telegram.org')) {sends++;return Response.json({ok:true,result:{message_id:10}});}
    if (url.includes('x.com/CNDHonduras')) return new Response(x);
    if (url.includes('x.com/eneehnoficial')) return new Response('<html>Sin datos</html>');
    assert.equal(url.includes('news.google.com'),false,'Google News no debe consultarse');
    if (url.includes('/listar/')) return new Response('<a href="/es/mantenimiento-NT123">Aviso de mantenimiento programado</a>');
    return new Response('<main><p>Mantenimiento fuera del circuito L-328</p></main>');
  });
  const state = await bot.load(); await bot.run(state);
  assert.equal(sends,1); assert.equal(Object.keys(state.sent).length,1); assert.equal(Object.keys(state.media).length,1);
  assert.equal(state.sources['x-enee'].failures,1);
  // Simulate the next scheduled cycle while keeping the publication unchanged.
  state.lastRun=0;state.telegram.next=0;for(const s of Object.values(state.sources))s.checked=0;
  await bot.run(state);assert.equal(sends,1);
});
