// BP36 §36.3 — shared report filter parsing.

export type Grouping = "day" | "week" | "month" | "quarter";

export type ReportFilters = {
  start: string; // ISO date YYYY-MM-DD
  end: string;
  grouping: Grouping;
  agent_user_id: string | null;
};

const DEFAULT_TRAILING_DAYS = 90;
const MAX_RANGE_DAYS = 366 * 7; // 7 years — beyond §25 retention horizon anyway

export function parseReportFilters(url: URL): ReportFilters | { error: string } {
  const startParam = url.searchParams.get("start");
  const endParam = url.searchParams.get("end");
  const groupingParam = url.searchParams.get("grouping");
  const agent = url.searchParams.get("agent_user_id");

  const now = new Date();
  const end = endParam ? toDateOrNull(endParam) : isoDate(now);
  const start = startParam
    ? toDateOrNull(startParam)
    : isoDate(new Date(now.getTime() - DEFAULT_TRAILING_DAYS * 24 * 60 * 60 * 1000));

  if (!start || !end) return { error: "invalid_date_format (expect YYYY-MM-DD)" };
  if (Date.parse(start) > Date.parse(end)) return { error: "start_after_end" };
  const spanDays = Math.round((Date.parse(end) - Date.parse(start)) / (24 * 60 * 60 * 1000));
  if (spanDays > MAX_RANGE_DAYS) return { error: `range_too_large:${spanDays}d` };

  // Default grouping: day for ranges <= 30d, month otherwise.
  const grouping: Grouping = groupingParam
    ? (groupingParam as Grouping)
    : spanDays <= 30
    ? "day"
    : "month";
  if (!["day", "week", "month", "quarter"].includes(grouping)) {
    return { error: `invalid_grouping:${grouping}` };
  }

  return { start, end, grouping, agent_user_id: agent };
}

function toDateOrNull(v: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
