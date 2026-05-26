// Shared helpers for k6 load scripts (§30.7).
// k6 runs Go-native JS — no Node modules; everything via http/check from k6.

import http from "k6/http";
import { check, sleep } from "k6";

export function baseUrl() {
  const u = __ENV.K6_BASE_URL;
  if (!u) throw new Error("K6_BASE_URL is required");
  return u.replace(/\/$/, "");
}

export function loadTenantPrefix() {
  return __ENV.K6_LOAD_TENANT_PREFIX || "load-tenant-";
}

export function loadTenantHost(slug) {
  // Tenant subdomains: <slug>.<primaryDomain>
  const base = baseUrl().replace(/^https?:\/\//, "");
  return `${slug}.${base}`;
}

// Bearer-auth wrapper. Tests use synthetic JWTs minted at setup() time
// against a known-good test user per load tenant.
export function authHeaders(token) {
  if (!token) return { "Content-Type": "application/json" };
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

export function jitter(maxMs = 250) {
  sleep((Math.random() * maxMs) / 1000);
}

// Standard threshold check helper.
export function assertOk(res, name) {
  return check(res, {
    [`${name} status 2xx`]: (r) => r.status >= 200 && r.status < 300,
    [`${name} body has length`]: (r) => r.body && r.body.length > 0,
  });
}
