"use client";

// #783 Phase 3 — cascading dropdowns for connected group-booking creation.
// Line → Ship → Sailing; selecting a sailing auto-fills sailing date,
// departure port, and shows a ports-of-call preview.

import * as React from "react";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MAX_INVITEES_PER_GROUP } from "@/lib/groups/constants";

interface CruiseLine {
  id: string;
  display_name: string;
}

interface CruiseShip {
  id: string;
  canonical_name: string;
  ship_class: string | null;
}

interface CruiseSailing {
  id: string;
  departure_date: string;
  departure_port: string;
  duration_nights: number;
  region: string | null;
  starting_price: number | null;
  ports: string[];
}

interface InviteeRow {
  email: string;
  name: string;
}

interface CatalogState {
  lines: CruiseLine[];
  ships: CruiseShip[];
  sailings: CruiseSailing[];
}

interface SelectionState {
  selectedLineId: string;
  selectedShipId: string;
  selectedSailingId: string;
  selectedSailing: CruiseSailing | null;
}

interface FormState {
  maxCabins: string;
  coordinatorMessage: string;
  invitees: InviteeRow[];
}

interface UiState {
  loadingShips: boolean;
  loadingSailings: boolean;
  submitting: boolean;
  error: string | null;
}

export function CreateGroupClient(): React.ReactElement {
  const router = useRouter();

  // #1812 — the 15 useState hooks (fetched catalog data, cascading line/ship/
  // sailing selection, group-settings form, loading/submit UI) are grouped
  // into 4 state objects by concern, one useState each, matching the pattern
  // established in #1791.
  const [catalog, setCatalog] = useState<CatalogState>({ lines: [], ships: [], sailings: [] });
  const [selection, setSelection] = useState<SelectionState>({
    selectedLineId: "", selectedShipId: "", selectedSailingId: "", selectedSailing: null,
  });
  const [form, setForm] = useState<FormState>({
    maxCabins: "", coordinatorMessage: "", invitees: [{ email: "", name: "" }],
  });
  const [ui, setUi] = useState<UiState>({
    loadingShips: false, loadingSailings: false, submitting: false, error: null,
  });

  const loadLines = useCallback(async () => {
    const res = await fetch("/api/cruise-lines");
    if (!res.ok) { setUi((u) => ({ ...u, error: `Could not load cruise lines (${res.status})` })); return; }
    const json = await res.json() as { lines: CruiseLine[] };
    setCatalog((c) => ({ ...c, lines: json.lines ?? [] }));
  }, []);

  useEffect(() => { void loadLines(); }, [loadLines]);

  const loadShips = useCallback(async (lineId: string) => {
    if (!lineId) { setCatalog((c) => ({ ...c, ships: [] })); return; }
    setUi((u) => ({ ...u, loadingShips: true }));
    try {
      const res = await fetch(`/api/cruise-ships?cruise_line_id=${encodeURIComponent(lineId)}`);
      if (!res.ok) { setUi((u) => ({ ...u, error: `Could not load ships (${res.status})` })); return; }
      const json = await res.json() as { ships: CruiseShip[] };
      setCatalog((c) => ({ ...c, ships: json.ships ?? [] }));
    } finally {
      setUi((u) => ({ ...u, loadingShips: false }));
    }
  }, []);

  const loadSailings = useCallback(async (shipId: string) => {
    if (!shipId) { setCatalog((c) => ({ ...c, sailings: [] })); return; }
    setUi((u) => ({ ...u, loadingSailings: true }));
    try {
      const res = await fetch(`/api/cruise-sailings?cruise_ship_id=${encodeURIComponent(shipId)}`);
      if (!res.ok) { setUi((u) => ({ ...u, error: `Could not load sailings (${res.status})` })); return; }
      const json = await res.json() as { sailings: CruiseSailing[] };
      setCatalog((c) => ({ ...c, sailings: json.sailings ?? [] }));
    } finally {
      setUi((u) => ({ ...u, loadingSailings: false }));
    }
  }, []);

  function handleLineChange(lineId: string): void {
    setSelection({ selectedLineId: lineId, selectedShipId: "", selectedSailingId: "", selectedSailing: null });
    setCatalog((c) => ({ ...c, ships: [], sailings: [] }));
    void loadShips(lineId);
  }

  function handleShipChange(shipId: string): void {
    setSelection((s) => ({ ...s, selectedShipId: shipId, selectedSailingId: "", selectedSailing: null }));
    setCatalog((c) => ({ ...c, sailings: [] }));
    void loadSailings(shipId);
  }

  function handleSailingChange(sailingId: string): void {
    const found = catalog.sailings.find((s) => s.id === sailingId) ?? null;
    setSelection((s) => ({ ...s, selectedSailingId: sailingId, selectedSailing: found }));
  }

  function addInvitee(): void {
    setForm((f) => ({ ...f, invitees: [...f.invitees, { email: "", name: "" }] }));
  }

  function removeInvitee(idx: number): void {
    setForm((f) => ({ ...f, invitees: f.invitees.filter((_, i) => i !== idx) }));
  }

  function updateInvitee(idx: number, field: keyof InviteeRow, value: string): void {
    setForm((f) => ({
      ...f,
      invitees: f.invitees.map((row, i) => i === idx ? { ...row, [field]: value } : row),
    }));
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setUi((u) => ({ ...u, error: null }));

    const selectedLine = catalog.lines.find((l) => l.id === selection.selectedLineId);
    const selectedShip = catalog.ships.find((s) => s.id === selection.selectedShipId);
    const { selectedSailing } = selection;

    if (!selectedLine || !selectedShip || !selectedSailing) {
      setUi((u) => ({ ...u, error: "Please select a cruise line, ship, and sailing." }));
      return;
    }

    const validInvitees = form.invitees.filter((r) => r.email.trim().length > 0);
    if (validInvitees.length > MAX_INVITEES_PER_GROUP) {
      setUi((u) => ({ ...u, error: `Maximum ${MAX_INVITEES_PER_GROUP} invitees per group.` }));
      return;
    }

    setUi((u) => ({ ...u, submitting: true }));
    try {
      const res = await fetch("/api/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cruise_line: selectedLine.display_name,
          ship_name: selectedShip.canonical_name,
          sailing_date: selectedSailing.departure_date,
          departure_port: selectedSailing.departure_port,
          sailing_id: selectedSailing.id,
          ...(form.maxCabins.trim() !== "" && { max_cabins: Number(form.maxCabins) }),
          ...(form.coordinatorMessage.trim() !== "" && { coordinator_message: form.coordinatorMessage.trim() }),
          invitees: validInvitees.map((r) => ({
            email: r.email.trim(),
            ...(r.name.trim() !== "" && { name: r.name.trim() }),
          })),
        }),
      });

      if (!res.ok) {
        const json = await res.json() as { error?: string };
        setUi((u) => ({ ...u, error: json.error ?? `Error ${res.status}` }));
        return;
      }

      const json = await res.json() as { group_id: string };
      router.push(`/groups/${json.group_id}/coordinate/overview`);
    } catch (err) {
      setUi((u) => ({ ...u, error: err instanceof Error ? err.message : "Unexpected error" }));
    } finally {
      setUi((u) => ({ ...u, submitting: false }));
    }
  }

  const { lines, ships, sailings } = catalog;
  const { selectedLineId, selectedShipId, selectedSailingId, selectedSailing } = selection;
  const { maxCabins, coordinatorMessage, invitees } = form;
  const { loadingShips, loadingSailings, submitting, error } = ui;

  return (
    <form onSubmit={(e) => { void handleSubmit(e); }} className="flex flex-col gap-6 max-w-2xl">
      {error && (
        <p className="text-[14px] text-red-600 bg-red-50 border border-red-200 rounded p-3">{error}</p>
      )}

      {/* Cascade: line → ship → sailing */}
      <section className="flex flex-col gap-4">
        <h3 className="text-[15px] font-semibold">Select your sailing</h3>

        <div className="flex flex-col gap-1">
          <Label htmlFor="cruise_line">Cruise Line</Label>
          <select
            id="cruise_line"
            className="border border-input rounded-md h-9 px-3 text-[14px] bg-background"
            value={selectedLineId}
            onChange={(e) => handleLineChange(e.target.value)}
            required
          >
            <option value="">— Select a cruise line —</option>
            {lines.map((l) => (
              <option key={l.id} value={l.id}>{l.display_name}</option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="cruise_ship">Ship</Label>
          <select
            id="cruise_ship"
            className="border border-input rounded-md h-9 px-3 text-[14px] bg-background disabled:opacity-50"
            value={selectedShipId}
            onChange={(e) => handleShipChange(e.target.value)}
            disabled={!selectedLineId || loadingShips}
            required
          >
            <option value="">
              {loadingShips ? "Loading…" : selectedLineId ? "— Select a ship —" : "— Select a cruise line first —"}
            </option>
            {ships.map((s) => (
              <option key={s.id} value={s.id}>
                {s.canonical_name}{s.ship_class ? ` (${s.ship_class})` : ""}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="sailing">Sailing Date</Label>
          <select
            id="sailing"
            className="border border-input rounded-md h-9 px-3 text-[14px] bg-background disabled:opacity-50"
            value={selectedSailingId}
            onChange={(e) => handleSailingChange(e.target.value)}
            disabled={!selectedShipId || loadingSailings}
            required
          >
            <option value="">
              {loadingSailings ? "Loading…" : selectedShipId ? "— Select a sailing —" : "— Select a ship first —"}
            </option>
            {sailings.map((s) => (
              <option key={s.id} value={s.id}>
                {s.departure_date} — {s.departure_port} — {s.duration_nights}n
                {s.starting_price != null ? ` from $${s.starting_price.toFixed(0)}` : ""}
              </option>
            ))}
          </select>
        </div>

        {selectedSailing && (
          <div className="bg-muted rounded-lg p-4 text-[13px] flex flex-col gap-1">
            <p><span className="font-medium">Departure:</span> {selectedSailing.departure_date} from {selectedSailing.departure_port}</p>
            <p><span className="font-medium">Duration:</span> {selectedSailing.duration_nights} nights{selectedSailing.region ? ` — ${selectedSailing.region}` : ""}</p>
            {selectedSailing.ports.length > 0 && (
              <p><span className="font-medium">Ports:</span> {selectedSailing.ports.join(" → ")}</p>
            )}
          </div>
        )}
      </section>

      {/* Group settings */}
      <section className="flex flex-col gap-4">
        <h3 className="text-[15px] font-semibold">Group settings</h3>

        <div className="flex flex-col gap-1">
          <Label htmlFor="max_cabins">Max cabins (optional)</Label>
          <Input
            id="max_cabins"
            type="number"
            min={1}
            max={500}
            value={maxCabins}
            onChange={(e) => setForm((f) => ({ ...f, maxCabins: e.target.value }))}
            placeholder="e.g. 20"
            className="max-w-[160px]"
          />
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="coordinator_message">Coordinator message (optional)</Label>
          <Textarea
            id="coordinator_message"
            rows={3}
            value={coordinatorMessage}
            onChange={(e) => setForm((f) => ({ ...f, coordinatorMessage: e.target.value }))}
            placeholder="Message shown on the invitation page…"
          />
        </div>
      </section>

      {/* Invitees */}
      <section className="flex flex-col gap-3">
        <h3 className="text-[15px] font-semibold">Invitees</h3>
        <p className="text-[13px] text-muted-foreground">Add up to {MAX_INVITEES_PER_GROUP} email addresses. Invitations are sent after the group is created.</p>

        {invitees.map((row, idx) => (
          <div key={idx} className="flex gap-2 items-start">
            <div className="flex flex-col gap-1 flex-1">
              <Input
                type="email"
                placeholder="Email address"
                value={row.email}
                onChange={(e) => updateInvitee(idx, "email", e.target.value)}
                aria-label={`Invitee ${idx + 1} email`}
              />
            </div>
            <div className="flex flex-col gap-1 flex-1">
              <Input
                type="text"
                placeholder="Name (optional)"
                value={row.name}
                onChange={(e) => updateInvitee(idx, "name", e.target.value)}
                aria-label={`Invitee ${idx + 1} name`}
              />
            </div>
            {invitees.length > 1 && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => removeInvitee(idx)}
                className="mt-0.5 text-muted-foreground"
              >
                ✕
              </Button>
            )}
          </div>
        ))}

        {invitees.length < MAX_INVITEES_PER_GROUP && (
          <Button type="button" variant="outline" onClick={addInvitee} className="self-start">
            + Add invitee
          </Button>
        )}
      </section>

      <div>
        <Button type="submit" disabled={submitting}>
          {submitting ? "Creating…" : "Create group"}
        </Button>
      </div>
    </form>
  );
}
