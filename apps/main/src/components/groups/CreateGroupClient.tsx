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

export function CreateGroupClient(): React.ReactElement {
  const router = useRouter();

  const [lines, setLines] = useState<CruiseLine[]>([]);
  const [ships, setShips] = useState<CruiseShip[]>([]);
  const [sailings, setSailings] = useState<CruiseSailing[]>([]);

  const [selectedLineId, setSelectedLineId] = useState<string>("");
  const [selectedShipId, setSelectedShipId] = useState<string>("");
  const [selectedSailingId, setSelectedSailingId] = useState<string>("");
  const [selectedSailing, setSelectedSailing] = useState<CruiseSailing | null>(null);

  const [maxCabins, setMaxCabins] = useState<string>("");
  const [coordinatorMessage, setCoordinatorMessage] = useState<string>("");
  const [invitees, setInvitees] = useState<InviteeRow[]>([{ email: "", name: "" }]);

  const [loadingShips, setLoadingShips] = useState(false);
  const [loadingSailings, setLoadingSailings] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadLines = useCallback(async () => {
    const res = await fetch("/api/cruise-lines");
    if (!res.ok) { setError(`Could not load cruise lines (${res.status})`); return; }
    const json = await res.json() as { lines: CruiseLine[] };
    setLines(json.lines ?? []);
  }, []);

  useEffect(() => { void loadLines(); }, [loadLines]);

  const loadShips = useCallback(async (lineId: string) => {
    if (!lineId) { setShips([]); return; }
    setLoadingShips(true);
    try {
      const res = await fetch(`/api/cruise-ships?cruise_line_id=${encodeURIComponent(lineId)}`);
      if (!res.ok) { setError(`Could not load ships (${res.status})`); return; }
      const json = await res.json() as { ships: CruiseShip[] };
      setShips(json.ships ?? []);
    } finally {
      setLoadingShips(false);
    }
  }, []);

  const loadSailings = useCallback(async (shipId: string) => {
    if (!shipId) { setSailings([]); return; }
    setLoadingSailings(true);
    try {
      const res = await fetch(`/api/cruise-sailings?cruise_ship_id=${encodeURIComponent(shipId)}`);
      if (!res.ok) { setError(`Could not load sailings (${res.status})`); return; }
      const json = await res.json() as { sailings: CruiseSailing[] };
      setSailings(json.sailings ?? []);
    } finally {
      setLoadingSailings(false);
    }
  }, []);

  function handleLineChange(lineId: string): void {
    setSelectedLineId(lineId);
    setSelectedShipId("");
    setSelectedSailingId("");
    setSelectedSailing(null);
    setShips([]);
    setSailings([]);
    void loadShips(lineId);
  }

  function handleShipChange(shipId: string): void {
    setSelectedShipId(shipId);
    setSelectedSailingId("");
    setSelectedSailing(null);
    setSailings([]);
    void loadSailings(shipId);
  }

  function handleSailingChange(sailingId: string): void {
    setSelectedSailingId(sailingId);
    const found = sailings.find((s) => s.id === sailingId) ?? null;
    setSelectedSailing(found);
  }

  function addInvitee(): void {
    setInvitees((prev) => [...prev, { email: "", name: "" }]);
  }

  function removeInvitee(idx: number): void {
    setInvitees((prev) => prev.filter((_, i) => i !== idx));
  }

  function updateInvitee(idx: number, field: keyof InviteeRow, value: string): void {
    setInvitees((prev) => prev.map((row, i) => i === idx ? { ...row, [field]: value } : row));
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError(null);

    const selectedLine = lines.find((l) => l.id === selectedLineId);
    const selectedShip = ships.find((s) => s.id === selectedShipId);

    if (!selectedLine || !selectedShip || !selectedSailing) {
      setError("Please select a cruise line, ship, and sailing.");
      return;
    }

    const validInvitees = invitees.filter((r) => r.email.trim().length > 0);
    if (validInvitees.length > 50) {
      setError("Maximum 50 invitees per group.");
      return;
    }

    setSubmitting(true);
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
          ...(maxCabins.trim() !== "" && { max_cabins: Number(maxCabins) }),
          ...(coordinatorMessage.trim() !== "" && { coordinator_message: coordinatorMessage.trim() }),
          invitees: validInvitees.map((r) => ({
            email: r.email.trim(),
            ...(r.name.trim() !== "" && { name: r.name.trim() }),
          })),
        }),
      });

      if (!res.ok) {
        const json = await res.json() as { error?: string };
        setError(json.error ?? `Error ${res.status}`);
        return;
      }

      const json = await res.json() as { group_id: string };
      router.push(`/groups/${json.group_id}/coordinate/overview`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error");
    } finally {
      setSubmitting(false);
    }
  }

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
            onChange={(e) => setMaxCabins(e.target.value)}
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
            onChange={(e) => setCoordinatorMessage(e.target.value)}
            placeholder="Message shown on the invitation page…"
          />
        </div>
      </section>

      {/* Invitees */}
      <section className="flex flex-col gap-3">
        <h3 className="text-[15px] font-semibold">Invitees</h3>
        <p className="text-[13px] text-muted-foreground">Add up to 50 email addresses. Invitations are sent after the group is created.</p>

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

        {invitees.length < 50 && (
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
