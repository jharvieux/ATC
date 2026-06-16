// Stable 500 response for DB errors. Logs the ref server-side so ops can
// correlate a client-reported ref to server logs without leaking error details.
export function dbErrorResponse(err?: unknown): Response {
  const ref = crypto.randomUUID();
  console.error("[db-error] ref=%s", ref, err);
  return Response.json({ error: "db_error", ref }, { status: 500 });
}
