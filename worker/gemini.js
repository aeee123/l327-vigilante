import { instructions, examples, validateDecision } from '../tools/gemini-rules.mjs';
export async function evaluateGemini(parts, text, apiKey) {

const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent', {
  method: 'POST', signal: AbortSignal.timeout(30000),
  headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
  body: JSON.stringify({
    systemInstruction: { parts: [{ text: instructions + examples }] },
    contents: [{ role: 'user', parts }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: {
      type: 'OBJECT', properties: {
        decision: { type: 'STRING', enum: ['alertar', 'descartar', 'revisar', 'actualizar'] },
        evidencia: { type: 'STRING' },
      }, required: ['decision', 'evidencia'],
    } },
  }),
});
if (!response.ok) throw Error('Gemini HTTP ' + response.status);
const data = await response.json();
const result = JSON.parse(data.candidates[0].content.parts.filter(p => !p.thought).map(p => p.text).join(''));
return { ...validateDecision(result, text), tokensEntrada: data.usageMetadata?.promptTokenCount };
}
