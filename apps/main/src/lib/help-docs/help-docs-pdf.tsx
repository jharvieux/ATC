// BP31 §32.3.3 — Real PDF renderer for the help-docs export.
//
// Replaces the prior Puppeteer-deferral HTML stub. Uses
// @react-pdf/renderer (already a dep from BP39's itinerary PDF work)
// so we don't need to ship ~200MB of Chromium.
//
// Layout: cover page with the platform name, then one section per
// help doc with title + lightly-formatted markdown body. Markdown
// transforms applied:
//   #/##/### headings   → larger styled Text
//   - item              → bulleted Text
//   1. item             → numbered Text
//   ![alt](/help/...)   → embedded Image, read from public/help on disk
//                          (#1688 — the export worker has no browser
//                          origin to resolve a relative src against)
//   blank line          → paragraph break
//   anything else       → paragraph Text
// Inline markdown (bold/italic/links/code) is rendered verbatim — the
// goal is a readable printout, not a publication-quality typeset.

import React from "react";
import { Document, Page, Text, View, Image, StyleSheet, renderToBuffer } from "@react-pdf/renderer";
import { loadAllDocs, type HelpDoc } from "@/lib/help-ai/docs-loader";
import { resolveHelpImage } from "./resolve-image";

const styles = StyleSheet.create({
  page: { padding: 36, fontSize: 11, fontFamily: "Helvetica", color: "#111" },
  cover: { marginBottom: 24, borderBottom: "2px solid #1f4e79", paddingBottom: 12 },
  coverTitle: { fontSize: 26, fontWeight: 700, color: "#1f4e79" },
  coverSub: { fontSize: 12, color: "#444", marginTop: 6 },
  docTitle: {
    fontSize: 20,
    fontWeight: 700,
    color: "#1f4e79",
    marginTop: 20,
    marginBottom: 10,
  },
  h2: { fontSize: 14, fontWeight: 700, marginTop: 12, marginBottom: 4 },
  h3: { fontSize: 12, fontWeight: 700, marginTop: 8, marginBottom: 2 },
  paragraph: { marginBottom: 6, lineHeight: 1.4 },
  bullet: { marginLeft: 14, marginBottom: 2 },
  image: { maxWidth: 460, marginTop: 4, marginBottom: 8 },
});

interface MarkdownNode {
  kind: "h1" | "h2" | "h3" | "p" | "ul" | "ol" | "img";
  text?: string;
  items?: string[];
  alt?: string;
  src?: string;
}

function parseMarkdownLite(md: string): MarkdownNode[] {
  const lines = md.split(/\r?\n/);
  const nodes: MarkdownNode[] = [];
  let paragraph: string[] = [];
  let listKind: "ul" | "ol" | null = null;
  let listItems: string[] = [];

  function flushParagraph(): void {
    if (paragraph.length > 0) {
      nodes.push({ kind: "p", text: paragraph.join(" ") });
      paragraph = [];
    }
  }
  function flushList(): void {
    if (listKind && listItems.length > 0) {
      nodes.push({ kind: listKind, items: listItems });
    }
    listKind = null;
    listItems = [];
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.startsWith("<!--")) continue; // skip HTML comments
    if (line.length === 0) {
      flushParagraph();
      flushList();
      continue;
    }
    if (line.startsWith("### ")) {
      flushParagraph(); flushList();
      nodes.push({ kind: "h3", text: line.slice(4).trim() });
      continue;
    }
    if (line.startsWith("## ")) {
      flushParagraph(); flushList();
      nodes.push({ kind: "h2", text: line.slice(3).trim() });
      continue;
    }
    if (line.startsWith("# ")) {
      flushParagraph(); flushList();
      // Document title is already emitted as docTitle; skip first h1 to
      // avoid duplication. We still emit subsequent h1s as h2 to keep
      // the visual hierarchy reasonable.
      nodes.push({ kind: "h2", text: line.slice(2).trim() });
      continue;
    }
    const imgMatch = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (imgMatch) {
      flushParagraph(); flushList();
      nodes.push({ kind: "img", alt: imgMatch[1] ?? "", src: imgMatch[2]! });
      continue;
    }
    const ulMatch = line.match(/^(\s*)-\s+(.+)$/);
    if (ulMatch) {
      flushParagraph();
      if (listKind !== "ul") { flushList(); listKind = "ul"; }
      listItems.push(ulMatch[2]!);
      continue;
    }
    const olMatch = line.match(/^(\s*)\d+\.\s+(.+)$/);
    if (olMatch) {
      flushParagraph();
      if (listKind !== "ol") { flushList(); listKind = "ol"; }
      listItems.push(olMatch[2]!);
      continue;
    }
    // Default: paragraph line.
    flushList();
    paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();
  return nodes;
}

function NodeView({ node }: { node: MarkdownNode }): JSX.Element | null {
  if (node.kind === "h2" && node.text) return <Text style={styles.h2}>{node.text}</Text>;
  if (node.kind === "h3" && node.text) return <Text style={styles.h3}>{node.text}</Text>;
  if (node.kind === "p" && node.text) return <Text style={styles.paragraph}>{node.text}</Text>;
  if (node.kind === "img" && node.src) {
    const resolved = resolveHelpImage(node.src);
    if (!resolved) {
      console.warn(`[help-docs-pdf] image not found, skipping: ${node.src}`);
      return null;
    }
    // react-pdf's <Image> is a PDF layout primitive, not an HTML <img> —
    // it has no `alt` prop (see @react-pdf/renderer's ImageProps), so
    // jsx-a11y's alt-text rule false-positives on the component name.
    // eslint-disable-next-line jsx-a11y/alt-text
    return <Image src={resolved.data} style={styles.image} />;
  }
  if ((node.kind === "ul" || node.kind === "ol") && node.items) {
    return (
      <View>
        {node.items.map((item, i) => (
          <Text key={i} style={styles.bullet}>
            {node.kind === "ul" ? "• " : `${i + 1}. `}
            {item}
          </Text>
        ))}
      </View>
    );
  }
  return null;
}

interface HelpDocsDocumentProps {
  docs: HelpDoc[];
  generatedAt: string;
  platformName: string;
}

function HelpDocsDocument({ docs, generatedAt, platformName }: HelpDocsDocumentProps): JSX.Element {
  return (
    <Document>
      <Page size="LETTER" style={styles.page}>
        <View style={styles.cover}>
          <Text style={styles.coverTitle}>{platformName}</Text>
          <Text style={styles.coverSub}>Help documentation</Text>
          <Text style={styles.coverSub}>Generated {generatedAt}</Text>
        </View>
        {docs.map((doc) => (
          <View key={doc.slug} wrap>
            <Text style={styles.docTitle}>{doc.title}</Text>
            {parseMarkdownLite(doc.body_markdown).map((node, i) => (
              <NodeView key={i} node={node} />
            ))}
          </View>
        ))}
      </Page>
    </Document>
  );
}

export async function renderHelpDocsPdf(opts?: {
  platformName?: string;
  /** Test-only override — defaults to the real on-disk help corpus. */
  docs?: HelpDoc[];
}): Promise<Buffer> {
  const docs = opts?.docs ?? loadAllDocs();
  const generatedAt = new Date().toISOString().slice(0, 10);
  const platformName = opts?.platformName ?? "AI Travel Concierge";
  return renderToBuffer(
    <HelpDocsDocument docs={docs} generatedAt={generatedAt} platformName={platformName} />,
  );
}
