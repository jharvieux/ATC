// §17.2 — In-process OTP store for Microsoft no-email flow.
//
// NOTE: In-memory storage works only within a single serverless function
// instance. For multi-instance / production deployments, replace with a
// Redis-backed store (REDIS_URL already used by the RAG service).
// Acceptable for Phase 1 launch with low-concurrency OTP flows.

export const OTP_STORE = new Map<string, { code: string; expires: number }>();
