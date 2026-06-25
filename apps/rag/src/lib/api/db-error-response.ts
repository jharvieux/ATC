export function dbErrorResponse(err: unknown): Response {
  const ref = crypto.randomUUID();
  console.error("[db-error] ref=%s", ref, err);
  return Response.json({ error: "db_error", ref }, { status: 500 });
}
