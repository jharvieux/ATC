/** Spec ref: §7.9 — Gmail Pub/Sub webhook */

export async function POST(_req: Request): Promise<Response> {
  return Response.json({ todo: "Gmail Pub/Sub webhook", spec_section: "§7.9" }, { status: 501 });
}
