// §23.4 — Cruise forecast chart for T-7 and T-1 emails.
//
// Renders an HTML table (not SVG) so the chart works in Outlook desktop
// and other email clients that strip SVG. Each cruise day is a column;
// rows are: day-of-week + date, port name, condition text, low/high
// temperature, and an inline temperature-range bar styled with inline
// CSS (no <style> blocks since Gmail's web client strips them in many
// configurations).
//
// Null fields render as "Forecast pending" — Open-Meteo's 16-day
// horizon means sailings beyond two weeks out can return null for the
// later stops; the chart preserves the column so the timeline stays
// intact rather than collapsing.

import * as React from "react";
import type { DailyForecast } from "@/lib/weather/cruise-forecast";

export interface CruiseForecastChartProps {
  forecast: DailyForecast[];
}

const TEMP_BAR_MIN_F = 40;   // bar floor; below this the bar starts empty
const TEMP_BAR_MAX_F = 100;  // bar ceiling
const TEMP_BAR_PX = 60;

function dayLabel(dateStr: string): string {
  // Force UTC interpretation so a date string "2026-08-28" renders as the
  // 28th regardless of the renderer's local timezone.
  const d = new Date(`${dateStr}T12:00:00Z`);
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

const TEMP_BAR_TRACK_STYLE: React.CSSProperties = {
  position: "relative",
  height: 8,
  background: "#e5e7eb",
  borderRadius: 4,
  margin: "6px 0",
  overflow: "hidden",
};

function tempBarFillStyle(low: number, high: number): React.CSSProperties {
  const lowPct = Math.max(0, Math.min(1, (low - TEMP_BAR_MIN_F) / (TEMP_BAR_MAX_F - TEMP_BAR_MIN_F)));
  const highPct = Math.max(0, Math.min(1, (high - TEMP_BAR_MIN_F) / (TEMP_BAR_MAX_F - TEMP_BAR_MIN_F)));
  return {
    position: "absolute",
    left: `${lowPct * 100}%`,
    width: `${Math.max(2, (highPct - lowPct) * 100)}%`,
    top: 0,
    bottom: 0,
    background: "linear-gradient(90deg, #3b82f6 0%, #f59e0b 100%)",
    borderRadius: 4,
  } as const;
}

export function CruiseForecastChart(
  props: CruiseForecastChartProps,
): React.ReactElement {
  return (
    <div style={{ margin: "20px 0", overflow: "auto" }}>
      <table
        role="presentation"
        cellSpacing={0}
        cellPadding={0}
        style={{
          width: "100%",
          borderCollapse: "separate",
          borderSpacing: 6,
          tableLayout: "fixed",
        }}
      >
        <tbody>
          <tr>
            {props.forecast.map((day) => (
              <td
                key={`${day.date}-${day.port_name}`}
                style={{
                  background: "#f9fafb",
                  border: "1px solid #e5e7eb",
                  borderRadius: 8,
                  padding: "10px 8px",
                  textAlign: "center",
                  verticalAlign: "top",
                  fontSize: 12,
                  color: "#374151",
                  minWidth: TEMP_BAR_PX,
                }}
              >
                <div style={{ fontWeight: 700, color: "#1f2937", fontSize: 12 }}>
                  {dayLabel(day.date)}
                </div>
                <div
                  style={{
                    fontWeight: 600,
                    color: "#374151",
                    fontSize: 11,
                    margin: "4px 0",
                    minHeight: 26,
                    lineHeight: 1.2,
                  }}
                >
                  {day.port_name}
                </div>
                {day.high_f !== null && day.low_f !== null ? (
                  <>
                    <div style={TEMP_BAR_TRACK_STYLE}>
                      <div style={tempBarFillStyle(day.low_f, day.high_f)} />
                    </div>
                    <div style={{ fontWeight: 600, color: "#1f2937" }}>
                      {Math.round(day.low_f)}° / {Math.round(day.high_f)}°
                    </div>
                    <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>
                      {day.conditions ?? ""}
                    </div>
                  </>
                ) : (
                  <div style={{ fontSize: 11, color: "#9ca3af", fontStyle: "italic", marginTop: 8 }}>
                    Forecast pending
                  </div>
                )}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
      <p style={{ fontSize: 11, color: "#9ca3af", margin: "6px 0 0 0", textAlign: "right" }}>
        Weather data by{" "}
        <a href="https://open-meteo.com/" style={{ color: "#9ca3af" }}>
          Open-Meteo
        </a>{" "}
        (CC BY 4.0)
      </p>
    </div>
  );
}
