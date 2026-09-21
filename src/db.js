// ponytail: compatibility shim for legacy fallback branches and tests; remove
// this file once those branches are deleted.
function postgresRemoved() {
  throw new Error("PostgreSQL runtime has been removed; use MongoDB instead");
}

export const pool = {
  query: async () => postgresRemoved(),
  connect: async () => postgresRemoved(),
  end: async () => {},
  on: () => {},
};
