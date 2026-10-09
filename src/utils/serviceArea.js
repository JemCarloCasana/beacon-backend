import { readFileSync } from "node:fs";

export const serviceArea = JSON.parse(readFileSync(new URL("../data/dagupan-city.geojson", import.meta.url), "utf8"));
const EPSILON = 1e-10;

// -1 = outside, 0 = boundary, 1 = inside. The boundary belongs to the service area.
function ringPosition(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j];
    const [bx, by] = ring[i];
    const cross = (x - ax) * (by - ay) - (y - ay) * (bx - ax);
    if (Math.abs(cross) <= EPSILON * Math.hypot(bx - ax, by - ay)
      && x >= Math.min(ax, bx) - EPSILON && x <= Math.max(ax, bx) + EPSILON
      && y >= Math.min(ay, by) - EPSILON && y <= Math.max(ay, by) + EPSILON) return 0;
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
  }
  return inside ? 1 : -1;
}

function polygonContains(latitude, longitude, rings) {
  if (!rings.length) return false;
  const exterior = ringPosition(longitude, latitude, rings[0]);
  if (exterior === -1) return false;
  if (exterior === 0) return true;
  for (const hole of rings.slice(1)) {
    const position = ringPosition(longitude, latitude, hole);
    if (position === 0) return true;
    if (position === 1) return false;
  }
  return true;
}

export function containsLocation(latitude, longitude, geometry) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  if (geometry?.type === "Polygon") return polygonContains(latitude, longitude, geometry.coordinates);
  if (geometry?.type === "MultiPolygon") return geometry.coordinates.some(rings => polygonContains(latitude, longitude, rings));
  return false;
}

export function getServiceAreaError(latitude, longitude) {
  if (latitude == null && longitude == null) {
    return Object.assign(new Error("Enable location to continue."), { statusCode: 400, code: "LOCATION_REQUIRED" });
  }
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    return Object.assign(new Error("Provide valid latitude and longitude."), { statusCode: 400, code: "INVALID_LOCATION" });
  }
  if (!serviceArea.features.some(feature => containsLocation(latitude, longitude, feature.geometry))) {
    return Object.assign(new Error("Beacon is currently available only within Dagupan City."), { statusCode: 422, code: "OUTSIDE_SERVICE_AREA" });
  }
  return null;
}
