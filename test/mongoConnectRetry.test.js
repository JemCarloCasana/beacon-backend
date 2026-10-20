import test from "node:test";
import assert from "node:assert/strict";
import { connectWithRetry } from "../src/mongo.js";

function makeLogger() {
  const warnings = [];
  return { warn: (line) => warnings.push(line), error: () => {}, log: () => {}, warnings };
}

test("a first-attempt success calls connect once and returns its result", async () => {
  let calls = 0;
  const result = await connectWithRetry(
    async () => {
      calls += 1;
      return "connected";
    },
    { attempts: 5, sleep: async () => {} }
  );

  assert.equal(result, "connected");
  assert.equal(calls, 1, "connect is not retried after a success");
});

test("a transient failure is retried until it succeeds", async () => {
  let calls = 0;
  const result = await connectWithRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error("selection timeout"), { name: "MongooseServerSelectionError" });
      return "connected";
    },
    { attempts: 5, sleep: async () => {} }
  );

  assert.equal(result, "connected");
  assert.equal(calls, 3, "connect is retried until it succeeds");
});

test("the attempt budget is exhausted and the last error is thrown", async () => {
  let calls = 0;
  const logger = makeLogger();
  await assert.rejects(
    connectWithRetry(
      async () => {
        calls += 1;
        throw new Error("still down");
      },
      { attempts: 4, sleep: async () => {}, logger }
    ),
    /still down/
  );

  assert.equal(calls, 4, "connect is attempted exactly the budgeted number of times");
  assert.equal(logger.warnings.length, 3, "a warning is logged for each retry");
});

test("the retry delay grows exponentially and is capped", async () => {
  const delays = [];
  await assert.rejects(
    connectWithRetry(
      async () => {
        throw new Error("down");
      },
      {
        attempts: 5,
        baseDelayMs: 100,
        maxDelayMs: 250,
        sleep: async (ms) => {
          delays.push(ms);
        },
        logger: makeLogger(),
      }
    ),
    /down/
  );

  assert.deepEqual(delays, [100, 200, 250, 250], "delays double then clamp at maxDelayMs");
});
