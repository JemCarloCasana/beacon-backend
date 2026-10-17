const SIMPLE_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FULL_NAME_REGEX = /^[\p{L} .'-]+$/u;
const ADMIN_CREATION_ROLES = ["admin", "personnel"];

export const ADMIN_PERMISSION_CATALOG = [
  "manage_users",
  "manage_admins",
  "manage_broadcasts",
  "view_broadcasts",
  "view_incidents",
  "manage_incidents",
  "manage_sos",
  "manage_reports",
];

export const OPS_SUITE_PERMISSIONS = [
  "manage_sos",
  "view_incidents",
  "manage_incidents",
  "manage_reports",
  "view_broadcasts",
  "manage_broadcasts",
];

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeEmail(email) {
  if (typeof email !== "string") return null;
  return email.trim().toLowerCase();
}

function normalizeFullName(fullName) {
  if (typeof fullName !== "string") return null;
  return fullName.trim().replace(/\s+/g, " ");
}

function buildValidationError(errors) {
  return {
    message: "Validation failed",
    errors
  };
}

function countPasswordClasses(password) {
  const classes = [
    /[A-Z]/.test(password),
    /[a-z]/.test(password),
    /[0-9]/.test(password),
    /[^A-Za-z0-9]/.test(password)
  ];
  return classes.filter(Boolean).length;
}

function validateLoginPayload(payload) {
  const body = payload && typeof payload === "object" ? payload : {};
  const errors = {};
  const normalized = {};

  if (!isNonEmptyString(body.email)) {
    errors.email = "Email is required";
  } else {
    const email = normalizeEmail(body.email);
    if (!SIMPLE_EMAIL_REGEX.test(email)) {
      errors.email = "Invalid email format";
    } else {
      normalized.email = email;
    }
  }

  if (!isNonEmptyString(body.password)) {
    errors.password = "Password is required";
  } else {
    normalized.password = body.password;
  }

  return { errors, normalized };
}

function validatePermissionsArray(value, errors, field = "permissions") {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    errors[field] = "Must be an array";
    return undefined;
  }
  const normalized = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== "string" || !ADMIN_PERMISSION_CATALOG.includes(item)) {
      errors[field] = `Unknown permission: ${String(item)}`;
      return undefined;
    }
    if (!seen.has(item)) {
      seen.add(item);
      normalized.push(item);
    }
  }
  return normalized;
}

function validateAdminCreatePayload(payload) {
  const body = payload && typeof payload === "object" ? payload : {};
  const errors = {};
  const normalized = {};

  if (!isNonEmptyString(body.email)) {
    errors.email = "Email is required";
  } else {
    const email = normalizeEmail(body.email);
    if (!SIMPLE_EMAIL_REGEX.test(email)) {
      errors.email = "Invalid email format";
    } else {
      normalized.email = email;
    }
  }

  if (!isNonEmptyString(body.full_name)) {
    errors.full_name = "Full name is required";
  } else {
    const fullName = normalizeFullName(body.full_name);
    if (fullName.length < 2 || fullName.length > 100) {
      errors.full_name = "Full name must be between 2 and 100 characters";
    } else if (!FULL_NAME_REGEX.test(fullName)) {
      errors.full_name = "Full name contains invalid characters";
    } else {
      normalized.full_name = fullName;
    }
  }

  if (!isNonEmptyString(body.password)) {
    errors.password = "Password is required";
  } else if (body.password.length < 10) {
    errors.password = "Password must be at least 10 characters";
  } else if (Buffer.byteLength(body.password, "utf8") > 72) {
    errors.password = "Password must be at most 72 bytes";
  } else if (countPasswordClasses(body.password) < 3) {
    errors.password = "Password must include at least 3 of uppercase, lowercase, number, and special character";
  } else {
    normalized.password = body.password;
  }

  if (!isNonEmptyString(body.role)) {
    errors.role = 'Role must be "admin" or "personnel"';
  } else {
    const role = body.role.trim().toLowerCase();
    if (!ADMIN_CREATION_ROLES.includes(role)) {
      errors.role = 'Role must be "admin" or "personnel"';
    } else {
      normalized.role = role;
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, "permissions")) {
    const permissions = validatePermissionsArray(body.permissions, errors);
    if (permissions !== undefined && !errors.permissions) {
      normalized.permissions = permissions;
    }
  }

  return { errors, normalized };
}

export {
  ADMIN_CREATION_ROLES,
  validateAdminCreatePayload,
  validatePermissionsArray,
  buildValidationError,
  validateLoginPayload
};
