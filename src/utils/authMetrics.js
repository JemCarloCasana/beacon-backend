const authMetrics = {
  totalChecks: 0,
  success: 0,
  failure: 0,
  missingBearer: 0,
  invalidOrExpired: 0,
  avgVerifyMs: 0,
  lastFailureAt: null
};

function updateAverage(currentAvg, currentCount, value) {
  if (currentCount <= 1) return value;
  return ((currentAvg * (currentCount - 1)) + value) / currentCount;
}

export function recordAuthSuccess(verifyMs) {
  authMetrics.totalChecks += 1;
  authMetrics.success += 1;
  authMetrics.avgVerifyMs = updateAverage(authMetrics.avgVerifyMs, authMetrics.success, verifyMs);
}

export function recordAuthFailure(reason) {
  authMetrics.totalChecks += 1;
  authMetrics.failure += 1;
  authMetrics.lastFailureAt = new Date().toISOString();

  if (reason === "missing_bearer") authMetrics.missingBearer += 1;
  if (reason === "invalid_or_expired") authMetrics.invalidOrExpired += 1;
}

export function getAuthMetricsSnapshot() {
  return {
    ...authMetrics,
    avgVerifyMs: Number(authMetrics.avgVerifyMs.toFixed(2))
  };
}
