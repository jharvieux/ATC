// BP40 §33.8 — Zod schemas for price-watch API routes.

import { z } from "zod";

export const CreateWatchSchema = z.object({
  booking_id: z.string().uuid().nullable().optional(),
  cruise_line: z.string().min(1),
  ship: z.string().min(1),
  sail_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  departure_port: z.string().min(1),
  cabin_class: z.enum(["interior", "oceanview", "balcony", "mini_suite", "suite"]),
  threshold_kind: z.enum(["dollar_drop", "percent_drop", "either"]),
  dollar_threshold: z.number().positive().optional(),
  percent_threshold: z.number().positive().max(100).optional(),
}).superRefine((v, ctx) => {
  if (v.threshold_kind === "dollar_drop" && v.dollar_threshold == null) {
    ctx.addIssue({ code: "custom", message: "dollar_threshold required for dollar_drop" });
  }
  if (v.threshold_kind === "percent_drop" && v.percent_threshold == null) {
    ctx.addIssue({ code: "custom", message: "percent_threshold required for percent_drop" });
  }
  if (v.threshold_kind === "either" && (v.dollar_threshold == null || v.percent_threshold == null)) {
    ctx.addIssue({ code: "custom", message: "both dollar_threshold and percent_threshold required for either" });
  }
});

export const PatchWatchSchema = z.object({
  status: z.enum(["paused", "active", "cancelled"]).optional(),
  threshold_kind: z.enum(["dollar_drop", "percent_drop", "either"]).optional(),
  dollar_threshold: z.number().positive().nullable().optional(),
  percent_threshold: z.number().positive().max(100).nullable().optional(),
});

export type CreateWatchInput = z.infer<typeof CreateWatchSchema>;
export type PatchWatchInput = z.infer<typeof PatchWatchSchema>;
