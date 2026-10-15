/**
 * NULL pre-launch waitlist API (Cloudflare Worker).
 * Public endpoint: POST /api/waitlist
 * Storage: D1 EU-jurisdiction database, binding DB.
 * This Worker is intentionally separate from the null-pouches website Worker.
 */
const ALLOWED_ORIGINS = new Set([
  "https://nullpouches.com",
  "https://www.nullpouches.com"
]);
const CONSENT_VERSION = "null-waitlist-2026-10-15-v1";
const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(data, status, origin) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
    "Vary": "Origin"
  };
  if (ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type";
    headers["Access-Control-Max-Age"] = "600";
  }
  return new Response(JSON.stringify(data), { status, headers });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    if (pathname === "/health" && request.method === "GET") {
      return json({ status: env.DB ? "ok" : "unavailable" }, env.DB ? 200 : 503, origin);
    }
    if (pathname !== "/api/waitlist") return json({ error: "Not found" }, 404, origin);
    if (!ALLOWED_ORIGINS.has(origin)) return json({ error: "Origin not allowed" }, 403, origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: json({}, 200, origin).headers });
    }
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, origin);
    if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
      return json({ error: "Expected JSON" }, 415, origin);
    }
    if (Number(request.headers.get("Content-Length") || 0) > 2048) {
      return json({ error: "Request too large" }, 413, origin);
    }

    let payload;
    try {
      const body = await request.text();
      if (body.length > 2048) return json({ error: "Request too large" }, 413, origin);
      payload = JSON.parse(body);
    } catch {
      return json({ error: "Invalid JSON" }, 400, origin);
    }

    // Hidden honeypot: a filled field is a likely automated submission.
    if (payload?.website) return json({ success: true }, 200, origin);

    const email = typeof payload?.email === "string" ? payload.email.trim().toLowerCase() : "";
    if (email.length < 5 || email.length > 254 || !EMAIL_FORMAT.test(email)) {
      return json({ error: "Please enter a valid email address." }, 400, origin);
    }
    if (payload.consent !== true) {
      return json({ error: "Please agree to receive launch emails." }, 400, origin);
    }
    if (!env.DB) return json({ error: "Waitlist temporarily unavailable." }, 503, origin);

    const source = payload.source === "menu" ? "menu" : "hero";
    try {
      // Idempotent registration. No public endpoint exposes saved addresses.
      await env.DB.prepare(
        "INSERT OR IGNORE INTO waitlist (email, consent_at, consent_version, source) VALUES (?, ?, ?, ?)"
      ).bind(email, new Date().toISOString(), CONSENT_VERSION, source).run();
      return json({ success: true, message: "You're on the NULL waitlist." }, 200, origin);
    } catch {
      return json({ error: "Could not save your email. Please try again." }, 503, origin);
    }
  }
};
