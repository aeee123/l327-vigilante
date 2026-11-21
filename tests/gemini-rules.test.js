import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDecision } from '../tools/gemini-rules.mjs';

for (const [text, quote, expected] of [
  ['El Toronjal II estará sin luz.', 'El Toronjal II estará sin luz.', 'alertar'],
  ['Falla en SIS-L327.', 'Falla en SIS-L327.', 'alertar'],
  ['El Toronjal I estará sin luz.', 'El Toronjal I estará sin luz.', 'revisar'],
  ['No se suspenderá el servicio del L-327.', 'se suspenderá el servicio del L-327', 'revisar'],
  ['L-328 sin energía. L-327 opera normalmente.', 'L-327 opera normalmente.', 'revisar'],
  ['Construimos un poste en L-327.', 'Construimos un poste en L-327.', 'revisar'],
  ['L-327 sin luz. Se cancela el aviso anterior.', 'L-327 sin luz.', 'revisar'],
  ['Mira el afiche adjunto.', 'L-327 sin energía.', 'revisar'],
]) {
  test(text, () => assert.equal(validateDecision({ decision: 'alertar', evidencia: quote }, text).decision, expected));
}
