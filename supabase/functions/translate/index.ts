// Supabase Edge Function: translate App Store screenshot headlines with Claude.
// NOT DEPLOYED. Deploy with:
//   supabase secrets set ANTHROPIC_API_KEY=...        (never commit the key)
//   supabase functions deploy translate
// Then set TRANSLATE_ENDPOINT in src/config.js to https://<project-ref>.supabase.co/functions/v1/translate
// and put the project's *anon* key in TRANSLATE_HEADERS (Authorization: Bearer <anon key>).
//
// Contract: POST { texts: string[], targetLanguage: string, sourceLanguage?: string }
//        -> 200 { translations: string[] }  (same length and order as texts)

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
// Model id is configurable so it can be updated without a code change.
const MODEL = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-4-5";
const MAX_TEXTS = 40;
const MAX_CHARS = 300;

// TODO: restrict to your production origin (e.g. https://duo.hearhere.media) before launch.
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
const cors = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "ANTHROPIC_API_KEY is not set" }, 500);

  let payload: { texts?: unknown; targetLanguage?: unknown; sourceLanguage?: unknown };
  try { payload = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const { texts, targetLanguage, sourceLanguage = "en" } = payload;
  if (!Array.isArray(texts) || !texts.every((t) => typeof t === "string")) return json({ error: "texts must be string[]" }, 400);
  if (typeof targetLanguage !== "string" || !/^[a-zA-Z-]{2,10}$/.test(targetLanguage)) return json({ error: "invalid targetLanguage" }, 400);
  if (texts.length > MAX_TEXTS || texts.some((t) => t.length > MAX_CHARS)) return json({ error: "too many or too long texts" }, 413);
  if (texts.length === 0) return json({ translations: [] });

  // TODO: rate-limit per IP / require a license key so the endpoint can't be abused for free translation.

  const system =
    "You localize short App Store screenshot marketing copy. Translate each string from " +
    `${sourceLanguage} to the language with BCP-47 code "${targetLanguage}". Keep it punchy and natural for ` +
    "App Store marketing in that locale, similar length, keep product names (e.g. iPhone Duo) unchanged, " +
    "do not add quotes or emoji. Empty strings stay empty. Reply with ONLY a JSON array of strings, " +
    "same length and order as the input.";

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2048,
      system,
      messages: [{ role: "user", content: JSON.stringify(texts) }],
    }),
  });
  if (!res.ok) return json({ error: `Anthropic API error ${res.status}`, detail: await res.text() }, 502);

  const data = await res.json();
  const text: string = (data.content ?? []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("");
  let translations: unknown;
  try {
    translations = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1));
  } catch {
    return json({ error: "Model did not return JSON", raw: text }, 502);
  }
  if (!Array.isArray(translations) || translations.length !== texts.length) {
    return json({ error: "Model returned the wrong number of strings", raw: text }, 502);
  }
  return json({ translations: translations.map(String) });
});
