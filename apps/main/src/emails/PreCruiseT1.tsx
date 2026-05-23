// §23.4 — T-1 day pre-cruise email template (Tomorrow!).
//
// CRITICAL: The carry-on essentials callout is hardcoded and MUST NOT be
// removed or AI-generated. It prevents the most common avoidable trip-ruining
// mistakes (passport / medications in checked luggage).
/* eslint-disable @next/next/no-head-element, @next/next/no-img-element */

import * as React from "react";
import { BrandedLayout, type BrandedLayoutProps } from "./BrandedLayout";

export interface PortInfo {
  port_name: string;
  official_url?: string;
  terminal_addresses?: Array<{ terminal: string; address: string }>;
  parking_info?: string;
  transit_dropoff_info?: string;
  arrival_advice?: string;
}

export interface PreCruiseT1Props {
  layout: Omit<BrandedLayoutProps, "children">;
  customer_name: string;
  ship_name: string;
  departure_port: PortInfo | null;
  // AI-generated sections
  first_port_preview: string;
  day_of_expectations: string;
  // Weather omitted if weather integration not configured — TODO(weather-integration)
  weather_summary?: string | null;
  companion_page_url?: string;
}

export function PreCruiseT1(props: PreCruiseT1Props): React.ReactElement {
  return (
    <BrandedLayout {...props.layout}>
      <h2 style={{ color: "#1f2937", marginTop: 0 }}>
        Tomorrow is the day, {props.customer_name}! 🚢
      </h2>
      <p>
        Your voyage on the <strong>{props.ship_name}</strong> sets sail tomorrow. Here&rsquo;s
        everything you need for a smooth embarkation.
      </p>

      {/* ── CARRY-ON ESSENTIALS CALLOUT — HARDCODED, DO NOT AI-GENERATE ── */}
      <table
        role="presentation"
        width="100%"
        cellSpacing={0}
        cellPadding={0}
        style={{ marginBottom: 24 }}
      >
        <tbody>
          <tr>
            <td
              style={{
                background: "#fef3c7",
                border: "2px solid #f59e0b",
                borderRadius: 8,
                padding: "20px 24px",
              }}
            >
              <p style={{ margin: "0 0 8px 0", fontWeight: 700, fontSize: 16, color: "#92400e" }}>
                ⚠ CARRY-ON ESSENTIALS
              </p>
              <p style={{ margin: "0 0 12px 0", color: "#78350f", fontWeight: 600 }}>
                Pack these in your CARRY-ON, not your checked luggage:
              </p>
              <ul style={{ margin: 0, paddingLeft: 20, color: "#78350f" }}>
                <li style={{ marginBottom: 4 }}>Passport and travel documents</li>
                <li style={{ marginBottom: 4 }}>Cruise paperwork (boarding pass, vaccination records)</li>
                <li style={{ marginBottom: 4 }}>Medications you take regularly</li>
              </ul>
              <p style={{ margin: "12px 0 0 0", fontSize: 13, color: "#92400e", fontStyle: "italic" }}>
                Checked luggage doesn&rsquo;t arrive at your cabin until hours later.
                Bring your essentials with you to board.
              </p>
            </td>
          </tr>
        </tbody>
      </table>
      {/* ── END CARRY-ON ESSENTIALS CALLOUT ── */}

      {props.departure_port && (
        <>
          <h3 style={{ color: "#374151" }}>Getting to the Port</h3>
          <p style={{ fontWeight: 600, marginBottom: 4 }}>{props.departure_port.port_name}</p>
          {props.departure_port.official_url && (
            <p style={{ marginTop: 0 }}>
              <a href={props.departure_port.official_url} style={{ color: "#3b82f6" }}>
                Official port website →
              </a>
            </p>
          )}
          {props.departure_port.transit_dropoff_info && (
            <p style={{ lineHeight: 1.7, color: "#374151" }}>
              {props.departure_port.transit_dropoff_info}
            </p>
          )}
          {props.departure_port.arrival_advice && (
            <p style={{ lineHeight: 1.7, color: "#374151" }}>
              {props.departure_port.arrival_advice}
            </p>
          )}
        </>
      )}

      {props.weather_summary && (
        <>
          <h3 style={{ color: "#374151" }}>Weather Overview</h3>
          <p style={{ lineHeight: 1.7 }}>{props.weather_summary}</p>
        </>
      )}

      <h3 style={{ color: "#374151" }}>First Port Preview</h3>
      <p style={{ lineHeight: 1.7 }}>{props.first_port_preview}</p>

      <h3 style={{ color: "#374151" }}>What to Expect Tomorrow</h3>
      <p style={{ lineHeight: 1.7 }}>{props.day_of_expectations}</p>

      {props.companion_page_url && (
        <p style={{ marginTop: 24 }}>
          <a
            href={props.companion_page_url}
            style={{ background: "#3b82f6", color: "#fff", padding: "12px 24px", borderRadius: 6, textDecoration: "none" }}
          >
            Open Your Full Day-1 Guide →
          </a>
        </p>
      )}

      <hr style={{ border: "none", borderTop: "1px solid #e5e7eb", margin: "24px 0" }} />
      <p style={{ textAlign: "center", fontSize: 15, fontWeight: 600, color: "#1f2937" }}>
        Bon voyage! Smooth seas await. 🌊
      </p>
    </BrandedLayout>
  );
}
