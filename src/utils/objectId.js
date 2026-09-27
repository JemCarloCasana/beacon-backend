import mongoose from "mongoose";

export function parseObjectId(value) {
  if (typeof value !== "string" || !/^[a-f\d]{24}$/i.test(value)) return null;
  return new mongoose.Types.ObjectId(value);
}

export function idString(value) {
  return value == null ? null : String(value);
}
