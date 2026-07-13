// §8.3 — Higher-order wrapper for RAG API routes
//
// All RAG API routes (except /api/tenant-events which uses HMAC-SHA256)
// call this wrapper. On ServiceAuthError, returns the structured error
// response with the correct status code and error code.
//
// Next 15: route-handler signature is (req, { params: Promise<...> }).
// We accept either shape (some routes have no [param] segment so the
// second argument is undefined) and await any params promise before
// passing the resolved record to the inner handler.

import { verifyServiceJwt, ServiceAuthError, type ServiceCallerContext } from "./verify-service-jwt";

type AuthedHandler = (
  req: Request,
  ctx: ServiceCallerContext,
  params?: Record<string, string>,
) => Promise<Response>;

type RouteContext = { params: Promise<Record<string, string>> };

export function withServiceAuth(handler: AuthedHandler) {
  return async (req: Request, routeCtx: RouteContext): Promise<Response> => {
    try {
      // #1792 — JWT verification and route-param resolution are
      // independent (neither reads the other's result); fan out instead of
      // waiting in sequence. Both stay under the same try/catch below.
      const [ctx, params] = await Promise.all([verifyServiceJwt(req), routeCtx.params]);
      return handler(req, ctx, params);
    } catch (err) {
      if (err instanceof ServiceAuthError) {
        return Response.json({ error: err.code }, { status: err.status });
      }
      console.error("[withServiceAuth] unexpected error:", err);
      return Response.json({ error: "internal" }, { status: 500 });
    }
  };
}
