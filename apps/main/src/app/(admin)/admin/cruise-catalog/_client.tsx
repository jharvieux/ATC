"use client";

// #780 — Platform-admin cruise catalog management.
// Three tabs: Lines (add + toggle active), Ships (toggle active per line),
// Ports (add + toggle active). All mutations go through /api/admin/cruise-catalog/*.

import { useEffect, useState } from "react";
import { adminFetch } from "@/lib/admin-fetch";

// ── Types ──────────────────────────────────────────────────────────────────────

interface CruiseLine {
  id: string;
  slug: string;
  canonical_name: string;
  display_name: string;
  tier: "mainstream" | "premium" | "luxury";
  is_active: boolean;
  cruisemapper_slug: string;
  website_url: string | null;
}

interface CruiseShip {
  id: string;
  cruise_line_id: string;
  slug: string;
  canonical_name: string;
  ship_class: string | null;
  is_active: boolean;
  cruisemapper_slug: string;
}

interface Port {
  id: string;
  slug: string;
  canonical_name: string;
  country: string | null;
  region: string | null;
  is_active: boolean;
  cruisemapper_slug: string | null;
}

type Tab = "lines" | "ships" | "ports";
const TIERS = ["mainstream", "premium", "luxury"] as const;

// ── Main page ─────────────────────────────────────────────────────────────────

