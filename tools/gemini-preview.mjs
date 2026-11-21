import { evaluateGemini } from '../worker/gemini.js';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { classify } from '../worker/core.js';

// Independent evaluation path: this command has no Telegram integration.
const [text, imagePath] = process.argv.slice(2);
if (!text || !process.env.GEMINI_API_KEY) throw Error('Se requieren texto y GEMINI_API_KEY');
const parts = [{ text }];
if (imagePath) {
  const mimeType = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' }[extname(imagePath).toLowerCase()];
  if (!mimeType) throw Error('Se requiere un afiche JPEG o PNG');
  parts.push({ inlineData: { mimeType, data: (await readFile(imagePath)).toString('base64') } });
}
const start = Date.now();
const result = await evaluateGemini(parts, text, process.env.GEMINI_API_KEY);
console.log(JSON.stringify({ anterior: classify({text, published: new Date().toISOString()}).relevant, ...result, ms: Date.now() - start }));
