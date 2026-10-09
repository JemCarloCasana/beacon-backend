import admin from "../firebaseAdmin.js";

// Firestore is an archive; MongoDB remains authoritative if synchronization fails.
export async function recordSosLocation(snapshot) {
  try {
    const db = admin.firestore();
    const doc = db.collection("sos_sessions").doc(snapshot.sos_id);
    const batch = db.batch();
    const point = {
      sos_id: snapshot.sos_id, user_id: snapshot.user_id,
      latitude: snapshot.latest_latitude, longitude: snapshot.latest_longitude,
      location_updated_at: new Date(snapshot.location_updated_at),
    };
    batch.set(doc, { ...point, latest_status: snapshot.latest_status }, { merge: true });
    batch.set(doc.collection("locations").doc(), point);
    await batch.commit();
    return true;
  } catch (error) {
    console.warn("SOS history synchronization failed", { code: String(error?.code ?? "unknown") });
    return false;
  }
}
