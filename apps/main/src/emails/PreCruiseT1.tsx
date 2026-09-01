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
  first_port_preview: string;
  day_of_expectations: string;
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

      <p style={{ margin: "0 0 8px 0", color: accent, fontSize: 11, fontWeight: 700, letterSpacing: 1.5, textAlign: "center", textTransform: "uppercase" }}>
        Your embarkation briefing
      </p>
      <h1 style={{ color: primary, fontFamily: "Georgia, 'Times New Roman', serif", fontSize: 30, fontWeight: 700, lineHeight: 1.15, margin: "0 0 20px 0", textAlign: "center" }}>
        Tomorrow, you&rsquo;re at sea.
      </h1>

      {props.destination_image && <DestinationHero image={props.destination_image} />}

      <table role="presentation" width="100%" cellSpacing={0} cellPadding={0} style={{ margin: "0 0 20px 0", borderLeft: `4px solid ${accent}` }}>
        <tbody>
          <tr>
            <td style={{ padding: "4px 0 4px 16px", color: "#425466", fontSize: 15, lineHeight: 1.7 }}>
              Hi {props.customer_name}, <strong style={{ color: primary }}>{props.ship_name}</strong> sets sail tomorrow. Keep this note handy for a smooth, unhurried embarkation.
            </td>
          </tr>
        </tbody>
      </table>

      {/* This warning stays hardcoded so AI generation can never omit the
          passport, paperwork, or medication guidance required by §23.4. */}
      <table
        role="presentation"
        width="100%"
        cellSpacing={0}
        cellPadding={0}
        style={{ marginBottom: 10, backgroundColor: "#fffbeb", border: "2px solid #b45309" }}
      >
        <tbody>
          <tr>
            <td style={{ padding: "20px 22px" }}>
              <p style={{ margin: "0 0 8px 0", color: "#92400e", fontSize: 11, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase" }}>
                CARRY-ON ESSENTIALS
              </p>
              <h2 style={{ margin: "0 0 10px 0", color: "#78350f", fontFamily: "Georgia, 'Times New Roman', serif", fontSize: 22, lineHeight: 1.25 }}>
                Pack these in your CARRY-ON, not your checked luggage:
              </h2>
              <table role="presentation" width="100%" cellSpacing={0} cellPadding={0}>
                <tbody>
                  {[
                    "Passport and travel documents",
                    "Cruise paperwork (boarding pass, vaccination records)",
                    "Medications you take regularly",
                  ].map((item) => (
                    <tr key={item}>
                      <td width={26} style={{ color: "#92400e", fontSize: 16, fontWeight: 700, lineHeight: 1.6, verticalAlign: "top" }}>•</td>
                      <td style={{ color: "#78350f", fontSize: 14, lineHeight: 1.6, verticalAlign: "top" }}>{item}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p style={{ margin: "14px 0 0 0", color: "#92400e", fontSize: 13, fontStyle: "italic", lineHeight: 1.55 }}>
                Checked luggage doesn&rsquo;t arrive at your cabin until hours later.
                Bring your essentials with you to board.
              </p>
            </td>
          </tr>
        </tbody>
      </table>
      {props.departure_port && <DeparturePortSection port={props.departure_port} accent={accent} />}

      {props.cruise_forecast && props.cruise_forecast.length > 0 ? (
        <>
          <SectionHeading accent={accent}>Weather Along the Way</SectionHeading>
          <CruiseForecastChart forecast={props.cruise_forecast} />
        </>
      ) : props.weather_summary ? (
        <>
          <SectionHeading accent={accent}>Weather overview</SectionHeading>
          <p style={{ margin: 0, color: "#425466", lineHeight: 1.7 }}>{props.weather_summary}</p>
          <p style={{ fontSize: 11, color: "#9ca3af", margin: "0 0 16px 0" }}>
            Weather data by{" "}
            <a href="https://open-meteo.com/" style={{ color: "#9ca3af" }}>
              Open-Meteo
            </a>{" "}
            (CC BY 4.0)
          </p>
        </>
      ) : null}

      <SectionHeading accent={accent}>First port preview</SectionHeading>
      <table role="presentation" width="100%" cellSpacing={0} cellPadding={0} style={{ backgroundColor: "#f8f6f1", borderTop: `3px solid ${accent}` }}>
        <tbody>
          <tr>
            <td style={{ padding: "18px 20px", color: "#425466", fontFamily: "Georgia, 'Times New Roman', serif", fontSize: 16, lineHeight: 1.65 }}>{props.first_port_preview}</td>
          </tr>
        </tbody>
      </table>

      <SectionHeading accent={accent}>What to expect tomorrow</SectionHeading>
      <table role="presentation" width="100%" cellSpacing={0} cellPadding={0} style={{ backgroundColor: "#f7fafc", border: "1px solid #e2e8f0", borderRadius: 4 }}>
        <tbody>
          <tr>
            <td width={6} style={{ backgroundColor: accent, fontSize: 1, lineHeight: "1px" }}>&nbsp;</td>
            <td style={{ padding: "16px 18px", color: "#425466", fontSize: 14, lineHeight: 1.6 }}>{props.day_of_expectations}</td>
          </tr>
        </tbody>
      </table>

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

      <hr style={{ border: "none", borderTop: "1px solid #dce5ea", margin: "30px 0 18px 0" }} />
      <p style={{ color: primary, fontFamily: "Georgia, 'Times New Roman', serif", fontSize: 18, fontWeight: 700, lineHeight: 1.4, margin: 0, textAlign: "center" }}>
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
                    backgroundColor: "#f3f4f6",
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
                    backgroundColor: "#f9fafb",
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
