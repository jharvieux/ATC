// PII column-classification guard — Harvey Tier-1 port (refs #2011).
//
// Ported from Harvey tools/pii-classify.mjs + src/migration-sql-parse.ts
// (parseLiveColumns) @ 5b5aada, adapted for ATC: instead of printing a data
// map, this runs the identical name/type classifier in STATIC schema mode over
// apps/*/supabase/migrations/*.sql (never a live DB — CI-safe) and diffs the
// classified columns against a committed baseline. A NEW column matching the
// PII/PHI/PCI/SECRET dictionary (or the JSONB denormalization-container
// pattern) that is not in scripts/pii-columns-baseline.txt fails with:
// "add RLS/retention/erasure review, then baseline".
//
// Privacy-safe by construction: matches column NAMES + SQL types only, never
// values. Disclosed limitation (inherited from the parser): column-level
// `ALTER TABLE … DROP COLUMN` is not tracked, so a dropped PII column can
// linger as a stale baseline entry (reported, non-fatal).
//
//   node scripts/check-pii-columns.mjs             # guard mode (CI)
//   node scripts/check-pii-columns.mjs --selftest  # classifier self-test
//   node scripts/check-pii-columns.mjs --schema <dir-or-file.sql>  # explicit target, report only

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_FILE = join(ROOT, "scripts/pii-columns-baseline.txt");

// --- classifier dictionary (verbatim from Harvey tools/pii-classify.mjs) -----

const RULES = [
  [/(^|_)e?mail(_|$)/, "EMAIL", "PII", "high"],
  [/(^|_)(ssn|social_security)(_|$)/, "US_SSN", "SENSITIVE_PII", "high"],
  [/(date_of_birth|(^|_)dob(_|$)|birth_?date)/, "DOB", "PII", "high"],
  [/(^|_)(phone|mobile|telephone|cell)(_|$)/, "PHONE", "PII", "high"],
  [/(^|_)fax(_|$)/, "FAX", "PII", "high"],
  [/passport/, "PASSPORT", "SENSITIVE_PII", "high"],
  [/(driver_?licen[cs]e|license_number)/, "DRIVERS_LICENSE", "SENSITIVE_PII", "high"],
  [/(national_id|government_id|citizen_id|resident_id|id_card_number)/, "NATIONAL_ID", "SENSITIVE_PII", "medium"],
  [/(medical_record_number|(^|_)mrn(_|$))/, "MEDICAL_RECORD_NUMBER", "PHI", "high"],
  [/(health_plan|insurance_(id|number|policy))/, "HEALTH_PLAN_ID", "PHI", "high"],
  [/(^|_)(device_id|imei|udid|mac_address|mac_addr)(_|$)/, "DEVICE_ID", "SENSITIVE_PII", "medium"],
  [/(^|_)(vin|vehicle_identification|license_plate|plate_number)(_|$)/, "VEHICLE_ID", "PII", "medium"],
  [/(biometric|fingerprint|retina|iris_scan|face_?id|faceprint|voiceprint)/, "BIOMETRIC", "SENSITIVE_PII", "high"],
  [/(photo_url|headshot|mugshot|profile_pic(ture)?|avatar_url|face_image|signature_image)/, "PHOTO", "PII", "medium"],
  [/(^|_)(cvv|cvc|card_verification|card_security_code)(_|$)/, "CVV", "PCI", "high"],
  [/(^|_)(pin_block|pin_verification|atm_pin|card_pin)(_|$)/, "PIN", "PCI", "high"],
  [/(track_?1|track_?2|track_data|mag_?stripe)/, "TRACK_DATA", "PCI", "high"],
  [/(card_expir|card_exp_(month|year))/, "CARD_EXPIRY", "PCI", "medium"],
  [/(credit_?card|card_number|cc_num|(^|_)pan(_|$)|card_last4|card_brand)/, "CARD", "PCI", "high"],
  [/(^|_)(iban|account_number|routing|swift)(_|$)/, "BANK_ACCT", "PCI", "medium"],
  [/(stripe_customer|payment_method|payment_intent)/, "PAYMENT_REF", "PCI", "medium"],
  [/(wallet_address|crypto_address|btc_address|eth_address)/, "CRYPTO_WALLET", "SENSITIVE_PII", "medium"],
  [/(^|_)(ip|ip_address)(_|$)/, "IP", "PII", "medium"],
  [/(first_name|last_name|full_name|surname|given_name|middle_name)/, "NAME", "PII", "medium"],
  [/(^|_)username(_|$)/, "USERNAME_HANDLE", "PII", "low"],
  [/(^|_)(address|street|city|zip|postal|postcode)(_|$)/, "ADDRESS", "PII", "medium"],
  [/(latitude|longitude|(^|_)geo|(^|_)lat(_|$)|(^|_)lng(_|$))/, "GEO", "PII", "low"],
  [/(political_(affiliation|party)|union_member(ship)?)/, "POLITICAL_OR_UNION", "SENSITIVE_PII", "high"],
  [/(genetic|dna_|genome)/, "GENETIC", "SENSITIVE_PII", "high"],
  [/(gender|ethnicit|(^|_)race(_|$)|religion|sexual)/, "SPECIAL_CATEGORY", "SENSITIVE_PII", "medium"],
  [/(^|_)(nationality|citizenship)(_|$)/, "NATIONALITY", "SENSITIVE_PII", "medium"],
  [/(health|diagnosis|medical|patient|prescription|(^|_)icd(_|$))/, "HEALTH", "PHI", "high"],
  [/(^|_)name(_|$)/, "NAME?", "PII", "low"], // ambiguous: product/display name — review
  [/(tax_id|tax_number|(^|_)ein(_|$)|(^|_)vat(_|$)|(^|_)nino(_|$))/, "TAX_ID", "SENSITIVE_PII", "medium"],
  [/(api_?key|client_secret|private_?key|encryption_?key|secret_?key)/, "API_KEY", "SECRET", "high"],
  [/(smtp_pass|(^|_)password(_|$)|(^|_)passwd(_|$))/, "STORED_PASSWORD", "SECRET", "high"],
  [/(access_?token|refresh_?token|auth_?token|session_?token)/, "AUTH_TOKEN", "SECRET", "high"],
];

