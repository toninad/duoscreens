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

/** Orientation used for export. MVP only lays out portrait. TODO: landscape templates. */
export const EXPORT_ORIENTATION = 'portrait';

/**
 * Translate endpoint. Leave empty to disable the "Translate" button.
 * Point it at the Supabase edge function once deployed, e.g.
 *   https://<project-ref>.supabase.co/functions/v1/translate
 * Contract: POST { targetLanguage, sourceLanguage, texts: string[] }
 *        -> 200 { translations: string[] }  (same order/length as texts)
 */
// (globalThis.DSS_TRANSLATE_ENDPOINT lets you override it without editing, e.g. in tests.)
export const TRANSLATE_ENDPOINT = globalThis.DSS_TRANSLATE_ENDPOINT || '';

/** Optional headers for the translate endpoint (e.g. Supabase anon key). Never put secret keys here. */
export const TRANSLATE_HEADERS = {
  // 'Authorization': 'Bearer <SUPABASE_ANON_KEY>',
};

/**
 * Licensing (Lemon Squeezy). Disabled until a product exists.
 * When enabled, the app POSTs to the public License API:
 *   POST https://api.lemonsqueezy.com/v1/licenses/validate  (form fields: license_key, [instance_id])
 * and checks `valid === true` plus that meta.store_id / meta.product_id match below.
 */
export const LICENSE = {
  lemonSqueezyEnabled: false,
  validateUrl: 'https://api.lemonsqueezy.com/v1/licenses/validate',
  storeId: null,       // TODO: your Lemon Squeezy store id (number)
  productIds: [],      // TODO: product ids that unlock (e.g. per-app €19, lifetime €49)
  // Local development key so the unlocked flow can be tested before Lemon Squeezy is set up.
  devKey: 'DUO-DEV-UNLOCK',
  buyUrl: '#',         // TODO: Lemon Squeezy checkout link
};

export const WATERMARK_TEXT = 'Made with Duo Screenshot Studio';

export const LANGUAGES = [
  ['en', 'English'], ['de', 'German'], ['fr', 'French'], ['es', 'Spanish'], ['it', 'Italian'],
  ['pt-BR', 'Portuguese (Brazil)'], ['nl', 'Dutch'], ['hr', 'Croatian'], ['pl', 'Polish'],
  ['sv', 'Swedish'], ['ja', 'Japanese'], ['ko', 'Korean'], ['zh-Hans', 'Chinese (Simplified)'],
];
