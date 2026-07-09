"use client";

// Admin Console home dashboard. Replaces the old card-grid that just
// duplicated the sidebar. Binds real workspace data from /api/tenant/dashboard:
// this-month stats, setup-checklist completion, recent activity, plan + health.
//
// Colors come exclusively from the --ta-* design tokens (inline styles) so the
// page tracks the console's light/dark theme. Those tokens only resolve under a
// [data-ta-theme] ancestor, so the root wrapper carries the attribute and syncs
// it to next-themes' resolvedTheme. The hero card is the one exception — it's a
// fixed dark navy gradient (always-white text) regardless of theme.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTheme } from "next-themes";
import { formatDate } from "@/lib/format-date";
import {
  Users,
  Bot,
  Palette,
  CreditCard,
  Check,
  MessageSquare,
  Sparkles,
  Gauge,
  AlertTriangle,
  ShieldCheck,
} from "lucide-react";

interface DashboardData {
  workspace: { name: string; owner_first_name: string; date: string };
  stats: {
    conversations_this_month: number;
    conversations_prev_month: number;
    ai_messages_this_month: number;
    chat_limit_used: number;
    chat_limit_cap: number;
    chat_limit_reset_date: string;
    seat_count: number;
    seats_in_use: number;
  };
  setup: {
    host_connected: boolean;
    branding_set: boolean;
    personas_customized: boolean;
    team_member_invited: boolean;
    email_templates_set: boolean;
    ai_mode_set: boolean;
  };
  activity: Array<{ id: string; action: string; description: string; created_at: string }>;
  plan: {
    tier_code: string | null;
    tier_name: string | null;
    price_monthly: number | null;
    billing_period: string | null;
    status: string;
  };
}

const MONO = "var(--font-geist-mono, monospace)";

function formatLongDate(iso: string): string {
  return formatDate(iso, "long");
}

function formatShortDate(iso: string | null): string {
  return formatDate(iso, "short");
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(iso, "short");
}

export default function ConsoleHomePage(): JSX.Element {
  const { resolvedTheme } = useTheme();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    void load();
  }, []);

  async function load(): Promise<void> {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch("/api/tenant/dashboard");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as DashboardData);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  const taTheme = resolvedTheme === "light" ? "light" : "dark";

  return (
    <div
      data-ta-theme={taTheme}
      style={{
        background: "var(--ta-bg)",
        color: "var(--ta-text)",
        minHeight: "100%",
        transition: "background .3s, color .3s",
      }}
    >
      <main
        style={{
          maxWidth: 1100,
          margin: "0 auto",
          padding: "28px 32px",
          display: "flex",
          flexDirection: "column",
          gap: 24,
        }}
      >
        {error ? (
          <ErrorState onRetry={() => void load()} />
        ) : loading || !data ? (
          <DashboardSkeleton />
        ) : (
          <Dashboard data={data} />
        )}
      </main>
    </div>
  );
}

function Dashboard({ data }: { data: DashboardData }): JSX.Element {
  const { workspace, stats, setup, activity, plan } = data;

  const setupSteps = [
    { key: "host", label: "Connect your host", href: "/settings/host-integration", done: setup.host_connected },
    { key: "branding", label: "Set up branding", href: "/settings/branding", done: setup.branding_set },
    { key: "personas", label: "Customize AI personas", href: "/settings/personas", done: setup.personas_customized },
    { key: "team", label: "Invite a team member", href: "/settings/users", done: setup.team_member_invited },
    { key: "email", label: "Configure email templates", href: "/settings/email-templates", done: setup.email_templates_set },
    { key: "ai", label: "Choose AI mode", href: "/settings/ai-mode", done: setup.ai_mode_set },
  ];
  const completeCount = setupSteps.filter((s) => s.done).length;
  const setupComplete = completeCount === setupSteps.length;
  const setupPct = Math.round((completeCount / setupSteps.length) * 100);

  return (
    <>
      <Hero workspace={workspace} />

      <StatRow stats={stats} />

      <div style={{ display: "grid", gridTemplateColumns: setupComplete ? "1fr" : "1.4fr 1fr", gap: 24 }}>
        {!setupComplete && (
          <SetupCard steps={setupSteps} completeCount={completeCount} total={setupSteps.length} pct={setupPct} />
        )}
        <QuickActions />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 24 }}>
        <RecentActivity activity={activity} />
        <PlanHealth plan={plan} setup={setup} />
      </div>
    </>
  );
}