// Observed FP classes — a column ABOUT an infotype is not a column OF it.
const BOOLEAN_FLAG_NAME_PATTERN =
  /(^|_)(is|has|awaiting|needs|requires|pending)_|_(flag|reprompt|required|pending|enabled|requested|consent)(_|$)/;
const INFRA_HEALTH_PATTERN =
  /(^|_)(vendor|service|system|api|db|database|server|infra|upstream|integration|endpoint|app|deployment|pipeline|job|worker|queue)_?health(_|$)/;
const DESCRIPTOR_SUFFIX_PATTERN = /_(category|type|kind|class)$/;
const ORG_ENTITY_TABLE_PATTERN = /(^|_)(organi[sz]ations?|orgs?|tenants?|companies|company|workspaces?|teams?)$/;
const NAME_INFOTYPES = new Set(["NAME", "NAME?"]);
const CAPABILITY_TOKEN_VERB_PATTERN = /(invite|invitation|share|reset|verif|confirm|magic_?link)/;
const CAPABILITY_TOKEN_NOUN_PATTERN = /(token|code|link)/;
const SECRET_INFOTYPES = new Set(["API_KEY", "STORED_PASSWORD", "AUTH_TOKEN"]);

function exclusionReason(column, sqlType, infotype, tableName) {
  if (sqlType && String(sqlType).toLowerCase() === "boolean") {
    return "sql type is boolean — a flag referencing the concept, not a value";
  }
  if (BOOLEAN_FLAG_NAME_PATTERN.test(column)) return "boolean-flag naming, not a data value";
  if (INFRA_HEALTH_PATTERN.test(column)) return "infra/system health naming, not medical data";
  if (DESCRIPTOR_SUFFIX_PATTERN.test(column)) return "descriptor suffix — categorizes the concept";
  if (NAME_INFOTYPES.has(infotype) && tableName && ORG_ENTITY_TABLE_PATTERN.test(String(tableName).toLowerCase())) {
    return "entity display name on an org/tenant table — not personal PII";
  }
  if (SECRET_INFOTYPES.has(infotype) && CAPABILITY_TOKEN_VERB_PATTERN.test(column) && CAPABILITY_TOKEN_NOUN_PATTERN.test(column)) {
    return "capability token/link — single-use authorization artifact, not a stored credential";
  }
  return null;
}

