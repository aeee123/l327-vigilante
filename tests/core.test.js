import test from 'node:test';
import assert from 'node:assert/strict';
import { dates, classify, clean, articleLinks, article, official, rss, tweets, message, phase, safeUrl } from '../worker/core.js';
const NOW = Date.parse('2026-10-20T18:00:00Z');
const c = (text, published = '2026-10-20T16:00:00Z') => ({ text, title: 'Aviso', url: 'https://www.eneeutcd.hn/es/aviso-NT1', published, source: 'ENEE' });
test('fecha con día de semana conserva el día explícito', () => {
  assert.deepEqual(dates('martes 20 de octubre de 2026', NOW), [{ iso: '2026-10-20', days: 0 }]);
  assert.deepEqual(dates('martes 6 de octubre', NOW), [{ iso: '2026-10-06', days: -14 }]);
});
test('aviso pasado no se mueve al siguiente año', () => {
  assert.equal(dates('19 de octubre de 2026', NOW)[0].days, -1);
  assert.equal(classify(c('L-327 corte de energía 19 de octubre de 2026'), NOW).relevant, false);
});
test('rollover acotado a diciembre/enero y año publicado', () => {
  assert.equal(dates('2 de enero', Date.parse('2026-12-30T18:00:00Z'))[0].iso, '2027-01-02');
  assert.equal(dates('30 de diciembre', Date.parse('2027-01-02T18:00:00Z'))[0].iso, '2026-12-30');
  assert.equal(dates('20 de octubre', NOW, Date.parse('2025-10-19'))[0].iso, '2025-10-20');
  assert.equal(dates('2 de enero', Date.parse('2026-12-30T18:00:00Z'), Date.parse('2026-12-29T18:00:00Z'))[0].iso, '2027-01-02');
});
test('fechas imposibles no se normalizan silenciosamente', () => { assert.deepEqual(dates('31 de febrero de 2026', NOW), []); });
test('fechas ISO y día/mes/año', () => {
  assert.equal(dates('2026-10-21', NOW)[0].days, 1);
  assert.equal(dates('21/10/2026', NOW)[0].days, 1);
});
test('intervalo mensual conserva año final explícito', () => {
  assert.deepEqual(dates('del 20 de octubre al 22 de octubre de 2025', NOW).map(x => x.iso), ['2025-10-20', '2025-10-22']);
});
test('coincidencias estrictas del circuito', () => {
  for (const circuit of ['L-327', 'L327', 'SIS-L327', 'SIS - L - 327', 'línea 327']) assert.equal(classify(c(`${circuit} mantenimiento programado 21 de octubre de 2026`), NOW).relevant, true, circuit);
  for (const area of ['La Ceiba', 'Atlántida', 'Toronjal', 'L-3270', 'L-328', 'San Isidro']) assert.equal(classify(c(`${area} corte de energía 21 de octubre de 2026`), NOW).relevant, false, area);
});
test('una palabra incidental de facturación no elimina un aviso real', () => { assert.equal(classify(c('L-327 corte de energía 21 de octubre de 2026. Consultas de factura en oficina.'), NOW).relevant, true); });
test('no se anuncian falsos apagones por horario de hoy', () => {
  const candidate = c('L-327 mantenimiento programado 20 de octubre de 2026 de 18:00 a 20:00');
  const txt = message(candidate, classify(candidate, NOW));
  assert.match(txt, /CORTE PROGRAMADO/); assert.doesNotMatch(txt, /AHORA.*SIN LUZ/);
});
test('cancelaciones y restablecimiento tienen estados propios', () => {
  assert.equal(phase('Mantenimiento cancelado L-327'), 'CANCELACIÓN');
  assert.equal(phase('Servicio restablecido L327 tras falla'), 'RESTABLECIMIENTO REPORTADO');
});
test('varios circuitos no se presentan como un único evento confirmado', () => {
  assert.equal(classify(c('L-327 y L-328 corte de energía 21 de octubre de 2026'), NOW).multiple, true);
});
test('material antiguo y sin fechas no se alerta', () => {
  assert.equal(classify(c('L-327 sin luz', null), NOW).relevant, false);
  assert.equal(classify(c('L-327 sin luz', '2026-10-10T12:00:00Z'), NOW).relevant, false);
  assert.equal(classify(c('L-327 sin luz', '2026-10-18T12:00:00Z'), NOW).relevant, false);
  assert.equal(classify(c('L-327 sin luz', 'no-fecha'), NOW).relevant, false);
});
test('no se confunde un dominio falso con fuente oficial', () => {
  assert.equal(official('https://enee.hn.atacante.com/'), false);
  assert.equal(official('https://example.org/enee.hn'), false);
  assert.equal(official('https://cnd.enee.hn/'), true);
  assert.equal(safeUrl('javascript:alert(1)', 'https://enee.hn'), null);
  assert.equal(safeUrl('https://user:pass@enee.hn'), null);
});
test('resolución de URL relativa conserva directorio', () => { assert.equal(safeUrl('aviso-NT1', 'https://enee.hn/es/'), 'https://enee.hn/es/aviso-NT1'); });
test('entidades unicode y contenido sin scripts', () => { assert.equal(clean('<script>no</script><p>&#x1F4A1; energ&iacute;a &amp; luz</p>'), '💡 energía & luz'); });
test('título genérico conduce al cuerpo completo del artículo', () => {
  const links = articleLinks('<a href="/es/mantenimiento-NT123">Aviso de mantenimiento programado</a>', 'https://www.eneeutcd.hn/es/');
  assert.equal(links.length, 1);
  const parsed = article('<title>Aviso</title><main><h2>Mantenimiento</h2><p>L-327 corte de energía 21 de octubre de 2026</p></main><footer>Otras zonas</footer>', links[0].url);
  assert.equal(classify(parsed, NOW).relevant, true);
});
test('captura imágenes, PDF y enlace acortado sin mezclar el pie de página', () => {
  const a = article('<main><p>Aviso</p><img src="https://s3.pagegear.co/aviso.png"><a href="https://goo.su/aJfeL8">Boletín</a><a href="/x.pdf">PDF</a></main><footer><img src="/logo.png"></footer>', 'https://www.eneeutcd.hn/es/a-NT1');
  assert.equal(a.media.length, 3);
});
test('RSS conserva la fecha de publicación y decodifica CDATA', () => {
  const a = rss('<rss><channel><item><title><![CDATA[L-327 corte de energía]]></title><description><![CDATA[<p>Aviso</p>]]></description><link>https://example.org/a</link><pubDate>Tue, 20 Oct 2026 12:00:00 GMT</pubDate></item></channel></rss>');
  assert.equal(a.length, 1); assert.match(a[0].text, /Aviso/); assert.equal(classify(a[0], NOW).relevant, true);
  assert.equal(rss('<rss><item><title>L327</title><link>https://example.org</link></item></rss>').length, 0);
});
test('X asocia texto, ID, autor y fotos del mismo objeto sin truncar comillas', () => {
  const text = 'L-327: falla en el sector "Toronjal". Servicio restablecido.';
  const tweet = { rest_id: '2110932649590038780', result: { __typename: 'Tweet', core: { user_results: { result: { core: { screen_name: 'CNDHonduras' } } } }, details: { full_text: text, created_at_ms: NOW }, media_entities2: [{type:'photo',media_url_https:'https://pbs.twimg.com/media/a.jpg'}] } };
  const payload = JSON.stringify({ data: { tweet_results: tweet } });
  const html = `<script>stream({value:${JSON.stringify(payload)}})</script>`;
  const parsed = tweets(html, 'CNDHonduras');
  assert.equal(parsed.length, 1); assert.equal(parsed[0].text, text); assert.match(parsed[0].url, /2110932649590038780$/); assert.equal(parsed[0].media.length, 1);
  assert.equal(tweets(html, 'eneehnoficial').length, 0);
});
test('X vacío y scripts no ejecutables', () => {
  assert.equal(tweets('<script>throw new Error("ejecutado")</script>', 'CNDHonduras').length, 0);
});
