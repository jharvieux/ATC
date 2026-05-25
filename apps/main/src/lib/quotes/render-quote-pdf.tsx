// §12.4 / §21.10.1 — Binary PDF renderer for quotes.
//
// Sibling to render-pdf.ts (which produces the HTML serialization used
// for the audit-log dispute-defense snapshot). This file produces the
// printable binary PDF customers actually receive via /api/quotes/[id]/send.
//
// Layout: tenant + customer header, line-item table, ESTIMATE / CONFIRMED
// banner, validity copy, host-agency disclosure, mandatory footer.
// All disclosure text mirrors render-pdf.ts so the binary and the
// audit-snapshot HTML stay in sync.

import React from "react";
import { Document, Page, Text, View, StyleSheet, renderToBuffer } from "@react-pdf/renderer";
import type { QuoteRenderInput } from "./render-pdf";

const styles = StyleSheet.create({
  page: { padding: 36, fontSize: 11, fontFamily: "Helvetica", color: "#1f2937" },
  banner: {
    padding: 12,
    borderRadius: 4,
    marginBottom: 16,
    fontSize: 12,
    fontWeight: 700,
  },
  bannerEstimate: { backgroundColor: "#fef3c7", color: "#92400e" },
  bannerConfirmed: { backgroundColor: "#d1fae5", color: "#065f46" },
  tenant: { fontSize: 20, fontWeight: 700, marginBottom: 4 },
  meta: { fontSize: 11, color: "#4b5563", marginBottom: 2 },
  table: { marginTop: 16, marginBottom: 12 },
  tableRow: {
    flexDirection: "row",
    borderBottom: "1px solid #e5e7eb",
    paddingVertical: 6,
  },
  tableRowTotal: {
    flexDirection: "row",
    borderTop: "2px solid #111827",
    paddingVertical: 8,
    marginTop: 6,
  },
  labelCol: { flex: 3 },
  amountCol: { flex: 1, textAlign: "right" },
  totalLabel: { flex: 3, fontWeight: 700 },
  totalAmount: { flex: 1, textAlign: "right", fontWeight: 700 },
  validity: { marginTop: 12, marginBottom: 8 },
  disclosure: {
    marginTop: 8,
    padding: 10,
    backgroundColor: "#fff7ed",
    borderRadius: 4,
    fontSize: 10,
    color: "#7c2d12",
  },
  footer: {
    marginTop: 18,
    paddingTop: 10,
    borderTop: "1px solid #e5e7eb",
    fontSize: 10,
    color: "#4b5563",
    lineHeight: 1.4,
  },
});

function formatCents(cents: number, currency: string): string {
  const amount = cents / 100;
  const code = currency.toUpperCase();
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(amount);
  } catch {
    return `${code} ${amount.toFixed(2)}`;
  }
}

function formatTs(ts: string | null): string {
  if (!ts) return "—";
  try {
    return new Date(ts).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  } catch {
    return ts;
  }
}

function formatDate(ts: string): string {
  try {
    return new Date(ts).toISOString().slice(0, 10);
  } catch {
    return ts;
  }
}

function ESTIMATE_FOOTER(varianceUsd: string): string {
  return (
    `This is an ESTIMATE — the final price at booking may differ. By accepting, ` +
    `you authorize us to submit the booking at the actual price PROVIDED the price ` +
    `is within ${varianceUsd} of the estimate above. If the actual price falls ` +
    `OUTSIDE this variance, we will pause the booking and ask you to reconfirm ` +
    `at the new price before submitting. Estimate quotes are valid for the period ` +
    `shown; after that they automatically expire and a fresh quote is required.`
  );
}

function CONFIRMED_FOOTER(host: string, lockEnd: string): string {
  return (
    `This is a CONFIRMED quote. ${host} has price-locked this fare through ` +
    `${lockEnd}. Acceptance submits the booking at the locked price.`
  );
}

function QuoteDocument({ input }: { input: QuoteRenderInput }): JSX.Element {
  const isEstimate = input.kind === "estimate";
  const variance = formatCents(input.variance_cents, input.currency);
  const headerBanner = isEstimate
    ? "ESTIMATE — pricing subject to confirmation at booking"
    : `QUOTE — price locked through ${formatTs(input.price_lock_expires_at)}`;
  const validityCopy = isEstimate
    ? `Valid for ${input.validity_days} days from ${formatDate(input.priced_at)}.`
    : `Valid through ${formatTs(input.price_lock_expires_at)}.`;
  const footer = isEstimate
    ? ESTIMATE_FOOTER(variance)
    : CONFIRMED_FOOTER(input.host_agency_legal_name, formatTs(input.price_lock_expires_at));

  return (
    <Document>
      <Page size="LETTER" style={styles.page}>
        <View style={[styles.banner, isEstimate ? styles.bannerEstimate : styles.bannerConfirmed]}>
          <Text>{headerBanner}</Text>
        </View>

        <Text style={styles.tenant}>{input.tenant_name}</Text>
        <Text style={styles.meta}>
          Prepared for {input.customer_name} · Quote {input.quote_id}
        </Text>
        <Text style={styles.meta}>
          {[
            input.cruise_line ?? "Cruise",
            input.ship_name ?? "",
            input.sailing_date ?? "",
            input.duration_nights ? `${input.duration_nights} nights` : "",
            input.cabin_category ?? "",
            input.passenger_count ? `${input.passenger_count} pax` : "",
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>

        <View style={styles.table}>
          {input.line_items.map((li, i) => (
            <View key={i} style={styles.tableRow}>
              <Text style={styles.labelCol}>{li.label}</Text>
              <Text style={styles.amountCol}>
                {formatCents(li.amount_cents, input.currency)}
                {isEstimate ? " est." : ""}
              </Text>
            </View>
          ))}
          <View style={styles.tableRowTotal}>
            <Text style={styles.totalLabel}>Total</Text>
            <Text style={styles.totalAmount}>
              {formatCents(input.total_cents, input.currency)}
              {isEstimate ? " est." : ""}
            </Text>
          </View>
        </View>

        <Text style={styles.validity}>{validityCopy}</Text>

        <View style={styles.disclosure}>
          <Text>
            This booking will be made through {input.host_agency_legal_name}.
            {" "}Your sub-host: {input.tenant_name}.
          </Text>
        </View>

        <View style={styles.footer}>
          <Text>{footer}</Text>
        </View>
      </Page>
    </Document>
  );
}

export async function renderQuotePdf(input: QuoteRenderInput): Promise<Buffer> {
  return renderToBuffer(<QuoteDocument input={input} />);
}