export default function CruiseCatalogPage(): JSX.Element {
  const [tab, setTab] = useState<Tab>("lines");

  return (
    <main className="px-6 py-8 max-w-[1000px] mx-auto">
      <h1 className="text-[26px] font-bold mb-1">Cruise Catalog</h1>
      <p className="text-muted-foreground text-[14px] mb-6">
        Manage canonical cruise lines, ships, and ports. Changes take effect on the next scraper run.
      </p>

      <div className="flex gap-2 mb-6 border-b border-border">
        {(["lines", "ships", "ports"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium capitalize border-b-2 -mb-px transition-colors ${
              tab === t
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "lines" && <LinesTab />}
      {tab === "ships" && <ShipsTab />}
      {tab === "ports" && <PortsTab />}
    </main>
  );
}

// ── Lines tab ─────────────────────────────────────────────────────────────────

function LinesTab(): JSX.Element {
  const [lines, setLines] = useState<CruiseLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ slug: "", canonical_name: "", display_name: "", tier: "mainstream", cruisemapper_slug: "", website_url: "" });

  async function load() {
    setLoading(true);
    const res = await adminFetch("/api/admin/cruise-catalog/lines");
    if (res.ok) setLines(((await res.json()) as { lines: CruiseLine[] }).lines);
    setLoading(false);
  }

  useEffect(() => { void load(); }, []);

  async function toggleActive(line: CruiseLine) {
    setBusy(line.id);
    setError(null);
    const res = await adminFetch(`/api/admin/cruise-catalog/lines/${line.id}`, {
      method: "PATCH",
      body: JSON.stringify({ is_active: !line.is_active }),
    });
    if (res.ok) {
      const updated = ((await res.json()) as { line: CruiseLine }).line;
      setLines((prev) => prev.map((l) => (l.id === updated.id ? updated : l)));
    } else {
      setError("Toggle failed");
    }
    setBusy(null);
  }

  async function addLine() {
    setBusy("add");
    setError(null);
    const res = await adminFetch("/api/admin/cruise-catalog/lines", {
      method: "POST",
      body: JSON.stringify({ ...form, website_url: form.website_url || undefined }),
    });
    if (res.ok) {
      const { line } = (await res.json()) as { line: CruiseLine };
      setLines((prev) => [...prev, line]);
      setForm({ slug: "", canonical_name: "", display_name: "", tier: "mainstream", cruisemapper_slug: "", website_url: "" });
      setShowAdd(false);
    } else {
      const d = (await res.json()) as { error?: string };
      setError(d.error ?? "Add failed");
    }
    setBusy(null);
  }

  if (loading) return <p className="text-muted-foreground text-sm">Loading…</p>;

  return (
    <div>
      {error && <p className="text-red-600 text-sm mb-3">{error}</p>}
      <table className="w-full text-sm border-collapse mb-4">
        <thead>
          <tr className="bg-muted text-left">
            <th className="px-3 py-2 border-b border-border">Name</th>
            <th className="px-3 py-2 border-b border-border">Tier</th>
            <th className="px-3 py-2 border-b border-border">CruiseMapper slug</th>
            <th className="px-3 py-2 border-b border-border">Active</th>
            <th className="px-3 py-2 border-b border-border"></th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.id} className="border-b border-muted">
              <td className="px-3 py-2 font-medium">{line.display_name}</td>
              <td className="px-3 py-2 text-muted-foreground capitalize">{line.tier}</td>
              <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{line.cruisemapper_slug}</td>
              <td className="px-3 py-2">
                <span className={line.is_active ? "text-green-600 dark:text-green-400" : "text-muted-foreground"}>
                  {line.is_active ? "Yes" : "No"}
                </span>
              </td>
              <td className="px-3 py-2">
                <button
                  disabled={busy === line.id}
                  onClick={() => void toggleActive(line)}
                  className="text-xs px-2 py-1 rounded border border-border hover:bg-muted disabled:opacity-50"
                >
                  {line.is_active ? "Disable" : "Enable"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {!showAdd && (
        <button
          onClick={() => setShowAdd(true)}
          className="text-sm px-3 py-1.5 rounded border border-border hover:bg-muted"
        >
          + Add cruise line
        </button>
      )}

      {showAdd && (
        <div className="border border-border rounded-lg p-4 mt-2 flex flex-col gap-3 max-w-[480px]">
          <h3 className="font-semibold text-sm">Add cruise line</h3>
          {(["slug", "canonical_name", "display_name", "cruisemapper_slug", "website_url"] as const).map((field) => (
            <label key={field} className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground capitalize">{field.replace(/_/g, " ")}</span>
              <input
                value={form[field]}
                onChange={(e) => setForm((f) => ({ ...f, [field]: e.target.value }))}
                className="border border-border rounded px-2 py-1.5 text-sm bg-background"
                placeholder={field === "website_url" ? "optional" : ""}
              />
            </label>
          ))}
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Tier</span>
            <select
              value={form.tier}
              onChange={(e) => setForm((f) => ({ ...f, tier: e.target.value }))}
              className="border border-border rounded px-2 py-1.5 text-sm bg-background"
            >
              {TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <div className="flex gap-2">
            <button
              disabled={busy === "add"}
              onClick={() => void addLine()}
              className="text-sm px-3 py-1.5 rounded bg-foreground text-background hover:opacity-90 disabled:opacity-50"
            >
              Add
            </button>
            <button onClick={() => setShowAdd(false)} className="text-sm px-3 py-1.5 rounded border border-border hover:bg-muted">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Ships tab ─────────────────────────────────────────────────────────────────

function ShipsTab(): JSX.Element {
  const [lines, setLines] = useState<CruiseLine[]>([]);
  const [ships, setShips] = useState<CruiseShip[]>([]);
  const [selectedLine, setSelectedLine] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    adminFetch("/api/admin/cruise-catalog/lines")
      .then((r) => r.json())
      .then((d) => {
        const ls = (d as { lines: CruiseLine[] }).lines;
        setLines(ls);
        if (ls.length > 0) setSelectedLine(ls[0]!.id);
      });
  }, []);

  useEffect(() => {
    if (!selectedLine) return;
    setLoading(true);
    adminFetch(`/api/admin/cruise-catalog/ships?line_id=${selectedLine}`)
      .then((r) => r.json())
      .then((d) => { setShips((d as { ships: CruiseShip[] }).ships); setLoading(false); });
  }, [selectedLine]);

  async function toggleActive(ship: CruiseShip) {
    setBusy(ship.id);
    setError(null);
    const res = await adminFetch(`/api/admin/cruise-catalog/ships/${ship.id}`, {
      method: "PATCH",
      body: JSON.stringify({ is_active: !ship.is_active }),
    });
    if (res.ok) {
      const updated = ((await res.json()) as { ship: CruiseShip }).ship;
      setShips((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    } else {
      setError("Toggle failed");
    }
    setBusy(null);
  }

  return (
    <div>
      {error && <p className="text-red-600 text-sm mb-3">{error}</p>}
      <div className="mb-4">
        <label className="text-sm text-muted-foreground mr-2">Cruise line:</label>
        <select
          value={selectedLine}
          onChange={(e) => setSelectedLine(e.target.value)}
          className="border border-border rounded px-2 py-1.5 text-sm bg-background"
        >
          {lines.map((l) => <option key={l.id} value={l.id}>{l.display_name}</option>)}
        </select>
      </div>
      {loading ? (
        <p className="text-muted-foreground text-sm">Loading…</p>
      ) : ships.length === 0 ? (
        <p className="text-muted-foreground text-sm">No ships found for this line. Run the scraper to populate.</p>
      ) : (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-muted text-left">
              <th className="px-3 py-2 border-b border-border">Ship</th>
              <th className="px-3 py-2 border-b border-border">Class</th>
              <th className="px-3 py-2 border-b border-border">Active</th>
              <th className="px-3 py-2 border-b border-border"></th>
            </tr>
          </thead>
          <tbody>
            {ships.map((ship) => (
              <tr key={ship.id} className="border-b border-muted">
                <td className="px-3 py-2 font-medium">{ship.canonical_name}</td>
                <td className="px-3 py-2 text-muted-foreground">{ship.ship_class ?? "—"}</td>
                <td className="px-3 py-2">
                  <span className={ship.is_active ? "text-green-600 dark:text-green-400" : "text-muted-foreground"}>
                    {ship.is_active ? "Yes" : "No"}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <button
                    disabled={busy === ship.id}
                    onClick={() => void toggleActive(ship)}
                    className="text-xs px-2 py-1 rounded border border-border hover:bg-muted disabled:opacity-50"
                  >
                    {ship.is_active ? "Disable" : "Enable"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Ports tab ─────────────────────────────────────────────────────────────────

function PortsTab(): JSX.Element {
  const [ports, setPorts] = useState<Port[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ slug: "", canonical_name: "", country: "", region: "", cruisemapper_slug: "" });

  async function load() {
    setLoading(true);
    const res = await adminFetch("/api/admin/cruise-catalog/ports");
    if (res.ok) setPorts(((await res.json()) as { ports: Port[] }).ports);
    setLoading(false);
  }

  useEffect(() => { void load(); }, []);

  async function toggleActive(port: Port) {
    setBusy(port.id);
    setError(null);
    const res = await adminFetch(`/api/admin/cruise-catalog/ports/${port.id}`, {
      method: "PATCH",
      body: JSON.stringify({ is_active: !port.is_active }),
    });
    if (res.ok) {
      const updated = ((await res.json()) as { port: Port }).port;
      setPorts((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    } else {
      setError("Toggle failed");
    }
    setBusy(null);
  }

  async function addPort() {
    setBusy("add");
    setError(null);
    const res = await adminFetch("/api/admin/cruise-catalog/ports", {
      method: "POST",
      body: JSON.stringify({
        slug: form.slug,
        canonical_name: form.canonical_name,
        country: form.country || undefined,
        region: form.region || undefined,
        cruisemapper_slug: form.cruisemapper_slug || undefined,
      }),
    });
    if (res.ok) {
      const { port } = (await res.json()) as { port: Port };
      setPorts((prev) => [...prev, port].sort((a, b) => a.canonical_name.localeCompare(b.canonical_name)));
      setForm({ slug: "", canonical_name: "", country: "", region: "", cruisemapper_slug: "" });
      setShowAdd(false);
    } else {
      const d = (await res.json()) as { error?: string };
      setError(d.error ?? "Add failed");
    }
    setBusy(null);
  }

  if (loading) return <p className="text-muted-foreground text-sm">Loading…</p>;

  return (
    <div>
      {error && <p className="text-red-600 text-sm mb-3">{error}</p>}
      <table className="w-full text-sm border-collapse mb-4">
        <thead>
          <tr className="bg-muted text-left">
            <th className="px-3 py-2 border-b border-border">Port</th>
            <th className="px-3 py-2 border-b border-border">Country</th>
            <th className="px-3 py-2 border-b border-border">Region</th>
            <th className="px-3 py-2 border-b border-border">Active</th>
            <th className="px-3 py-2 border-b border-border"></th>
          </tr>
        </thead>
        <tbody>
          {ports.map((port) => (
            <tr key={port.id} className="border-b border-muted">
              <td className="px-3 py-2 font-medium">{port.canonical_name}</td>
              <td className="px-3 py-2 text-muted-foreground">{port.country ?? "—"}</td>
              <td className="px-3 py-2 text-muted-foreground">{port.region ?? "—"}</td>
              <td className="px-3 py-2">
                <span className={port.is_active ? "text-green-600 dark:text-green-400" : "text-muted-foreground"}>
                  {port.is_active ? "Yes" : "No"}
                </span>
              </td>
              <td className="px-3 py-2">
                <button
                  disabled={busy === port.id}
                  onClick={() => void toggleActive(port)}
                  className="text-xs px-2 py-1 rounded border border-border hover:bg-muted disabled:opacity-50"
                >
                  {port.is_active ? "Disable" : "Enable"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {!showAdd && (
        <button
          onClick={() => setShowAdd(true)}
          className="text-sm px-3 py-1.5 rounded border border-border hover:bg-muted"
        >
          + Add port
        </button>
      )}

      {showAdd && (
        <div className="border border-border rounded-lg p-4 mt-2 flex flex-col gap-3 max-w-[480px]">
          <h3 className="font-semibold text-sm">Add port</h3>
          {(["slug", "canonical_name", "country", "region", "cruisemapper_slug"] as const).map((field) => (
            <label key={field} className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground capitalize">{field.replace(/_/g, " ")}</span>
              <input
                value={form[field]}
                onChange={(e) => setForm((f) => ({ ...f, [field]: e.target.value }))}
                className="border border-border rounded px-2 py-1.5 text-sm bg-background"
                placeholder={["country", "region", "cruisemapper_slug"].includes(field) ? "optional" : ""}
              />
            </label>
          ))}
          <div className="flex gap-2">
            <button
              disabled={busy === "add"}
              onClick={() => void addPort()}
              className="text-sm px-3 py-1.5 rounded bg-foreground text-background hover:opacity-90 disabled:opacity-50"
            >
              Add
            </button>
            <button onClick={() => setShowAdd(false)} className="text-sm px-3 py-1.5 rounded border border-border hover:bg-muted">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
