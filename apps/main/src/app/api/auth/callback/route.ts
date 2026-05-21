/** Spec ref: §7.1 — Auth callback (OAuth redirect handler) */

export async function GET(_req: Request): Promise<Response> {
  return Response.json({ todo: "OAuth callback exchange", spec_section: "§7.1" }, { status: 501 });
}
