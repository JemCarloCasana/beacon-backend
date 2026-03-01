import test from "node:test";
import assert from "node:assert/strict";

import router from "./routes/sosRoutes.js";

function getRoute(path, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === path && entry.route.methods?.[method]
  );
  if (!layer) {
    throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  }
  return layer.route.stack;
}

function createRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

test("POST /sos returns 400 when category is missing", async () => {
  const stack = getRoute("/sos", "post");
  const handler = stack[stack.length - 1].handle;

  const req = {
    auth: { uid: "firebase-uid-1" },
    body: { latitude: 16.04, longitude: 120.33 }
  };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: "Invalid category" });
});

