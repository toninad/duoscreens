// POST /api/translate
//   { key, device, sourceLanguage, targetLanguages: string[], texts: string[] }
//   -> 200 { translations: { [lang]: string[] }, usage: { runs, limit } }
// Pro only: the license is checked (cached for a day), then a monthly per-key allowance where one
// run is all texts into one language. Only text is sent to Claude, never images.

import Anthropic from '@anthropic-ai/sdk';
import { json, originAllowed, rateLimit, readJson } from '../_lib/http.js';
import { verifyLicense, LicenseError } from '../_lib/license.js';
import { LANGUAGES } from '../_lib/languages.js';

const MAX_TEXTS = 40;
const MAX_CHARS = 300;
const MAX_TARGETS = 12;

const SCHEMA = {
  type: 'object',
  properties: { translations: { type: 'array', items: { type: 'string' } } },
  required: ['translations'],
  additionalProperties: false,
};

function systemPrompt(source, target) {
  return `You localize short App Store screenshot marketing copy from ${source} to ${target}.
Write each string the way a native copywriter in that market would: natural, concise and confident, about the same length as the original, so it still fits on the screenshot. Keep product and brand names unchanged (for example iPhone Duo, App Store). Use the market's normal capitalization and punctuation. Don't add quotes, emoji or explanations. An empty string stays empty.
Return the translations in the same order as the input, one per input string.`;
}

async function translateOne(client, model, texts, source, target) {
  const response = await client.beta.messages.create({
    model,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',   // if the model declines, Anthropic retries on its recommended fallback model
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    system: systemPrompt(source, target),
    messages: [{ role: 'user', content: JSON.stringify(texts) }],
  });
  if (response.stop_reason === 'refusal') throw new Error(`Translation to ${target} was declined.`);
  if (response.stop_reason === 'max_tokens') throw new Error(`Translation to ${target} was cut off.`);
  const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const out = JSON.parse(text).translations;
  if (!Array.isArray(out) || out.length !== texts.length) throw new Error(`Translation to ${target} came back incomplete.`);
  return out.map(String);
}

export async function onRequestPost({ request, env }) {
  if (!originAllowed(request, env)) return json({ error: 'Forbidden' }, 403);
  if (!(await rateLimit(env, request, 'translate', 10))) return json({ error: 'Too many requests. Wait a minute.' }, 429);
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'Translation is not configured on the server yet.' }, 503);

  const body = await readJson(request);
  if (!body) return json({ error: 'Invalid request.' }, 400);
  const { texts, targetLanguages, sourceLanguage = 'en' } = body;
  if (!Array.isArray(texts) || !texts.every(t => typeof t === 'string')) return json({ error: 'texts must be a list of strings.' }, 400);
  if (texts.length > MAX_TEXTS || texts.some(t => t.length > MAX_CHARS)) return json({ error: 'Too many or too long texts.' }, 413);
  if (!Array.isArray(targetLanguages) || !targetLanguages.length || targetLanguages.length > MAX_TARGETS
      || !targetLanguages.every(l => LANGUAGES[l]) || !LANGUAGES[sourceLanguage]) {
    return json({ error: `Pick 1–${MAX_TARGETS} supported languages.` }, 400);
  }

  let keyHash;
  try {
    ({ keyHash } = await verifyLicense(env, body.key, body.device));
  } catch (e) {
    if (e instanceof LicenseError) return json({ error: e.message, pro: false }, e.status);
    throw e;
  }

  const month = new Date().toISOString().slice(0, 7);
  const limit = Number(env.TRANSLATION_RUNS_PER_MONTH || 100);
  const used = (await env.DB.prepare('SELECT runs FROM translation_usage WHERE key_hash = ?1 AND month = ?2').bind(keyHash, month).first())?.runs ?? 0;
  if (used + targetLanguages.length > limit) {
    return json({ error: `Monthly translation allowance reached (${used} of ${limit} languages used). It resets on the 1st.`, usage: { runs: used, limit } }, 429);
  }

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const model = env.ANTHROPIC_MODEL || 'claude-opus-5-5';
  const source = LANGUAGES[sourceLanguage];
  const results = await Promise.allSettled(targetLanguages.map(l => translateOne(client, model, texts, source, LANGUAGES[l])));

  const translations = {};
  const failed = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') translations[targetLanguages[i]] = r.value;
    else { failed.push(targetLanguages[i]); console.error(targetLanguages[i], r.reason); }
  });
  const runs = Object.keys(translations).length;
  if (runs) {
    await env.DB.prepare(
      `INSERT INTO translation_usage (key_hash, month, runs) VALUES (?1, ?2, ?3)
       ON CONFLICT(key_hash, month) DO UPDATE SET runs = runs + ?3`,
    ).bind(keyHash, month, runs).run();
  }
  if (!runs) {
    const err = results[0].reason;
    const status = err instanceof Anthropic.RateLimitError ? 429 : 502;
    return json({ error: 'Translation failed. Try again in a moment.' }, status);
  }
  return json({ translations, failed, usage: { runs: used + runs, limit } });
}
