// #1599 — a real in-memory table mock for ai_batch_requests / ai_batch_jobs.
//
// A naive "always succeeds, ignores filters" Supabase stub can't test a
// CAS-guarded update: the whole point of the fix is that
// `.eq("status", "submitted")` only flips rows still in that status and
// `.select("id")` reports exactly which ones it affected. This mock
// actually filters rows by the chained .eq()/.in()/.is() calls and
// mutates them in place, so a test can simulate "a prior run already
// completed this row" and assert the second run skips it.

type MockRow = Record<string, unknown>;
type Filter = (row: MockRow) => boolean;

export class InMemoryTable {
  rows: MockRow[];
  constructor(rows: MockRow[] = []) {
    this.rows = rows;
  }
}

export function makeBatchDb(tables: Record<string, InMemoryTable>) {
  let nextId = 1;

  function query(tableName: string, table: InMemoryTable) {
    const filters: Filter[] = [];
    let selectedCols: string | null = null;
    let selectOpts: { count?: string; head?: boolean } | undefined;
    let orderCol: string | null = null;
    let orderAsc = true;
    let limitN: number | null = null;
    let pendingUpdate: Record<string, unknown> | null = null;
    let pendingInsert: Record<string, unknown> | null = null;

    const applyFilters = (rows: MockRow[]): MockRow[] => rows.filter((r) => filters.every((f) => f(r)));

    function currentMatches(): MockRow[] {
      let matched = applyFilters(table.rows);
      if (orderCol) {
        const col = orderCol;
        matched = [...matched].sort((a, b) => {
          const av = String(a[col] ?? "");
          const bv = String(b[col] ?? "");
          if (av === bv) return 0;
          const cmp = av < bv ? -1 : 1;
          return orderAsc ? cmp : -cmp;
        });
      }
      if (limitN !== null) matched = matched.slice(0, limitN);
      return matched;
    }

    function resolveResult(): { data: unknown; error: null; count?: number } {
      if (pendingInsert) {
        const row: MockRow = { id: `${tableName}-${nextId++}`, ...pendingInsert };
        table.rows.push(row);
        return { data: selectedCols ? [{ ...row }] : null, error: null };
      }
      if (pendingUpdate) {
        const matched = applyFilters(table.rows);
        for (const row of matched) Object.assign(row, pendingUpdate);
        const data = selectedCols ? matched.map((r) => ({ ...r })) : null;
        return { data, error: null };
      }
      if (selectOpts?.count === "exact") {
        return { data: selectOpts.head ? null : currentMatches(), error: null, count: applyFilters(table.rows).length };
      }
      return { data: currentMatches().map((r) => ({ ...r })), error: null };
    }

    const chain = {
      select(cols: string, opts?: { count?: string; head?: boolean }) {
        selectedCols = cols;
        selectOpts = opts;
        return chain;
      },
      insert(payload: Record<string, unknown>) {
        pendingInsert = payload;
        return chain;
      },
      update(payload: Record<string, unknown>) {
        pendingUpdate = payload;
        return chain;
      },
      eq(col: string, val: unknown) {
        filters.push((r) => r[col] === val);
        return chain;
      },
      in(col: string, vals: unknown[]) {
        filters.push((r) => vals.includes(r[col]));
        return chain;
      },
      is(col: string, val: unknown) {
        filters.push((r) => (val === null ? r[col] === null || r[col] === undefined : r[col] === val));
        return chain;
      },
      // .not(col, "is", null) → col IS NOT NULL (the only form we use).
      not(col: string, op: string, val: unknown) {
        if (op === "is" && val === null) {
          filters.push((r) => r[col] !== null && r[col] !== undefined);
        } else {
          filters.push((r) => r[col] !== val);
        }
        return chain;
      },
      lt(col: string, val: unknown) {
        filters.push((r) => String(r[col] ?? "") < String(val));
        return chain;
      },
      order(col: string, opts?: { ascending: boolean }) {
        orderCol = col;
        orderAsc = opts?.ascending ?? true;
        return chain;
      },
      limit(n: number) {
        limitN = n;
        return chain;
      },
      async single() {
        const r = resolveResult();
        const arr = Array.isArray(r.data) ? r.data : r.data ? [r.data] : [];
        return { data: arr[0] ?? null, error: null };
      },
      async maybeSingle() {
        const r = resolveResult();
        const arr = Array.isArray(r.data) ? r.data : r.data ? [r.data] : [];
        return { data: arr[0] ?? null, error: null };
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve(resolveResult()).then(resolve, reject);
      },
    };
    return chain;
  }

  return {
    from(tableName: string) {
      const t = tables[tableName];
      if (!t) throw new Error(`makeBatchDb: unexpected table "${tableName}"`);
      return query(tableName, t);
    },
    // #1743 — mirrors the ai_batch_requests_rollup() Postgres RPC: a
    // server-side SUM with no row cap, so a >1000-row fixture can prove the
    // rollup doesn't inherit PostgREST's row-cap the old .select().limit()
    // aggregate was subject to.
    async rpc(name: string, params: Record<string, unknown>) {
      if (name !== "ai_batch_requests_rollup") {
        throw new Error(`makeBatchDb: unexpected rpc "${name}"`);
      }
      const requests = tables.ai_batch_requests;
      if (!requests) throw new Error("makeBatchDb: rpc requires an ai_batch_requests table");
      const matched = requests.rows.filter(
        (r) => r.batch_job_id === params.p_batch_job_id && r.status === "completed",
      );
      let totalCostCents = 0;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      for (const r of matched) {
        totalCostCents += Number(r.cost_cents ?? 0);
        const meta = r.result_metadata as { input_tokens?: number; output_tokens?: number } | null;
        totalInputTokens += Number(meta?.input_tokens ?? 0);
        totalOutputTokens += Number(meta?.output_tokens ?? 0);
      }
      return {
        data: [{ total_cost_cents: totalCostCents, total_input_tokens: totalInputTokens, total_output_tokens: totalOutputTokens }],
        error: null,
      };
    },
  };
}
