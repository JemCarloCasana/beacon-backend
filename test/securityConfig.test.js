import test from "node:test";
import assert from "node:assert/strict";
import { resolveTrustProxyHops, resolveBcryptCost } from "../src/utils/securityConfig.js";

test("the trust proxy hop count defaults to one", () => {
  assert.equal(resolveTrustProxyHops(undefined), 1);
  assert.equal(resolveTrustProxyHops(null), 1);
  assert.equal(resolveTrustProxyHops(""), 1);
  assert.equal(resolveTrustProxyHops("  "), 1);
});

test("the trust proxy hop count is read from the environment", () => {
  assert.equal(resolveTrustProxyHops("2"), 2);
  assert.equal(resolveTrustProxyHops(0), 0);
});

test("an unusable trust proxy hop count falls back to the default", () => {
  assert.equal(resolveTrustProxyHops("abc"), 1);
  assert.equal(resolveTrustProxyHops("-1"), 1);
  assert.equal(resolveTrustProxyHops("1.5"), 1);
});

test("the bcrypt cost defaults to twelve", () => {
  assert.equal(resolveBcryptCost(undefined), 12);
  assert.equal(resolveBcryptCost(null), 12);
  assert.equal(resolveBcryptCost(""), 12);
});

test("the bcrypt cost is read from the environment", () => {
  assert.equal(resolveBcryptCost("10"), 10);
  assert.equal(resolveBcryptCost(11), 11);
});

test("the bcrypt cost is clamped to a workable range", () => {
  assert.equal(resolveBcryptCost("2"), 4);
  assert.equal(resolveBcryptCost("99"), 15);
  assert.equal(resolveBcryptCost("abc"), 12);
});
