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
//   AuthForbidden       → 403 + { error: "forbidden", resource, action, role }
//   AuthReauthRequired  → 401 + { error: "reauth_required", return_to }
//   PlatformAdminError  → its own toResponse() (401/403/500)
//   anything else       → 401 + { error: <message> }   (preserves the
//                          existing "treat unknown error as auth failure"
//                          behavior of legacy catches)

import { AuthForbidden, AuthReauthRequired } from "./assert-permission";
import { PlatformAdminError } from "./assert-platform-admin";

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
  const msg = err instanceof Error ? err.message : String(err);
  return Response.json({ error: msg }, { status: 401 });
}
