// BP39 §39.2.3 — Token generation for tokenized public URLs.
//
// 32 bytes of randomness encoded base64url → 43-char tokens. Stored
// verbatim in trip_itineraries.access_token / trip_resources.access_token
// (UNIQUE on the column ensures collision is treated as an integrity error).

import { randomBytes } from "node:crypto";

export function newAccessToken(): string {
  return randomBytes(32).toString("base64url");
}
