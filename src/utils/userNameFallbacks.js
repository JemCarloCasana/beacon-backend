const PLACEHOLDER_USER_NAME_REGEX = /^user\s+\d+$/i;

function normalizeWhitespace(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized || null;
}

export function sanitizeName(name) {
  const normalized = normalizeWhitespace(name);
  if (!normalized) return null;
  return normalized.slice(0, 50);
}

export function isPlaceholderUserName(name) {
  const normalized = normalizeWhitespace(name);
  if (!normalized) return false;
  return PLACEHOLDER_USER_NAME_REGEX.test(normalized);
}

export function deriveNameFromEmail(email) {
  if (typeof email !== "string" || !email.includes("@")) return "Beacon User";
  const local = email.split("@")[0];
  const normalized = local
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "Beacon User";
  return normalized.slice(0, 50);
}

export function chooseBootstrapFullName({ tokenName, existingName, email }) {
  const normalizedTokenName = sanitizeName(tokenName);
  if (normalizedTokenName && !isPlaceholderUserName(normalizedTokenName)) {
    return normalizedTokenName;
  }

  const normalizedExistingName = sanitizeName(existingName);
  if (normalizedExistingName && !isPlaceholderUserName(normalizedExistingName)) {
    return normalizedExistingName;
  }

  return deriveNameFromEmail(email);
}
