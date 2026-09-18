import mongoose from "mongoose";

const counterSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true, maxlength: 100 },
    seq: { type: Number, required: true, default: 0, min: 0 },
  },
  { collection: "counters", versionKey: false }
);

// Atomic numeric ID allocation. One $inc per call; concurrent callers
// receive distinct values from the single counter document.
counterSchema.statics.nextPublicId = async function nextPublicId(key) {
  const doc = await this.findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 } },
    { returnDocument: "after", upsert: true }
  );
  return doc.seq;
};

export const Counter = mongoose.models.Counter ?? mongoose.model("Counter", counterSchema);
