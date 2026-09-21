import { isDeepStrictEqual } from "node:util";
import { Counter } from "../src/models/Counter.js";

const imported = new Map();

export async function upsertMany(model, docs, keyFields) {
  for (const doc of docs) {
    try {
      await new model(doc).validate();
    } catch (err) {
      const detail = `${model.modelName} key=${keyFields.map((key) => doc[key]).join("/")} invalid fields: ${Object.keys(err.errors ?? {}).join(",")}`;
      console.error(detail);
      throw new Error("Historical document validation failed");
    }
  }
  imported.set(model, { docs, keyFields });
  if (docs.length === 0) return { upserted: 0, modified: 0, matched: 0 };
  const ops = docs.map((doc) => {
    const filter = {};
    for (const key of keyFields) filter[key] = doc[key];
    const fields = Object.fromEntries(Object.entries(doc).map(([key, value]) => [key, value ?? null]));
    return { updateOne: { filter, update: { $set: fields }, upsert: true } };
  });
  const result = await model.bulkWrite(ops, { ordered: false });
  return {
    upserted: result.upsertedCount ?? 0,
    modified: result.modifiedCount ?? 0,
    matched: result.matchedCount ?? 0,
  };
}

export async function advanceCounter(key, floor) {
  const counter = await Counter.findOneAndUpdate(
    { _id: key }, { $max: { seq: Number(floor ?? 0) } },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: false }
  );
  return counter.seq;
}

function normalize(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value?.toHexString === "function") return value.toHexString();
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalize(entry)]));
  }
  return value;
}

export function compareImportedDocuments(expected, actual, keyFields) {
  const keyOf = (doc) => keyFields.map((key) => String(doc[key])).join("/");
  const remaining = new Map(actual.map((doc) => [keyOf(doc), doc]));
  const problems = [];
  if (remaining.size !== actual.length) problems.push("duplicate keys");
  for (const source of expected) {
    const key = keyOf(source);
    const target = remaining.get(key);
    if (!target) problems.push(`missing ${key}`);
    else {
      for (const field of Object.keys(source)) {
        const sourceValue = source[field];
        const targetValue = target[field];
        const nullableIdEqual = field.endsWith("_id") && sourceValue == null && targetValue == null;
        const numericIdEqual = field.endsWith("_id") && sourceValue != null && targetValue != null && Number(sourceValue) === Number(targetValue);
        if (!nullableIdEqual && !numericIdEqual && !isDeepStrictEqual(normalize(sourceValue), normalize(targetValue))) {
          problems.push(`${key} field ${field}`);
        }
      }
    }
    remaining.delete(key);
  }
  for (const key of remaining.keys()) problems.push(`unexpected ${key}`);
  return problems;
}
