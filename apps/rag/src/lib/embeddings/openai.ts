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
  const model = process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small";
  const dimensions = parseInt(process.env.OPENAI_EMBEDDING_DIMENSIONS ?? "1536", 10);
  const res = await getClient().embeddings.create({ model, input: text, dimensions });
  const embedding = res.data[0]?.embedding;
  if (!embedding) throw new Error("OpenAI returned no embedding");
  return embedding;
}
