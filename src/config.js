// Duo Screenshot Studio — configuration.
// Everything the app needs to know about the outside world lives here.

/**
 * iPhone Duo App Store screenshot sizes (pixels).
 *
 * VERIFIED on 2026-10-24 against Apple's App Store Connect Help page
 * "Screenshot specifications" (iPhone > iPhone Duo):
 *   https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/
 *   - Outer display: 1398 × 2034 (portrait), 2034 × 1398 (landscape)
 *   - Inner display: 2007 × 2853 (portrait), 2853 × 2007 (landscape)
 *   - PNG/JPEG, 1–10 per size, no alpha channel / transparency.
 * Note: the inner screenshot size is NOT the inner panel resolution (1878 × 2670);
 * use the size Apple lists in the spec. See README for all sources.
 */
export const DUO_SIZES = Object.freeze({
  inner: Object.freeze({
    label: 'Inner display (unfolded)',
    portrait: Object.freeze({ width: 2007, height: 2853 }),
    landscape: Object.freeze({ width: 2853, height: 2007 }),
  }),
  outer: Object.freeze({
    label: 'Outer display (cover)',
    portrait: Object.freeze({ width: 1398, height: 2034 }),
    landscape: Object.freeze({ width: 2034, height: 1398 }),
  }),
});


/**
 * Server endpoints (Cloudflare Pages Functions in functions/api/). Same origin as the app.
 * globalThis.DSS_API_BASE lets tests or a local setup point them elsewhere.
 */
const API_BASE = globalThis.DSS_API_BASE || '';
export const LICENSE_ENDPOINT = `${API_BASE}/api/license`;
export const TRANSLATE_ENDPOINT = `${API_BASE}/api/translate`;
export const CLAIM_ENDPOINT = `${API_BASE}/api/claim`;

/** Pro is a one-time purchase on Polar, which emails a license key after checkout. */
export const PRO = {
  price: '€15.99',
  // Polar checkout link for the Pro product; returns to /?checkout=success after payment.
  checkoutUrl: 'https://buy.polar.sh/polar_cl_XygCp6D91TvJ2TL3WeErfvJRQ1XhWAPxMtu9o1VC2AO',
};

export const WATERMARK_TEXT = 'Made with Duo Screenshot Studio';

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
