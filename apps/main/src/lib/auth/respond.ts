// §26.3 — Centralized auth-error → HTTP response mapping.
//
// Use this from route handlers' catch blocks so different auth failures
// get correct status codes instead of the historical "everything is 401":
//
//   } catch (err) {
//     return respondToAuthError(err);
//   }
//
// Mapping:
//   AuthForbidden        → 403 + { error: "forbidden", resource, action, role }
//   AuthReauthRequired   → 401 + { error: "reauth_required", return_to }
//   PlatformAdminError   → its own toResponse() (401/403/500)
//   assertPermission()'s known thrown messages  → 401 + { error: "unauthorized" }
//   anything else        → 500 + { error: "internal_error" }, with the raw error
//                           logged server-side. We DO NOT echo err.message —
//                           internal Postgres / RLS hints would leak.
//                           (Audit pass 2, Finding 1: a tenant member who
//                           triggered a DB-tier failure was seeing raw
//                           PostgREST error text in the 401 body.)

import {
  AuthForbidden,
  AuthReauthRequired,
  ConsentPendingError,
} from "./assert-permission";
import { PlatformAdminError } from "./assert-platform-admin";

// Known-shape error messages that `assertPermission` throws as a plain
// Error. We surface these to the client as 401 so the UX matches "log in
// again" / "session missing", but we don't reveal anything beyond a flat
// "unauthorized" code.
const KNOWN_AUTH_FAILURE_PREFIXES = [
  "assertPermission: missing Authorization Bearer token",
  "assertPermission: invalid or expired access token",
  "assertPermission: invalid or expired bearer token",
  "assertPermission: user is not an active member",
  "assertPermission: bearer path:",
  "tenantContextFromRequest:",
] as const;

function isKnownAuthFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return KNOWN_AUTH_FAILURE_PREFIXES.some((p) => err.message.startsWith(p));
}

export function respondToAuthError(err: unknown): Response {
  if (err instanceof PlatformAdminError) {
    return err.toResponse();
  }
  if (err instanceof AuthForbidden) {
    return Response.json(
      {
        error: "forbidden",
        resource: err.resource,
        action: err.action,
        role: err.role,
      },
      { status: 403 },
    );
  }
  if (err instanceof AuthReauthRequired) {
    return Response.json(
      { error: "reauth_required", return_to: err.return_to },
      { status: 401 },
    );
  }
  if (err instanceof ConsentPendingError) {
    return Response.json(
      {
        error: "consent_pending",
        return_to: err.return_to,
        pending: err.pending,
      },
      { status: 403 },
    );
  }
  if (isKnownAuthFailure(err)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  // Truly unknown error — server bug, DB failure, etc. Log + 500.
  console.error("[respondToAuthError] unhandled error:", err);
  return Response.json({ error: "internal_error" }, { status: 500 });
}
