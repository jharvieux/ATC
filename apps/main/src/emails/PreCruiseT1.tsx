// §23.4 — T-1 day pre-cruise email template (Tomorrow!).
// #975 — marketing-grade layout: countdown badge, eyebrow section headings,
// tenant-accent CTA.
//
// CRITICAL: The carry-on essentials callout is hardcoded and MUST NOT be
// removed or AI-generated. It prevents the most common avoidable trip-ruining
// mistakes (passport / medications in checked luggage).

import * as React from "react";
import { BrandedLayout, type BrandedLayoutProps } from "./BrandedLayout";
import { CruiseForecastChart } from "./CruiseForecastChart";
import { DestinationHero } from "./DestinationHero";
import { SectionHeading, CtaButton, CountdownBadge, DEFAULT_PRIMARY, DEFAULT_ACCENT } from "./EmailParts";
import type { DestinationImage } from "@/lib/cruise-regions/destination-images";
import type { DailyForecast } from "@/lib/weather/cruise-forecast";

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
  destination_image?: DestinationImage | null;
  // AI-generated sections
  first_port_preview: string;
  day_of_expectations: string;
  // Multi-day forecast for the cruise. Falls back to weather_summary
  // when null (e.g., sailings outside Open-Meteo's 16-day horizon at
  // send time).
  cruise_forecast?: DailyForecast[] | null;
  weather_summary?: string | null;
  companion_page_url?: string;
}

export function PreCruiseT1(props: PreCruiseT1Props): React.ReactElement {
  const primary = props.layout.branding.primary_color ?? DEFAULT_PRIMARY;
  const accent = props.layout.branding.accent_color ?? DEFAULT_ACCENT;

  return (
    <BrandedLayout {...props.layout}>
      <CountdownBadge accent={accent}>Departing tomorrow</CountdownBadge>

      <h2 style={{ color: primary, margin: "0 0 16px 0", fontSize: 24, textAlign: "center" }}>
        Tomorrow is the day, {props.customer_name}! 🚢
      </h2>

      {props.destination_image && <DestinationHero image={props.destination_image} />}

      <p style={{ lineHeight: 1.7 }}>
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

      {props.departure_port && <DeparturePortSection port={props.departure_port} accent={accent} />}

      {props.cruise_forecast && props.cruise_forecast.length > 0 ? (
        <>
          <SectionHeading accent={accent}>Weather Along the Way</SectionHeading>
          <CruiseForecastChart forecast={props.cruise_forecast} />
        </>
      ) : props.weather_summary ? (
        <>
          <SectionHeading accent={accent}>Weather Overview</SectionHeading>
          <p style={{ lineHeight: 1.7 }}>{props.weather_summary}</p>
          <p style={{ fontSize: 11, color: "#9ca3af", margin: "0 0 16px 0" }}>
            Weather data by{" "}
            <a href="https://open-meteo.com/" style={{ color: "#9ca3af" }}>
              Open-Meteo
            </a>{" "}
            (CC BY 4.0)
          </p>
        </>
      ) : null}

      <SectionHeading accent={accent}>First Port Preview</SectionHeading>
      <p style={{ lineHeight: 1.7 }}>{props.first_port_preview}</p>

      <SectionHeading accent={accent}>What to Expect Tomorrow</SectionHeading>
      <p style={{ lineHeight: 1.7 }}>{props.day_of_expectations}</p>

      {props.companion_page_url && (
        <CtaButton href={props.companion_page_url} accent={accent}>
          Open Your Full Day-1 Guide →
        </CtaButton>
      )}

      {props.destination_image && (
        <p style={{ fontSize: 11, color: "#9ca3af", margin: "16px 0 0 0", textAlign: "center" }}>
          Cover image: {props.destination_image.attribution}
        </p>
      )}

      <hr style={{ border: "none", borderTop: "1px solid #e5e7eb", margin: "24px 0" }} />
      <p style={{ textAlign: "center", fontSize: 15, fontWeight: 600, color: "#1f2937" }}>
        Bon voyage! Smooth seas await. 🌊
      </p>
    </BrandedLayout>
  );
}

function DeparturePortSection(props: { port: PortInfo; accent: string }): React.ReactElement {
  const { port, accent } = props;
  return (
    <>
      <SectionHeading accent={accent}>Getting to the Port</SectionHeading>
      <p style={{ fontWeight: 600, marginBottom: 4 }}>{port.port_name}</p>
      {port.official_url && (
        <p style={{ marginTop: 0 }}>
          <a href={port.official_url} style={{ color: accent }}>
            Official port website →
          </a>
        </p>
      )}
      {port.terminal_addresses && port.terminal_addresses.length > 0 && (
        <table
          role="presentation"
          cellSpacing={0}
          cellPadding={0}
          style={{ width: "100%", margin: "8px 0 12px 0", borderCollapse: "collapse" }}
        >
          <tbody>
            {port.terminal_addresses.map((t) => (
              <tr key={`${t.terminal}-${t.address}`}>
                <td
                  style={{
                    padding: "8px 12px",
                    fontWeight: 600,
                    color: "#374151",
                    background: "#f3f4f6",
                    borderTopLeftRadius: 6,
                    borderBottomLeftRadius: 6,
                    whiteSpace: "nowrap",
                  }}
                >
                  {t.terminal}
                </td>
                <td
                  style={{
                    padding: "8px 12px",
                    color: "#374151",
                    background: "#f9fafb",
                    borderTopRightRadius: 6,
                    borderBottomRightRadius: 6,
                  }}
                >
                  {t.address}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {port.parking_info && (
        <p style={{ lineHeight: 1.7, color: "#374151", margin: "0 0 8px 0" }}>
          <strong style={{ color: "#1f2937" }}>Parking:</strong> {port.parking_info}
        </p>
      )}
      {port.transit_dropoff_info && (
        <p style={{ lineHeight: 1.7, color: "#374151", margin: "0 0 8px 0" }}>
          {port.transit_dropoff_info}
        </p>
      )}
      {port.arrival_advice && (
        <p style={{ lineHeight: 1.7, color: "#374151" }}>{port.arrival_advice}</p>
      )}
    </>
  );
}
