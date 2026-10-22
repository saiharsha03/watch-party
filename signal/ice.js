const STUN_ONLY = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
const TTL = 24 * 3600;

let cached = null;
let cachedAt = 0;

// Cloudflare TURN relays video when a direct connection is blocked (cellular / carrier NAT).
// The TURN key stays on this server; browsers only get short-lived credentials.
export async function getIceServers() {
  // Any TURN provider with a fixed username/password (e.g. ExpressTURN's free plan).
  const turnUrls = (process.env.TURN_URLS || '').split(',').map((u) => u.trim()).filter(Boolean);
  if (turnUrls.length) {
    return [...STUN_ONLY, { urls: turnUrls, username: process.env.TURN_USERNAME || '', credential: process.env.TURN_CREDENTIAL || '' }];
  }

  const keyId = (process.env.CF_TURN_KEY_ID || '').trim();
  const token = (process.env.CF_TURN_API_TOKEN || '').trim();
  if (!keyId || !token) return STUN_ONLY;
  if (cached && Date.now() - cachedAt < (TTL / 2) * 1000) return cached;

  try {
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: TTL }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    cached = body.iceServers;
    cachedAt = Date.now();
    console.log('[ice] Cloudflare TURN credentials ready');
    return cached;
  } catch (e) {
    console.log(`[ice] TURN credentials failed (${e.message}); falling back to STUN only`);
    return STUN_ONLY;
  }
}
