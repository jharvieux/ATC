// Unit tests — App Router boundary guard (Harvey Tier-1 port, M9 classes).
// Intent: a raw DB row crossing into a 'use client' component ships EVERY
// field to the browser, and a secret-reading module reachable from client code
// without `import "server-only"` can be bundled silently — the guard must
// catch both while clearing projected DTOs and unreachable modules (the
// reachability distinction is its whole value over check-server-only.ts).
import { describe, it, expect } from "vitest";
import { scanSources, loadBaseline } from "../../../scripts/check-app-router-boundaries";

const SRC = "apps/main/src";

const clientCard = {
  rel: `${SRC}/components/Card.tsx`,
  text: `"use client";\nexport function Card(props: any) { return <div />; }\n`,
};

describe("server-client-leak", () => {
  const page = (jsx: string) => ({
    rel: `${SRC}/app/notes/page.tsx`,
    text: `
import { Card } from "@/components/Card";
export default async function Page() {
  const { data: rows } = await db.from("notes").select("*");
  return ${jsx};
}
`,
  });

  it("flags a raw query result spread into a client component", () => {
    const findings = scanSources([clientCard, page(`<Card {...rows} />`)], SRC);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe("server-client-leak");
  });

  it("flags a raw query result passed whole as a prop (the shape the regex-tier guard misses)", () => {
    const findings = scanSources([clientCard, page(`<Card note={rows} />`)], SRC);
    expect(findings).toHaveLength(1);
  });

  it("clears a projected DTO", () => {
    const projected = {
      rel: `${SRC}/app/notes/page.tsx`,
      text: `
import { Card } from "@/components/Card";
export default async function Page() {
  const { data: rows } = await db.from("notes").select("*");
  const dto = { title: rows[0].title };
  return <Card note={dto} />;
}
`,
    };
    expect(scanSources([clientCard, projected], SRC)).toEqual([]);
  });

  it("clears a raw row passed to a SERVER component", () => {
    const serverCard = { rel: `${SRC}/components/Card.tsx`, text: `export function Card(props: any) { return <div />; }\n` };
    expect(scanSources([serverCard, page(`<Card {...rows} />`)], SRC)).toEqual([]);
  });
});

describe("missing-server-only", () => {
  const secretLib = (guarded: boolean) => ({
    rel: `${SRC}/lib/pay/stripe.ts`,
    text: `${guarded ? `import "server-only";\n` : ""}export const key = process.env.STRIPE_SECRET_KEY;\n`,
  });
  const clientImporter = {
    rel: `${SRC}/components/Pay.tsx`,
    text: `"use client";\nimport { key } from "@/lib/pay/stripe";\nexport function Pay() { return <div />; }\n`,
  };

  it("flags a secret-reading module reachable from a 'use client' file", () => {
    const findings = scanSources([secretLib(false), clientImporter], SRC);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe("missing-server-only");
  });

  it("clears the same module once it imports server-only", () => {
    expect(scanSources([secretLib(true), clientImporter], SRC)).toEqual([]);
  });

  it("clears a secret-reading module NOTHING on the client side imports (no bundling risk)", () => {
    expect(scanSources([secretLib(false)], SRC)).toEqual([]);
  });

  it("clears route handlers (server-exclusive by routing convention)", () => {
    const route = { rel: `${SRC}/app/api/pay/route.ts`, text: `export const key = process.env.STRIPE_SECRET_KEY;\n` };
    const importer = { ...clientImporter, text: `"use client";\nimport { key } from "@/app/api/pay/route";\n` };
    expect(scanSources([route, importer], SRC)).toEqual([]);
  });

  it("follows a transitive relative-import chain from the client file", () => {
    const middle = { rel: `${SRC}/lib/pay/index.ts`, text: `export * from "./stripe";\n` };
    const importer = { ...clientImporter, text: `"use client";\nimport { key } from "@/lib/pay";\nexport function Pay() { return <div />; }\n` };
    const findings = scanSources([secretLib(false), middle, importer], SRC);
    expect(findings).toHaveLength(1);
  });
});

describe("loadBaseline", () => {
  it("returns an empty map for a missing file (fail-closed)", () => {
    expect(loadBaseline("/nonexistent/boundaries-baseline.txt")).toEqual(new Map());
  });
});
