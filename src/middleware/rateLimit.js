const store = new Map();

function pruneOld(now, windowMs, entries) {
  const cutoff = now - windowMs;
  return entries.filter((value) => value > cutoff);
}

export function createRateLimiter({ windowMs, max, keyPrefix, message }) {
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error("windowMs must be a positive number");
  }
  if (!Number.isFinite(max) || max <= 0) {
    throw new Error("max must be a positive number");
  }

  const responseMessage = message || "Too many requests. Please try again later.";
  const prefix = keyPrefix || "rate_limit";

  return function rateLimiter(req, res, next) {
    const now = Date.now();
    const key = `${prefix}:${req.ip || "unknown"}:${req.path}`;
    const existing = store.get(key) || [];
    const recent = pruneOld(now, windowMs, existing);

    recent.push(now);
    store.set(key, recent);

    if (recent.length > max) {
      return res.status(429).json({ message: responseMessage });
    }

    return next();
  };
}
