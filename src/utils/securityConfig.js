const DEFAULT_TRUST_PROXY_HOPS = 1;
const DEFAULT_BCRYPT_COST = 12;
const MIN_BCRYPT_COST = 4;
const MAX_BCRYPT_COST = 15;

/**
 * Number of proxy hops in front of the app. One hop is a single reverse proxy
 * (Render, Fly, Heroku, Nginx); zero means the app is reached directly.
 */
export function resolveTrustProxyHops(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return DEFAULT_TRUST_PROXY_HOPS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return DEFAULT_TRUST_PROXY_HOPS;
  return parsed;
}

/**
 * bcrypt work factor for newly hashed passwords. Existing hashes keep the
 * factor they were created with, so this only affects new hashes.
 */
export function resolveBcryptCost(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return DEFAULT_BCRYPT_COST;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return DEFAULT_BCRYPT_COST;
  return Math.min(Math.max(parsed, MIN_BCRYPT_COST), MAX_BCRYPT_COST);
}
