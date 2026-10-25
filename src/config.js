// HearHere Studio — configuration.
// Everything the app needs to know about the outside world lives here.

/**
 * Server endpoints (Cloudflare Pages Functions in functions/api/). Same origin as the app.
 * globalThis.DSS_API_BASE lets tests or a local setup point them elsewhere.
 */
const API_BASE = globalThis.DSS_API_BASE || '';
export const LICENSE_ENDPOINT = `${API_BASE}/api/license`;
export const TRANSLATE_ENDPOINT = `${API_BASE}/api/translate`;
export const CLAIM_ENDPOINT = `${API_BASE}/api/claim`;
export const SYNC_ENDPOINT = `${API_BASE}/api/sync`;

/** Pro is a one-time purchase on Polar, which emails a license key after checkout. */
export const PRO = {
  price: '€15.99',
  // Polar checkout link for the Pro product; returns to /?checkout=success after payment.
  checkoutUrl: 'https://buy.polar.sh/polar_cl_XygCp6D91TvJ2TL3WeErfvJRQ1XhWAPxMtu9o1VC2AO',
};

export const WATERMARK_TEXT = 'Made with HearHere Studio';

// App Store Connect localizations. Keep in sync with functions/_lib/languages.js.
export const LANGUAGES = [
  ['en', 'English'], ['en-GB', 'English (UK)'], ['en-AU', 'English (Australia)'], ['en-CA', 'English (Canada)'],
  ['de', 'German'], ['fr', 'French'], ['fr-CA', 'French (Canada)'], ['es', 'Spanish (Spain)'], ['es-MX', 'Spanish (Mexico)'],
  ['it', 'Italian'], ['pt-BR', 'Portuguese (Brazil)'], ['pt-PT', 'Portuguese (Portugal)'], ['nl', 'Dutch'],
  ['ja', 'Japanese'], ['ko', 'Korean'], ['zh-Hans', 'Chinese (Simplified)'], ['zh-Hant', 'Chinese (Traditional)'],
  ['sv', 'Swedish'], ['da', 'Danish'], ['no', 'Norwegian'], ['fi', 'Finnish'], ['pl', 'Polish'], ['cs', 'Czech'],
  ['sk', 'Slovak'], ['hu', 'Hungarian'], ['ro', 'Romanian'], ['hr', 'Croatian'], ['el', 'Greek'], ['tr', 'Turkish'],
  ['ru', 'Russian'], ['uk', 'Ukrainian'], ['ar', 'Arabic'], ['he', 'Hebrew'], ['hi', 'Hindi'], ['th', 'Thai'],
  ['vi', 'Vietnamese'], ['id', 'Indonesian'], ['ms', 'Malay'], ['ca', 'Catalan'],
];
