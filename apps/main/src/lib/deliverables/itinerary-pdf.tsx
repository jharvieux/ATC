// BP39 §39.6 — Itinerary PDF renderer via @react-pdf/renderer.
//
// renderItineraryPdf(data) returns a Buffer ready to upload to Supabase
// storage. Layout is intentionally print-friendly: cover, at-a-glance,
// day-by-day, agent notes, contact card.

import React from "react";
import { Document, Page, Text, View, StyleSheet, renderToBuffer } from "@react-pdf/renderer";

export interface ItineraryPdfData {
  tenant: { display_name: string };
  cruise_line: string | null;
  ship_name: string | null;
  sailing_date: string | null;
  duration_nights: number | null;
  cabin_category: string | null;
  primary_passenger_name: string | null;
  embarkation_port: string | null;
  agent_notes: string | null;
  agent: { name: string | null; email: string | null; phone: string | null };
  days?: Array<{ day_number: number; port_name: string | null; arrival_time: string | null; departure_time: string | null; description: string | null }>;
  whats_included?: string[];
}

const styles = StyleSheet.create({
  page: { padding: 36, fontSize: 11, fontFamily: "Helvetica" },
  cover: { borderBottom: "2px solid #1f4e79", paddingBottom: 12, marginBottom: 16 },
  tenant: { fontSize: 14, fontWeight: 700, color: "#1f4e79" },
  title: { fontSize: 22, fontWeight: 700, marginTop: 8 },
  meta: { fontSize: 11, color: "#444", marginTop: 4 },
  h2: { fontSize: 14, fontWeight: 700, color: "#1f4e79", marginTop: 18, marginBottom: 6 },
  row: { flexDirection: "row", marginBottom: 4 },
  label: { width: 140, color: "#666" },
  value: { flex: 1 },
  dayBlock: { marginTop: 6, borderTop: "1px dotted #ccc", paddingTop: 6 },
  dayHeader: { fontWeight: 700, marginBottom: 2 },
  contact: { marginTop: 24, padding: 12, backgroundColor: "#f5f7fa", border: "1px solid #d9e1eb", borderRadius: 4 },
  bullet: { marginLeft: 12 },
});

function ItineraryDocument({ data }: { data: ItineraryPdfData }): JSX.Element {
  return (
    <Document>
      <Page size="LETTER" style={styles.page}>
        <View style={styles.cover}>
          <Text style={styles.tenant}>{data.tenant.display_name}</Text>
          <Text style={styles.title}>
            {data.cruise_line ?? ""} {data.ship_name ?? ""}
          </Text>
          <Text style={styles.meta}>
            {data.sailing_date ?? "?"} · {data.duration_nights ?? "?"} nights · {data.cabin_category ?? "Cabin TBD"}
          </Text>
          {data.primary_passenger_name && (
            <Text style={styles.meta}>For {data.primary_passenger_name}</Text>
          )}
        </View>

        <Text style={styles.h2}>At a glance</Text>
        <View style={styles.row}><Text style={styles.label}>Embarkation</Text><Text style={styles.value}>{data.embarkation_port ?? "—"}</Text></View>
        <View style={styles.row}><Text style={styles.label}>Sail date</Text><Text style={styles.value}>{data.sailing_date ?? "—"}</Text></View>
        <View style={styles.row}><Text style={styles.label}>Duration</Text><Text style={styles.value}>{data.duration_nights ? `${data.duration_nights} nights` : "—"}</Text></View>
        <View style={styles.row}><Text style={styles.label}>Cabin</Text><Text style={styles.value}>{data.cabin_category ?? "—"}</Text></View>

        {data.whats_included && data.whats_included.length > 0 && (
          <>
            <Text style={styles.h2}>What&apos;s included</Text>
            {data.whats_included.map((item, i) => (
              <Text key={i} style={styles.bullet}>• {item}</Text>
            ))}
          </>
        )}

        {data.days && data.days.length > 0 && (
          <>
            <Text style={styles.h2}>Day-by-day</Text>
            {data.days.map((d) => (
              <View key={d.day_number} style={styles.dayBlock}>
                <Text style={styles.dayHeader}>
                  Day {d.day_number} — {d.port_name ?? "At Sea"}
                </Text>
                <Text>
                  {d.arrival_time ? `Arrive ${d.arrival_time}` : ""}
                  {d.arrival_time && d.departure_time ? " · " : ""}
                  {d.departure_time ? `Depart ${d.departure_time}` : ""}
                </Text>
                {d.description && <Text style={{ marginTop: 2, color: "#555" }}>{d.description}</Text>}
              </View>
            ))}
          </>
        )}

        {data.agent_notes && (
          <>
            <Text style={styles.h2}>From your agent</Text>
            <Text>{data.agent_notes}</Text>
          </>
        )}

        <View style={styles.contact}>
          <Text style={{ fontWeight: 700 }}>{data.agent.name ?? "Your travel agent"}</Text>
          {data.agent.email && <Text>{data.agent.email}</Text>}
          {data.agent.phone && <Text>{data.agent.phone}</Text>}
        </View>
      </Page>
    </Document>
  );
}

export async function renderItineraryPdf(data: ItineraryPdfData): Promise<Buffer> {
  return renderToBuffer(<ItineraryDocument data={data} />);
}
