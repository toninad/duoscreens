// Shared helpers for the Pages Functions: JSON responses, origin check, hashing, rate limits.

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

/**
 * Only accept calls from the app itself: the configured production origin, or the origin the
 * request was made to (covers *.pages.dev preview deployments).
 */
export function originAllowed(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return false;
  if (env.ALLOWED_ORIGIN && origin === env.ALLOWED_ORIGIN) return true;
  return origin === new URL(request.url).origin;
}

/** License keys are never stored in plain text: only their SHA-256. */
export async function sha256(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Fixed-window rate limit per client IP, stored in D1. Returns true when the call is allowed.
 * @param {string} route   short name, e.g. 'license'
 * @param {number} perMinute
 */
export async function rateLimit(env, request, route, perMinute) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const now = Date.now();
  const minute = Math.floor(now / 60_000);
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (bucket, count, expires_at) VALUES (?1, 1, ?2)
     ON CONFLICT(bucket) DO UPDATE SET count = count + 1
     RETURNING count`,
  ).bind(`${route}:${ip}:${minute}`, (minute + 2) * 60_000).first();
  if (Math.random() < 0.02) {
    await env.DB.prepare('DELETE FROM rate_limits WHERE expires_at < ?1').bind(now).run();
  }
  return (row?.count ?? 0) <= perMinute;
}

export async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}
