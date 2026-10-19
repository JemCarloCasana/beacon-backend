import test from "node:test";
import assert from "node:assert/strict";

import { createRateLimiter, sweepStore } from "../src/middleware/rateLimit.js";

const makeReq = (ip, path = "/") => ({ ip, path });
const makeRes = () => ({ statusCode: null, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test("rate limiter buckets the client across every path of the mount", () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 2, keyPrefix: "pathless" });
  let passed = 0;
  const next = () => { passed += 1; };
  limiter(makeReq("1.1.1.1", "/"), makeRes(), next);
  limiter(makeReq("1.1.1.1", "/abc123/status"), makeRes(), next);
  const res = makeRes();
  limiter(makeReq("1.1.1.1", "/other"), res, next);
  assert.equal(passed, 2);
  assert.equal(res.statusCode, 429);
});

test("rate limiter keeps separate buckets per client ip", () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 1, keyPrefix: "per-ip" });
  let passed = 0;
  const next = () => { passed += 1; };
  limiter(makeReq("1.1.1.1"), makeRes(), next);
  limiter(makeReq("2.2.2.2"), makeRes(), next);
  const res = makeRes();
  limiter(makeReq("1.1.1.1"), res, next);
  assert.equal(passed, 2);
  assert.equal(res.statusCode, 429);
  assert.deepEqual(res.body, { message: "Too many requests. Please try again later." });
});

test("sweepStore evicts expired buckets instead of leaking them", () => {
  const store = new Map([
    ["stale", [1000]],
    ["fresh", [6500]],
    ["empty", []],
  ]);
  sweepStore(store, 7000, 2000);
  assert.deepEqual([...store.keys()], ["fresh"]);
});
