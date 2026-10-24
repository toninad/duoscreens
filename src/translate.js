import { TRANSLATE_ENDPOINT, TRANSLATE_HEADERS } from './config.js';

export function translateConfigured() { return !!TRANSLATE_ENDPOINT; }

/** @returns {Promise<string[]>} translations, same order as texts */
export async function translateTexts(texts, targetLanguage, sourceLanguage = 'en') {
  if (!TRANSLATE_ENDPOINT) throw new Error('Set TRANSLATE_ENDPOINT in src/config.js (see README).');
  const res = await fetch(TRANSLATE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...TRANSLATE_HEADERS },
    body: JSON.stringify({ texts, targetLanguage, sourceLanguage }),
  });
  if (!res.ok) throw new Error(`Translate failed: HTTP ${res.status} ${await res.text()}`);
  const data = await res.json();
  if (!Array.isArray(data.translations) || data.translations.length !== texts.length) {
    throw new Error('Translate endpoint returned an unexpected shape.');
  }
  return data.translations;
}