const BARE_NUMBER_COLUMN_PATTERN = /^number$/;
const PHONE_CONTEXT_TABLE_PATTERN = /(phone|contact|sms|call|dial)/;
const OPAQUE_STORE_TABLE_PATTERN = /(_store|_config|_secrets?|_credentials?)$/;
const OPAQUE_STORE_COLUMN_PATTERN = /^(value|data|payload|blob|secret|config)$/;
const JSON_CONTAINER_TYPE_PATTERN = /^jsonb?$/;
const JSON_CONTAINER_NAME_PATTERN =
  /(^|_)(metadata|profile|details|custom_fields|extra_data|settings|preferences|raw_data|payload|attributes|info)(_|$)/;

/** Classify one column by name (+ type/table context). Never inspects data. */
export function classifyColumn(column, sqlType, tableName) {
  const c = String(column).toLowerCase();
  for (const [pattern, infotype, category, confidence] of RULES) {
    if (!pattern.test(c)) continue;
    if (exclusionReason(c, sqlType, infotype, tableName)) return null;
    return { infotype, category, confidence };
  }
  if (tableName) {
    const t = String(tableName).toLowerCase();
    if (BARE_NUMBER_COLUMN_PATTERN.test(c) && PHONE_CONTEXT_TABLE_PATTERN.test(t)) {
      return { infotype: "PHONE", category: "PII", confidence: "medium" };
    }
    if (OPAQUE_STORE_COLUMN_PATTERN.test(c) && OPAQUE_STORE_TABLE_PATTERN.test(t)) {
      return { infotype: "OPAQUE_ENCRYPTED_STORE", category: "SECRET", confidence: "medium" };
    }
  }
  if (sqlType && JSON_CONTAINER_TYPE_PATTERN.test(String(sqlType).toLowerCase()) && JSON_CONTAINER_NAME_PATTERN.test(c)) {
    return { infotype: "OPAQUE_JSON_BLOB", category: "PII", confidence: "low" };
  }
  return null;
}

// --- static schema parsing (ported parseLiveColumns) -------------------------

