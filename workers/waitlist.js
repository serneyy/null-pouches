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


const META_PIXEL_ID = "1782758953034642";
const MARKETING_CONSENT_VERSION = "meta-ads-2026-10-15-v1";

async function sha256Hex(value) {
  const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, "0")).join("");
}

function approvedPageUrl(urlValue, origin) {
  try {
    const url = new URL(urlValue);
    if (url.protocol === "https:" && url.origin === origin && url.href.length < 1024)
      return url.origin + url.pathname + url.search;
  } catch {}
  return origin + "/";
}

function approvedMetaCookie(value) {
  if (typeof value !== "string" || value.length > 250) return null;
  return /^fb[.]1[.][0-9]{8,16}[.][A-Za-z0-9._-]+$/.test(value) ? value : null;
}

async function sendMetaLead(env, request, email, eventId, origin, payload) {
  if (!env.META_CAPI_ACCESS_TOKEN) return;
  const userData = { em: [await sha256Hex(email)] };
  const ip = request.headers.get("CF-Connecting-IP");
  const ua = request.headers.get("User-Agent");
  if (ip) userData.client_ip_address = ip;
  if (ua) userData.client_user_agent = ua.slice(0, 500);
  const fbp = approvedMetaCookie(payload.fbp), fbc = approvedMetaCookie(payload.fbc);
  if (fbp) userData.fbp = fbp;
  if (fbc) userData.fbc = fbc;
  try {
    const res = await fetch("https://graph.facebook.com/v26.0/" + META_PIXEL_ID + "/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + env.META_CAPI_ACCESS_TOKEN
      },
      body: JSON.stringify({data:[{
        event_name: "Lead",
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId,
        action_source: "website",
        event_source_url: approvedPageUrl(payload.pageUrl, origin),
        user_data: userData,
        custom_data: { content_name: "NULL Waitlist" }
      }]}),
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) console.warn("NULL CAPI delivery failed: HTTP " + res.status);
  } catch {
    console.warn("NULL CAPI delivery failed: network error");
  }
}

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
  async fetch(request, env, ctx) {
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

    // Require Cloudflare Turnstile siteverify before any database write.
    // The Turnstile secret is a secret_text binding, never shipped to the browser.
    const turnstileToken = payload?.turnstileToken;
    const expectedHostnames = new Set(
      (env.TURNSTILE_HOSTNAMES || "").split(",").map(host => host.trim()).filter(Boolean)
    );
    if (
      typeof turnstileToken !== "string" ||
      turnstileToken.length === 0 ||
      turnstileToken.length > 2048
    ) {
      return json({ error: "Complete the security check and try again." }, 403, origin);
    }
    if (!env.TURNSTILE_SECRET || expectedHostnames.size === 0) {
      return json({ error: "Waitlist temporarily unavailable." }, 503, origin);
    }
    let verification;
    try {
      const params = new URLSearchParams({
        secret: env.TURNSTILE_SECRET,
        response: turnstileToken
      });
      const ip = request.headers.get("CF-Connecting-IP");
      if (ip) params.set("remoteip", ip);
      const check = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params,
        signal: AbortSignal.timeout(10000)
      });
      if (!check.ok) throw new Error("Turnstile service unavailable");
      verification = await check.json();
    } catch {
      return json({ error: "Security verification unavailable. Please try again." }, 503, origin);
    }
    if (
      verification.success !== true ||
      verification.action !== "signup" ||
      !expectedHostnames.has(verification.hostname)
    ) {
      return json({ error: "Security verification failed. Please try again." }, 403, origin);
    }

    const source = payload.source === "menu" ? "menu" : "hero";
    const marketingConsent = payload.marketingConsent === true;
    const now = new Date().toISOString();
    try {
      // The UNIQUE email index and INSERT OR IGNORE prevent duplicate signups.
      const inserted = await env.DB.prepare(
        "INSERT OR IGNORE INTO waitlist (email, consent_at, consent_version, source, marketing_consent_at, marketing_consent_version) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(
        email, now, CONSENT_VERSION, source,
        marketingConsent ? now : null,
        marketingConsent ? MARKETING_CONSENT_VERSION : null
      ).run();
      const isNew = inserted.meta?.changes === 1;
      let leadEventId = null;
      if (isNew && marketingConsent) {
        leadEventId = "null_lead_" + crypto.randomUUID();
        ctx.waitUntil(sendMetaLead(env, request, email, leadEventId, origin, payload));
      }
      return json({ success: true, isNew, leadEventId,
        message: "You're on the NULL waitlist." }, 200, origin);
    } catch {
      return json({ error: "Could not save your email. Please try again." }, 503, origin);
    }
  }
};
