// BP37 §37.2 — Shared task enums (single source, previously duplicated across routes).

export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