function stripLineComments(sql) {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

const SQL_TYPES = [
  "uuid", "text", "timestamptz", "timestamp", "integer", "bigint", "boolean",
  "numeric", "jsonb", "json", "date", "smallint", "varchar", "real", "double precision",
  "serial", "bigserial", "smallserial",
  "inet", "cidr", "citext", "bytea", "geography", "geometry",
];
const IDENT = `(?:"((?:[^"]|"")*)"|(\\w+))`;
function identText(quoted, bare) {
  return quoted !== undefined ? quoted.replace(/""/g, '"') : bare;
}
const COLUMN_LINE = new RegExp(`^\\s*${IDENT}\\s+(${SQL_TYPES.join("|")})\\b`, "i");
const CREATE_TABLE = new RegExp(
  `create table\\s+(?:if not exists\\s+)?(?:${IDENT}\\.)?${IDENT}\\s*\\(([\\s\\S]*?)\\n\\s*\\);`,
  "gi",
);
const DROP_TABLE = new RegExp(`\\bdrop\\s+table\\s+(?:if\\s+exists\\s+)?(?:${IDENT}\\.)?${IDENT}`, "gi");
// PII columns added after table creation (`ALTER TABLE … ADD COLUMN email text`).
const ALTER_ADD_COLUMN = new RegExp(
  `\\balter\\s+table\\s+(?:only\\s+)?(?:${IDENT}\\.)?${IDENT}\\s+add\\s+column\\s+(?:if\\s+not\\s+exists\\s+)?${IDENT}\\s+(${SQL_TYPES.join("|")})\\b`,
  "gi",
);

// Columns of each live table's EFFECTIVE definition: last create/drop event per
// table wins, so a dropped-and-recreated table contributes only its final shape.
export function parseLiveColumns(sql) {
  const clean = stripLineComments(sql);
  const events = [];
  for (const m of clean.matchAll(CREATE_TABLE)) {
    events.push({
      pos: m.index,
      key: `${m[1] !== undefined || m[2] !== undefined ? identText(m[1], m[2]) : "public"}.${identText(m[3], m[4])}`.toLowerCase(),
      table: identText(m[3], m[4]),
      body: m[5],
      ifNotExists: /create\s+table\s+if\s+not\s+exists/i.test(m[0]),
      op: "create",
    });
  }
  for (const m of clean.matchAll(DROP_TABLE)) {
    events.push({
      pos: m.index,
      key: `${m[1] !== undefined || m[2] !== undefined ? identText(m[1], m[2]) : "public"}.${identText(m[3], m[4])}`.toLowerCase(),
      op: "drop",
    });
  }
  events.sort((a, b) => a.pos - b.pos);
  const live = new Map();
  for (const e of events) {
    if (e.op === "drop") live.delete(e.key);
    else if (!(e.ifNotExists && live.has(e.key))) live.set(e.key, { table: e.table, body: e.body });
  }
  const out = [];
  for (const { table, body } of live.values()) {
    for (const line of body.split("\n")) {
      const cm = COLUMN_LINE.exec(line);
      if (cm) out.push({ table_name: table, column_name: identText(cm[1], cm[2]), data_type: cm[3].toLowerCase() });
    }
  }
  const liveTables = new Set([...live.values()].map((t) => t.table.toLowerCase()));
  for (const m of clean.matchAll(ALTER_ADD_COLUMN)) {
    const table = identText(m[3], m[4]);
    if (!liveTables.has(table.toLowerCase())) continue;
    out.push({ table_name: table, column_name: identText(m[5], m[6]), data_type: m[7].toLowerCase() });
  }
  return out;
}

// --- guard mode --------------------------------------------------------------

// Reads target directly (no existsSync/statSync pre-check — that would be a
// check-then-use race, CodeQL js/file-system-race). EISDIR means it's a
// directory; any other error (including ENOENT) is the caller's to interpret.
function readSchemaSql(target) {
  try {
    return readFileSync(target, "utf8");
  } catch (err) {
    if (err.code !== "EISDIR") throw err;
  }
  return readdirSync(target, { recursive: true })
    .filter((f) => String(f).endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(target, String(f)), "utf8"))
    .join("\n\n");
}

function defaultMigrationDirs() {
  return readdirSync(join(ROOT, "apps"), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(ROOT, "apps", e.name, "supabase/migrations"));
}

export function classifyDirs(dirs) {
  const hits = [];
  for (const dir of dirs) {
    let sql;
    try {
      sql = readSchemaSql(dir);
    } catch (err) {
      if (err.code === "ENOENT") continue; // app has no supabase/migrations dir — optional
      throw err;
    }
    const cols = parseLiveColumns(sql);
    const app = relative(ROOT, dir).split("/")[1] ?? dir; // apps/<app>/supabase/migrations
    for (const col of cols) {
      const hit = classifyColumn(col.column_name, col.data_type, col.table_name);
      if (hit) hits.push({ key: `${app}::${col.table_name}.${col.column_name}::${hit.infotype}`, ...col, ...hit });
    }
  }
  return hits;
}

function loadBaseline(file = BASELINE_FILE) {
  const set = new Set();
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return set; // baseline file is optional — empty set fallback
    throw err;
  }
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    set.add(line.split(/\s+/)[0]);
  }
  return set;
}

function guardMode() {
  const dirs = defaultMigrationDirs();
  if (dirs.length === 0) {
    console.error("pii-columns guard: no apps/*/supabase/migrations dirs found — check paths.");
    process.exit(1);
  }
  const hits = classifyDirs(dirs);
  if (hits.length === 0) {
    console.error("pii-columns guard: classifier matched ZERO columns — parser or dictionary regression (the schema is known to hold PII). Failing loud.");
    process.exit(1);
  }
  const baseline = loadBaseline();
  const fresh = hits.filter((h) => !baseline.has(h.key));
  const live = new Set(hits.map((h) => h.key));
  const stale = [...baseline].filter((k) => !live.has(k));

  if (fresh.length > 0) {
    console.error(
      "pii-columns guard: NEW column(s) matching the PII/PHI/PCI/SECRET dictionary (or the JSONB" +
        " container pattern). For each: add RLS/retention/erasure review, then baseline it in" +
        " scripts/pii-columns-baseline.txt (key + one-line review note):\n",
    );
    for (const h of fresh) console.error(`  ${h.key}  (${h.category}/${h.confidence})`);
    console.error(`\n${fresh.length} NEW PII-classified column(s) beyond scripts/pii-columns-baseline.txt.`);
    process.exit(1);
  }
  const note = stale.length > 0 ? ` (${stale.length} stale baseline entr(y/ies) — trim them)` : "";
  console.log(`pii-columns guard passed: ${hits.length} classified column(s) baselined, 0 new${note}.`);
}

