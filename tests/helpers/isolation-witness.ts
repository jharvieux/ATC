import { expect } from "vitest";

interface IsolationRow {
  id: string;
}

interface SupabaseIsolationResult {
  data: IsolationRow[] | null;
  error: unknown;
}

interface IsolationQueryOptions {
  query: () => PromiseLike<IsolationRow[] | SupabaseIsolationResult>;
  allowedIds: string[];
  deniedIds: [string, ...string[]];
}

export async function assertIsolationQuery({
  query,
  allowedIds,
  deniedIds,
}: IsolationQueryOptions): Promise<void> {
  if (deniedIds.length === 0) {
    throw new Error("assertIsolationQuery requires at least one denied ID");
  }

  const result = await query();
  let rows: IsolationRow[];
  if (Array.isArray(result)) {
    rows = result;
  } else {
    expect(result.error).toBeNull();
    rows = result.data ?? [];
  }
  const actualIds = rows.map((row) => row.id).sort();

  expect(actualIds).toEqual([...allowedIds].sort());
  for (const deniedId of deniedIds) {
    expect(actualIds).not.toContain(deniedId);
  }
}
