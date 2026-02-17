export function generateBeaconCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I,O,1,0 to avoid confusion
  let code = "BCN-";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code; // e.g. BCN-5F8K2Q
}