function reportMode(target) {
  if (!target) {
    console.error(`Usage: check-pii-columns.mjs --schema <migrations dir or .sql file>`);
    process.exit(1);
  }
  let sql;
  try {
    sql = readSchemaSql(target);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    console.error(`Usage: check-pii-columns.mjs --schema <migrations dir or .sql file> — ${target} does not exist`);
    process.exit(1);
  }
  const cols = parseLiveColumns(sql);
  for (const col of cols) {
    const hit = classifyColumn(col.column_name, col.data_type, col.table_name);
    if (hit) console.log(`${col.table_name}.${col.column_name} → ${hit.infotype} (${hit.category}/${hit.confidence})`);
  }
}

// Kept verbatim from Harvey (minus cases for rules it doesn't ship): the
// classifier's acceptance cases, runnable anywhere via --selftest.
function selftest() {
  const cases = [
    ["email", "PII", "high"],
    ["customer_ssn", "SENSITIVE_PII", "high"],
    ["date_of_birth", "PII", "high"],
    ["card_last4", "PCI", "high"],
    ["cvv", "PCI", "high"],
    ["passport_number", "SENSITIVE_PII", "high"],
    ["medical_record_number", "PHI", "high"],
    ["genetic_marker", "SENSITIVE_PII", "high"],
    ["product_name", "PII", "low"],
    ["created_at", null, null],
    ["tenant_id", null, null],
    ["email_category", null, null],
    ["awaiting_dob_reprompt", null, null],
    ["vendor_health", null, null],
    ["tax_number", "SENSITIVE_PII", "medium"],
    ["vat_id", "SENSITIVE_PII", "medium"],
    ["ai_api_key", "SECRET", "high"],
    ["smtp_pass", "SECRET", "high"],
    ["access_token", "SECRET", "high"],
    ["password_reset_token", null, null, undefined],
    ["invite_token", null, null],
    ["share_token", null, null],
    ["name", "PII", "low", undefined, "profiles"],
    ["name", null, null, undefined, "organizations"],
    ["company_name", null, null, undefined, "tenants"],
    ["number", null, null, undefined, "orders"],
    ["number", "PII", "medium", undefined, "contact_numbers"],
    ["value", null, null, undefined, "widgets"],
    ["value", "SECRET", "medium", undefined, "jackson_store"],
    ["pin_block", "PCI", "high"],
    ["track2", "PCI", "high"],
    ["is_pinned", null, null],
    ["mac_address", "SENSITIVE_PII", "medium"],
    ["license_plate", "PII", "medium"],
    ["avatar_url", "PII", "medium"],
    ["has_photo", null, null, "boolean"],
    ["national_id", "SENSITIVE_PII", "medium"],
    ["id", null, null],
    ["user_id", null, null],
    ["profile", "PII", "low", "jsonb", "users"],
    ["metadata", "PII", "low", "jsonb"],
    ["ui_state", null, null, "jsonb"],
    ["profile", null, null, "text"],
  ];
  let ok = 0;
  for (const [col, cat, conf, sqlType, tableName] of cases) {
    const r = classifyColumn(col, sqlType, tableName);
    const pass = cat === null ? r === null : r && r.category === cat && r.confidence === conf;
    const label = tableName ? `${tableName}.${col}` : col;
    console.log(`${pass ? "PASS" : "FAIL"}  ${label} → ${r ? r.category + "/" + r.confidence : "none"}`);
    if (pass) ok++;
  }
  console.log(`\n${ok}/${cases.length} passed`);
  process.exit(ok === cases.length ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--selftest")) selftest();
  else if (process.argv.includes("--schema")) reportMode(process.argv[process.argv.indexOf("--schema") + 1]);
  else guardMode();
}
