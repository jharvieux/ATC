// D-095 / Pattern 13 fix — load prior chat turns so multi-turn conversations
// actually have context. Replaces the `messages: [{role:"user", content:msg}]`
// pattern that made every turn stateless.
//
// Returns the conversation's user+assistant rows in chronological order,
// trimmed to fit a char budget (oldest dropped first). The first message in
// the returned array is guaranteed to be `user` (Anthropic requires this);
// a leading `assistant` row after trimming is dropped.
//
// Caller is responsible for ensuring the current user message is already
// persisted to the messages table BEFORE calling this — that row becomes
// the final element of the returned array, exactly what Anthropic expects.
// If the caller hasn't persisted the current turn, they must append it
// manually before passing to the LLM.

export type ChatRole = "user" | "assistant";
export type ChatTurn = { role: ChatRole; content: string };

// Conservative cap. Haiku and Sonnet both have 200k context; 50k chars
// (~12k tokens) leaves room for system prompt + RAG + reply without ever
// approaching the limit, while comfortably holding a long support thread.
const DEFAULT_MAX_CHARS = 50_000;

interface MessagesRow {
  role: string;
  content: string | null;
}

// Duck-typed — both the service-role client and tenantClient have a
// compatible `.from(...)` shape, but their exact return types differ
// across generics. `unknown` keeps the helper usable with either.
//
// tenantId is REQUIRED (Greptile #266 review): the service-role client
// bypasses RLS, so we enforce tenant scoping at the query layer. This
// satisfies the "two layers of tenant isolation" doctrine — app-layer
// conversation-ownership check AND db-layer tenant_id filter. An IDOR
// or future caller that hands us a foreign conversationId can no longer
// leak messages because the row's tenant_id won't match.
export async function loadConversationHistory(
  db: unknown,
  tenantId: string,
  conversationId: string,
  options?: { maxChars?: number },
): Promise<ChatTurn[]> {
  const maxChars = options?.maxChars ?? DEFAULT_MAX_CHARS;

  const query = (db as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (col: string, val: string) => {
          eq: (col: string, val: string) => {
            in: (col: string, vals: readonly string[]) => {
              order: (
                col: string,
                opts: { ascending: boolean },
              ) => Promise<{ data: MessagesRow[] | null; error: { message: string } | null }>;
            };
          };
        };
      };
    };
  })
    .from("messages")
    .select("role, content")
    .eq("tenant_id", tenantId)
    .eq("conversation_id", conversationId)
    .in("role", ["user", "assistant"])
    .order("created_at", { ascending: true });

  const { data, error } = await query;
  if (error) {
    throw new Error(`loadConversationHistory: ${error.message}`);
  }

  const rows = data ?? [];
  const turns: ChatTurn[] = [];
  for (const row of rows) {
    if (row.role !== "user" && row.role !== "assistant") continue;
    const content = typeof row.content === "string" ? row.content : "";
    if (!content) continue;
    turns.push({ role: row.role, content });
  }

  return trimToBudget(turns, maxChars);
}

// Exported for unit tests. Drops oldest turns until total content chars
// fit under budget, ensures the first message is `user` (Anthropic
// requirement), and collapses runs of consecutive same-role messages
// down to the last one in each run (Anthropic rejects non-alternating
// histories; collapsing rather than dropping preserves the most recent
// signal from each side).
export function trimToBudget(turns: ChatTurn[], maxChars: number): ChatTurn[] {
  let totalChars = turns.reduce((sum, t) => sum + t.content.length, 0);
  let start = 0;
  while (totalChars > maxChars && start < turns.length) {
    totalChars -= turns[start]!.content.length;
    start++;
  }
  let trimmed = turns.slice(start);
  while (trimmed.length > 0 && trimmed[0]!.role === "assistant") {
    trimmed = trimmed.slice(1);
  }
  // Collapse consecutive same-role turns: keep the latest one in each
  // run. A db with non-alternating rows (e.g. from a prior assistant
  // failure that never wrote) would otherwise break the Anthropic
  // alternation requirement on every turn.
  return collapseConsecutiveSameRole(trimmed);
}

function collapseConsecutiveSameRole(turns: ChatTurn[]): ChatTurn[] {
  if (turns.length <= 1) return turns;
  const out: ChatTurn[] = [];
  for (const t of turns) {
    const last = out[out.length - 1];
    if (last && last.role === t.role) {
      out[out.length - 1] = t;
    } else {
      out.push(t);
    }
  }
  return out;
}
