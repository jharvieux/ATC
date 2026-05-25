"use client";

// BP36 §36.9 — Shared shell for per-report pages.
//
// Renders the title + date-range filters + CSV export button + a slot
// for the per-report table. Filters live in URL search params so they
// survive refresh + the CSV export inherits them.

import { useRouter, useSearchParams } from "next/navigation";
import { useState, type ReactNode } from "react";

type ReportShellProps = {
  title: string;
  description?: string;
  api_path: string; // e.g. "/api/reports/leads-by-source"
  extra_query?: Record<string, string>; // for routes that need group_by etc.
  children: ReactNode;
};

export function ReportShell(props: ReportShellProps): JSX.Element {
  const router = useRouter();
  const search = useSearchParams();
  const [start, setStart] = useState(search.get("start") ?? "");
  const [end, setEnd] = useState(search.get("end") ?? "");

  const apply = () => {
    const sp = new URLSearchParams(search);
    if (start) sp.set("start", start);
    else sp.delete("start");
    if (end) sp.set("end", end);
    else sp.delete("end");
    router.push(`?${sp.toString()}`);
  };

  const csvHref = (() => {
    const sp = new URLSearchParams(search);
    sp.set("format", "csv");
    for (const [k, v] of Object.entries(props.extra_query ?? {})) sp.set(k, v);
    return `${props.api_path}?${sp.toString()}`;
  })();

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-start justify-between mb-2">
        <div>
          <a href="/crm/reports" className="text-sm text-blue-600 hover:underline">
            ← All reports
          </a>
          <h1 className="text-2xl font-semibold mt-1">{props.title}</h1>
          {props.description && <p className="text-sm text-gray-500 mt-1">{props.description}</p>}
        </div>
      </div>

      <div className="flex items-center gap-3 my-4 flex-wrap">
        <label className="text-sm text-gray-600">From</label>
        <input
          type="date"
          value={start}
          onChange={(e) => setStart(e.target.value)}
          className="border border-gray-300 rounded-md px-2 py-1 text-sm"
        />
        <label className="text-sm text-gray-600">To</label>
        <input
          type="date"
          value={end}
          onChange={(e) => setEnd(e.target.value)}
          className="border border-gray-300 rounded-md px-2 py-1 text-sm"
        />
        <button
          onClick={apply}
          className="bg-blue-600 text-white px-3 py-1 rounded-md text-sm hover:bg-blue-700"
        >
          Apply
        </button>
        <a
          href={csvHref}
          download
          className="ml-auto bg-white border border-gray-300 text-gray-700 px-3 py-1 rounded-md text-sm hover:bg-gray-50"
        >
          Export CSV
        </a>
      </div>

      {props.children}
    </div>
  );
}
