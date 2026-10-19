import "dotenv/config";
import { connectMongo, disconnectMongo } from "../src/mongo.js";
import { SosRecord } from "../src/models/Reduced.js";

try {
  await connectMongo();
  const duplicates = await SosRecord.aggregate([
    { $match: { record_type: "case", latest_status: "active" } },
    { $group: { _id: "$user_id", count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]);
  console.log(JSON.stringify({ duplicates: duplicates.length, rows: duplicates }, null, 2));
  if (duplicates.length > 0) {
    console.error("Resolve duplicate active cases before deploying the unique_active_case_per_user index.");
    process.exitCode = 1;
  }
} catch (error) {
  console.error(JSON.stringify({ failed: true, message: error?.message ?? String(error) }));
  process.exitCode = 1;
} finally {
  await disconnectMongo();
}
