"use client";

// §18 — Coordinator "danger zone": delete the whole group. Guard: the
// coordinator must re-type the group's sailing date to confirm. The date is NOT
// shown here — knowing it is the confirmation — and it's re-checked server-side.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function DeleteGroupClient({ groupId }: { groupId: string }): React.ReactElement {
  const router = useRouter();
  const [arming, setArming] = useState(false);
  const [confirmDate, setConfirmDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function handleDelete(): Promise<void> {
    setError(null);
    setDeleting(true);
    try {
      const res = await fetch(`/api/groups/${groupId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm_sailing_date: confirmDate.trim() }),
      });
      if (res.ok) {
        router.push("/groups");
        return;
      }
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      setError(
        json.error === "sailing_date_mismatch"
          ? "That doesn't match the group's sailing date. Deletion cancelled."
          : json.error === "forbidden"
            ? "Only the group's coordinator can delete it."
            : `Could not delete the group (${res.status}).`,
      );
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className="mt-10 border border-red-200 rounded-lg p-4 bg-red-50/50">
      <h3 className="text-[15px] font-semibold text-red-700">Delete this group</h3>
      <p className="text-[13px] text-muted-foreground mt-1">
        Permanently deletes the group, its invitations, and its forum. This cannot be undone.
      </p>

      {!arming ? (
        <Button
          type="button"
          className="mt-3 bg-red-600 hover:bg-red-700 text-white"
          onClick={() => { setArming(true); setError(null); }}
        >
          Delete group
        </Button>
      ) : (
        <div className="mt-3 flex flex-col gap-2 max-w-sm">
          <Label htmlFor="confirm_sailing_date" className="text-[13px]">
            Type the group&apos;s sailing date (YYYY-MM-DD) to confirm
          </Label>
          <Input
            id="confirm_sailing_date"
            type="date"
            value={confirmDate}
            onChange={(e) => setConfirmDate(e.target.value)}
          />
          {error && <p className="text-[13px] text-red-600">{error}</p>}
          <div className="flex gap-2">
            <Button
              type="button"
              className="bg-red-600 hover:bg-red-700 text-white"
              disabled={deleting || confirmDate.trim() === ""}
              onClick={() => { void handleDelete(); }}
            >
              {deleting ? "Deleting…" : "Confirm delete"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={deleting}
              onClick={() => { setArming(false); setConfirmDate(""); setError(null); }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