function Hero({ workspace }: { workspace: DashboardData["workspace"] }): JSX.Element {
  return (
    <section
      style={{
        position: "relative",
        overflow: "hidden",
        background: "linear-gradient(135deg, #0A2342 0%, #12395f 65%)",
        borderRadius: 18,
        padding: "32px 36px",
        color: "#ffffff",
      }}
    >
      <svg
        aria-hidden
        width="280"
        height="280"
        viewBox="0 0 280 280"
        style={{ position: "absolute", top: -70, right: -50, opacity: 0.08 }}
      >
        {[40, 75, 110, 140].map((r) => (
          <circle key={r} cx="140" cy="140" r={r} fill="none" stroke="#ffffff" strokeWidth="2" />
        ))}
      </svg>

      <div
        style={{
          fontFamily: MONO,
          fontSize: 12,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          color: "rgba(255,255,255,0.7)",
          marginBottom: 10,
        }}
      >
        {workspace.name} · {formatLongDate(workspace.date)}
      </div>
      <h1 style={{ fontSize: 28, fontWeight: 700, margin: 0, marginBottom: 8 }}>
        Welcome back, {workspace.owner_first_name}.
      </h1>
      <p style={{ fontSize: 15, color: "rgba(255,255,255,0.82)", margin: 0, marginBottom: 22, maxWidth: 520 }}>
        Your AI concierge is active and ready to assist your clients.
      </p>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <Link
          href="/"
          style={{
            background: "var(--ta-accent)",
            color: "var(--ta-accent-ink)",
            padding: "10px 18px",
            borderRadius: 10,
            fontSize: 14,
            fontWeight: 600,
            textDecoration: "none",
          }}
        >
          Open agent console
        </Link>
        <Link
          href="/settings/users"
          style={{
            background: "transparent",
            color: "#ffffff",
            padding: "10px 18px",
            borderRadius: 10,
            fontSize: 14,
            fontWeight: 600,
            textDecoration: "none",
            border: "1px solid rgba(255,255,255,0.4)",
          }}
        >
          Invite a team member
        </Link>
      </div>
    </section>
  );
}

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }): JSX.Element {
  return (
    <div
      style={{
        background: "var(--ta-surface)",
        border: "1px solid var(--ta-border)",
        borderRadius: 13,
        padding: 20,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// Rough desk-time-saved estimate. Not an empirical measurement — surfaced to
// the tenant explicitly as an estimate (see the "estimated" label below) so the
// basis is transparent. Single-sourced here so the math and label never drift.
const EST_DESK_MINUTES_PER_AI_MESSAGE = 2;

function StatRow({ stats }: { stats: DashboardData["stats"] }): JSX.Element {
  const trend =
    stats.conversations_prev_month > 0
      ? Math.round(
          ((stats.conversations_this_month - stats.conversations_prev_month) /
            stats.conversations_prev_month) *
            100,
        )
      : null;

  const hoursSaved = ((stats.ai_messages_this_month * EST_DESK_MINUTES_PER_AI_MESSAGE) / 60).toFixed(1);

  const chatPct =
    stats.chat_limit_cap > 0 ? Math.min(100, Math.round((stats.chat_limit_used / stats.chat_limit_cap) * 100)) : 0;
  const chatNearLimit = chatPct >= 80;

  const seatPct =
    stats.seat_count > 0 ? Math.min(100, Math.round((stats.seats_in_use / stats.seat_count) * 100)) : 0;
  const seatsAvailable = Math.max(0, stats.seat_count - stats.seats_in_use);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
      <StatCard icon={<MessageSquare size={18} />} label="Conversations this month">
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span style={{ fontFamily: MONO, fontSize: 26, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
            {stats.conversations_this_month}
          </span>
          {trend !== null && (
            <span
              style={{
                fontFamily: MONO,
                fontSize: 12,
                fontWeight: 600,
                color: trend >= 0 ? "var(--ta-green)" : "var(--ta-amber)",
              }}
            >
              {trend >= 0 ? "▲" : "▼"} {Math.abs(trend)}%
            </span>
          )}
        </div>
      </StatCard>

      <StatCard icon={<Sparkles size={18} />} label="AI messages">
        <div style={{ fontFamily: MONO, fontSize: 26, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
          {stats.ai_messages_this_month}
        </div>
        <div style={{ fontFamily: MONO, fontSize: 12, color: "var(--ta-text-mute)", marginTop: 4 }}>
          ~{hoursSaved} hrs estimated (≈{EST_DESK_MINUTES_PER_AI_MESSAGE} min/msg)
        </div>
      </StatCard>

      <StatCard icon={<Gauge size={18} />} label="Chat limit">
        <div style={{ fontFamily: MONO, fontSize: 22, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
          {stats.chat_limit_used}/{stats.chat_limit_cap > 0 ? stats.chat_limit_cap : "∞"}
        </div>
        {stats.chat_limit_cap > 0 && (
          <ProgressBar pct={chatPct} color={chatNearLimit ? "var(--ta-amber)" : "var(--ta-accent)"} />
        )}
        <div style={{ fontFamily: MONO, fontSize: 11, color: "var(--ta-text-mute)", marginTop: 6 }}>
          resets {formatShortDate(stats.chat_limit_reset_date)}
        </div>
      </StatCard>

      <StatCard icon={<Users size={18} />} label="Team">
        <div style={{ fontFamily: MONO, fontSize: 22, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
          {stats.seats_in_use}/{stats.seat_count}
        </div>
        <ProgressBar pct={seatPct} color="var(--ta-accent)" />
        <div style={{ fontFamily: MONO, fontSize: 11, color: "var(--ta-text-mute)", marginTop: 6 }}>
          {seatsAvailable} seats available
        </div>
      </StatCard>
    </div>
  );
}

function StatCard({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <Card style={{ borderRadius: 13 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--ta-text-mute)", marginBottom: 10 }}>
        {icon}
        <span style={{ fontSize: 12, fontWeight: 600 }}>{label}</span>
      </div>
      {children}
    </Card>
  );
}

function ProgressBar({ pct, color }: { pct: number; color: string }): JSX.Element {
  return (
    <div style={{ height: 6, borderRadius: 4, background: "var(--ta-border)", marginTop: 8, overflow: "hidden" }}>
      <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 4 }} />
    </div>
  );
}

function SetupCard({
  steps,
  completeCount,
  total,
  pct,
}: {
  steps: Array<{ key: string; label: string; href: string; done: boolean }>;
  completeCount: number;
  total: number;
  pct: number;
}): JSX.Element {
  return (
    <Card>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>Finish setting up your workspace</h2>
        <span
          style={{
            fontFamily: MONO,
            fontSize: 12,
            fontWeight: 600,
            color: "var(--ta-text-soft)",
            background: "var(--ta-surface-2)",
            border: "1px solid var(--ta-border)",
            borderRadius: 999,
            padding: "2px 10px",
          }}
        >
          {completeCount}/{total} complete
        </span>
      </div>
      <ProgressBar pct={pct} color="var(--ta-accent)" />

      <ul style={{ listStyle: "none", margin: "16px 0 0", padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
        {steps.map((step) => (
          <li
            key={step.key}
            style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderTop: "1px solid var(--ta-border)" }}
          >
            <span
              style={{
                width: 22,
                height: 22,
                borderRadius: 999,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
                background: step.done ? "var(--ta-green)" : "transparent",
                border: step.done ? "none" : "1.5px solid var(--ta-border-2)",
                color: step.done ? "#04121F" : "var(--ta-text-mute)",
              }}
            >
              {step.done && <Check size={13} strokeWidth={3} />}
            </span>
            <span style={{ flex: 1, fontSize: 14, color: step.done ? "var(--ta-text-mute)" : "var(--ta-text)" }}>
              {step.label}
            </span>
            {!step.done && (
              <Link
                href={step.href}
                style={{ fontSize: 13, fontWeight: 600, color: "var(--ta-accent)", textDecoration: "none" }}
              >
                Configure →
              </Link>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function QuickActions(): JSX.Element {
  const actions = [
    { label: "Invite a member", href: "/settings/users", icon: <Users size={18} /> },
    { label: "Edit AI personas", href: "/settings/personas", icon: <Bot size={18} /> },
    { label: "Update branding", href: "/settings/branding", icon: <Palette size={18} /> },
    { label: "Manage billing", href: "/settings/billing", icon: <CreditCard size={18} /> },
    { label: "Content safety", href: "/tenant-admin/safety", icon: <ShieldCheck size={18} /> },
  ];
  return (
    <Card>
      <h2 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 14px" }}>Quick actions</h2>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        {actions.map((a) => (
          <QuickActionTile key={a.href} {...a} />
        ))}
      </div>
    </Card>
  );
}

function QuickActionTile({
  label,
  href,
  icon,
}: {
  label: string;
  href: string;
  icon: React.ReactNode;
}): JSX.Element {
  const [hover, setHover] = useState(false);
  return (
    <Link
      href={href}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: 16,
        borderRadius: 10,
        background: "var(--ta-surface-2)",
        border: `1px solid ${hover ? "var(--ta-accent)" : "var(--ta-border)"}`,
        boxShadow: hover ? "0 4px 12px rgba(0,0,0,0.08)" : "none",
        textDecoration: "none",
        color: "var(--ta-text)",
        transition: "border-color .15s, box-shadow .15s",
      }}
    >
      <span style={{ color: "var(--ta-accent)" }}>{icon}</span>
      <span style={{ fontSize: 14, fontWeight: 600 }}>{label}</span>
    </Link>
  );
}

const ACTIVITY_DOT_COLORS = ["var(--ta-accent)", "var(--ta-green)", "var(--ta-amber)"];

function RecentActivity({ activity }: { activity: DashboardData["activity"] }): JSX.Element {
  return (
    <Card>
      <h2 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 14px" }}>Recent activity</h2>
      {activity.length === 0 ? (
        <p style={{ fontSize: 14, color: "var(--ta-text-mute)", margin: 0 }}>
          Nothing yet — your AI crew&apos;s actions will appear here.
        </p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 2 }}>
          {activity.map((ev, i) => (
            <li
              key={ev.id}
              style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 0", borderTop: i === 0 ? "none" : "1px solid var(--ta-border)" }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  flexShrink: 0,
                  background: ACTIVITY_DOT_COLORS[i % ACTIVITY_DOT_COLORS.length],
                }}
              />
              <span style={{ flex: 1, fontSize: 14 }}>{ev.description}</span>
              <span style={{ fontFamily: MONO, fontSize: 12, color: "var(--ta-text-mute)" }}>
                {relativeTime(ev.created_at)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function PlanHealth({
  plan,
  setup,
}: {
  plan: DashboardData["plan"];
  setup: DashboardData["setup"];
}): JSX.Element {
  const healthItems = [
    { label: "Host connected", ok: setup.host_connected, href: "/settings/host-integration" },
    { label: "Branding set", ok: setup.branding_set, href: "/settings/branding" },
    { label: "AI mode chosen", ok: setup.ai_mode_set, href: "/settings/ai-mode" },
  ];

  return (
    <Card>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span
          style={{
            fontFamily: MONO,
            fontSize: 11,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            color: "var(--ta-accent-ink)",
            background: "var(--ta-accent)",
            borderRadius: 6,
            padding: "2px 8px",
          }}
        >
          {plan.tier_code ?? "plan"}
        </span>
        <span style={{ fontSize: 15, fontWeight: 700 }}>{plan.tier_name ?? "Current plan"}</span>
      </div>
      <div style={{ fontFamily: MONO, fontSize: 13, color: "var(--ta-text-soft)", marginBottom: 14 }}>
        {plan.price_monthly != null ? `$${plan.price_monthly}/mo` : "—"}
        {plan.billing_period ? ` · ${plan.billing_period}` : ""} · {plan.status}
      </div>

      <Link
        href="/settings/billing"
        style={{
          display: "inline-block",
          background: "var(--ta-accent)",
          color: "var(--ta-accent-ink)",
          padding: "8px 14px",
          borderRadius: 9,
          fontSize: 13,
          fontWeight: 600,
          textDecoration: "none",
        }}
      >
        Upgrade plan
      </Link>

      <div style={{ height: 1, background: "var(--ta-border)", margin: "16px 0" }} />

      <h3 style={{ fontSize: 13, fontWeight: 700, margin: "0 0 10px", color: "var(--ta-text-soft)" }}>
        Workspace health
      </h3>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
        {healthItems.map((h) => (
          <li key={h.label} style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {h.ok ? (
              <Check size={15} strokeWidth={3} style={{ color: "var(--ta-green)", flexShrink: 0 }} />
            ) : (
              <AlertTriangle size={15} style={{ color: "var(--ta-amber)", flexShrink: 0 }} />
            )}
            <span style={{ flex: 1, fontSize: 14 }}>{h.label}</span>
            {!h.ok && (
              <Link
                href={h.href}
                style={{ fontSize: 13, fontWeight: 600, color: "var(--ta-accent)", textDecoration: "none" }}
              >
                Configure →
              </Link>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ErrorState({ onRetry }: { onRetry: () => void }): JSX.Element {
  return (
    <Card style={{ textAlign: "center", padding: 40 }}>
      <p style={{ fontSize: 15, margin: "0 0 16px", color: "var(--ta-text-soft)" }}>
        Could not load dashboard data.
      </p>
      <button
        type="button"
        onClick={onRetry}
        style={{
          background: "var(--ta-accent)",
          color: "var(--ta-accent-ink)",
          border: "none",
          padding: "9px 18px",
          borderRadius: 9,
          fontSize: 14,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        Retry
      </button>
    </Card>
  );
}

function Skel({ style }: { style?: React.CSSProperties }): JSX.Element {
  return <div style={{ background: "var(--ta-surface-2)", borderRadius: 6, ...style }} />;
}

function DashboardSkeleton(): JSX.Element {
  return (
    <>
      <div className="animate-pulse">
        <Skel style={{ height: 190, borderRadius: 18 }} />
      </div>
      <div className="animate-pulse" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
        {[0, 1, 2, 3].map((i) => (
          <Card key={i}>
            <Skel style={{ height: 14, width: "60%", marginBottom: 14 }} />
            <Skel style={{ height: 28, width: "40%" }} />
          </Card>
        ))}
      </div>
      <div className="animate-pulse" style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 24 }}>
        <Card>
          <Skel style={{ height: 16, width: "50%", marginBottom: 18 }} />
          {[0, 1, 2, 3, 4].map((i) => (
            <Skel key={i} style={{ height: 18, marginBottom: 12 }} />
          ))}
        </Card>
        <Card>
          <Skel style={{ height: 16, width: "40%", marginBottom: 18 }} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {[0, 1, 2, 3].map((i) => (
              <Skel key={i} style={{ height: 70 }} />
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}
