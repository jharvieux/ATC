/** Spec ref: §7.9 — Resend email webhook */

export async function POST(_req: Request): Promise<Response> {
  return Response.json({ todo: "Resend email webhook", spec_section: "§7.9" }, { status: 501 });
}
