import OpenAI from "openai";

let _client: OpenAI | undefined;

function getClient(): OpenAI {
  if (!_client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY not set");
    _client = new OpenAI({ apiKey });
  }
  return _client;
}

export async function embed(text: string): Promise<number[]> {
  return (await embedWithUsage(text)).embedding;
}

// Returns the embedding plus the token count and resolved model. Use this
// from cost-attributable callsites (the 5 ingest routes when the batch flag
// is off). /api/retrieve intentionally stays on embed() and skips the cost
// log — the chat critical path can't afford an extra DB write, and query-
// time embedding spend is negligible compared to ingest (one call per chat
// turn vs N per ingested doc).
export async function embedWithUsage(text: string): Promise<{
  embedding: number[];
  prompt_tokens: number;
  model: string;
}> {
  const model = process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small";
  const dimensions = parseInt(process.env.OPENAI_EMBEDDING_DIMENSIONS ?? "1536", 10);
  const res = await getClient().embeddings.create({ model, input: text, dimensions });
  const embedding = res.data[0]?.embedding;
  if (!embedding) throw new Error("OpenAI returned no embedding");
  return { embedding, prompt_tokens: res.usage?.prompt_tokens ?? 0, model };
}
