// Mocked-tenant-test guard — Harvey Tier-1 port (refs #2028).
//
// Ported from Harvey src/detectors/test-intent.ts (the rls-mocked-db check
// ONLY) @ 5b5aada, adapted for ATC (no Finding[] plumbing — repo check-script
// output/exit-code conventions).
//
// Flags a test that CLAIMS tenant-isolation/RLS coverage by name (its title or
// an enclosing describe mentions tenant / rls / isolation / row-level) while
// the file mocks the Supabase client (vi.mock/jest.mock of an @supabase/*
// package, a supabase-named module, or a local wrapper that creates the
// client). RLS is enforced by Postgres, not application code — a mocked client
// means no query ever reaches the layer the test's name promises to verify, so
// the test is provably unable to observe an RLS regression.
//
// Deliberately narrow (Harvey's own precision boundary): only name-claiming
// tests are eligible — a keyword miss is a silent skip, not an FP. Partial
// mocks (importActual/importOriginal factories) are exempt only while they
// preserve the real DB client factory.
//
// A genuine app-layer unit test may declare a mechanically checked companion
// integration test immediately above its registration:
//   // @rls-covered-by resources=table:public.bookings target=apps/main/test/integration/rls.test.ts#RLS integration bookings: userB cannot SELECT tenantA rows
// The target must resolve to exactly one full runnable title. Its callback must
// await the canonical isolation witness, which directly owns a real query for
// the declared resource(s), an exact allow-list, and a non-empty deny-list.
//
// FREEZE-EXISTING / BLOCK-NEW: the existing claimed-but-mocked tests (#2028's
// ~53 raw Harvey sites; fewer under this port's precision boundary) are frozen
// in scripts/mocked-tenant-tests-baseline.txt, count-keyed by file. NEW ones
// fail. Fails loud when zero test files are scanned.
//
// Usage: tsx scripts/check-mocked-tenant-tests.ts [testDir ...]

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { parseRoutineEvents } from "./check-ledger-objects";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_FILE = path.join(ROOT, "scripts/mocked-tenant-tests-baseline.txt");

// Harvey's regex is a bare /tenant|rls|isolation|row-level/. In ATC "tenant"
// is the core domain noun (billing, onboarding, review flows all name it), so
// the bare word flags hundreds of non-isolation tests; the claim is narrowed
// to ISOLATION-shaped phrases — the coverage the mock makes impossible.
const TENANT_CLAIM =
  /tenant[- ]?(isolation|scope[ds]?|filter)|cross[- ]?tenant|(another|other|wrong|second)[- ]tenant'?s?\b|\brls\b|isolation|row[- ]?level/i;
const SUPABASE_CLIENT_FACTORY = /\bcreate(Server|Browser|Route|Middleware)?Client\s*\(/;
const COVERAGE_POINTER = /@rls-covered-by[^\r\n]*/g;
const COVERAGE_POINTER_FORMAT = /^@rls-covered-by resources=([^\s]+) target=([^\s#]+)#(.+)$/;
const COVERAGE_RESOURCE = /^(table|rpc):[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;
const INTEGRATION_TEST_PATH = /^apps\/[^/]+\/test\/integration\/.+\.(test|spec)\.[cm]?[jt]sx?$/;
const ISOLATION_WITNESS_PATH = "tests/helpers/isolation-witness";

export type PostgresProvenanceTarget = "main" | "rag";
type PostgresRelationKind = "table" | "partitioned_table" | "view" | "materialized_view" | "foreign_table";
const REVIEWED_POLICY_ROUTINES = ["auth_user_in_tenant"] as const;
const REVIEWED_ROUTINES = ["public.auth_user_in_tenant", "public.match_region_itinerary_chunks"] as const;

interface PostgresPolicyProvenance {
  command: "all" | "select" | "insert" | "update" | "delete";
  definitionHash: string;
  functionBindings: ReadonlyMap<string, string | undefined>;
}

interface PostgresRoleAuthority {
  superuser: boolean;
  bypassRls: boolean;
}

export interface PostgresMigrationProvenance {
  relations: ReadonlyMap<string, PostgresRelationKind>;
  relationAlterations: ReadonlyMap<string, readonly string[]>;
  rlsEnabled: ReadonlyMap<string, boolean>;
  policies: ReadonlyMap<string, ReadonlyMap<string, PostgresPolicyProvenance>>;
  functions: ReadonlyMap<string, ReadonlyMap<string, string>>;
  functionIdentities: ReadonlyMap<string, ReadonlyMap<string, string>>;
  catalogRoutinesTrusted: boolean;
  executableProvenanceTrusted: boolean;
  rules: ReadonlyMap<string, ReadonlyMap<string, string>>;
  operators: ReadonlyMap<string, string>;
  casts: ReadonlySet<string>;
  types: ReadonlySet<string>;
  extensions: ReadonlyMap<string, string>;
  runtimeSearchPaths: ReadonlyMap<string, readonly string[] | undefined>;
  roleAuthorities: ReadonlyMap<string, PostgresRoleAuthority>;
  ambiguousRoleAuthorities: ReadonlySet<string>;
  ambiguousSchemas: ReadonlySet<string>;
  ambiguousOperators: ReadonlySet<string>;
  ambiguousCasts: ReadonlySet<string>;
  ambiguousTypes: ReadonlySet<string>;
  ambiguousExtensions: ReadonlySet<string>;
  ambiguousIndexCatalog: ReadonlySet<string>;
  ambiguousPolicyTables: ReadonlySet<string>;
  ambiguousFunctions: ReadonlySet<string>;
}

const SQL_IDENTIFIER = '(?:"(?:""|[^"])+"|[a-zA-Z_][a-zA-Z0-9_$]*)';
const SQL_QUALIFIED_NAME = `${SQL_IDENTIFIER}(?:\\s*\\.\\s*${SQL_IDENTIFIER})?`;

function unquotePostgresIdentifier(identifier: string): string {
  return identifier.startsWith('"')
    ? identifier.slice(1, -1).replace(/""/g, '"')
    : identifier.toLowerCase();
}

function normalizedQualifiedName(name: string): string | undefined {
  const match = new RegExp(`^(${SQL_IDENTIFIER})(?:\\s*\\.\\s*(${SQL_IDENTIFIER}))?$`).exec(name.trim());
  if (!match) return undefined;
  const schema = match[2] ? unquotePostgresIdentifier(match[1]!) : "public";
  const object = unquotePostgresIdentifier(match[2] ?? match[1]!);
  return `${schema}.${object}`;
}

function skipLeadingSqlTrivia(sql: string): number {
  let index = 0;
  while (index < sql.length) {
    if (/\s/.test(sql[index]!)) {
      index += 1;
      continue;
    }
    if (sql.startsWith("--", index)) {
      const newline = sql.indexOf("\n", index + 2);
      index = newline < 0 ? sql.length : newline + 1;
      continue;
    }
    if (sql.startsWith("/*", index)) {
      let depth = 1;
      index += 2;
      while (index < sql.length && depth > 0) {
        if (sql.startsWith("/*", index)) {
          depth += 1;
          index += 2;
        } else if (sql.startsWith("*/", index)) {
          depth -= 1;
          index += 2;
        } else index += 1;
      }
      if (depth !== 0) return sql.length;
      continue;
    }
    break;
  }
  return index;
}

function migrationStatements(sql: string): string[] {
  const statements: string[] = [];
  const executableSql = sql.split("");
  const maskComment = (from: number, to: number) => {
    for (let offset = from; offset < to; offset += 1) {
      if (executableSql[offset] !== "\n" && executableSql[offset] !== "\r") executableSql[offset] = " ";
    }
  };
  let start = 0;
  let index = 0;
  while (index < sql.length) {
    const char = sql[index]!;
    const escapeString = (char === "e" || char === "E") && sql[index + 1] === "'";
    if (char === "'" || char === '"' || escapeString) {
      const quote = escapeString ? "'" : char;
      index += escapeString ? 2 : 1;
      let closed = false;
      while (index < sql.length) {
        if (quote === "'" && escapeString && sql[index] === "\\") index += Math.min(2, sql.length - index);
        else if (sql[index] === quote && sql[index + 1] === quote) index += 2;
        else if (sql[index] === quote) {
          index += 1;
          closed = true;
          break;
        } else index += 1;
      }
      if (!closed) throw new Error("unterminated quoted value in migration SQL");
      continue;
    }
    if (sql.startsWith("--", index)) {
      const commentStart = index;
      const newline = sql.indexOf("\n", index + 2);
      index = newline < 0 ? sql.length : newline + 1;
      maskComment(commentStart, index);
      continue;
    }
    if (sql.startsWith("/*", index)) {
      const commentStart = index;
      let depth = 1;
      index += 2;
      while (index < sql.length && depth > 0) {
        if (sql.startsWith("/*", index)) {
          depth += 1;
          index += 2;
        } else if (sql.startsWith("*/", index)) {
          depth -= 1;
          index += 2;
        } else index += 1;
      }
      if (depth !== 0) throw new Error("unterminated block comment in migration SQL");
      maskComment(commentStart, index);
      continue;
    }
    if (char === "$") {
      const delimiter = /^\$[a-zA-Z_][a-zA-Z0-9_]*\$|^\$\$/.exec(sql.slice(index))?.[0];
      if (delimiter) {
        const close = sql.indexOf(delimiter, index + delimiter.length);
        if (close < 0) throw new Error("unterminated dollar-quoted value in migration SQL");
        index = close + delimiter.length;
        continue;
      }
    }
    if (char === ";") {
      const statement = executableSql.slice(start, index).join("").trim();
      if (statement) statements.push(statement.slice(skipLeadingSqlTrivia(statement)).trim());
      start = index + 1;
    }
    index += 1;
  }
  const statement = executableSql.slice(start).join("").trim();
  if (statement) statements.push(statement.slice(skipLeadingSqlTrivia(statement)).trim());
  return statements.filter(Boolean);
}

function postgresExecutableAnalysis(sql: string): {
  executableSql: string;
  unquotedExecutableSql: string;
  routineCalls: string[];
  unicodeDelimitedIdentifier: boolean;
} {
  const executable = [...sql];
  const quotedIdentifiers: Array<readonly [number, number]> = [];
  let unicodeDelimitedIdentifier = false;
  for (let index = 0; index < executable.length; index += 1) {
    const char = executable[index]!;
    const escapeString = /[eE]/.test(char) && executable[index + 1] === "'";
    if (char === "'" || escapeString) {
      const start = index;
      index += escapeString ? 2 : 1;
      while (index < executable.length) {
        if (escapeString && executable[index] === "\\") index += 2;
        else if (executable[index] === "'" && executable[index + 1] === "'") index += 2;
        else if (executable[index] === "'") break;
        else index += 1;
      }
      executable.fill(" ", start, Math.min(index + 1, executable.length));
    } else if (char === "\"") {
      const start = index;
      index += 1;
      while (index < executable.length) {
        if (executable[index] === "\"" && executable[index + 1] === "\"") index += 2;
        else if (executable[index] === "\"") break;
        else index += 1;
      }
      quotedIdentifiers.push([start, index]);
    } else if ((char === "u" || char === "U") && executable[index + 1] === "&" && executable[index + 2] === "\"") {
      unicodeDelimitedIdentifier = true;
    } else if (char === "-") {
      if (executable[index + 1] !== "-") continue;
      const start = index;
      const newline = sql.indexOf("\n", index + 2);
      index = newline < 0 ? executable.length : newline;
      executable.fill(" ", start, Math.min(index + 1, executable.length));
    } else if (char === "/") {
      if (executable[index + 1] !== "*") continue;
      const start = index;
      let depth = 1;
      index += 2;
      while (index < executable.length && depth > 0) {
        if (executable[index] === "/" && executable[index + 1] === "*") {
          depth += 1;
          index += 2;
        } else if (executable[index] === "*" && executable[index + 1] === "/") {
          depth -= 1;
          index += 2;
        } else index += 1;
      }
      index -= 1;
      executable.fill(" ", start, Math.min(index + 1, executable.length));
    } else if (char === "$") {
      const delimiter = /^\$[a-zA-Z_][a-zA-Z0-9_]*\$|^\$\$/.exec(executable.slice(index).join(""))?.[0];
      if (delimiter) {
        const start = index;
        const close = sql.indexOf(delimiter, index + delimiter.length);
        index = close < 0 ? executable.length : close + delimiter.length - 1;
        executable.fill(" ", start, Math.min(index + 1, executable.length));
      }
    }
  }
  const executableSql = executable.join("");
  const unquotedExecutable = [...executableSql];
  for (const [start, end] of quotedIdentifiers) unquotedExecutable.fill(" ", start, end + 1);
  const routineCalls: string[] = [];
  for (const match of executableSql.matchAll(new RegExp(`(${SQL_QUALIFIED_NAME})\\s*\\(`, "gi"))) {
    if (quotedIdentifiers.some(([start, end]) => match.index > start && match.index < end)) continue;
    routineCalls.push(match[1]!);
  }
  return { executableSql, unquotedExecutableSql: unquotedExecutable.join(""), routineCalls, unicodeDelimitedIdentifier };
}

function definitionHash(sql: string): string {
  return createHash("sha256").update(sql.replace(/\r\n?/g, "\n").trim()).digest("hex");
}

const POSTGRES_TYPE_ALIASES: Readonly<Record<string, string>> = {
  int: "integer", int4: "integer", int2: "smallint", int8: "bigint",
  bool: "boolean", float4: "real", float8: "double precision",
  varchar: "character varying", char: "character", decimal: "numeric",
  timestamp: "timestamp without time zone", timestamptz: "timestamp with time zone",
  time: "time without time zone", timetz: "time with time zone",
};

function normalizedRoutineSignature(types: readonly string[]): string {
  return types.map((type) => {
    const normalized = type
      .trim()
      .replace(/\s+/g, " ")
      .replace(/(?:\bpg_catalog|"pg_catalog")\s*\.\s*/gi, "")
      .replace(/\s+ARRAY\b/gi, "[]")
      .replace(/\s*\[\s*\]/g, "[]")
      .toLowerCase();
    const suffix = normalized.endsWith("[]") ? "[]" : "";
    const rawBase = suffix ? normalized.slice(0, -2) : normalized;
    const base = /^"(?:""|[^"])+"$/.test(rawBase) ? unquotePostgresIdentifier(rawBase) : rawBase;
    return `${POSTGRES_TYPE_ALIASES[base] ?? base}${suffix}`;
  }).join(",");
}

function normalizedRoutineEventSignature(
  event: ReturnType<typeof parseRoutineEvents>[number],
): string {
  return normalizedRoutineSignature(event.arguments.map((argument) => {
    const first = argument.typeCandidates[0]!;
    const last = argument.typeCandidates.at(-1)!;
    return event.action === "drop" && /^(?:\.|\[|array\b|with(?:out)?\b|varying\b|precision\b)/i.test(last.trim())
      ? first
      : last;
  }));
}

function normalizedSearchPath(value: string): string[] | undefined {
  const normalized = value.trim().replace(/^TO\s+/i, "").replace(/^=\s*/, "");
  if (/^DEFAULT$/i.test(normalized)) return ["$user", "public"];
  const schemas: string[] = [];
  for (const raw of normalized.split(",")) {
    const item = raw.trim();
    if (!item) return undefined;
    if (/^'[^']*'$/.test(item)) {
      const contents = item.slice(1, -1).replace(/''/g, "'");
      for (const part of contents.split(",")) {
        const schema = part.trim();
        if (!schema) return undefined;
        schemas.push(schema === "$user" ? schema : schema.toLowerCase());
      }
      continue;
    }
    if (item === "$user") schemas.push(item);
    else {
      const name = new RegExp(`^(${SQL_IDENTIFIER})$`).exec(item)?.[1];
      if (!name) return undefined;
      schemas.push(unquotePostgresIdentifier(name));
    }
  }
  return schemas;
}

function splitTopLevelSqlList(value: string): string[] {
  const items: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (quote) {
      if (char === quote && value[index + 1] === quote) index += 1;
      else if (char === quote) quote = undefined;
    } else if (char === "'" || char === '"') quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      items.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  items.push(value.slice(start).trim());
  return items.filter(Boolean);
}

function normalizedRoleValue(value: string): string | undefined {
  const stringRole = /^'((?:''|[^'])*)'$/.exec(value)?.[1]?.replace(/''/g, "'");
  const identifierRole = new RegExp(`^(${SQL_IDENTIFIER})$`).exec(value)?.[1];
  return stringRole ?? (identifierRole ? unquotePostgresIdentifier(identifierRole) : undefined);
}

function resolvedRoleSpecification(
  value: string,
  currentRole: string,
  sessionAuthorization: string,
): string | undefined {
  const keyword = !value.startsWith('"') ? value.toLowerCase() : undefined;
  if (keyword === "current_role" || keyword === "current_user") return currentRole;
  if (keyword === "session_user") return sessionAuthorization;
  return keyword === "all" ? undefined : unquotePostgresIdentifier(value);
}

const POSTGRES_OPERATOR_NAME = "[-+*/<>=~!@#%^&|`?]+";

interface PostgresOperatorClass {
  name: string;
  method: string;
  isDefault: boolean;
}

const POSTGRES_BUILTIN_OPERATOR_CLASSES = new Set([
  "array_ops\u0000btree", "array_ops\u0000hash", "array_ops\u0000gin",
  "date_ops\u0000btree", "date_ops\u0000hash",
  "text_ops\u0000btree", "text_ops\u0000hash",
  "timestamp_ops\u0000btree", "timestamp_ops\u0000hash",
  "timestamptz_ops\u0000btree", "timestamptz_ops\u0000hash",
  "uuid_ops\u0000btree", "uuid_ops\u0000hash",
]);

const REVIEWED_POSTGRES_ROLE_AUTHORITIES: ReadonlyMap<string, PostgresRoleAuthority> = new Map([
  ["authenticated", { superuser: false, bypassRls: false }],
  ["service_role", { superuser: false, bypassRls: true }],
]);

const REVIEWED_POSTGRES_DO_HASHES = new Map([
  ["20260617000000_bp34_phase_c_gmail_storage.sql", "d18341646fb0342f0fe245ee03bba94de26b334444efe4ea47a958f6aa69cefa"],
  ["20260618000000_bp35_referral_attribution.sql", "eb56c168c13632eaecc15a1d285a73d9c7ebb77caf8d63b97c225f0728d8b5c4"],
  ["20260620000000_bp37_tasks_and_follow_up.sql", "20e88a0e9df89348a5f835d0fa866bf537822ce5e928b22e44fb2c8ad0f2dc71"],
  ["20260622000000_bp39_client_facing_deliverables.sql", "528616916316f4114ba08c9433c94e694d06274483f5f2900284c856c2157031"],
  ["20260625000003_quote_pdfs_bucket.sql", "696af51ee7327239e5a9635749cf9253ca7b5787aa01c0dc2a9785cff4f10c9c"],
  ["20260701000003_canonical_match_reviews.sql", "49675286a501c7fc4e6ffde3957b36dd06afdb5eb0362a36a0e7a8e2b7c338d5"],
  ["20260814041302_help_docs_storage_tenant_select.sql", "1b8b074167006f22f287aeff56c015e52a48ce12c4b19142d8089fc87afe930f"],
]);

function normalizedOperatorName(value: string): { schema: string; name: string } | undefined {
  const match = new RegExp(`^(?:(${SQL_IDENTIFIER})\\s*\\.\\s*)?(${POSTGRES_OPERATOR_NAME})$`).exec(value.trim());
  if (!match) return undefined;
  return {
    schema: match[1] ? unquotePostgresIdentifier(match[1]) : "public",
    name: match[2]!,
  };
}

function operatorIdentity(schema: string, name: string, leftType: string, rightType: string): string {
  return [schema, name, leftType, rightType].join("\u0000");
}

/** Derives only executable object facts needed to validate reviewed raw-SQL witnesses. */
export function derivePostgresMigrationProvenance(
  migrations: readonly { file: string; sql: string }[],
): PostgresMigrationProvenance {
  const relations = new Map<string, PostgresRelationKind>();
  const relationAlterations = new Map<string, string[]>();
  const rlsEnabled = new Map<string, boolean>();
  const policies = new Map<string, Map<string, PostgresPolicyProvenance>>();
  const functions = new Map<string, Map<string, string>>();
  const functionIdentities = new Map<string, Map<string, string>>();
  const directDynamicRoutineIdentities = new Set<string>();
  const routineCallDependencies = new Map<string, Set<string>>();
  const droppedRoutineIdentityBySlot = new Map<string, string>();
  const routineIdentitySuccessors = new Map<string, string | null>();
  const triggers = new Map<string, {
    table: string;
    events: ReadonlySet<string>;
    routineIdentity: string | undefined;
  }>();
  let catalogRoutinesTrusted = true;
  let executableProvenanceTrusted = true;
  const rules = new Map<string, Map<string, string>>();
  const operators = new Map<string, string>();
  const casts = new Set<string>();
  const types = new Set<string>();
  const extensions = new Map<string, string>();
  const runtimeSearchPaths = new Map<string, readonly string[] | undefined>();
  const roleAuthorities = new Map<string, PostgresRoleAuthority>(
    [...REVIEWED_POSTGRES_ROLE_AUTHORITIES].map(([role, authority]) => [role, { ...authority }] as const),
  );
  const ambiguousRoleAuthorities = new Set<string>();
  const ambiguousSchemas = new Set<string>();
  const ambiguousOperators = new Set<string>();
  const ambiguousCasts = new Set<string>();
  const ambiguousTypes = new Set<string>();
  const ambiguousExtensions = new Set<string>();
  const ambiguousIndexCatalog = new Set<string>();
  const operatorClasses = new Map<string, PostgresOperatorClass>();
  const accessMethods = new Set<string>();
  const indexes = new Set(["public.bookings_pkey"]);
  const schemas = new Set(["pg_catalog", "public"]);
  const ambiguousPolicyTables = new Set<string>();
  const ambiguousFunctions = new Set<string>();
  let sessionSearchPath: readonly string[] | undefined = ["$user", "public"];
  let sessionAuthorization = "postgres";
  let sessionRole = sessionAuthorization;
  let routineIdentitySerial = 0;

  const routineIdentityIsDynamic = (identity: string, visited = new Set<string>()): boolean => {
    if (directDynamicRoutineIdentities.has(identity)) return true;
    if (visited.has(identity)) return false;
    visited.add(identity);
    if (routineIdentitySuccessors.has(identity)) {
      const successor = routineIdentitySuccessors.get(identity);
      return successor === null || routineIdentityIsDynamic(successor!, visited);
    }
    return [...(routineCallDependencies.get(identity) ?? [])].some((dependency) =>
      routineIdentityIsDynamic(dependency, visited)
    );
  };

  const resolvedRelationName = (
    value: string,
    searchPath: readonly string[] | undefined,
    role: string,
    creation = false,
  ): string | undefined => {
    const match = new RegExp(`^(${SQL_IDENTIFIER})(?:\\s*\\.\\s*(${SQL_IDENTIFIER}))?$`).exec(value.trim());
    if (!match) return undefined;
    if (match[2]) return `${unquotePostgresIdentifier(match[1]!)}.${unquotePostgresIdentifier(match[2])}`;
    const object = unquotePostgresIdentifier(match[1]!);
    const configuredPath = searchPath?.map((schema) => schema === "$user" ? role : schema);
    if (creation) {
      const schema = configuredPath?.find((candidate) => schemas.has(candidate));
      return schema && `${schema}.${object}`;
    }
    const orderedPath = configuredPath?.includes("pg_catalog")
      ? configuredPath
      : configuredPath && ["pg_catalog", ...configuredPath];
    return orderedPath?.map((schema) => `${schema}.${object}`).find((name) => relations.has(name));
  };

  const relationExpression = new RegExp(
    `^CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:(UNLOGGED)\\s+)?(MATERIALIZED\\s+VIEW|FOREIGN\\s+TABLE|VIEW|TABLE)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${SQL_QUALIFIED_NAME})([\\s\\S]*)$`,
    "i",
  );
  const dropRelationExpression = new RegExp(
    `^DROP\\s+(?:MATERIALIZED\\s+VIEW|FOREIGN\\s+TABLE|VIEW|TABLE)\\s+(?:IF\\s+EXISTS\\s+)?([\\s\\S]+)$`,
    "i",
  );
  const tableTailExpression = new RegExp(
    `^ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?(${SQL_QUALIFIED_NAME})([\\s\\S]*)$`,
    "i",
  );
  const createPolicyExpression = new RegExp(
    `^CREATE\\s+POLICY\\s+(${SQL_IDENTIFIER})\\s+ON\\s+(${SQL_QUALIFIED_NAME})([\\s\\S]*)$`,
    "i",
  );
  const dropPolicyExpression = new RegExp(
    `^DROP\\s+POLICY\\s+(?:IF\\s+EXISTS\\s+)?(${SQL_IDENTIFIER})\\s+ON\\s+(${SQL_QUALIFIED_NAME})`,
    "i",
  );
  const alterPolicyExpression = new RegExp(
    `^ALTER\\s+POLICY\\s+${SQL_IDENTIFIER}\\s+ON\\s+(${SQL_QUALIFIED_NAME})`,
    "i",
  );
  const createRuleExpression = new RegExp(
    `^CREATE\\s+(?:OR\\s+REPLACE\\s+)?RULE\\s+(${SQL_IDENTIFIER})[\\s\\S]*?\\bTO\\s+(${SQL_QUALIFIED_NAME})`,
    "i",
  );
  const dropRuleExpression = new RegExp(
    `^DROP\\s+RULE\\s+(?:IF\\s+EXISTS\\s+)?(${SQL_IDENTIFIER})\\s+ON\\s+(${SQL_QUALIFIED_NAME})`,
    "i",
  );

  for (const migration of migrations) {
    let currentSearchPath = sessionSearchPath;
    let currentRole = sessionRole;
    for (const statement of migrationStatements(migration.sql)) {
      const executableAnalysis = postgresExecutableAnalysis(statement);
      if (executableAnalysis.unicodeDelimitedIdentifier) executableProvenanceTrusted = false;
      const createdSchema = new RegExp(
        `^CREATE\\s+SCHEMA\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${SQL_IDENTIFIER})\\b`,
        "i",
      ).exec(statement);
      if (createdSchema) schemas.add(unquotePostgresIdentifier(createdSchema[1]!));
      const setRole = /^SET\s+(LOCAL\s+|SESSION\s+)?ROLE\s+([\s\S]+)$/i.exec(statement);
      if (setRole) {
        const rawRole = setRole[2]!.trim();
        if (/^(?:NONE|DEFAULT)$/i.test(rawRole)) currentRole = sessionAuthorization;
        else currentRole = normalizedRoleValue(rawRole) ?? "";
        if (!/^LOCAL\s+$/i.test(setRole[1] ?? "")) sessionRole = currentRole;
      } else if (/^RESET\s+ROLE$/i.test(statement)) {
        currentRole = sessionAuthorization;
        sessionRole = currentRole;
      }
      const setSessionAuthorization = /^SET\s+SESSION\s+AUTHORIZATION\s+([\s\S]+)$/i.exec(statement);
      if (setSessionAuthorization) {
        const rawRole = setSessionAuthorization[1]!.trim();
        sessionAuthorization = /^(?:DEFAULT)$/i.test(rawRole)
          ? "postgres"
          : normalizedRoleValue(rawRole) ?? "";
        currentRole = sessionAuthorization;
        sessionRole = currentRole;
      } else if (/^RESET\s+SESSION\s+AUTHORIZATION$/i.test(statement)) {
        sessionAuthorization = "postgres";
        currentRole = sessionAuthorization;
        sessionRole = currentRole;
      }
      const setSearchPath = /^SET\s+(LOCAL\s+|SESSION\s+)?search_path(?=\s|=)\s*([\s\S]+)$/i.exec(statement) ??
        /^SET\s+(LOCAL\s+|SESSION\s+)?SCHEMA\s+([\s\S]+)$/i.exec(statement);
      if (setSearchPath) {
        currentSearchPath = normalizedSearchPath(setSearchPath[2]!);
        if (!/^LOCAL\s+$/i.test(setSearchPath[1] ?? "")) sessionSearchPath = currentSearchPath;
      } else if (/^RESET\s+(?:search_path|ALL)$/i.test(statement)) {
        currentSearchPath = ["$user", "public"];
        sessionSearchPath = currentSearchPath;
      }
      const configuredSearchPath = /^SELECT\s+(?:pg_catalog\s*\.\s*)?set_config\s*\(\s*'search_path'\s*,\s*'((?:''|[^'])*)'\s*,\s*(true|false)\s*\)$/i.exec(statement);
      if (configuredSearchPath) {
        currentSearchPath = normalizedSearchPath(`'${configuredSearchPath[1]}'`);
        if (configuredSearchPath[2]!.toLowerCase() === "false") sessionSearchPath = currentSearchPath;
      } else if (/^SELECT\s+(?:pg_catalog\s*\.\s*)?set_config\s*\(\s*'search_path'/i.test(statement)) {
        currentSearchPath = undefined;
        sessionSearchPath = undefined;
      }

      const alteredRuntimePath = /^ALTER\s+(ROLE|USER|DATABASE|SYSTEM)\s+([\s\S]+)$/i.exec(statement);
      if (alteredRuntimePath && /\b(?:SET|RESET)\s+(?:ALL\b|search_path\b)/i.test(alteredRuntimePath[2]!)) {
        const kind = alteredRuntimePath[1]!.toLowerCase();
        const tail = alteredRuntimePath[2]!;
        let key: string | undefined;
        let action: string | undefined;
        if (kind === "role" || kind === "user") {
          const match = new RegExp(`^(${SQL_IDENTIFIER})(?:\\s+IN\\s+DATABASE\\s+(${SQL_IDENTIFIER}))?\\s+([\\s\\S]+)$`, "i").exec(tail);
          if (match) {
            const rawRole = match[1]!;
            const keywordRole = !rawRole.startsWith('"') ? rawRole.toLowerCase() : undefined;
            const database = match[2] ? unquotePostgresIdentifier(match[2]) : undefined;
            const role = resolvedRoleSpecification(rawRole, currentRole, sessionAuthorization);
            key = keywordRole === "all"
              ? database ? `database\u0000${database}` : "role-all"
              : database ? `role-db\u0000${role}\u0000${database}` : `role\u0000${role}`;
            action = match[3];
          }
        } else if (kind === "database") {
          const match = new RegExp(`^(${SQL_IDENTIFIER})\\s+([\\s\\S]+)$`, "i").exec(tail);
          if (match) {
            key = `database\u0000${unquotePostgresIdentifier(match[1]!)}`;
            action = match[2];
          }
        } else {
          key = "system";
          action = tail;
        }
        if (key && action) {
          if (/^RESET\s+(?:ALL|search_path)$/i.test(action.trim())) runtimeSearchPaths.delete(key);
          else {
            const value = /^SET\s+search_path(?=\s|=)\s*([\s\S]+)$/i.exec(action.trim())?.[1];
            runtimeSearchPaths.set(key, value ? normalizedSearchPath(value) : undefined);
          }
        }
      }

      const alteredRoleAuthority = new RegExp(
        `^ALTER\\s+(?:ROLE|USER)\\s+(${SQL_IDENTIFIER})\\s+([\\s\\S]+)$`,
        "i",
      ).exec(statement);
      if (alteredRoleAuthority && /\b(?:NO)?(?:SUPERUSER|BYPASSRLS)\b/i.test(alteredRoleAuthority[2]!)) {
        const rawRole = alteredRoleAuthority[1]!;
        const role = resolvedRoleSpecification(rawRole, currentRole, sessionAuthorization);
        const authority = role ? roleAuthorities.get(role) : undefined;
        if (authority) {
          for (const option of alteredRoleAuthority[2]!.matchAll(/\b(NOSUPERUSER|SUPERUSER|NOBYPASSRLS|BYPASSRLS)\b/gi)) {
            const value = option[1]!.toLowerCase();
            if (value.endsWith("superuser")) authority.superuser = value === "superuser";
            else authority.bypassRls = value === "bypassrls";
          }
        } else if (!role || role === "postgres") ambiguousRoleAuthorities.add(role ?? "*");
      }

      const changedRole = new RegExp(
        `^(?:CREATE|ALTER|DROP)\\s+(?:ROLE|USER)\\s+(?:IF\\s+EXISTS\\s+)?([\\s\\S]+)$`,
        "i",
      ).exec(statement);
      if (changedRole) {
        const candidates = /^DROP\s/i.test(statement)
          ? splitTopLevelSqlList(changedRole[1]!.replace(/\s+(?:CASCADE|RESTRICT)\s*$/i, ""))
          : [changedRole[1]!.split(/\s+(?:WITH\b|RENAME\b|IN\s+DATABASE\b|SET\b|RESET\b)/i, 1)[0]!];
        for (const candidate of candidates) {
          const rawRole = new RegExp(`^\\s*(${SQL_IDENTIFIER})`).exec(candidate)?.[1];
          if (!rawRole) {
            ambiguousRoleAuthorities.add("*");
            continue;
          }
          const role = resolvedRoleSpecification(rawRole, currentRole, sessionAuthorization);
          const destructive = !/^ALTER\s+(?:ROLE|USER)\b/i.test(statement) || /\bRENAME\s+TO\b/i.test(statement);
          if (destructive && (!role || ["authenticated", "service_role", "postgres"].includes(role))) {
            ambiguousRoleAuthorities.add(role ?? "*");
          }
        }
      }

      const relation = relationExpression.exec(statement);
      if (relation) {
        const name = resolvedRelationName(relation[3]!, currentSearchPath, currentRole, true);
        if (!name) continue;
        const declaredKind = relation[2]!.replace(/\s+/g, " ").toUpperCase();
        const kind: PostgresRelationKind = declaredKind === "MATERIALIZED VIEW"
          ? "materialized_view"
          : declaredKind === "FOREIGN TABLE"
            ? "foreign_table"
            : declaredKind === "VIEW"
              ? "view"
              : /\bPARTITION\s+BY\b/i.test(relation[4]!)
                ? "partitioned_table"
                : "table";
        relations.set(name, kind);
        if (!relationAlterations.has(name)) relationAlterations.set(name, []);
      }
      const droppedRelation = dropRelationExpression.exec(statement);
      if (droppedRelation) {
        for (const candidate of splitTopLevelSqlList(
          droppedRelation[1]!.replace(/\s+(?:CASCADE|RESTRICT)\s*$/i, ""),
        )) {
          const name = resolvedRelationName(candidate, currentSearchPath, currentRole);
          if (!name) continue;
          relations.delete(name);
          relationAlterations.delete(name);
          rlsEnabled.delete(name);
          policies.delete(name);
          rules.delete(name);
          for (const [key, trigger] of triggers) if (trigger.table === name) triggers.delete(key);
        }
      }
      const alteredTable = tableTailExpression.exec(statement);
      if (alteredTable) {
        const name = resolvedRelationName(alteredTable[1]!, currentSearchPath, currentRole);
        if (name) {
          const tail = alteredTable[2]!;
          const alterations = relationAlterations.get(name) ?? [];
          alterations.push(definitionHash(statement));
          relationAlterations.set(name, alterations);
          if (/\bENABLE\s+ROW\s+LEVEL\s+SECURITY\b/i.test(tail)) rlsEnabled.set(name, true);
          if (/\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i.test(tail)) rlsEnabled.set(name, false);
          const renamed = new RegExp(`^\\s*RENAME\\s+TO\\s+(${SQL_IDENTIFIER})`, "i").exec(tail);
          const schemaChanged = new RegExp(`^\\s*SET\\s+SCHEMA\\s+(${SQL_IDENTIFIER})`, "i").exec(tail);
          if (renamed || schemaChanged) {
            const separator = name.indexOf(".");
            const next = renamed
              ? `${name.slice(0, separator)}.${unquotePostgresIdentifier(renamed[1]!)}`
              : `${unquotePostgresIdentifier(schemaChanged![1]!)}.${name.slice(separator + 1)}`;
            const kind = relations.get(name);
            if (kind) relations.set(next, kind);
            relations.delete(name);
            relationAlterations.set(next, relationAlterations.get(name) ?? []);
            relationAlterations.delete(name);
            if (rlsEnabled.has(name)) rlsEnabled.set(next, rlsEnabled.get(name)!);
            rlsEnabled.delete(name);
            if (policies.has(name)) policies.set(next, policies.get(name)!);
            policies.delete(name);
            if (rules.has(name)) rules.set(next, rules.get(name)!);
            rules.delete(name);
            for (const [key, trigger] of triggers) if (trigger.table === name) {
              triggers.delete(key);
              triggers.set(`${next}\u0000${key.slice(key.indexOf("\u0000") + 1)}`, { ...trigger, table: next });
            }
          }
        }
      }
      const createdPolicy = createPolicyExpression.exec(statement);
      if (createdPolicy) {
        const table = normalizedQualifiedName(createdPolicy[2]!);
        if (table) {
          const name = unquotePostgresIdentifier(createdPolicy[1]!);
          const command = /\bFOR\s+(ALL|SELECT|INSERT|UPDATE|DELETE)\b/i.exec(createdPolicy[3]!)?.[1]?.toLowerCase() ?? "all";
          const functionBindings = new Map<string, string | undefined>();
          for (const routine of REVIEWED_POLICY_ROUTINES) {
            const qualifiedCallsRemoved = createdPolicy[3]!.replace(
              new RegExp(`${SQL_IDENTIFIER}\\s*\\.\\s*${routine}\\s*\\(`, "gi"),
              "",
            );
            if (new RegExp(`\\b${routine}\\s*\\(`, "i").test(qualifiedCallsRemoved)) {
              let identity: string | undefined;
              const ordered = currentSearchPath?.includes("pg_catalog")
                ? currentSearchPath
                : currentSearchPath && ["pg_catalog", ...currentSearchPath];
              for (const schema of ordered ?? []) {
                const qualified = `${schema === "$user" ? currentRole : schema}.${routine}`;
                const overloads = functions.get(qualified);
                if (overloads && overloads.size > 1) break;
                if (overloads?.size === 1) {
                  identity = functionIdentities.get(qualified)?.values().next().value;
                  break;
                }
              }
              functionBindings.set(routine, identity);
            }
          }
          const byName = policies.get(table) ?? new Map<string, PostgresPolicyProvenance>();
          byName.set(name, {
            command: command as PostgresPolicyProvenance["command"],
            definitionHash: definitionHash(statement),
            functionBindings,
          });
          policies.set(table, byName);
        }
      }
      const droppedPolicy = dropPolicyExpression.exec(statement);
      if (droppedPolicy) {
        const table = normalizedQualifiedName(droppedPolicy[2]!);
        if (table) policies.get(table)?.delete(unquotePostgresIdentifier(droppedPolicy[1]!));
      }
      const alteredPolicy = alterPolicyExpression.exec(statement);
      if (alteredPolicy) {
        const table = normalizedQualifiedName(alteredPolicy[1]!);
        if (table) ambiguousPolicyTables.add(table);
      }
      const createdRule = createRuleExpression.exec(statement);
      if (createdRule) {
        const table = normalizedQualifiedName(createdRule[2]!);
        if (table) {
          const byName = rules.get(table) ?? new Map<string, string>();
          byName.set(unquotePostgresIdentifier(createdRule[1]!), definitionHash(statement));
          rules.set(table, byName);
        }
      }
      const droppedRule = dropRuleExpression.exec(statement);
      if (droppedRule) {
        const table = normalizedQualifiedName(droppedRule[2]!);
        if (table) rules.get(table)?.delete(unquotePostgresIdentifier(droppedRule[1]!));
      }

      if (/^DO\b/i.test(statement) &&
        REVIEWED_POSTGRES_DO_HASHES.get(migration.file) !== definitionHash(statement)) {
        catalogRoutinesTrusted = false;
      }

      const resolveRoutineMutation = (
        declaredName: string,
        creation: boolean,
        signature?: string,
      ): string | undefined => {
        const normalized = normalizedQualifiedName(declaredName);
        if (!normalized) return undefined;
        const qualified = new RegExp(`^${SQL_IDENTIFIER}\\s*\\.\\s*${SQL_IDENTIFIER}$`).test(declaredName);
        if (qualified) return normalized;
        const configuredPath = currentSearchPath?.map((item) => item === "$user" ? currentRole : item);
        if (!configuredPath) return undefined;
        if (creation) {
          const schema = configuredPath.find((item) => schemas.has(item));
          return schema && `${schema}.${normalized.slice(normalized.indexOf(".") + 1)}`;
        }
        const objectName = normalized.slice(normalized.indexOf(".") + 1);
        const lookupPath = configuredPath.includes("pg_catalog")
          ? configuredPath
          : ["pg_catalog", ...configuredPath];
        for (const schema of lookupPath) {
          const overloads = functions.get(`${schema}.${objectName}`);
          if (signature === undefined ? overloads?.size === 1 : overloads?.has(signature)) {
            return `${schema}.${objectName}`;
          }
          if (schema === "pg_catalog") return `${schema}.${objectName}`;
        }
        return undefined;
      };
      const routineMutationTouchesCatalog = (
        declaredName: string,
        creation: boolean,
        signature?: string,
      ): boolean => {
        const resolved = resolveRoutineMutation(declaredName, creation, signature);
        return !resolved || resolved.startsWith("pg_catalog.");
      };
      const routineCallIdentities = (calls: readonly string[], signature?: string): Set<string> => {
        const identities = new Set<string>();
        const configuredPath = currentSearchPath?.map((item) => item === "$user" ? currentRole : item);
        const lookupPath = configuredPath?.includes("pg_catalog")
          ? configuredPath
          : configuredPath && ["pg_catalog", ...configuredPath];
        for (const call of calls) {
          const name = normalizedQualifiedName(call);
          if (!name) continue;
          const qualified = new RegExp(`^${SQL_IDENTIFIER}\\s*\\.\\s*${SQL_IDENTIFIER}$`).test(call);
          const candidates = qualified
            ? [name]
            : lookupPath?.map((schema) => `${schema}.${name.slice(name.indexOf(".") + 1)}`) ?? [];
          for (const candidate of candidates) {
            if (signature !== undefined) {
              const identity = functionIdentities.get(candidate)?.get(signature);
              if (identity) {
                identities.add(identity);
                break;
              }
            } else {
              for (const identity of functionIdentities.get(candidate)?.values() ?? []) identities.add(identity);
            }
          }
        }
        return identities;
      };
      const createRoutineHeader = /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE|AGGREGATE)\b/i.test(statement);
      if (createRoutineHeader) {
        const createdRoutine = new RegExp(
          `^CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:FUNCTION|PROCEDURE|AGGREGATE)\\s+(${SQL_QUALIFIED_NAME})(?=\\s|\\()`,
          "i",
        ).exec(statement);
        if (!createdRoutine || routineMutationTouchesCatalog(createdRoutine[1]!, true)) {
          catalogRoutinesTrusted = false;
        }
      }
      const alterRoutineHeader = /^ALTER\s+(?:FUNCTION|PROCEDURE|ROUTINE|AGGREGATE)\b/i.test(statement);
      if (alterRoutineHeader) {
        const alteredRoutine = new RegExp(
          `^ALTER\\s+(?:FUNCTION|PROCEDURE|ROUTINE|AGGREGATE)\\s+(${SQL_QUALIFIED_NAME})(?=\\s|\\()`,
          "i",
        ).exec(statement);
        const alteredEvent = parseRoutineEvents(
          statement.replace(/^ALTER\s+(?:FUNCTION|PROCEDURE|ROUTINE|AGGREGATE)\b/i, "DROP FUNCTION"),
          migration.file,
        )[0];
        const alteredSignature = alteredEvent && normalizedRoutineEventSignature(alteredEvent);
        const changesSchema = /\bSET\s+SCHEMA\b/i.test(statement);
        const destination = new RegExp(`\\bSET\\s+SCHEMA\\s+(${SQL_IDENTIFIER})\\s*$`, "i").exec(statement)?.[1];
        if (!alteredRoutine || routineMutationTouchesCatalog(alteredRoutine[1]!, false, alteredSignature) ||
          (changesSchema && (!destination || unquotePostgresIdentifier(destination) === "pg_catalog"))) {
          catalogRoutinesTrusted = false;
        }
        const source = alteredRoutine && resolveRoutineMutation(alteredRoutine[1]!, false, alteredSignature);
        const renamed = new RegExp(`\\bRENAME\\s+TO\\s+(${SQL_IDENTIFIER})\\s*$`, "i").exec(statement)?.[1];
        if (source && !source.startsWith("pg_catalog.") && (renamed || destination)) {
          const sourceDefinitions = functions.get(source);
          const signature = alteredSignature ?? (sourceDefinitions?.size === 1
            ? sourceDefinitions.keys().next().value
            : undefined);
          if (signature !== undefined) {
            const separator = source.indexOf(".");
            const next = renamed
              ? `${source.slice(0, separator)}.${unquotePostgresIdentifier(renamed)}`
              : `${unquotePostgresIdentifier(destination!)}.${source.slice(separator + 1)}`;
            const definition = sourceDefinitions?.get(signature);
            const identity = functionIdentities.get(source)?.get(signature);
            if (definition !== undefined) {
              const nextDefinitions = functions.get(next) ?? new Map<string, string>();
              nextDefinitions.set(signature, definition);
              functions.set(next, nextDefinitions);
              sourceDefinitions!.delete(signature);
              if (sourceDefinitions!.size === 0) functions.delete(source);
            }
            if (identity !== undefined) {
              const nextIdentities = functionIdentities.get(next) ?? new Map<string, string>();
              nextIdentities.set(signature, identity);
              functionIdentities.set(next, nextIdentities);
              const sourceIdentities = functionIdentities.get(source)!;
              sourceIdentities.delete(signature);
              if (sourceIdentities.size === 0) functionIdentities.delete(source);
            }
          }
        }
      }
      const dropRoutineMutation = /^DROP\s+(?:FUNCTION|PROCEDURE|ROUTINE|AGGREGATE)\s+(?:IF\s+EXISTS\s+)?([\s\S]+)$/i.exec(statement);
      if (dropRoutineMutation) {
        for (const item of splitTopLevelSqlList(
          dropRoutineMutation[1]!.replace(/\s+(?:CASCADE|RESTRICT)\s*$/i, ""),
        )) {
          const declaredName = new RegExp(`^(${SQL_QUALIFIED_NAME})(?=\\s|\\(|$)`).exec(item.trim())?.[1];
          const droppedEvent = parseRoutineEvents(`DROP FUNCTION ${item}`, migration.file)[0];
          const droppedSignature = droppedEvent && normalizedRoutineEventSignature(droppedEvent);
          if (!declaredName || routineMutationTouchesCatalog(declaredName, false, droppedSignature)) {
            catalogRoutinesTrusted = false;
          }
        }
      }
      const extensionRoutineMutationHeader = new RegExp(
        `^ALTER\\s+EXTENSION\\s+${SQL_IDENTIFIER}\\s+(?:ADD|DROP)\\s+` +
        "(?:FUNCTION|PROCEDURE|ROUTINE|AGGREGATE)\\b",
        "i",
      ).test(statement);
      const extensionRoutineMutation = new RegExp(
        `^ALTER\\s+EXTENSION\\s+${SQL_IDENTIFIER}\\s+(?:ADD|DROP)\\s+` +
        `(?:FUNCTION|PROCEDURE|ROUTINE|AGGREGATE)\\s+(${SQL_QUALIFIED_NAME})(?=\\s|\\()`,
        "i",
      ).exec(statement);
      if (extensionRoutineMutationHeader && (!extensionRoutineMutation ||
        routineMutationTouchesCatalog(extensionRoutineMutation[1]!, false))) {
        catalogRoutinesTrusted = false;
      }
      const routineStatement = statement
        .replace(/^(CREATE\s+(?:OR\s+REPLACE\s+)?)(?:PROCEDURE|AGGREGATE)\b/i, "$1FUNCTION")
        .replace(/^(DROP\s+)(?:PROCEDURE|AGGREGATE|ROUTINE)\b/i, "$1FUNCTION");
      const dropRoutineList = /^DROP\s+FUNCTION\s+(IF\s+EXISTS\s+)?([\s\S]+)$/i.exec(routineStatement);
      const routineStatements = dropRoutineList
        ? splitTopLevelSqlList(dropRoutineList[2]!.replace(/\s+(?:CASCADE|RESTRICT)\s*$/i, ""))
          .map((item) => `DROP FUNCTION ${dropRoutineList[1] ?? ""}${item}`)
        : [routineStatement];
      const createsExecutableRoutine = /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\b/i.test(statement);
      const routineBodyClause = createsExecutableRoutine
        ? [...executableAnalysis.executableSql.matchAll(/\bAS(?=\s)/gi)].at(-1)
        : undefined;
      const routineBodyMatch = routineBodyClause?.index === undefined
        ? undefined
        : /^AS\s+(?:(\$[a-zA-Z_][a-zA-Z0-9_]*\$|\$\$)([\s\S]*?)\1|([eE]|[uU]&)?'((?:''|[^'])*)')/i
          .exec(statement.slice(routineBodyClause.index));
      const routineLanguage = createsExecutableRoutine
        ? [...executableAnalysis.executableSql.matchAll(
          new RegExp(`\\bLANGUAGE\\s+(${SQL_IDENTIFIER})(?=\\s|$)`, "gi"),
        )].at(-1)?.[1]
        : undefined;
      const analysableRoutineLanguage = routineLanguage !== undefined &&
        ["sql", "plpgsql"].includes(unquotePostgresIdentifier(routineLanguage));
      const routineBody = routineBodyMatch?.[2] ?? (routineBodyMatch?.[3]
        ? undefined
        : routineBodyMatch?.[4]?.replace(/''/g, "'"));
      const unanalysableRoutineBody = createsExecutableRoutine &&
        (!analysableRoutineLanguage || routineBody === undefined);
      const routineBodyAnalysis = !createsExecutableRoutine || unanalysableRoutineBody
        ? undefined
        : postgresExecutableAnalysis(routineBody!);
      const routineBodyHasStaticEffect = routineBodyAnalysis && (
        /\b(?:CREATE|ALTER|DROP)\s+(?:(?:OR\s+REPLACE|IF\s+(?:NOT\s+)?EXISTS)\s+)*(?:ACCESS\s+METHOD|AGGREGATE|CAST|DATABASE|DOMAIN|EXTENSION|FUNCTION|INDEX|MATERIALIZED\s+VIEW|OPERATOR(?:\s+(?:CLASS|FAMILY))?|POLICY|PROCEDURE|ROLE|RULE|SCHEMA|SEQUENCE|TABLE|TRIGGER|TYPE|USER|VIEW)\b/i
          .test(routineBodyAnalysis.unquotedExecutableSql) ||
        /\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE|GRANT|REVOKE|REINDEX|CLUSTER)\b/i
          .test(routineBodyAnalysis.unquotedExecutableSql)
      );
      if (routineBodyAnalysis?.unicodeDelimitedIdentifier) executableProvenanceTrusted = false;
      const calledRoutineIdentities = routineCallIdentities(routineBodyAnalysis?.routineCalls ?? []);
      for (const routine of routineStatements) for (const event of parseRoutineEvents(routine, migration.file)) {
        const signature = normalizedRoutineEventSignature(event);
        const declaredName = new RegExp(
          `^(?:CREATE\\s+(?:OR\\s+REPLACE\\s+)?|DROP\\s+(?:IF\\s+EXISTS\\s+)?)FUNCTION\\s+(${SQL_QUALIFIED_NAME})`,
          "i",
        ).exec(routine)?.[1];
        const objectName = event.name.toLowerCase();
        let schema = event.schema.toLowerCase();
        const qualifiedDeclaration = declaredName && new RegExp(
          `^${SQL_IDENTIFIER}\\s*\\.\\s*${SQL_IDENTIFIER}$`,
        ).test(declaredName);
        if (declaredName && !qualifiedDeclaration) {
          const configuredPath = currentSearchPath?.map((item) => item === "$user" ? currentRole : item);
          if (event.action === "drop") {
            const lookupPath = configuredPath?.includes("pg_catalog")
              ? configuredPath
              : configuredPath && ["pg_catalog", ...configuredPath];
            schema = lookupPath?.find((item) => functions.get(`${item}.${objectName}`)?.has(signature)) ?? "";
          } else schema = configuredPath?.find((item) => schemas.has(item)) ?? "";
        }
        const name = `${schema || "public"}.${objectName}`;
        const routineSlot = `${name}\u0000${signature}`;
        if (event.action === "drop") {
          const identity = functionIdentities.get(name)?.get(signature);
          if (identity) {
            directDynamicRoutineIdentities.delete(identity);
            routineCallDependencies.delete(identity);
            routineIdentitySuccessors.set(identity, null);
            droppedRoutineIdentityBySlot.set(routineSlot, identity);
          }
          const overloads = functions.get(name);
          overloads?.delete(signature);
          functionIdentities.get(name)?.delete(signature);
          if (overloads?.size === 0) {
            functions.delete(name);
            functionIdentities.delete(name);
            ambiguousFunctions.delete(name);
          }
        } else {
          const overloads = functions.get(name) ?? new Map<string, string>();
          const identities = functionIdentities.get(name) ?? new Map<string, string>();
          const replacing = overloads.has(signature);
          overloads.set(signature, definitionHash(statement));
          if (!replacing) identities.set(signature, `${migration.file}:${routineIdentitySerial++}`);
          const identity = identities.get(signature)!;
          const droppedIdentity = droppedRoutineIdentityBySlot.get(routineSlot);
          if (!replacing && droppedIdentity) {
            routineIdentitySuccessors.set(droppedIdentity, identity);
            droppedRoutineIdentityBySlot.delete(routineSlot);
          }
          if (unanalysableRoutineBody || routineBodyHasStaticEffect ||
            /\bEXECUTE\b/i.test(routineBodyAnalysis?.executableSql ?? "")) {
            directDynamicRoutineIdentities.add(identity);
          } else directDynamicRoutineIdentities.delete(identity);
          routineCallDependencies.set(identity, new Set(calledRoutineIdentities));
          functions.set(name, overloads);
          functionIdentities.set(name, identities);
          if (!replacing && overloads.size === 1) ambiguousFunctions.delete(name);
        }
      }
      if (/^DROP\s+(?:FUNCTION|PROCEDURE|ROUTINE|AGGREGATE)\b/i.test(statement)) {
        for (const name of REVIEWED_ROUTINES) {
          const [schema, routine] = name.split(".", 2);
          if (functions.has(name) && new RegExp(`\\b${schema}\\s*\\.\\s*${routine}\\s*\\(`, "i").test(statement)) {
            ambiguousFunctions.add(name);
          }
        }
      }
      const alteredFunction = new RegExp(
        `^ALTER\\s+(?:FUNCTION|PROCEDURE|ROUTINE|AGGREGATE)\\s+(${SQL_QUALIFIED_NAME})(?=\\s|\\()`,
        "i",
      ).exec(statement);
      if (alteredFunction) {
        const name = normalizedQualifiedName(alteredFunction[1]!);
        if (name) ambiguousFunctions.add(name);
      }
      const triggerPrefix = new RegExp(
        `^CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:CONSTRAINT\\s+)?TRIGGER\\s+(${SQL_IDENTIFIER})\\s+`,
        "i",
      ).exec(executableAnalysis.executableSql);
      if (triggerPrefix) {
        const triggerClauseOffset = triggerPrefix[0].length;
        const triggerClauseSql = executableAnalysis.unquotedExecutableSql.slice(triggerClauseOffset);
        const onClause = /\bON\b/i.exec(triggerClauseSql);
        if (onClause) {
          const onOffset = triggerClauseOffset + onClause.index;
          const afterOnSql = executableAnalysis.executableSql.slice(onOffset + onClause[0].length);
          const tableTarget = new RegExp(`^\\s*(${SQL_QUALIFIED_NAME})(?=\\s|$)`, "i").exec(afterOnSql)?.[1];
          const afterOnExecutable = executableAnalysis.unquotedExecutableSql.slice(onOffset + onClause[0].length);
          const executeClause = /\bEXECUTE\s+(?:FUNCTION|PROCEDURE)\b/i.exec(afterOnExecutable);
          const routineOffset = executeClause &&
            onOffset + onClause[0].length + executeClause.index + executeClause[0].length;
          const routineTarget = routineOffset !== null && routineOffset !== undefined
            ? new RegExp(`^\\s*(${SQL_QUALIFIED_NAME})\\s*\\(`, "i")
              .exec(executableAnalysis.executableSql.slice(routineOffset))?.[1]
            : undefined;
          const table = tableTarget && resolvedRelationName(tableTarget, currentSearchPath, currentRole);
          if (table && routineTarget) {
            const name = unquotePostgresIdentifier(triggerPrefix[1]!);
            const triggerEventSql = executableAnalysis.unquotedExecutableSql.slice(triggerClauseOffset, onOffset);
            const events = new Set(
              [...triggerEventSql.matchAll(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/gi)]
                .map((match) => match[0].toLowerCase()),
            );
            const routineIdentity = [...routineCallIdentities([routineTarget], "")].at(-1);
            if (!routineIdentity) catalogRoutinesTrusted = false;
            triggers.set(`${table}\u0000${name}`, { table, events, routineIdentity });
          }
        }
      }
      const droppedTrigger = new RegExp(
        `^DROP\\s+TRIGGER\\s+(?:IF\\s+EXISTS\\s+)?(${SQL_IDENTIFIER})\\s+ON\\s+(${SQL_QUALIFIED_NAME})`,
        "i",
      ).exec(statement);
      if (droppedTrigger) {
        const table = resolvedRelationName(droppedTrigger[2]!, currentSearchPath, currentRole);
        if (table) triggers.delete(`${table}\u0000${unquotePostgresIdentifier(droppedTrigger[1]!)}`);
      }
      const renamedTrigger = new RegExp(
        `^ALTER\\s+TRIGGER\\s+(${SQL_IDENTIFIER})\\s+ON\\s+(${SQL_QUALIFIED_NAME})\\s+` +
        `RENAME\\s+TO\\s+(${SQL_IDENTIFIER})$`,
        "i",
      ).exec(statement);
      if (renamedTrigger) {
        const table = resolvedRelationName(renamedTrigger[2]!, currentSearchPath, currentRole);
        const oldKey = table && `${table}\u0000${unquotePostgresIdentifier(renamedTrigger[1]!)}`;
        const trigger = oldKey ? triggers.get(oldKey) : undefined;
        if (table && oldKey && trigger) {
          triggers.delete(oldKey);
          triggers.set(`${table}\u0000${unquotePostgresIdentifier(renamedTrigger[3]!)}`, trigger);
        }
      }
      function tableMutationsForSql(
        executableSql: string,
        unquotedExecutableSql: string,
      ): Array<{ events: Set<string>; table: string }> {
        const tableMutations: Array<{ events: Set<string>; table: string }> = [];
        let mutationOffset = 0;
        if (/^WITH\b/i.test(unquotedExecutableSql)) {
          mutationOffset = -1;
          let depth = 0;
          for (let index = 0; index < unquotedExecutableSql.length; index += 1) {
            const char = unquotedExecutableSql[index]!;
            if (char === "(" && depth === 0 && /\bAS\s+(?:(?:NOT\s+)?MATERIALIZED\s+)?$/i.test(
              unquotedExecutableSql.slice(0, index),
            )) {
              let close = index + 1;
              let memberDepth = 1;
              while (close < unquotedExecutableSql.length && memberDepth > 0) {
                if (unquotedExecutableSql[close] === "(") memberDepth += 1;
                else if (unquotedExecutableSql[close] === ")") memberDepth -= 1;
                close += 1;
              }
              if (memberDepth === 0) {
                tableMutations.push(...tableMutationsForSql(
                  executableSql.slice(index + 1, close - 1).trim(),
                  unquotedExecutableSql.slice(index + 1, close - 1).trim(),
                ));
                index = close - 1;
              }
            } else if (char === "(") depth += 1;
            else if (char === ")") depth -= 1;
            else if (depth === 0 && /^(?:INSERT|UPDATE|DELETE|MERGE)\b/i.test(
              unquotedExecutableSql.slice(index),
            )) {
              mutationOffset = index;
              break;
            }
          }
        }
        const mutationSql = mutationOffset >= 0 ? executableSql.slice(mutationOffset) : "";
        const mutationUnquotedSql = mutationOffset >= 0 ? unquotedExecutableSql.slice(mutationOffset) : "";
        const insertedTable = new RegExp(
          `^INSERT\\s+INTO\\s+(?:ONLY\\s+)?(${SQL_QUALIFIED_NAME})(?=\\s|\\()`,
          "i",
        ).exec(mutationSql)?.[1];
        const updatedTable = new RegExp(
          `^UPDATE\\s+(?:ONLY\\s+)?(${SQL_QUALIFIED_NAME})(?=\\s|$)`,
          "i",
        ).exec(mutationSql)?.[1];
        const deletedTable = new RegExp(
          `^DELETE\\s+FROM\\s+(?:ONLY\\s+)?(${SQL_QUALIFIED_NAME})(?=\\s|$)`,
          "i",
        ).exec(mutationSql)?.[1];
        const truncatedTables = /^TRUNCATE\s+(?:TABLE\s+)?([\s\S]+)$/i.exec(mutationSql)?.[1];
        const mergedTable = new RegExp(
          `^MERGE\\s+INTO\\s+(?:ONLY\\s+)?(${SQL_QUALIFIED_NAME})(?=\\s|$)`,
          "i",
        ).exec(mutationSql)?.[1];
        if (insertedTable) {
          const events = new Set(["insert"]);
          if (/\bON\s+CONFLICT\b[\s\S]*\bDO\s+UPDATE\b/i.test(mutationUnquotedSql)) events.add("update");
          const table = resolvedRelationName(insertedTable, currentSearchPath, currentRole);
          if (table) tableMutations.push({ events, table });
        } else if (updatedTable || deletedTable || mergedTable) {
          const target = updatedTable ?? deletedTable ?? mergedTable!;
          const table = resolvedRelationName(target, currentSearchPath, currentRole);
          const events = updatedTable
            ? new Set(["update"])
            : deletedTable
              ? new Set(["delete"])
              : new Set(
                [...mutationUnquotedSql.matchAll(/\bTHEN\s+(INSERT|UPDATE|DELETE)\b/gi)]
                  .map((match) => match[1]!.toLowerCase()),
              );
          if (table) tableMutations.push({ events, table });
        } else if (truncatedTables) {
          const targets = truncatedTables
            .replace(/\s+(?:CASCADE|RESTRICT)\s*$/i, "")
            .replace(/\s+(?:RESTART|CONTINUE)\s+IDENTITY\s*$/i, "");
          for (const candidate of splitTopLevelSqlList(targets)) {
            const target = new RegExp(`^(?:ONLY\\s+)?(${SQL_QUALIFIED_NAME})(?:\\s*\\*)?$`, "i")
              .exec(candidate)?.[1];
            const table = target && resolvedRelationName(target, currentSearchPath, currentRole);
            if (table) tableMutations.push({ events: new Set(["truncate"]), table });
          }
        }
        return tableMutations;
      }
      const tableMutations = tableMutationsForSql(
        executableAnalysis.executableSql,
        executableAnalysis.unquotedExecutableSql,
      );
      for (const tableMutation of tableMutations) {
        for (const trigger of triggers.values()) {
          if (trigger.table === tableMutation.table &&
            [...tableMutation.events].some((event) => trigger.events.has(event)) &&
            (!trigger.routineIdentity || routineIdentityIsDynamic(trigger.routineIdentity))) {
            catalogRoutinesTrusted = false;
          }
        }
      }
      const routineDefinition = createRoutineHeader || alterRoutineHeader || dropRoutineMutation;
      const routineReferenceOnly = /^(?:GRANT|REVOKE|COMMENT)\b/i.test(statement) ||
        /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\b/i.test(statement);
      if (!routineDefinition && !routineReferenceOnly) {
        for (const identity of routineCallIdentities(executableAnalysis.routineCalls)) {
          if (routineIdentityIsDynamic(identity)) catalogRoutinesTrusted = false;
        }
      }

      const operatorNamePattern = `(?:${SQL_IDENTIFIER}\\s*\\.\\s*)?${POSTGRES_OPERATOR_NAME}`;
      const createdOperator = new RegExp(`^CREATE\\s+OPERATOR\\s+(${operatorNamePattern})\\s*\\(([\\s\\S]*)\\)$`, "i").exec(statement);
      if (createdOperator) {
        const name = normalizedOperatorName(createdOperator[1]!);
        const left = /\bLEFTARG\s*=\s*([^,]+)/i.exec(createdOperator[2]!)?.[1] ?? "NONE";
        const right = /\bRIGHTARG\s*=\s*([^,]+)/i.exec(createdOperator[2]!)?.[1] ?? "NONE";
        if (name) {
          const leftType = normalizedRoutineSignature([left]);
          const rightType = normalizedRoutineSignature([right]);
          const identity = operatorIdentity(name.schema, name.name, leftType, rightType);
          operators.set(identity, `${name.schema}.${name.name}`);
          ambiguousOperators.delete(`${name.schema}.${name.name}`);
        }
      }
      const droppedOperatorList = /^DROP\s+OPERATOR\s+(?:IF\s+EXISTS\s+)?([\s\S]+)$/i.exec(statement);
      if (droppedOperatorList) {
        for (const item of splitTopLevelSqlList(
          droppedOperatorList[1]!.replace(/\s+(?:CASCADE|RESTRICT)\s*$/i, ""),
        )) {
          const droppedOperator = new RegExp(
            `^(${operatorNamePattern})\\s*\\(\\s*([^,]+)\\s*,\\s*([^)]+)\\s*\\)$`,
            "i",
          ).exec(item);
          const name = droppedOperator ? normalizedOperatorName(droppedOperator[1]!) : undefined;
          if (name && droppedOperator) {
            const identity = operatorIdentity(
              name.schema,
              name.name,
              normalizedRoutineSignature([droppedOperator[2]!]),
              normalizedRoutineSignature([droppedOperator[3]!]),
            );
            if (operators.delete(identity)) ambiguousOperators.delete(`${name.schema}.${name.name}`);
            else ambiguousOperators.add(`${name.schema}.${name.name}`);
          }
        }
      }
      const alteredOperator = new RegExp(`^ALTER\\s+OPERATOR\\s+(${operatorNamePattern})\\s*\\(`, "i").exec(statement);
      if (alteredOperator) {
        const name = normalizedOperatorName(alteredOperator[1]!);
        if (name) ambiguousOperators.add(`${name.schema}.${name.name}`);
      }

      const createdCast = /^CREATE\s+CAST\s*\(\s*([\s\S]+?)\s+AS\s+([\s\S]+?)\s*\)/i.exec(statement);
      if (createdCast) {
        const identity = `${normalizedRoutineSignature([createdCast[1]!])}\u0000${normalizedRoutineSignature([createdCast[2]!])}`;
        casts.add(identity);
        ambiguousCasts.delete(identity);
      }
      const droppedCast = /^DROP\s+CAST\s+(?:IF\s+EXISTS\s+)?\(\s*([\s\S]+?)\s+AS\s+([\s\S]+?)\s*\)/i.exec(statement);
      if (droppedCast) {
        const identity = `${normalizedRoutineSignature([droppedCast[1]!])}\u0000${normalizedRoutineSignature([droppedCast[2]!])}`;
        if (casts.delete(identity)) ambiguousCasts.delete(identity);
        else ambiguousCasts.add(identity);
      }

      const createdType = new RegExp(`^CREATE\\s+(?:TYPE|DOMAIN)\\s+(${SQL_QUALIFIED_NAME})\\b`, "i").exec(statement);
      if (createdType) {
        const name = normalizedQualifiedName(createdType[1]!);
        if (name) {
          types.add(name);
          ambiguousTypes.delete(name);
        }
      }
      const droppedType = new RegExp(`^DROP\\s+(?:TYPE|DOMAIN)\\s+(?:IF\\s+EXISTS\\s+)?(${SQL_QUALIFIED_NAME})\\b`, "i").exec(statement);
      if (droppedType) {
        const name = normalizedQualifiedName(droppedType[1]!);
        if (name) {
          if (types.delete(name)) ambiguousTypes.delete(name);
          else ambiguousTypes.add(name);
        }
      }
      const alteredType = new RegExp(`^ALTER\\s+(?:TYPE|DOMAIN)\\s+(${SQL_QUALIFIED_NAME})\\b`, "i").exec(statement);
      if (alteredType) {
        const name = normalizedQualifiedName(alteredType[1]!);
        if (name) ambiguousTypes.add(name);
      }

      const createdExtension = new RegExp(`^CREATE\\s+EXTENSION\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${SQL_IDENTIFIER})\\b`, "i").exec(statement);
      if (createdExtension) {
        const name = unquotePostgresIdentifier(createdExtension[1]!);
        const hash = definitionHash(statement);
        extensions.set(name, hash);
        ambiguousExtensions.delete(name);
        if (!Object.values(REVIEWED_POSTGRES_EXTENSIONS).some((review) => review[name] === hash)) {
          catalogRoutinesTrusted = false;
        }
      }
      const droppedExtension = new RegExp(`^DROP\\s+EXTENSION\\s+(?:IF\\s+EXISTS\\s+)?(${SQL_IDENTIFIER})\\b`, "i").exec(statement);
      if (droppedExtension) {
        const name = unquotePostgresIdentifier(droppedExtension[1]!);
        if (extensions.delete(name)) ambiguousExtensions.delete(name);
        else ambiguousExtensions.add(name);
        catalogRoutinesTrusted = false;
      }
      if (/^DROP\s+EXTENSION\b/i.test(statement)) {
        for (const name of ["vector", "pg_trgm"]) {
          if (extensions.has(name) && new RegExp(`\\b${name}\\b`, "i").test(statement)) {
            ambiguousExtensions.add(name);
          }
        }
      }
      const alteredExtension = new RegExp(`^ALTER\\s+EXTENSION\\s+(${SQL_IDENTIFIER})\\b`, "i").exec(statement);
      if (alteredExtension) {
        ambiguousExtensions.add(unquotePostgresIdentifier(alteredExtension[1]!));
        catalogRoutinesTrusted = false;
      }

      const createdOperatorClass = new RegExp(
        `^CREATE\\s+OPERATOR\\s+CLASS\\s+(${SQL_QUALIFIED_NAME})\\s+(DEFAULT\\s+)?FOR\\s+TYPE\\s+[\\s\\S]+?\\s+USING\\s+(${SQL_IDENTIFIER})\\b`,
        "i",
      ).exec(statement);
      if (createdOperatorClass) {
        const name = normalizedQualifiedName(createdOperatorClass[1]!);
        const method = unquotePostgresIdentifier(createdOperatorClass[3]!);
        if (name) {
          operatorClasses.set(`${name}\u0000${method}`, {
            name,
            method,
            isDefault: createdOperatorClass[2] !== undefined,
          });
        }
      }
      const changedOperatorIndexObject = new RegExp(
        `^(ALTER|DROP)\\s+OPERATOR\\s+(?:CLASS|FAMILY)\\s+(?:IF\\s+EXISTS\\s+)?(${SQL_QUALIFIED_NAME})\\s+USING\\s+(${SQL_IDENTIFIER})`,
        "i",
      ).exec(statement);
      if (changedOperatorIndexObject) {
        const name = normalizedQualifiedName(changedOperatorIndexObject[2]!);
        if (name) {
          const identity = `${name}\u0000${unquotePostgresIdentifier(changedOperatorIndexObject[3]!)}`;
          if (changedOperatorIndexObject[1]!.toLowerCase() === "drop" && operatorClasses.delete(identity)) {
            ambiguousIndexCatalog.delete(identity);
          } else ambiguousIndexCatalog.add(identity);
        }
      }
      const createdAccessMethod = new RegExp(
        `^CREATE\\s+ACCESS\\s+METHOD\\s+(${SQL_IDENTIFIER})\\s+TYPE\\s+INDEX\\s+HANDLER\\b`,
        "i",
      ).exec(statement);
      if (createdAccessMethod) accessMethods.add(unquotePostgresIdentifier(createdAccessMethod[1]!));
      const changedAccessMethod = new RegExp(
        `^(ALTER|DROP)\\s+ACCESS\\s+METHOD\\s+(?:IF\\s+EXISTS\\s+)?(${SQL_IDENTIFIER})\\b`,
        "i",
      ).exec(statement);
      if (changedAccessMethod) {
        const method = unquotePostgresIdentifier(changedAccessMethod[2]!);
        const identity = `*\u0000${method}`;
        if (changedAccessMethod[1]!.toLowerCase() === "drop" && accessMethods.delete(method)) {
          ambiguousIndexCatalog.delete(identity);
        } else ambiguousIndexCatalog.add(identity);
      }

      const createdIndex = new RegExp(
        `^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?(${SQL_QUALIFIED_NAME})\\s+ON\\s+(?:ONLY\\s+)?(${SQL_QUALIFIED_NAME})(?:\\s+USING\\s+(${SQL_IDENTIFIER}))?([\\s\\S]*)$`,
        "i",
      ).exec(statement);
      if (createdIndex) {
        const relation = normalizedQualifiedName(createdIndex[2]!);
        const qualifiedIndex = new RegExp(`^${SQL_IDENTIFIER}\\s*\\.\\s*${SQL_IDENTIFIER}$`).test(createdIndex[1]!);
        const index = qualifiedIndex
          ? normalizedQualifiedName(createdIndex[1]!)
          : relation && `${relation.slice(0, relation.indexOf("."))}.${unquotePostgresIdentifier(createdIndex[1]!)}`;
        if (index) indexes.add(index);
        const method = createdIndex[3] ? unquotePostgresIdentifier(createdIndex[3]) : "btree";
        const qualifiedIdentifiers = new Set<string>();
        const unqualifiedIdentifiers = new Set<string>();
        for (const match of createdIndex[4]!.matchAll(new RegExp(SQL_QUALIFIED_NAME, "g"))) {
          const raw = match[0];
          if (new RegExp(`^${SQL_IDENTIFIER}\\s*\\.\\s*${SQL_IDENTIFIER}$`).test(raw)) {
            const name = normalizedQualifiedName(raw);
            if (name) qualifiedIdentifiers.add(name);
          } else unqualifiedIdentifiers.add(unquotePostgresIdentifier(raw));
        }
        const configuredIndexSearchPath = currentSearchPath?.map((schema) => schema === "$user" ? currentRole : schema);
        const indexSearchPath = configuredIndexSearchPath?.includes("pg_catalog")
          ? configuredIndexSearchPath
          : configuredIndexSearchPath && ["pg_catalog", ...configuredIndexSearchPath];
        const resolvedUnqualifiedClasses = new Set<string>();
        for (const name of unqualifiedIdentifiers) {
          if (!indexSearchPath) {
            for (const operatorClass of operatorClasses.values()) {
              if (operatorClass.method === method && operatorClass.name.split(".").at(-1) === name) {
                resolvedUnqualifiedClasses.add(`${operatorClass.name}\u0000${method}`);
              }
            }
            continue;
          }
          for (const schema of indexSearchPath) {
            const identity = `${schema}.${name}\u0000${method}`;
            if (operatorClasses.has(identity)) {
              resolvedUnqualifiedClasses.add(identity);
              break;
            }
            if (schema === "pg_catalog" && POSTGRES_BUILTIN_OPERATOR_CLASSES.has(`${name}\u0000${method}`)) break;
          }
        }
        const hazardousClass = [...operatorClasses.values()].some((operatorClass) =>
          operatorClass.method === method && (
            qualifiedIdentifiers.has(operatorClass.name) ||
            resolvedUnqualifiedClasses.has(`${operatorClass.name}\u0000${method}`) ||
            operatorClass.isDefault && (!indexSearchPath || indexSearchPath.includes(operatorClass.name.split(".", 1)[0]!))
          ),
        );
        if (index && relation && (accessMethods.has(method) || hazardousClass)) {
          ambiguousIndexCatalog.add(`index\u0000${relation}\u0000${index}`);
        }
      }
      const droppedIndex = /^DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?([\s\S]+)$/i.exec(statement);
      if (droppedIndex) {
        const dropped = new Set(
          splitTopLevelSqlList(droppedIndex[1]!.replace(/\s+(?:CASCADE|RESTRICT)\s*$/i, ""))
            .map((candidate) => {
              const raw = candidate.trim();
              if (new RegExp(`^${SQL_IDENTIFIER}\\s*\\.\\s*${SQL_IDENTIFIER}$`).test(raw)) {
                return normalizedQualifiedName(raw);
              }
              const objectName = unquotePostgresIdentifier(raw);
              const configuredPath = currentSearchPath?.map((schema) => schema === "$user" ? currentRole : schema);
              const lookupPath = configuredPath?.includes("pg_catalog")
                ? configuredPath
                : configuredPath && ["pg_catalog", ...configuredPath];
              const schema = lookupPath?.find((item) => indexes.has(`${item}.${objectName}`));
              return schema && `${schema}.${objectName}`;
            })
            .filter((name): name is string => name !== undefined),
        );
        if (dropped.has("public.bookings_pkey")) {
          ambiguousIndexCatalog.add("reviewed-index\u0000public.bookings\u0000public.bookings_pkey");
        }
        for (const identity of ambiguousIndexCatalog) {
          if (identity.startsWith("index\u0000") && dropped.has(identity.split("\u0000")[2]!)) {
            ambiguousIndexCatalog.delete(identity);
          }
        }
        for (const name of dropped) indexes.delete(name);
      }

      const alteredSchema = new RegExp(`^ALTER\\s+SCHEMA\\s+(${SQL_IDENTIFIER})\\s+([\\s\\S]+)$`, "i").exec(statement);
      if (alteredSchema) {
        const name = unquotePostgresIdentifier(alteredSchema[1]!);
        const renamed = new RegExp(`^RENAME\\s+TO\\s+(${SQL_IDENTIFIER})$`, "i").exec(alteredSchema[2]!.trim());
        if (renamed) {
          schemas.delete(name);
          schemas.add(unquotePostgresIdentifier(renamed[1]!));
        }
        ambiguousSchemas.add(name);
      }
      const droppedSchema = new RegExp(`^DROP\\s+SCHEMA\\s+(?:IF\\s+EXISTS\\s+)?(${SQL_IDENTIFIER})\\b`, "i").exec(statement);
      if (droppedSchema) {
        const name = unquotePostgresIdentifier(droppedSchema[1]!);
        schemas.delete(name);
        ambiguousSchemas.add(name);
      }
      if (/^DROP\s+SCHEMA\b/i.test(statement) && /\bpublic\b/i.test(statement)) ambiguousSchemas.add("public");
      if (/^(?:DROP|REASSIGN)\s+OWNED\s+BY\b/i.test(statement)) ambiguousSchemas.add("public");
    }
  }
  return {
    relations,
    relationAlterations,
    rlsEnabled,
    policies,
    functions,
    functionIdentities,
    catalogRoutinesTrusted,
    executableProvenanceTrusted,
    rules,
    operators,
    casts,
    types,
    extensions,
    runtimeSearchPaths,
    roleAuthorities,
    ambiguousRoleAuthorities,
    ambiguousSchemas,
    ambiguousOperators,
    ambiguousCasts,
    ambiguousTypes,
    ambiguousExtensions,
    ambiguousIndexCatalog,
    ambiguousPolicyTables,
    ambiguousFunctions,
  };
}

function normalizePostgresSql(sql: string): string | undefined {
  let normalized = "";
  let index = 0;
  let pendingSpace = false;
  let tightAfterPunctuation = false;
  const append = (value: string): void => {
    const punctuation = value.length === 1 && ".,()[]".includes(value);
    if (punctuation) {
      normalized += value;
      pendingSpace = false;
      tightAfterPunctuation = ".,([".includes(value);
      return;
    }
    if (pendingSpace && normalized && !tightAfterPunctuation) normalized += " ";
    normalized += value;
    pendingSpace = false;
    tightAfterPunctuation = false;
  };
  while (index < sql.length) {
    const char = sql[index]!;
    if (/\s/.test(char)) {
      pendingSpace = true;
      index += 1;
      continue;
    }
    if (char === "-" && sql[index + 1] === "-") {
      pendingSpace = true;
      index += 2;
      while (index < sql.length && sql[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && sql[index + 1] === "*") {
      pendingSpace = true;
      index += 2;
      let depth = 1;
      while (index < sql.length && depth > 0) {
        if (sql[index] === "/" && sql[index + 1] === "*") {
          depth += 1;
          index += 2;
        } else if (sql[index] === "*" && sql[index + 1] === "/") {
          depth -= 1;
          index += 2;
        } else index += 1;
      }
      if (depth !== 0) return undefined;
      continue;
    }
    const escapeString = (char === "e" || char === "E") && sql[index + 1] === "'";
    if (char === "'" || char === '"' || escapeString) {
      const start = index;
      const quote = escapeString ? "'" : char;
      index += escapeString ? 2 : 1;
      while (index < sql.length) {
        if (quote === "'" && escapeString && sql[index] === "\\") index += Math.min(2, sql.length - index);
        else if (sql[index] === quote && sql[index + 1] === quote) index += 2;
        else if (sql[index] === quote) {
          index += 1;
          break;
        } else index += 1;
      }
      append(sql.slice(start, index));
      continue;
    }
    if (char === "$") {
      const delimiter = /^\$[a-zA-Z_][a-zA-Z0-9_]*\$|^\$\$/.exec(sql.slice(index))?.[0];
      if (delimiter) {
        const start = index;
        const close = sql.indexOf(delimiter, index + delimiter.length);
        index = close < 0 ? sql.length : close + delimiter.length;
        append(sql.slice(start, index));
        continue;
      }
    }
    append(char);
    index += 1;
  }
  return normalized.trim().replace(/\s*;+$/, "");
}

// Raw witnesses are rare enough to review explicitly; executable object definitions are
// hash-bound below, while unrelated migration bytes do not invalidate a reviewed statement.
const REVIEWED_MAIN_POSTGRES_SQL = [
  "SELECT id FROM public.bookings",
  "SELECT id FROM public.bookings;",
  "WITH visible AS (SELECT id FROM public.bookings) SELECT id FROM visible",
  "SELECT 'INTO public.bookings_copy' AS note, id FROM public.bookings",
  'SELECT "into", id FROM public.bookings',
  "SELECT id AS into FROM public.bookings",
  "SELECT E'quote\\' INTO public.copy' AS note, id FROM public.bookings",
  'SELECT id FROM "public"."bookings"',
  "SELECT id FROM ONLY public.bookings",
  "SELECT visible.id FROM LATERAL (SELECT id FROM public.bookings) visible",
  "SELECT id FROM public.bookings WHERE id IN (SELECT id FROM public.bookings)",
  "SELECT id FROM public.bookings WHERE (id IS NOT NULL)",
  "SELECT id FROM public.bookings WHERE id = ANY (ARRAY['booking-a'])",
  "SELECT id FROM public.bookings WHERE id = ALL (ARRAY['booking-a'])",
  "SELECT id FROM public.bookings WHERE id = SOME (ARRAY['booking-a'])",
  "SELECT id FROM public.bookings WHERE id = ANY (SELECT id FROM public.bookings)",
  "SELECT id FROM public.bookings WHERE CASE WHEN true THEN (id IS NOT NULL) ELSE (id IS NULL) END",
  "SELECT id FROM public.bookings WHERE CASE (id) WHEN ('booking-a') THEN (true) ELSE (true) END",
  "SELECT id FROM public.bookings WHERE ROW(id) = ROW('booking-a')",
  "SELECT id FROM public.bookings WHERE id = ANY (ARRAY(SELECT id FROM public.bookings))",
  "SELECT id FROM public.bookings GROUP BY CUBE (id)",
  "SELECT id FROM public.bookings GROUP BY ROLLUP (id)",
  "SELECT id FROM public.bookings GROUP BY GROUPING SETS ((id), ())",
  "SELECT COALESCE(id, id) AS id FROM public.bookings",
  "SELECT NULLIF(id, 'unrelated') AS id FROM public.bookings",
  "SELECT GREATEST(id, id) AS id FROM public.bookings",
  "SELECT LEAST(id, id) AS id FROM public.bookings",
  "WITH visible(id) AS (SELECT id FROM public.bookings) SELECT id FROM visible",
  "SELECT booking.id FROM public.bookings booking(id)",
  "SELECT visible.id FROM (SELECT id FROM public.bookings) visible(id)",
  "SELECT id FROM public.bookings INTERSECT (SELECT id FROM public.bookings)",
  "SELECT id FROM public.bookings EXCEPT (SELECT id FROM public.bookings)",
  "SELECT id FROM public.bookings FETCH FIRST (1) ROWS ONLY",
  "SELECT id FROM public.bookings FETCH NEXT (1) ROWS ONLY",
  "SELECT id FROM public.bookings WHERE id BETWEEN ('a') AND ('z')",
  "SELECT id FROM public.bookings WHERE CURRENT_TIMESTAMP AT TIME ZONE ('UTC') IS NOT NULL",
  "SELECT id FROM public.bookings WHERE CURRENT_TIME(3) IS NOT NULL AND CURRENT_TIMESTAMP(3) IS NOT NULL AND LOCALTIME(3) IS NOT NULL AND LOCALTIMESTAMP(3) IS NOT NULL",
  "SELECT id FROM public.bookings WHERE LOCALTIMESTAMP(3) IS NOT NULL",
  "SELECT DISTINCT ON (id) id FROM public.bookings",
  "SELECT id FROM public.bookings WINDOW booking_window AS (PARTITION BY id)",
  "SELECT id FROM public.bookings LIMIT (1) OFFSET (0)",
  "SELECT id FROM public.bookings LIMIT (1)",
  "SELECT id FROM public.bookings WHERE EXISTS (SELECT 1 FROM public.bookings visible WHERE visible.id = id)",
] as const;

const REVIEWED_RAG_POSTGRES_SQL = [
  "SELECT related_chunk_id AS id FROM public.match_region_itinerary_chunks(ARRAY[]::text[], ARRAY[]::text[], CURRENT_DATE, CURRENT_DATE)",
  "SELECT kc.id FROM public.match_region_itinerary_chunks(ARRAY[]::text[], ARRAY[]::text[], CURRENT_DATE, CURRENT_DATE) matched JOIN public.knowledge_chunks kc ON true",
  "SELECT asset_id AS id FROM public.rag_media_assets WHERE asset_id IN ( ? , ? , ? ) AND (scope = 'global' OR tenant_id = ? )",
  "SELECT id FROM public.knowledge_chunks WHERE id IN ( ? , ? , ? ) AND (scope = 'global' OR tenant_id = ? )",
  "SELECT kc.id FROM public.itineraries i JOIN public.knowledge_chunks kc ON kc.id = i.related_chunk_id WHERE i.ship ILIKE ? AND i.departure_date = ? AND (kc.scope = 'global' OR kc.tenant_id = ? )",
  "SELECT id FROM public.knowledge_chunks WHERE ship_or_property ILIKE ? AND category IN ('deck_intel', 'ship_intel') AND status = 'approved' AND superseded_by_chunk_id IS NULL AND embedding IS NOT NULL AND sell_by_at IS NULL AND (scope = 'global' OR tenant_id = ? )",
  "SELECT kc.id FROM public.itineraries i JOIN public.knowledge_chunks kc ON kc.id = i.related_chunk_id WHERE i.departure_port ILIKE ? AND i.departure_date = ? AND (kc.scope = 'global' OR kc.tenant_id = ? )",
  "SELECT kc.id FROM public.match_region_itinerary_chunks( ARRAY[ ? ]::text[], ARRAY[]::text[], ? ::date, ? ::date, ARRAY[]::text[], 12 ) matched JOIN public.knowledge_chunks kc ON kc.id = matched.related_chunk_id WHERE kc.scope = 'global' OR kc.tenant_id = ?",
] as const;

interface ReviewedPostgresSql {
  target?: PostgresProvenanceTarget;
  resources: readonly string[];
}

const REVIEWED_POSTGRES_SQL = new Map<string, ReviewedPostgresSql>([
  ["SELECT 1", { resources: [] }],
  ...REVIEWED_MAIN_POSTGRES_SQL.map((sql) => [
    normalizePostgresSql(sql)!,
    { target: "main" as const, resources: ["table:public.bookings"] },
  ] as const),
  ...REVIEWED_RAG_POSTGRES_SQL.map((sql, index) => [
    normalizePostgresSql(sql)!,
    {
      target: "rag" as const,
      resources: [
        ["rpc:public.match_region_itinerary_chunks"],
        ["rpc:public.match_region_itinerary_chunks", "table:public.knowledge_chunks"],
        ["table:public.rag_media_assets"],
        ["table:public.knowledge_chunks"],
        ["table:public.itineraries", "table:public.knowledge_chunks"],
        ["table:public.knowledge_chunks"],
        ["table:public.itineraries", "table:public.knowledge_chunks"],
        ["rpc:public.match_region_itinerary_chunks", "table:public.knowledge_chunks"],
      ][index]!.sort(),
    },
  ] as const),
]);

interface ReviewedRelationProvenance {
  selectPolicies: Readonly<Record<string, string>>;
  alterationHashes: readonly string[];
  functionDependencies?: readonly string[];
}

const REVIEWED_POSTGRES_RELATIONS: Readonly<Record<PostgresProvenanceTarget, Readonly<Record<string, ReviewedRelationProvenance>>>> = {
  main: {
    "public.bookings": {
      selectPolicies: {
        bookings_select_policy: "cb7d6cca52a1500a5e6ef8c69c81289e120d228c03989a8bb864e53f8a6a4eed",
      },
      alterationHashes: [
        "cd53441be04dcdee8104199623551ed741da71fb895c177962cc64207e17e007",
        "eac5db2d2c2496a33033bc57dd214a61b7a4536f99b8c787236b80938ec3131e",
        "b35491d18f5bfcd1220eabff9eebd93f41de6a109555e97e3fd66d40f3abcc70",
        "92f33bb85537a3e1b17fc882ea653b22b75438a88d37c3b606a41e9699fabdfd",
        "81003c20e4d60982982b08d776a16b580663eb47ace5bd6c5725f14bd5890840",
        "a24f5122f5f2cf252fb3e23c27e0d412a768935ed105444587109663eb974a74",
        "90e03c68f4a11207c0a2afbc3aa20a2dd03505a3eb24747b83741ec9db95d2da",
        "829c34c7bcadfffa0d5edd68c17a999de3d3255225064b98a3c70cdebf7d46fa",
        "afe08f39d57827ef3ba73b2acf584a4d54305c27ceb43e3e502d70ae9e81b569",
        "7b89751ae9255c9924f9c30252f1be102d1435e182a3546edb88f606031313d8",
        "0532d7527cef77d7cd42e0d50c2d37d5f93d10daeaca8e258a7e8457f05e1d54",
        "f8add2d51e737b253145a7e667151de1c9895254553ccb8b46137e3cee4368ed",
        "ceaad2f7fdc75cbaad36f6dec8093692b4ea0bb578026bd4def14fbc2ae95c09",
        "349e5e6604e62d1f4f75ad12365e0d2f37a15af56dfb28501fac5dc44405083b",
        "fa3c125c246d08c0ec54f9518df8d140a2a0a7f4051d4a0b1f13cc0158fcc475",
      ],
      functionDependencies: ["public.auth_user_in_tenant"],
    },
  },
  rag: {
    "public.itineraries": {
      selectPolicies: {},
      alterationHashes: [
        "9fccd630c26dc99ffd2afe2d0078978f468762b3f4c5c439b83edd07497213d4",
        "e564820c52593e6dc7be9139d361f940f243fc726b5109c50f65a43a5b493237",
      ],
    },
    "public.knowledge_chunks": {
      selectPolicies: {},
      alterationHashes: [
        "2fdefd61f8806ecca1f54099bfbee80bebe76334b5a50a49baf334bde0046c3b",
        "e7d8615d4e2b677863a4e9cd3aa0e46666d667048bfff5043eba7b1ac87710d4",
        "45aa8cf3432b71f03aa63cd5e92d7e93404bf82ee317a4ef112a40fce50354ca",
        "7fd111f282a3e1a42223371c2f45096d52fd435bc72ff77797eccf85b4d2735b",
        "225ad7c6342a0e5ec986620fa632553690e53de8bc2b305015de0327b0be7112",
        "f384dcf0edd5220c677a2bab7d5614fbeae18d926a6826b79d917b6106c1becd",
      ],
    },
    "public.rag_media_assets": {
      selectPolicies: {
        rag_media_assets_select: "a26e20481a252a561df5db1b7ca0f06ac7da348cc20045e662cd17fb87e823d9",
      },
      alterationHashes: [
        "07fa2168c6f2af532cbae3dc01a4be015adbe2cf2304147c8fd65a616f91cefc",
        "f6d578a40c2cc97c0d107907a42d84091042aa5e69fc43b1d5633d900f829744",
        "872def233818397cf458779672efca31b810a5b461137af43b669ee997df3fba",
        "254c23a36b6d40325906a419f243863bc41a4990c89409e457a782ef9b63cb80",
        "e7bd20d48cdd4d84420f008bd741d3952c385ed6b00fd4853bec9e8c0a961e12",
        "0762238b6e83cc8e94809307a5007101b850a58563100787733ab354e1b04b39",
      ],
    },
  },
};

const REVIEWED_POSTGRES_EXTENSIONS: Readonly<Record<PostgresProvenanceTarget, Readonly<Record<string, string>>>> = {
  main: {},
  rag: {
    vector: "8d2eedd3856d2a3a5094f8448f3ba641f7721f109d50bd712c5581c9a0d28196",
    pg_trgm: "fc12c63e2a252eb5752fad2823324b076344ba3ef3f2bb2110e339b742938524",
  },
};

const REVIEWED_POSTGRES_CATALOG_NAMES: Readonly<Record<PostgresProvenanceTarget, {
  operators: ReadonlySet<string>;
  types: ReadonlySet<string>;
  roles: ReadonlySet<string>;
  indexCatalog: ReadonlySet<string>;
}>> = {
  main: {
    operators: new Set(["=", ">=", "<=", "||"]),
    types: new Set(["uuid", "text", "date", "time", "timestamp", "timestamptz"]),
    roles: new Set(["authenticated", "service_role", "postgres"]),
    indexCatalog: new Set(["uuid_ops", "text_ops", "date_ops", "timestamp_ops", "timestamptz_ops", "btree"]),
  },
  rag: {
    operators: new Set(["=", ">=", "<=", "||", "~~*"]),
    types: new Set(["uuid", "text", "date", "integer"]),
    roles: new Set(["authenticated", "service_role", "postgres"]),
    indexCatalog: new Set(["uuid_ops", "text_ops", "date_ops", "array_ops", "vector_cosine_ops", "gin_trgm_ops", "btree", "gin", "hnsw", "ivfflat"]),
  },
};

const REVIEWED_POSTGRES_FUNCTIONS: Readonly<Record<PostgresProvenanceTarget, Readonly<Record<string, { signature: string; definitionHash: string }>>>> = {
  main: {
    "public.auth_user_in_tenant": {
      signature: "uuid",
      definitionHash: "36349550fc50aeb0ec4e170211ef1b357fd8d567ec728f1c484fb580d8c76c02",
    },
  },
  rag: {
    "public.match_region_itinerary_chunks": {
      signature: "text[],text[],date,date,text[],integer",
      definitionHash: "c4fb79753b6e8ede85cb775e99eab2ce3a409a382814617672f9d7702a4b6b11",
    },
  },
};

const postgresMigrationProvenance = new Map<PostgresProvenanceTarget, PostgresMigrationProvenance | undefined>();

function loadPostgresMigrationProvenance(target: PostgresProvenanceTarget): PostgresMigrationProvenance | undefined {
  if (postgresMigrationProvenance.has(target)) return postgresMigrationProvenance.get(target);
  try {
    const dir = path.join(ROOT, "apps", target, "supabase", "migrations");
    const provenance = derivePostgresMigrationProvenance(
      fs.readdirSync(dir)
        .filter((file) => file.endsWith(".sql"))
        .sort()
        .map((file) => ({ file, sql: fs.readFileSync(path.join(dir, file), "utf8") })),
    );
    postgresMigrationProvenance.set(target, provenance);
    return provenance;
  } catch {
    postgresMigrationProvenance.set(target, undefined);
    return undefined;
  }
}

export function postgresResourcesMatchReviewedProvenance(
  target: PostgresProvenanceTarget,
  resources: readonly string[],
  provenance: PostgresMigrationProvenance,
): boolean {
  if (!provenance.executableProvenanceTrusted) return false;
  const functions = new Set<string>();
  const sameOrderedValues = (actual: readonly string[] | undefined, expected: readonly string[]) =>
    actual?.length === expected.length && actual.every((value, index) => value === expected[index]);
  for (const resource of resources) {
    const [kind, name] = resource.split(":", 2) as ["table" | "rpc", string];
    if (kind === "rpc") {
      functions.add(name);
      continue;
    }
    const review = REVIEWED_POSTGRES_RELATIONS[target][name];
    if (!review || provenance.relations.get(name) !== "table" || provenance.rlsEnabled.get(name) !== true) return false;
    if (provenance.ambiguousSchemas.has(name.split(".", 1)[0]!) ||
      !sameOrderedValues(provenance.relationAlterations.get(name), review.alterationHashes)) return false;
    if (provenance.ambiguousPolicyTables.has(name) || (provenance.rules.get(name)?.size ?? 0) > 0) return false;
    const effectivePolicies = new Map(
      [...(provenance.policies.get(name) ?? [])].filter(([, policy]) => policy.command === "all" || policy.command === "select"),
    );
    if (effectivePolicies.size !== Object.keys(review.selectPolicies).length) return false;
    for (const [policy, hash] of Object.entries(review.selectPolicies)) {
      const effective = effectivePolicies.get(policy);
      if (effective?.definitionHash !== hash) return false;
      for (const dependency of review.functionDependencies ?? []) {
        const dependencyReview = REVIEWED_POSTGRES_FUNCTIONS[target][dependency];
        const objectName = dependency.slice(dependency.indexOf(".") + 1);
        const identity = dependencyReview
          ? provenance.functionIdentities.get(dependency)?.get(dependencyReview.signature)
          : undefined;
        if (!identity || effective.functionBindings.get(objectName) !== identity) return false;
      }
    }
    for (const dependency of review.functionDependencies ?? []) functions.add(dependency);
  }
  for (const name of functions) {
    const review = REVIEWED_POSTGRES_FUNCTIONS[target][name];
    const overloads = provenance.functions.get(name);
    if (
      !review || provenance.ambiguousSchemas.has(name.split(".", 1)[0]!) ||
      provenance.ambiguousFunctions.has(name) || !overloads || overloads.size !== 1 ||
      overloads.get(review.signature) !== review.definitionHash
    ) return false;
  }
  if (!provenance.catalogRoutinesTrusted) return false;

  const expectedExtensions = REVIEWED_POSTGRES_EXTENSIONS[target];
  if (provenance.extensions.size !== Object.keys(expectedExtensions).length) return false;
  for (const [name, hash] of Object.entries(expectedExtensions)) {
    if (provenance.extensions.get(name) !== hash || provenance.ambiguousExtensions.has(name)) return false;
  }
  if (provenance.ambiguousExtensions.size > 0) return false;

  const catalog = REVIEWED_POSTGRES_CATALOG_NAMES[target];
  const catalogSchemaRelevant = (name: string) => ["pg_catalog", "public"].includes(name.split(".", 1)[0]!);
  const operatorRelevant = (operator: string) =>
    catalogSchemaRelevant(operator) && catalog.operators.has(operator.slice(operator.indexOf(".") + 1));
  if ([...provenance.operators.values()].some(operatorRelevant) ||
    [...provenance.ambiguousOperators].some(operatorRelevant)) return false;
  const castTouchesReviewedType = (identity: string) =>
    identity.split("\u0000").every((type) => catalog.types.has(type.replace(/\[\]$/, "").split(".").at(-1)!));
  if ([...provenance.casts].some(castTouchesReviewedType) ||
    [...provenance.ambiguousCasts].some(castTouchesReviewedType)) return false;
  const typeTouchesReviewedName = (name: string) =>
    catalogSchemaRelevant(name) && catalog.types.has(name.split(".").at(-1)!);
  if ([...provenance.types].some(typeTouchesReviewedName) ||
    [...provenance.ambiguousTypes].some(typeTouchesReviewedName)) return false;
  if ([...provenance.ambiguousIndexCatalog].some((identity) => {
    if (identity.startsWith("reviewed-index\u0000")) {
      return resources.includes(`table:${identity.split("\u0000")[1]}`);
    }
    if (identity.startsWith("index\u0000")) {
      return resources.includes(`table:${identity.split("\u0000")[1]}`);
    }
    const [name, method] = identity.split("\u0000", 2);
    return name === "*"
      ? catalog.indexCatalog.has(method!)
      : catalogSchemaRelevant(name!) && catalog.indexCatalog.has(name!.split(".").at(-1)!) &&
        catalog.indexCatalog.has(method!);
  })) return false;
  for (const [role, expected] of REVIEWED_POSTGRES_ROLE_AUTHORITIES) {
    const actual = provenance.roleAuthorities.get(role);
    if (catalog.roles.has(role) &&
      (actual?.superuser !== expected.superuser || actual.bypassRls !== expected.bypassRls)) return false;
  }
  if ([...provenance.ambiguousRoleAuthorities].some((role) => role === "*" || catalog.roles.has(role))) return false;
  for (const [key, searchPath] of provenance.runtimeSearchPaths) {
    const [scope, roleOrDatabase, database] = key.split("\u0000");
    const relevant = key === "system" || key === "role-all" ||
      scope === "database" && roleOrDatabase === "postgres" ||
      scope === "role" && catalog.roles.has(roleOrDatabase!) ||
      scope === "role-db" && database === "postgres" && catalog.roles.has(roleOrDatabase!);
    if (relevant && !sameOrderedValues(searchPath, ["$user", "public"])) return false;
  }
  return true;
}

function postgresProvenanceMatchesReview(target: PostgresProvenanceTarget, resources: readonly string[]): boolean {
  const provenance = loadPostgresMigrationProvenance(target);
  return provenance ? postgresResourcesMatchReviewedProvenance(target, resources, provenance) : false;
}

const CHECKERS = new WeakMap<ts.SourceFile, ts.TypeChecker>();

function parse(p: string, text: string): ts.SourceFile {
  const fileName = path.resolve(ROOT, p);
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
    noLib: true,
    noResolve: true,
    types: [],
    skipLibCheck: true,
  };
  const host = ts.createCompilerHost(options, true);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (candidate, languageVersion, onError, shouldCreateNewSourceFile) =>
    path.resolve(candidate) === fileName
      ? ts.createSourceFile(fileName, text, languageVersion, true, /x$/.test(p) ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
      : originalGetSourceFile(candidate, languageVersion, onError, shouldCreateNewSourceFile);
  host.fileExists = (candidate) => path.resolve(candidate) === fileName || ts.sys.fileExists(candidate);
  host.readFile = (candidate) => path.resolve(candidate) === fileName ? text : ts.sys.readFile(candidate);
  const program = ts.createProgram([fileName], options, host);
  const sourceFile = program.getSourceFile(fileName);
  if (!sourceFile) throw new Error(`mocked-tenant-tests guard could not parse ${p}`);
  CHECKERS.set(sourceFile, program.getTypeChecker());
  return sourceFile;
}

function collectModuleMocks(sf: ts.SourceFile): MockCall[] {
  const out: MockCall[] = [];
  const engine = new LocalFlowEngine(sf);
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && engine.moduleMockKind(node)) {
      const arg = node.arguments[0];
      const importedSpecifier =
        arg &&
        ts.isCallExpression(unwrapExpression(arg)) &&
        unwrapExpression(arg).expression.kind === ts.SyntaxKind.ImportKeyword
          ? unwrapExpression(arg).arguments[0]
          : undefined;
      const specifier =
        arg && ts.isStringLiteralLike(unwrapExpression(arg))
          ? (unwrapExpression(arg) as ts.StringLiteralLike).text
          : importedSpecifier && ts.isStringLiteralLike(unwrapExpression(importedSpecifier))
            ? (unwrapExpression(importedSpecifier) as ts.StringLiteralLike).text
            : "__dynamic_db_mock__";
      const factory = node.arguments[1];
      const createClient = engine.mockFactoryProof(factory, "createClient");
      const defaultExport = engine.mockFactoryProof(factory, "default");
      const witness = engine.mockFactoryProof(factory, "assertIsolationQuery");
      out.push({
        specifier,
        partial: createClient.partial,
        replacesCreateClient: createClient.replacesProtected,
        replacesDefault: defaultExport.replacesProtected,
        replacesWitness: witness.replacesProtected,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

// Resolve a relative/`@/` specifier against the scanned file set so a local
// wrapper around the Supabase client is recognised as a DB mock too.
function resolveModule(fromPath: string, specifier: string, byPath: ReadonlyMap<string, string>): string | undefined {
  let candidate: string;
  if (specifier.startsWith(".")) candidate = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), specifier));
  else if (specifier.startsWith("@/") || specifier.startsWith("~/")) {
    // Each app's tsconfig maps `@/*` to its own src/ — derive the app from the
    // importing test's path so wrapper modules resolve into apps/<app>/src.
    const app = /^(apps\/[^/]+)\//.exec(fromPath)?.[1];
    candidate = app ? `${app}/src/${specifier.slice(2)}` : specifier.slice(2);
  } else return undefined;
  const base = candidate.replace(/\.([cm]?[jt]s|[jt]sx)$/, "");
  for (const p of [candidate, base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    if (byPath.has(p)) return p;
  }
  return undefined;
}

function dbClientMockDescription(mock: MockCall, fromPath: string, byPath: ReadonlyMap<string, string>): string | undefined {
  const spec = mock.specifier;
  if (spec === "__dynamic_db_mock__") return "an unresolved dynamic DB mock";
  if (spec === "postgres") return 'the Postgres client package "postgres"';
  if (spec.startsWith("@supabase/")) return `the Supabase client package "${spec}"`;
  if (/supabase/i.test(spec)) return `"${spec}" (a Supabase client module by name)`;
  const resolved = resolveModule(fromPath, spec, byPath);
  if (resolved !== undefined) {
    const text = byPath.get(resolved)!;
    if (/@supabase\//.test(text) || SUPABASE_CLIENT_FACTORY.test(text)) {
      return `"${spec}", which wraps the Supabase client (${resolved})`;
    }
  }
  return undefined;
}

export interface MockedTenantTest {
  file: string;
  line: number;
  fullName: string;
  mockedModule: string;
  annotationError?: string;
}

function unwrapExpression(input: ts.Expression): ts.Expression {
  let expression = input;
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    expression = expression.expression;
  }
  return expression;
}

function staticBoolean(input: ts.Expression | undefined): boolean | undefined {
  if (!input) return undefined;
  const expression = unwrapExpression(input);
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (expression.kind === ts.SyntaxKind.NullKeyword) return false;
  if (ts.isNumericLiteral(expression)) return Number(expression.text) !== 0;
  if (ts.isStringLiteralLike(expression)) return expression.text.length > 0;
  if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken) {
    const operand = staticBoolean(expression.operand);
    return operand === undefined ? undefined : !operand;
  }
  return undefined;
}

type FrameworkTag = "vi" | "jest" | "vitest" | "mock" | "doMock" | "mocked" | "spyOn" | "replaceProperty" | "unknown";
type RegistrationKind = "suite" | "test";
type RegistrationState = "enabled" | "disabled" | "unknown";

interface RegistrationValue {
  kind: RegistrationKind;
  state: RegistrationState;
  pending?: "skipIf" | "runIf" | "each" | "for";
}

type FlowAtom = string;
type FlowValue = ReadonlySet<FlowAtom>;
type FlowOutcome = "normal" | "return" | "throw" | "break" | "continue" | "nonterminating";

interface ClosureEnvironment {
  frame: FlowAtom;
  cells: Map<ts.Symbol, Set<FlowAtom>>;
  lexicalThis?: Set<FlowAtom>;
}

interface MockControlLifecycle {
  attached: boolean;
  kind: "spy" | "replace";
  member?: string;
  originals: Map<FlowAtom, Set<FlowAtom>>;
  receivers: Set<FlowAtom>;
}

type MutationKind = "insert" | "update" | "delete" | "upsert";

interface MutationAttempt {
  kind: MutationKind;
  operation: FlowAtom;
  resources: Set<string>;
  attemptedIds?: Set<string>;
  intentInvalid: boolean;
}

interface MutationWitnessEvidence {
  kind: MutationKind;
  mode: "combined" | "split";
  allowedAttemptIds: string[];
  deniedAttemptIds: string[];
}

interface FlowState {
  cells: Map<ts.Symbol, Set<FlowAtom>>;
  reassignedCells: Set<ts.Symbol>;
  members: Map<FlowAtom, Map<string, Set<FlowAtom>>>;
  dirty: Set<FlowAtom>;
  outcome: FlowOutcome;
  returned: Set<FlowAtom>;
  witnessCount: number;
  awaitedWitnessCount: number;
  witnessResources: Set<string>;
  generatorSteps: Map<FlowAtom, number>;
  generatorArguments: Map<FlowAtom, Set<FlowAtom>[]>;
  generatorLocals: Map<FlowAtom, Map<ts.Symbol, Set<FlowAtom>>>;
  closureEnvironments: Map<FlowAtom, ClosureEnvironment>;
  mockControls: Map<FlowAtom, MockControlLifecycle>;
  allocationSerial: number;
  unsupportedReasons: Set<string>;
  unsupported: boolean;
  mutationAttempts: Map<FlowAtom, MutationAttempt>;
  observedDeniedMutationOperations: Set<FlowAtom>;
  witnessMutationSignatures: Set<string>;
}

interface FlowEvaluation {
  state: FlowState;
  value: Set<FlowAtom>;
}

interface TestFlowProof {
  mockedReceiver?: DbReceiverKind;
  mockedWitness: boolean;
  witnessCount?: number;
  awaitedWitnessCount?: number;
  queryResources: string[];
  unsupported: boolean;
  normalPathWithoutWitness: boolean;
  witnessCall?: ts.CallExpression;
  mutationEvidence?: MutationWitnessEvidence;
  mutationEvidenceInvalid: boolean;
}

const UNKNOWN_ATOM = "unknown";
const UNDEFINED_ATOM = "undefined";
const REASSIGNED_BINDING_ATOM = "binding:reassigned";
const ORIGINAL_LOADER_ATOM = "loader:original";
const ORIGINAL_MODULE_ATOM = "module:original";
const SUPABASE_FACTORY_ATOM = "factory:supabase";
const POSTGRES_FACTORY_ATOM = "factory:postgres";
const WITNESS_ATOM = "witness:canonical";
const NATIVE_PROMISE_ATOM = "native:Promise";
const NATIVE_PROMISE_ALL_ATOM = "native:Promise.all";
const NATIVE_PROMISE_REJECT_ATOM = "native:Promise.reject";
const NATIVE_PROMISE_RESOLVE_ATOM = "native:Promise.resolve";
const REJECTED_PROMISE_ATOM = "promise:rejected";

class LocalFlowEngine {
  readonly checker: ts.TypeChecker;
  private readonly functions = new Map<FlowAtom, ts.FunctionLikeDeclaration>();
  private readonly classes = new Map<FlowAtom, ts.ClassLikeDeclaration>();
  private readonly classBases = new Map<FlowAtom, Set<FlowAtom>>();
  private readonly instanceClasses = new Map<FlowAtom, FlowAtom>();
  private readonly generatorTargets = new Map<FlowAtom, ts.FunctionLikeDeclaration>();
  private readonly generatorInstances = new Map<FlowAtom, FlowAtom>();
  private readonly functionLocals = new Map<ts.FunctionLikeDeclaration, Set<ts.Symbol>>();
  private readonly identityFunctions = new WeakMap<ts.FunctionLikeDeclaration, boolean>();
  private readonly boundTargets = new Map<FlowAtom, Set<FlowAtom>>();
  private readonly controlTargets = new Map<FlowAtom, Set<FlowAtom>>();
  private readonly memberTargets = new Map<FlowAtom, { receiver: Set<FlowAtom>; member?: string }>();
  private readonly controlOwners = new Map<FlowAtom, Set<FlowAtom>>();
  private readonly controlMethods = new Map<FlowAtom, string>();
  private readonly literalValues = new Map<FlowAtom, string>();
  private readonly stringLiteralAtoms = new Set<FlowAtom>();
  private readonly ambiguousLiteralAtoms = new Set<FlowAtom>();
  private readonly overwrittenObjectAtoms = new Set<FlowAtom>();
  private readonly unsafeOptionAtoms = new Set<FlowAtom>();
  private readonly queryResourcesByAtom = new Map<FlowAtom, Set<string>>();
  private readonly invalidPostgresOperations = new Set<FlowAtom>();
  // Keep attempted mutation IDs separate from returned rows: both are required to prove tenant isolation.
  private readonly mutationResourcesByAtom = new Map<FlowAtom, Set<string>>();
  private readonly mutationErrorTargets = new Map<FlowAtom, FlowAtom>();
  private readonly executedWitnessCalls = new Set<ts.CallExpression>();
  private allocationFrame: FlowAtom | undefined;
  private lexicalFrame: FlowAtom | undefined;
  private lexicalLocals: ReadonlySet<ts.Symbol> | undefined;
  private capturedFrame: FlowAtom | undefined;
  private lexicalThis: FlowValue | undefined;
  private mayThrowSnapshots: FlowState[] | undefined;
  private executeSuites = false;

  constructor(readonly sourceFile: ts.SourceFile) {
    const checker = CHECKERS.get(sourceFile);
    if (!checker) throw new Error("mocked-tenant-tests guard missing TypeChecker analysis context");
    this.checker = checker;
  }

  private symbol(node: ts.Node): ts.Symbol | undefined {
    if (ts.isIdentifier(node) && ts.isShorthandPropertyAssignment(node.parent)) {
      return this.checker.getShorthandAssignmentValueSymbol(node.parent) ?? this.checker.getSymbolAtLocation(node);
    }
    return this.checker.getSymbolAtLocation(node);
  }

  private atom(prefix: string, node: ts.Node): FlowAtom {
    const base = `${prefix}:${node.pos}:${node.end}`;
    return this.allocationFrame ? `${base}:frame:${this.allocationFrame}` : base;
  }

  private functionAtom(fn: ts.FunctionLikeDeclaration, state?: FlowState): FlowAtom {
    const atom = this.atom("function", fn);
    this.functions.set(atom, fn);
    this.captureEnvironment(atom, state, ts.isArrowFunction(fn));
    return atom;
  }

  private captureEnvironment(atom: FlowAtom, state?: FlowState, captureThis = false): void {
    const lexicalThis = captureThis ? this.lexicalThis : undefined;
    if (state && ((this.lexicalFrame && this.lexicalLocals) || lexicalThis)) {
      state.closureEnvironments.set(
        atom,
        {
          frame: this.lexicalFrame ?? this.allocationFrame ?? atom,
          cells: new Map(
            [...(this.lexicalLocals ?? [])].map((symbol) => [
              symbol,
              new Set(state.cells.get(symbol) ?? [UNDEFINED_ATOM]),
            ]),
          ),
          ...(lexicalThis ? { lexicalThis: new Set(lexicalThis) } : {}),
        },
      );
    }
  }

  private classAtom(declaration: ts.ClassLikeDeclaration, state?: FlowState): FlowAtom {
    const atom = this.atom("class", declaration);
    this.classes.set(atom, declaration);
    this.captureEnvironment(atom, state);
    return atom;
  }

  private cloneState(state: FlowState): FlowState {
    return {
      cells: new Map([...state.cells].map(([symbol, value]) => [symbol, new Set(value)])),
      reassignedCells: new Set(state.reassignedCells),
      members: new Map(
        [...state.members].map(([atom, members]) => [
          atom,
          new Map([...members].map(([name, value]) => [name, new Set(value)])),
        ]),
      ),
      dirty: new Set(state.dirty),
      outcome: state.outcome,
      returned: new Set(state.returned),
      witnessCount: state.witnessCount,
      awaitedWitnessCount: state.awaitedWitnessCount,
      witnessResources: new Set(state.witnessResources),
      generatorSteps: new Map(state.generatorSteps),
      generatorArguments: new Map(
        [...state.generatorArguments].map(([generator, args]) => [generator, args.map((value) => new Set(value))]),
      ),
      generatorLocals: new Map(
        [...state.generatorLocals].map(([generator, locals]) => [
          generator,
          new Map([...locals].map(([symbol, value]) => [symbol, new Set(value)])),
        ]),
      ),
      closureEnvironments: new Map(
        [...state.closureEnvironments].map(([closure, environment]) => [
          closure,
          {
            frame: environment.frame,
            cells: new Map([...environment.cells].map(([symbol, value]) => [symbol, new Set(value)])),
            ...(environment.lexicalThis ? { lexicalThis: new Set(environment.lexicalThis) } : {}),
          },
        ]),
      ),
      mockControls: new Map(
        [...state.mockControls].map(([control, lifecycle]) => [
          control,
          {
            attached: lifecycle.attached,
            kind: lifecycle.kind,
            member: lifecycle.member,
            originals: new Map(
              [...lifecycle.originals].map(([receiver, value]) => [receiver, new Set(value)]),
            ),
            receivers: new Set(lifecycle.receivers),
          },
        ]),
      ),
      allocationSerial: state.allocationSerial,
      unsupportedReasons: new Set(state.unsupportedReasons),
      unsupported: state.unsupported,
      mutationAttempts: new Map(
        [...state.mutationAttempts].map(([atom, attempt]) => [
          atom,
          {
            ...attempt,
            resources: new Set(attempt.resources),
            ...(attempt.attemptedIds ? { attemptedIds: new Set(attempt.attemptedIds) } : {}),
          },
        ]),
      ),
      observedDeniedMutationOperations: new Set(state.observedDeniedMutationOperations),
      witnessMutationSignatures: new Set(state.witnessMutationSignatures),
    };
  }

  private emptyState(): FlowState {
    return {
      cells: new Map(),
      reassignedCells: new Set(),
      members: new Map(),
      dirty: new Set(),
      outcome: "normal",
      returned: new Set(),
      witnessCount: 0,
      awaitedWitnessCount: 0,
      witnessResources: new Set(),
      generatorSteps: new Map(),
      generatorArguments: new Map(),
      generatorLocals: new Map(),
      closureEnvironments: new Map(),
      mockControls: new Map(),
      allocationSerial: 0,
      unsupportedReasons: new Set(),
      unsupported: false,
      mutationAttempts: new Map(),
      observedDeniedMutationOperations: new Set(),
      witnessMutationSignatures: new Set(),
    };
  }

  private statesEqual(left: FlowState, right: FlowState): boolean {
    const sameSet = <T>(a: ReadonlySet<T>, b: ReadonlySet<T>) =>
      a.size === b.size && [...a].every((value) => b.has(value));
    const sameMap = <K, V>(
      a: ReadonlyMap<K, V>,
      b: ReadonlyMap<K, V>,
      sameValue: (leftValue: V, rightValue: V) => boolean,
    ) => a.size === b.size && [...a].every(([key, value]) => {
      const other = b.get(key);
      return other !== undefined && sameValue(value, other);
    });
    return (
      left.outcome === right.outcome &&
      sameMap(left.cells, right.cells, sameSet) &&
      sameSet(left.reassignedCells, right.reassignedCells) &&
      sameMap(left.members, right.members, (a, b) => sameMap(a, b, sameSet)) &&
      sameSet(left.dirty, right.dirty) &&
      sameSet(left.returned, right.returned) &&
      left.witnessCount === right.witnessCount &&
      left.awaitedWitnessCount === right.awaitedWitnessCount &&
      sameSet(left.witnessResources, right.witnessResources) &&
      sameMap(left.generatorSteps, right.generatorSteps, (a, b) => a === b) &&
      sameMap(left.generatorArguments, right.generatorArguments, (a, b) =>
        a.length === b.length && a.every((value, index) => sameSet(value, b[index] ?? new Set())),
      ) &&
      sameMap(left.generatorLocals, right.generatorLocals, (a, b) => sameMap(a, b, sameSet)) &&
      sameMap(left.closureEnvironments, right.closureEnvironments, (a, b) =>
        a.frame === b.frame &&
        sameMap(a.cells, b.cells, sameSet) &&
        (a.lexicalThis === undefined
          ? b.lexicalThis === undefined
          : b.lexicalThis !== undefined && sameSet(a.lexicalThis, b.lexicalThis)),
      ) &&
      sameMap(left.mockControls, right.mockControls, (a, b) =>
        a.attached === b.attached &&
        a.kind === b.kind &&
        a.member === b.member &&
        sameMap(a.originals, b.originals, sameSet) &&
        sameSet(a.receivers, b.receivers)
      ) &&
      left.allocationSerial === right.allocationSerial &&
      sameSet(left.unsupportedReasons, right.unsupportedReasons) &&
      left.unsupported === right.unsupported &&
      sameMap(left.mutationAttempts, right.mutationAttempts, (a, b) =>
        a.kind === b.kind &&
        a.operation === b.operation &&
        a.intentInvalid === b.intentInvalid &&
        sameSet(a.resources, b.resources) &&
        (a.attemptedIds === undefined
          ? b.attemptedIds === undefined
          : b.attemptedIds !== undefined && sameSet(a.attemptedIds, b.attemptedIds))
      ) &&
      sameSet(left.observedDeniedMutationOperations, right.observedDeniedMutationOperations) &&
      sameSet(left.witnessMutationSignatures, right.witnessMutationSignatures)
    );
  }

  private values(...atoms: FlowAtom[]): Set<FlowAtom> {
    return new Set(atoms.length ? atoms : [UNKNOWN_ATOM]);
  }

  private markUnsupported(state: FlowState, reason: string): void {
    state.unsupported = true;
    state.unsupportedReasons.add(reason);
  }

  private recordMayThrow(state: FlowState): void {
    if (!this.mayThrowSnapshots) return;
    const thrown = this.cloneState(state);
    thrown.outcome = "throw";
    this.mayThrowSnapshots.push(thrown);
  }

  private cellValue(state: FlowState, node: ts.Identifier): Set<FlowAtom> {
    const symbol = this.symbol(node);
    const sourceDeclaration = symbol?.declarations?.some(
      (declaration) => declaration.getSourceFile() === this.sourceFile,
    );
    if (
      node.text === "undefined" &&
      !sourceDeclaration
    ) {
      return this.values(UNDEFINED_ATOM);
    }
    if (node.text === "Promise" && !sourceDeclaration) return this.values(NATIVE_PROMISE_ATOM);
    if (symbol) {
      const value = new Set(state.cells.get(symbol) ?? [UNKNOWN_ATOM]);
      if (
        state.reassignedCells.has(symbol) &&
        [...value].some((atom) => atom.startsWith("object:") || atom === REASSIGNED_BINDING_ATOM)
      ) value.add(REASSIGNED_BINDING_ATOM);
      return value;
    }
    if (node.text === "vi" || node.text === "jest") return this.values(`framework:${node.text}`);
    return this.values(UNKNOWN_ATOM);
  }

  private setCell(state: FlowState, node: ts.Identifier, value: FlowValue): void {
    const symbol = this.symbol(node);
    if (!symbol) return;
    state.cells.set(symbol, new Set(value));
    const ownerFrames = new Set(
      [this.lexicalFrame, this.capturedFrame].filter((frame): frame is FlowAtom => frame !== undefined),
    );
    if (!ownerFrames.size) return;
    for (const environment of state.closureEnvironments.values()) {
      if (ownerFrames.has(environment.frame) && environment.cells.has(symbol)) {
        environment.cells.set(symbol, new Set(value));
      }
    }
  }

  private staticKey(
    node: ts.Node | undefined,
    resolveIdentifier = false,
    seen = new Set<ts.Symbol>(),
  ): string | undefined {
    if (!node) return undefined;
    const computed = ts.isComputedPropertyName(node);
    const expression = computed ? unwrapExpression(node.expression) : unwrapExpression(node as ts.Expression);
    if (ts.isIdentifier(expression)) {
      if (!computed && !resolveIdentifier) return expression.text;
      const symbol = this.symbol(expression);
      if (!symbol || seen.has(symbol)) return undefined;
      const declarations = symbol.declarations ?? [];
      if (declarations.length !== 1 || !ts.isVariableDeclaration(declarations[0])) return undefined;
      const declaration = declarations[0];
      const declarationList = declaration.parent;
      if (!ts.isVariableDeclarationList(declarationList) || !(declarationList.flags & ts.NodeFlags.Const)) {
        return undefined;
      }
      return this.staticKey(declaration.initializer, true, new Set(seen).add(symbol));
    }
    if (ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression)) {
      return expression.text;
    }
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = this.staticKey(expression.left, true, seen);
      const right = this.staticKey(expression.right, true, seen);
      return left === undefined || right === undefined ? undefined : left + right;
    }
    return undefined;
  }

  private literalAtom(node: ts.Expression): FlowAtom {
    const atom = this.atom("literal", node);
    if (ts.isStringLiteralLike(node)) {
      this.literalValues.set(atom, node.text);
      this.stringLiteralAtoms.add(atom);
    } else if (ts.isNumericLiteral(node)) this.literalValues.set(atom, node.text);
    else if (node.kind === ts.SyntaxKind.TrueKeyword) this.literalValues.set(atom, "true");
    else if (node.kind === ts.SyntaxKind.FalseKeyword) this.literalValues.set(atom, "false");
    else if (node.kind === ts.SyntaxKind.NullKeyword) this.literalValues.set(atom, "null");
    else if (ts.isNoSubstitutionTemplateLiteral(node)) this.literalValues.set(atom, node.text);
    return atom;
  }

  private valueKey(value: FlowValue): string | undefined {
    if ([...value].some((atom) => this.ambiguousLiteralAtoms.has(atom))) return undefined;
    const keys = new Set([...value].map((atom) => this.literalValues.get(atom)));
    return keys.size === 1 && !keys.has(undefined) ? [...keys][0] : undefined;
  }

  private stringValues(value: FlowValue): Set<string> | undefined {
    if (!value.size || [...value].some((atom) => !this.stringLiteralAtoms.has(atom) || this.ambiguousLiteralAtoms.has(atom))) {
      return undefined;
    }
    return new Set([...value].map((atom) => this.literalValues.get(atom)!));
  }

  private arrayStringValues(state: FlowState, value: FlowValue): Set<string> | undefined {
    const strings = new Set<string>();
    for (const array of value) {
      const length = this.arrayLength(state, array);
      if (length === undefined) return undefined;
      for (let index = 0; index < length; index += 1) {
        const item = state.members.get(array)?.get(String(index));
        const literals = item && this.stringValues(item);
        if (!literals) return undefined;
        for (const literal of literals) strings.add(literal);
      }
    }
    return strings;
  }

  private mutationRowIds(state: FlowState, value: FlowValue): Set<string> | undefined {
    const rows: FlowAtom[] = [];
    for (const atom of value) {
      const length = this.arrayLength(state, atom);
      if (length === undefined) rows.push(atom);
      else {
        for (let index = 0; index < length; index += 1) {
          const item = state.members.get(atom)?.get(String(index));
          if (!item || item.size !== 1) return undefined;
          rows.push(...item);
        }
      }
    }
    if (!rows.length) return undefined;
    const ids = new Set<string>();
    for (const row of rows) {
      const id = state.members.get(row)?.get("id");
      const literals = id && this.stringValues(id);
      if (!literals) return undefined;
      for (const literal of literals) ids.add(literal);
    }
    return ids;
  }

  private constrainMutationIds(attempt: MutationAttempt, ids: ReadonlySet<string>): void {
    attempt.attemptedIds = attempt.attemptedIds === undefined
      ? new Set(ids)
      : new Set([...attempt.attemptedIds].filter((id) => ids.has(id)));
  }

  private applyMutationFilter(
    state: FlowState,
    attempt: MutationAttempt,
    member: string,
    args: readonly FlowValue[],
  ): void {
    if (attempt.kind === "insert" || attempt.kind === "upsert") {
      attempt.intentInvalid = true;
      return;
    }
    if (member === "eq" || member === "in") {
      const columns = this.stringValues(args[0] ?? this.values(UNKNOWN_ATOM));
      if (!columns || columns.size !== 1 || !columns.has("id")) {
        attempt.intentInvalid = true;
        return;
      }
      const ids = member === "eq"
        ? this.stringValues(args[1] ?? this.values(UNKNOWN_ATOM))
        : this.arrayStringValues(state, args[1] ?? this.values(UNKNOWN_ATOM));
      if (!ids || !ids.size) attempt.intentInvalid = true;
      else this.constrainMutationIds(attempt, ids);
      return;
    }
    if (member === "match") {
      const objects = args[0] ?? this.values(UNKNOWN_ATOM);
      for (const object of objects) {
        const members = state.members.get(object);
        if (!members || members.size !== 1 || !members.has("id")) {
          attempt.intentInvalid = true;
          continue;
        }
        const id = state.members.get(object)?.get("id");
        const ids = this.stringValues(id);
        if (!ids || !ids.size) attempt.intentInvalid = true;
        else this.constrainMutationIds(attempt, ids);
      }
      return;
    }
    attempt.intentInvalid = true;
  }

  private memberKey(node: ts.Node | undefined, state: FlowState, value?: FlowValue): string | undefined {
    return this.staticKey(node, true) ??
      this.valueKey(value ?? (node && ts.isIdentifier(node) ? this.cellValue(state, node) : this.values(UNKNOWN_ATOM)));
  }

  private setMember(state: FlowState, receivers: FlowValue, member: string | undefined, value: FlowValue): void {
    for (const receiver of receivers) {
      const members = state.members.get(receiver) ?? new Map<string, Set<FlowAtom>>();
      members.set(member ?? "@unknown", new Set(value));
      state.members.set(receiver, members);
      if (
        receiver.startsWith("client:supabase:") &&
        (member === undefined || member === "from" || member === "rpc")
      ) {
        state.dirty.add(receiver);
      }
      if (receiver.startsWith("client:postgres:") || receiver === ORIGINAL_LOADER_ATOM) {
        state.dirty.add(receiver);
      }
    }
  }

  private markUnsafeOptions(values: readonly FlowValue[]): void {
    for (const value of values) {
      for (const atom of value) {
        if (atom.startsWith("object:")) this.unsafeOptionAtoms.add(atom);
      }
    }
  }

  private onceImplementationKeys(
    members: ReadonlyMap<string, Set<FlowAtom>> | undefined,
    member: string,
  ): string[] {
    const prefix = `@once:${member}:`;
    return [...(members?.keys() ?? [])]
      .filter((key) => key.startsWith(prefix))
      .sort((left, right) => Number(left.slice(prefix.length)) - Number(right.slice(prefix.length)));
  }

  private promiseImplementation(state: FlowState, receiver: FlowAtom, member: string | undefined): Set<FlowAtom> {
    const members = state.members.get(receiver);
    const explicit = members?.get(member ?? "@unknown");
    if (explicit) return new Set(explicit);
    if (member === "all" && !members?.has("@all") && !members?.has("@unknown")) {
      return this.values(NATIVE_PROMISE_ALL_ATOM);
    }
    return this.values(UNKNOWN_ATOM);
  }

  private restorePromiseImplementation(
    state: FlowState,
    receiver: FlowAtom,
    member: string | undefined,
    value: FlowValue,
  ): void {
    const members = state.members.get(receiver) ?? new Map<string, Set<FlowAtom>>();
    const key = member ?? "@unknown";
    if (member === "all" && value.size === 1 && value.has(NATIVE_PROMISE_ALL_ATOM)) members.delete(key);
    else members.set(key, new Set(value));
    for (const onceKey of this.onceImplementationKeys(members, key)) members.delete(onceKey);
    state.members.set(receiver, members);
  }

  private replaceMember(
    state: FlowState,
    receivers: FlowValue,
    member: string | undefined,
    value: FlowValue,
  ): void {
    for (const receiver of receivers) {
      if (receiver.startsWith("object:")) this.overwrittenObjectAtoms.add(receiver);
      if (receiver === NATIVE_PROMISE_ATOM) {
        const members = state.members.get(receiver) ?? new Map<string, Set<FlowAtom>>();
        const key = member ?? "@unknown";
        for (const onceKey of this.onceImplementationKeys(members, key)) members.delete(onceKey);
        if (member === undefined) {
          for (const onceKey of [...members.keys()].filter((candidate) => candidate.startsWith("@once:"))) {
            members.delete(onceKey);
          }
        }
        state.members.set(receiver, members);
        for (const lifecycle of state.mockControls.values()) {
          if (
            lifecycle.receivers.has(receiver) &&
            (member === undefined || lifecycle.member === undefined || lifecycle.member === member)
          ) lifecycle.attached = false;
        }
      }
    }
    this.setMember(state, receivers, member, value);
  }

  private restoreControl(state: FlowState, control: FlowAtom, detach: boolean): void {
    const lifecycle = state.mockControls.get(control);
    if (!lifecycle) return;
    for (const receiver of lifecycle.receivers) {
      if (receiver !== NATIVE_PROMISE_ATOM) continue;
      this.restorePromiseImplementation(
        state,
        receiver,
        lifecycle.member,
        lifecycle.originals.get(receiver) ?? this.values(UNKNOWN_ATOM),
      );
    }
    if (detach) lifecycle.attached = false;
  }

  private assignSelected(
    state: FlowState,
    target: ts.Expression,
    selected: Set<FlowAtom>,
    initializer: ts.Expression | undefined,
    active: ReadonlySet<ts.FunctionLikeDeclaration>,
  ): FlowState[] {
    if (!initializer || (!selected.has(UNDEFINED_ATOM) && !selected.has(UNKNOWN_ATOM))) {
      return this.assignTarget(state, target, selected, active);
    }
    const alternatives = this.evaluateExpression(
      initializer,
      this.cloneState(state),
      new Set(active),
    ).flatMap((evaluated) => this.assignTarget(evaluated.state, target, evaluated.value, active));
    const present = new Set([...selected].filter((atom) => atom !== UNDEFINED_ATOM));
    if (present.size) alternatives.push(...this.assignTarget(this.cloneState(state), target, present, active));
    return alternatives;
  }

  private assignTarget(
    state: FlowState,
    target: ts.Expression,
    value: FlowValue,
    active: ReadonlySet<ts.FunctionLikeDeclaration> = new Set(),
  ): FlowState[] {
    const expression = unwrapExpression(target);
    if (ts.isIdentifier(expression)) {
      const symbol = this.symbol(expression);
      if (symbol) state.reassignedCells.add(symbol);
      this.setCell(state, expression, value);
      return [state];
    }
    if (ts.isPropertyAccessExpression(expression)) {
      return this.evaluateExpression(expression.expression, state, new Set(active)).map((receiver) => {
        this.replaceMember(receiver.state, receiver.value, expression.name.text, value);
        return receiver.state;
      });
    }
    if (ts.isElementAccessExpression(expression)) {
      return this.evaluateExpression(expression.expression, state, new Set(active)).flatMap((receiver) =>
        expression.argumentExpression
          ? this.evaluateExpression(expression.argumentExpression, receiver.state, new Set(active)).map((argument) => {
              this.replaceMember(
                argument.state,
                receiver.value,
                this.memberKey(expression.argumentExpression, argument.state, argument.value),
                value,
              );
              return argument.state;
            })
          : [receiver.state]
      );
    }
    if (ts.isArrayLiteralExpression(expression)) {
      let states = [state];
      for (let index = 0; index < expression.elements.length; index += 1) {
        const element = expression.elements[index]!;
        if (ts.isOmittedExpression(element)) continue;
        states = states.flatMap((current) => {
          if (ts.isSpreadElement(element)) {
            return this.assignTarget(current, element.expression, this.values(UNKNOWN_ATOM), active);
          }
          const assignment = ts.isBinaryExpression(element) &&
            element.operatorToken.kind === ts.SyntaxKind.EqualsToken
            ? element
            : undefined;
          const selected = this.arrayElementValue(current, value, index, element);
          return this.assignSelected(
            current,
            assignment?.left ?? element,
            selected,
            assignment?.right,
            active,
          );
        });
      }
      return states;
    }
    if (ts.isObjectLiteralExpression(expression)) {
      let states = [state];
      for (const property of expression.properties) {
        states = states.flatMap((current) => {
          if (ts.isShorthandPropertyAssignment(property)) {
            const selected = this.memberValue(current, value, property.name.text, property);
            return this.assignSelected(
              current,
              property.name,
              selected,
              property.objectAssignmentInitializer,
              active,
            );
          }
          if (ts.isPropertyAssignment(property)) {
            const key = this.staticKey(property.name);
            const selected = key === undefined
              ? this.values(UNKNOWN_ATOM)
              : this.propertyFromValue(current, value, key);
            const assignment = ts.isBinaryExpression(property.initializer) &&
              property.initializer.operatorToken.kind === ts.SyntaxKind.EqualsToken
              ? property.initializer
              : undefined;
            return this.assignSelected(
              current,
              assignment?.left ?? property.initializer,
              selected,
              assignment?.right,
              active,
            );
          }
          if (ts.isSpreadAssignment(property)) {
            return this.assignTarget(current, property.expression, this.values(UNKNOWN_ATOM), active);
          }
          this.markUnsupported(current, "unsupported assignment property");
          return [current];
        });
      }
      return states;
    }
    this.markUnsupported(state, "unsupported assignment target");
    return [state];
  }

  private seedImports(): FlowState {
    const state = this.emptyState();
    for (const statement of this.sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
      const module = statement.moduleSpecifier.text;
      if (statement.importClause?.name) {
        const atom = module === "postgres" ? POSTGRES_FACTORY_ATOM : UNKNOWN_ATOM;
        this.setCell(state, statement.importClause.name, this.values(atom));
      }
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      for (const element of bindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text;
        let atom = UNKNOWN_ATOM;
        if (module === "postgres" && imported === "default") atom = POSTGRES_FACTORY_ATOM;
        else if (module === "@supabase/supabase-js" && imported === "createClient") atom = SUPABASE_FACTORY_ATOM;
        else if (module === "vitest" && ["vi", "vitest"].includes(imported)) atom = `framework:${imported}`;
        else if (module === "vitest" && ["beforeAll", "beforeEach", "afterAll", "afterEach"].includes(imported)) {
          atom = `framework:${imported}`;
        }
        else if (module.endsWith("tests/helpers/isolation-witness") && imported === "assertIsolationQuery") atom = WITNESS_ATOM;
        this.setCell(state, element.name, this.values(atom));
      }
    }
    return state;
  }

  private memberValue(
    state: FlowState,
    receivers: FlowValue,
    member: string | undefined,
    node: ts.Node,
  ): Set<FlowAtom> {
    const value = new Set<FlowAtom>();
    for (const receiver of receivers) {
      const members = state.members.get(receiver);
      if (receiver === NATIVE_PROMISE_ATOM) {
        if (member === "reject") value.add(NATIVE_PROMISE_REJECT_ATOM);
        else if (member === "resolve") value.add(NATIVE_PROMISE_RESOLVE_ATOM);
        else if (member === "all" && this.onceImplementationKeys(members, member).length) {
          const call = this.atom("promise-member", node);
          this.memberTargets.set(call, { receiver: this.values(receiver), member });
          value.add(call);
        } else {
          const explicit = members?.get(member ?? "@unknown");
          if (explicit) {
            for (const atom of explicit) value.add(atom);
          } else if (member === "all" && !members?.has("@all") && !members?.has("@unknown")) {
            value.add(NATIVE_PROMISE_ALL_ATOM);
          } else value.add(UNKNOWN_ATOM);
        }
        continue;
      }
      const explicit = members?.get(member ?? "@unknown");
      if (explicit) {
        for (const atom of explicit) value.add(atom);
        continue;
      }
      if (receiver === "framework:vi" || receiver === "framework:vitest" || receiver === "framework:jest") {
        if (member === "replaceProperty" && receiver !== "framework:jest") {
          this.markUnsupported(state, "Vitest does not provide replaceProperty");
          value.add("framework:unsupportedReplaceProperty");
          continue;
        }
        if (
          member &&
          [
            "mock",
            "doMock",
            "mocked",
            "spyOn",
            "replaceProperty",
            "restoreAllMocks",
            "resetAllMocks",
            "clearAllMocks",
          ].includes(member)
        ) {
          value.add(`framework:${member}`);
        }
        else value.add(UNKNOWN_ATOM);
        continue;
      }
      if (member && ["call", "apply", "bind"].includes(member) && this.isCallableAtom(receiver)) {
        const wrapper = this.atom(member, node);
        this.boundTargets.set(wrapper, new Set([receiver]));
        value.add(wrapper);
        continue;
      }
      if (receiver.startsWith("generator:") && member === "next") {
        const next = this.atom("generator-next", node);
        const target = this.generatorTargets.get(receiver);
        if (target) this.generatorInstances.set(next, receiver);
        value.add(target ? next : UNKNOWN_ATOM);
        continue;
      }
      if (receiver.startsWith("generator:") && (member === "return" || member === "throw")) {
        this.markUnsupported(state, `generator.${member}`);
        value.add(UNKNOWN_ATOM);
        continue;
      }
      const instanceClass = this.instanceClasses.get(receiver);
      if (instanceClass && member) {
        const declaration = this.classes.get(instanceClass);
        const classMember = declaration?.members.find((candidate) =>
          "name" in candidate && this.staticKey(candidate.name) === member,
        );
        if (classMember && (ts.isMethodDeclaration(classMember) || ts.isAccessor(classMember))) {
          this.markUnsupported(state, "invoked class method or accessor");
          value.add(UNKNOWN_ATOM);
          continue;
        }
      }
      if (receiver.startsWith("client:supabase:") && member && ["from", "rpc"].includes(member)) {
        if (state.dirty.has(receiver)) value.add(UNKNOWN_ATOM);
        else {
          const method = this.atom(`supabase-${member}`, node);
          this.memberTargets.set(method, { receiver: new Set([receiver]), member });
          value.add(method);
        }
        continue;
      }
      if (receiver.startsWith("client:postgres:") && member) {
        const method = this.atom("postgres-operation", node);
        this.memberTargets.set(method, { receiver: new Set([receiver]), member });
        value.add(method);
        continue;
      }
      if (receiver.startsWith("query:supabase:") && member && ["select", "insert", "update", "delete", "upsert"].includes(member)) {
        const method = this.atom("supabase-operation", node);
        this.memberTargets.set(method, { receiver: new Set([receiver]), member });
        value.add(method);
        continue;
      }
      if (receiver.startsWith("result:query:") && member === "error") {
        const attempt = state.mutationAttempts.get(receiver);
        if (attempt && this.queryResourcesByAtom.has(receiver)) {
          const error = this.atom("mutation-error", node);
          this.mutationErrorTargets.set(error, attempt.operation);
          value.add(error);
          continue;
        }
      }
      if (member === "code") {
        const operation = this.mutationErrorTargets.get(receiver);
        if (operation) {
          const code = this.atom("mutation-error-code", node);
          this.mutationErrorTargets.set(code, operation);
          value.add(code);
          continue;
        }
      }
      if (
        receiver.startsWith("result:query:") &&
        member &&
        [
          "eq",
          "neq",
          "gt",
          "gte",
          "lt",
          "lte",
          "like",
          "ilike",
          "is",
          "in",
          "contains",
          "containedBy",
          "range",
          "order",
          "limit",
          "single",
          "maybeSingle",
          "not",
          "or",
          "filter",
          "match",
          "textSearch",
          "overlaps",
        ].includes(member)
      ) {
        const method = this.atom("supabase-chain", node);
        this.memberTargets.set(method, { receiver: new Set([receiver]), member });
        value.add(method);
        continue;
      }
      if (receiver.startsWith("result:query:") && member === "select" && this.mutationResourcesByAtom.has(receiver)) {
        const method = this.atom("supabase-mutation-select", node);
        this.memberTargets.set(method, { receiver: new Set([receiver]), member });
        value.add(method);
        continue;
      }
      if (
        receiver.startsWith("control:") &&
        member &&
        (/^(?:mock|withImplementation)/.test(member) || member === "restore")
      ) {
        const configure = `${this.atom("configure", node)}:method:${member}`;
        this.controlTargets.set(configure, new Set(this.controlTargets.get(receiver) ?? [UNKNOWN_ATOM]));
        this.controlOwners.set(configure, this.values(receiver));
        this.controlMethods.set(configure, member);
        const mutationTarget = this.memberTargets.get(receiver);
        if (mutationTarget) {
          this.memberTargets.set(configure, {
            receiver: new Set(mutationTarget.receiver),
            member: mutationTarget.member,
          });
        }
        value.add(configure);
        continue;
      }
      if (receiver.startsWith("result:query:") && member && ["then", "catch", "finally"].includes(member)) {
        value.add(UNKNOWN_ATOM);
        continue;
      }
      value.add(UNKNOWN_ATOM);
    }
    return value.size ? value : this.values(UNKNOWN_ATOM);
  }

  private isCallableAtom(atom: FlowAtom): boolean {
    return (
      atom === ORIGINAL_LOADER_ATOM ||
      atom === SUPABASE_FACTORY_ATOM ||
      atom === POSTGRES_FACTORY_ATOM ||
      atom === WITNESS_ATOM ||
      atom === NATIVE_PROMISE_REJECT_ATOM ||
      atom === NATIVE_PROMISE_RESOLVE_ATOM ||
      atom.startsWith("function:") ||
      atom.startsWith("bound:") ||
      atom.startsWith("call:") ||
      atom.startsWith("apply:") ||
      atom.startsWith("bind:") ||
      atom.startsWith("supabase-") ||
      atom.startsWith("postgres-operation:") ||
      atom.startsWith("configure:") ||
      atom.startsWith("promise-member:") ||
      atom.startsWith("generator-next:")
    );
  }

  private evaluateExpression(
    input: ts.Expression,
    state: FlowState,
    active = new Set<ts.FunctionLikeDeclaration>(),
    awaited = false,
  ): FlowEvaluation[] {
    const expression = unwrapExpression(input);
    if (ts.isAwaitExpression(expression)) {
      return this.evaluateExpression(expression.expression, state, active, true).map((evaluated) => {
        if (evaluated.value.has(REJECTED_PROMISE_ATOM)) evaluated.state.outcome = "throw";
        if (evaluated.value.has(UNKNOWN_ATOM)) this.recordMayThrow(evaluated.state);
        return evaluated;
      });
    }
    if (ts.isVoidExpression(expression)) {
      return this.evaluateExpression(expression.expression, state, active).map((evaluated) => ({
        state: evaluated.state,
        value: this.values(UNDEFINED_ATOM),
      }));
    }
    if (ts.isIdentifier(expression)) return [{ state, value: this.cellValue(state, expression) }];
    if (expression.kind === ts.SyntaxKind.ThisKeyword) {
      return [{ state, value: new Set(this.lexicalThis ?? [UNKNOWN_ATOM]) }];
    }
    if (expression.kind === ts.SyntaxKind.UndefinedKeyword) {
      return [{ state, value: this.values(UNDEFINED_ATOM) }];
    }
    if (
      ts.isStringLiteralLike(expression) ||
      ts.isNumericLiteral(expression) ||
      expression.kind === ts.SyntaxKind.TrueKeyword ||
      expression.kind === ts.SyntaxKind.FalseKeyword ||
      expression.kind === ts.SyntaxKind.NullKeyword
    ) {
      return [{ state, value: this.values(this.literalAtom(expression)) }];
    }
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
      const atom = this.functionAtom(expression, state);
      if (ts.isFunctionExpression(expression) && expression.name) this.setCell(state, expression.name, this.values(atom));
      return [{ state, value: this.values(atom) }];
    }
    if (ts.isClassExpression(expression)) {
      return this.evaluateClass(expression, state, active);
    }
    if (ts.isPropertyAccessExpression(expression)) {
      return this.evaluateExpression(expression.expression, state, active).map((base) => ({
        state: base.state,
        value: this.memberValue(base.state, base.value, expression.name.text, expression),
      }));
    }
    if (ts.isElementAccessExpression(expression)) {
      return this.evaluateExpression(expression.expression, state, active).flatMap((base) =>
        expression.argumentExpression
          ? this.evaluateExpression(expression.argumentExpression, base.state, active).map((argument) => {
              const member = this.memberKey(expression.argumentExpression, argument.state, argument.value);
              if (
                member === undefined &&
                [...base.value].some((receiver) =>
                  receiver === NATIVE_PROMISE_ATOM || argument.state.mockControls.has(receiver)
                )
              ) {
                this.markUnsupported(argument.state, "unresolved mock member alias");
              }
              return {
                state: argument.state,
                value: this.memberValue(argument.state, base.value, member, expression),
              };
            })
          : [{
              state: base.state,
              value: this.memberValue(base.state, base.value, undefined, expression),
            }],
      );
    }
    if (ts.isConditionalExpression(expression)) {
      const condition = staticBoolean(expression.condition);
      const conditions = this.evaluateExpression(expression.condition, state, active);
      return conditions.flatMap((after) => {
        if (condition === true) return this.evaluateExpression(expression.whenTrue, after.state, active, awaited);
        if (condition === false) return this.evaluateExpression(expression.whenFalse, after.state, active, awaited);
        const branches = [
          ...this.evaluateExpression(expression.whenTrue, this.cloneState(after.state), active, awaited),
          ...this.evaluateExpression(expression.whenFalse, this.cloneState(after.state), active, awaited),
        ];
        const keys = new Set(
          branches.flatMap((branch) => [...branch.value].map((atom) => this.literalValues.get(atom))),
        );
        if (keys.size !== 1 || keys.has(undefined)) {
          for (const branch of branches) {
            for (const atom of branch.value) {
              if (this.literalValues.has(atom)) this.ambiguousLiteralAtoms.add(atom);
            }
          }
        }
        return branches;
      });
    }
    if (ts.isBinaryExpression(expression)) return this.evaluateBinary(expression, state, active, awaited);
    if (ts.isObjectLiteralExpression(expression)) return this.evaluateObject(expression, state, active);
    if (ts.isArrayLiteralExpression(expression)) {
      const arrayAtom = this.atom("array", expression);
      state.members.set(arrayAtom, new Map());
      let evaluations: FlowEvaluation[] = [{ state, value: this.values(arrayAtom) }];
      expression.elements.forEach((element, index) => {
        if (ts.isOmittedExpression(element)) {
          for (const current of evaluations) {
            this.setMember(current.state, this.values(arrayAtom), String(index), this.values(UNDEFINED_ATOM));
          }
          return;
        }
        const item = ts.isSpreadElement(element) ? element.expression : element;
        evaluations = evaluations.flatMap((current) =>
          this.evaluateExpression(item, current.state, active).map((evaluated) => {
            if (ts.isSpreadElement(element)) this.markUnsupported(evaluated.state, "array spread enumeration");
            else this.setMember(evaluated.state, this.values(arrayAtom), String(index), evaluated.value);
            return { state: evaluated.state, value: current.value };
          }),
        );
      });
      for (const current of evaluations) {
        current.state.members.get(arrayAtom)?.set(`@array-length:${expression.elements.length}`, new Set());
      }
      return evaluations;
    }
    if (ts.isCallExpression(expression)) return this.evaluateCall(expression, state, active, awaited, false);
    if (ts.isNewExpression(expression)) return this.evaluateNew(expression, state, active);
    if (ts.isTaggedTemplateExpression(expression)) return this.evaluateTaggedTemplate(expression, state, active);
    if (ts.isPrefixUnaryExpression(expression) || ts.isPostfixUnaryExpression(expression)) {
      if (
        (expression.operator === ts.SyntaxKind.PlusPlusToken || expression.operator === ts.SyntaxKind.MinusMinusToken) &&
        ts.isExpression(expression.operand)
      ) {
        return this.evaluateExpression(expression.operand, state, active).flatMap((operand) =>
          this.assignTarget(operand.state, expression.operand, this.values(UNKNOWN_ATOM), active).map(
            (assigned) => ({ state: assigned, value: this.values(UNKNOWN_ATOM) }),
          )
        );
      }
      return this.evaluateExpression(expression.operand, state, active).map((operand) => ({
        state: operand.state,
        value: this.values(UNKNOWN_ATOM),
      }));
    }
    if (ts.isTemplateExpression(expression)) {
      let evaluations: FlowEvaluation[] = [{ state, value: this.values(this.literalAtom(expression)) }];
      for (const span of expression.templateSpans) {
        evaluations = evaluations.flatMap((current) =>
          this.evaluateExpression(span.expression, current.state, active).map((evaluated) => ({
            state: evaluated.state,
            value: current.value,
          })),
        );
      }
      return evaluations;
    }
    if (ts.isNoSubstitutionTemplateLiteral(expression)) {
      return [{ state, value: this.values(this.literalAtom(expression)) }];
    }
    this.markUnsupported(state, `unsupported expression ${ts.SyntaxKind[expression.kind]}`);
    return [{ state, value: this.values(UNKNOWN_ATOM) }];
  }

  private evaluateBinary(
    expression: ts.BinaryExpression,
    state: FlowState,
    active: ReadonlySet<ts.FunctionLikeDeclaration>,
    awaited: boolean,
  ): FlowEvaluation[] {
    const operator = expression.operatorToken.kind;
    if (operator === ts.SyntaxKind.CommaToken) {
      return this.evaluateExpression(expression.left, state, new Set(active)).flatMap((left) =>
        this.evaluateExpression(expression.right, left.state, new Set(active), awaited),
      );
    }
    if (operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment) {
      if (
        operator === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
        operator === ts.SyntaxKind.BarBarEqualsToken ||
        operator === ts.SyntaxKind.QuestionQuestionEqualsToken
      ) {
        const unchanged = this.cloneState(state);
        const assigned = this.evaluateExpression(expression.right, this.cloneState(state), new Set(active)).flatMap(
          (right) => this.assignTarget(right.state, expression.left, right.value, active).map(
            (assignedState) => ({ state: assignedState, value: right.value }),
          ),
        );
        return [{ state: unchanged, value: this.values(UNKNOWN_ATOM) }, ...assigned];
      }
      return this.evaluateExpression(expression.right, state, new Set(active)).flatMap((right) =>
        this.assignTarget(
          right.state,
          expression.left,
          operator === ts.SyntaxKind.EqualsToken ? right.value : this.values(UNKNOWN_ATOM),
          active,
        ).map((assignedState) => ({ state: assignedState, value: right.value }))
      );
    }
    if (
      operator === ts.SyntaxKind.AmpersandAmpersandToken ||
      operator === ts.SyntaxKind.BarBarToken ||
      operator === ts.SyntaxKind.QuestionQuestionToken
    ) {
      const leftBoolean = staticBoolean(expression.left);
      return this.evaluateExpression(expression.left, state, new Set(active)).flatMap((left) => {
        const mustRight =
          operator === ts.SyntaxKind.AmpersandAmpersandToken
            ? leftBoolean === true
            : operator === ts.SyntaxKind.BarBarToken
              ? leftBoolean === false
              : false;
        const cannotRight =
          operator === ts.SyntaxKind.AmpersandAmpersandToken
            ? leftBoolean === false
            : operator === ts.SyntaxKind.BarBarToken
              ? leftBoolean === true
              : false;
        if (mustRight) return this.evaluateExpression(expression.right, left.state, new Set(active), awaited);
        if (cannotRight) return [left];
        return [
          { state: this.cloneState(left.state), value: left.value },
          ...this.evaluateExpression(expression.right, this.cloneState(left.state), new Set(active), awaited),
        ];
      });
    }
    return this.evaluateExpression(expression.left, state, new Set(active)).flatMap((left) =>
      this.evaluateExpression(expression.right, left.state, new Set(active)).map((right) => ({
        state: right.state,
        value: this.values(UNKNOWN_ATOM),
      })),
    );
  }

  private evaluateObject(
    object: ts.ObjectLiteralExpression,
    state: FlowState,
    active: ReadonlySet<ts.FunctionLikeDeclaration>,
  ): FlowEvaluation[] {
    const objectAtom = this.atom("object", object);
    state.members.set(objectAtom, new Map());
    let evaluations: FlowEvaluation[] = [{ state, value: this.values(objectAtom) }];
    for (const property of object.properties) {
      evaluations = evaluations.flatMap((current) => {
        if ("name" in property && ts.isComputedPropertyName(property.name)) {
          return this.evaluateExpression(property.name.expression, current.state, new Set(active)).flatMap((computed) =>
            this.evaluateObjectProperty(objectAtom, property, computed.state, active),
          );
        }
        return this.evaluateObjectProperty(objectAtom, property, current.state, active);
      });
    }
    return evaluations;
  }

  private evaluateObjectProperty(
    objectAtom: FlowAtom,
    property: ts.ObjectLiteralElementLike,
    state: FlowState,
    active: ReadonlySet<ts.FunctionLikeDeclaration>,
  ): FlowEvaluation[] {
    const current: FlowEvaluation = { state, value: this.values(objectAtom) };
        if (ts.isSpreadAssignment(property)) {
          return this.evaluateExpression(property.expression, state, new Set(active)).map((spread) => {
            const targetMembers = spread.state.members.get(objectAtom) ?? new Map<string, Set<FlowAtom>>();
            for (const sourceAtom of spread.value) {
              if (sourceAtom === ORIGINAL_MODULE_ATOM) {
                targetMembers.clear();
                targetMembers.set("@all", this.values(ORIGINAL_MODULE_ATOM));
                targetMembers.set("@seenOriginal", this.values(ORIGINAL_MODULE_ATOM));
                continue;
              }
              const sourceMembers = spread.state.members.get(sourceAtom);
              if (!sourceMembers || sourceAtom === UNKNOWN_ATOM) {
                targetMembers.clear();
                targetMembers.set("@all", this.values(UNKNOWN_ATOM));
                continue;
              }
              const sourceAll = sourceMembers.get("@all");
              const sourceSeen = sourceMembers.get("@seenOriginal");
              if (sourceAll) {
                targetMembers.clear();
                targetMembers.set("@all", new Set(sourceAll));
              }
              if (sourceSeen) targetMembers.set("@seenOriginal", new Set(sourceSeen));
              for (const [name, value] of sourceMembers) {
                if (name !== "@all" && name !== "@seenOriginal") targetMembers.set(name, new Set(value));
              }
            }
            spread.state.members.set(objectAtom, targetMembers);
            return { state: spread.state, value: this.values(objectAtom) };
          });
        }
        if (ts.isMethodDeclaration(property) || ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property)) {
          const key = this.staticKey(property.name);
          this.setMember(state, this.values(objectAtom), key, this.values(this.functionAtom(property, state)));
          if (key === undefined) state.members.get(objectAtom)?.set("@all", this.values(UNKNOWN_ATOM));
          return [current];
        }
        if (ts.isShorthandPropertyAssignment(property)) {
          this.setMember(state, this.values(objectAtom), property.name.text, this.cellValue(state, property.name));
          return [current];
        }
        if (ts.isPropertyAssignment(property)) {
          return this.evaluateExpression(property.initializer, state, new Set(active)).map((value) => {
            const key = this.staticKey(property.name);
            this.setMember(value.state, this.values(objectAtom), key, value.value);
            if (key === undefined) value.state.members.get(objectAtom)?.set("@all", this.values(UNKNOWN_ATOM));
            return { state: value.state, value: this.values(objectAtom) };
          });
        }
        this.markUnsupported(state, "unsupported object literal member");
        return [current];
  }

  private propertyFromValue(state: FlowState, value: FlowValue, property: string): Set<FlowAtom> {
    const result = new Set<FlowAtom>();
    for (const atom of value) {
      const members = state.members.get(atom);
      const explicit = members?.get(property);
      const fallback = members?.get("@all");
      for (const member of explicit ?? fallback ?? [UNKNOWN_ATOM]) result.add(member);
    }
    return result.size ? result : this.values(UNKNOWN_ATOM);
  }

  private arrayElementValue(
    state: FlowState,
    arrays: FlowValue,
    index: number,
    node: ts.Node,
  ): Set<FlowAtom> {
    const selected = new Set<FlowAtom>();
    for (const array of arrays) {
      const length = this.arrayLength(state, array);
      if (length !== undefined && index >= length) {
        selected.add(UNDEFINED_ATOM);
        continue;
      }
      for (const value of this.memberValue(state, this.values(array), String(index), node)) {
        selected.add(value);
      }
    }
    return selected.size ? selected : this.values(UNKNOWN_ATOM);
  }

  private bindElement(
    state: FlowState,
    element: ts.BindingElement,
    selected: Set<FlowAtom>,
    active: ReadonlySet<ts.FunctionLikeDeclaration>,
  ): FlowState[] {
    if (!element.initializer || (!selected.has(UNDEFINED_ATOM) && !selected.has(UNKNOWN_ATOM))) {
      return this.bindName(state, element.name, selected, active);
    }
    const alternatives = this.evaluateExpression(
      element.initializer,
      this.cloneState(state),
      new Set(active),
    ).flatMap((evaluated) => this.bindName(evaluated.state, element.name, evaluated.value, active));
    const present = new Set([...selected].filter((atom) => atom !== UNDEFINED_ATOM));
    if (present.size) {
      alternatives.push(...this.bindName(this.cloneState(state), element.name, present, active));
    }
    return alternatives;
  }

  private bindName(
    state: FlowState,
    name: ts.BindingName,
    value: FlowValue,
    active: ReadonlySet<ts.FunctionLikeDeclaration> = new Set(),
  ): FlowState[] {
    if (ts.isIdentifier(name)) {
      this.setCell(state, name, value);
      return [state];
    }
    if (ts.isObjectBindingPattern(name)) {
      let states = [state];
      for (const element of name.elements) {
        if (ts.isOmittedExpression(element)) continue;
        states = states.flatMap((current) => {
          const key = this.staticKey(
            element.propertyName ?? (ts.isIdentifier(element.name) ? element.name : undefined),
          );
          const selected = key === undefined
            ? this.values(UNKNOWN_ATOM)
            : this.memberValue(current, value, key, element);
          return this.bindElement(current, element, selected, active);
        });
      }
      return states;
    }
    let states = [state];
    for (let index = 0; index < name.elements.length; index += 1) {
      const element = name.elements[index]!;
      if (ts.isOmittedExpression(element)) continue;
      states = states.flatMap((current) => {
        let selected: Set<FlowAtom>;
        if (element.dotDotDotToken) {
          const rest = this.atom("array", element);
          current.members.set(rest, new Map());
          const lengths = new Set<number>();
          let unresolved = false;
          for (const array of value) {
            const length = this.arrayLength(current, array);
            if (length === undefined) {
              unresolved = true;
              continue;
            }
            const restLength = Math.max(0, length - index);
            lengths.add(restLength);
            for (let restIndex = 0; restIndex < restLength; restIndex += 1) {
              const prior = current.members.get(rest)?.get(String(restIndex)) ?? new Set<FlowAtom>();
              for (const item of this.arrayElementValue(current, this.values(array), index + restIndex, element)) {
                prior.add(item);
              }
              this.setMember(current, this.values(rest), String(restIndex), prior);
            }
          }
          if (unresolved || lengths.size !== 1) {
            this.setMember(current, this.values(rest), "@all", this.values(UNKNOWN_ATOM));
          } else {
            current.members.get(rest)?.set(`@array-length:${[...lengths][0]}`, new Set());
          }
          selected = this.values(rest);
        } else selected = this.arrayElementValue(current, value, index, element);
        return this.bindElement(current, element, selected, active);
      });
    }
    return states;
  }

  private declareName(state: FlowState, name: ts.BindingName): void {
    if (ts.isIdentifier(name)) {
      this.setCell(state, name, this.values(UNDEFINED_ATOM));
      return;
    }
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) this.declareName(state, element.name);
    }
  }

  private initialiseHoisted(statements: readonly ts.Statement[], state: FlowState): void {
    const visitVar = (node: ts.Node) => {
      if (node !== this.sourceFile && ts.isFunctionLike(node)) return;
      if (ts.isVariableDeclarationList(node) && !(node.flags & ts.NodeFlags.BlockScoped)) {
        for (const declaration of node.declarations) this.declareName(state, declaration.name);
      }
      ts.forEachChild(node, visitVar);
    };
    for (const statement of statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        this.setCell(state, statement.name, this.values(this.functionAtom(statement, state)));
      }
      visitVar(statement);
    }
  }

  private evaluateCall(
    call: ts.CallExpression,
    state: FlowState,
    active: ReadonlySet<ts.FunctionLikeDeclaration>,
    awaited: boolean,
    construct: boolean,
  ): FlowEvaluation[] {
    if (call.expression.kind === ts.SyntaxKind.SuperKeyword) {
      let states: FlowEvaluation[] = [{ state, value: this.values(UNDEFINED_ATOM) }];
      for (const argument of call.arguments) {
        states = states.flatMap((current) =>
          this.evaluateExpression(
            ts.isSpreadElement(argument) ? argument.expression : argument,
            current.state,
            new Set(active),
          ).map((evaluated) => ({ state: evaluated.state, value: this.values(UNDEFINED_ATOM) })),
        );
      }
      return states;
    }
    return this.evaluateExpression(call.expression, state, new Set(active)).flatMap((callee) => {
      type CallInputs = { state: FlowState; args: Set<FlowAtom>[] };
      let inputs: CallInputs[] = [{ state: callee.state, args: [] }];
      for (const argument of call.arguments) {
        if (ts.isSpreadElement(argument)) {
          inputs = inputs.map((input) => {
            this.markUnsupported(input.state, "spread call argument");
            return { state: input.state, args: [...input.args, this.values(UNKNOWN_ATOM)] };
          });
          continue;
        }
        inputs = inputs.flatMap((input) =>
          this.evaluateExpression(argument, input.state, new Set(active)).map((evaluated) => ({
            state: evaluated.state,
            args: [...input.args, evaluated.value],
          })),
        );
      }
      if (this.isCanonicalPromiseAll(call, callee.value)) {
        return inputs.map((input) => {
          this.recordMayThrow(input.state);
          return {
            state: input.state,
            value: new Set(input.args[0] ?? [UNKNOWN_ATOM]),
          };
        });
      }
      return inputs.flatMap((input) =>
        this.invokeAtoms(callee.value, input.args, input.state, call, active, awaited, construct),
      );
    });
  }

  private isCanonicalPromiseAll(call: ts.CallExpression, calleeValue: FlowValue): boolean {
    const callee = unwrapExpression(call.expression);
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "all") return false;
    const receiver = unwrapExpression(callee.expression);
    if (!ts.isIdentifier(receiver) || receiver.text !== "Promise") return false;
    if (this.symbol(receiver)?.declarations?.some((declaration) => declaration.getSourceFile() === this.sourceFile)) return false;
    return calleeValue.size === 1 && calleeValue.has(NATIVE_PROMISE_ALL_ATOM);
  }

  private evaluateNew(
    expression: ts.NewExpression,
    state: FlowState,
    active: ReadonlySet<ts.FunctionLikeDeclaration>,
  ): FlowEvaluation[] {
    const synthetic = expression as unknown as ts.CallExpression;
    return this.evaluateExpression(expression.expression, state, new Set(active)).flatMap((callee) => {
      let inputs: { state: FlowState; args: Set<FlowAtom>[] }[] = [{ state: callee.state, args: [] }];
      for (const argument of expression.arguments ?? []) {
        inputs = inputs.flatMap((input) =>
          this.evaluateExpression(argument, input.state, new Set(active)).map((evaluated) => ({
            state: evaluated.state,
            args: [...input.args, evaluated.value],
          })),
        );
      }
      return inputs.flatMap((input) =>
        this.invokeAtoms(callee.value, input.args, input.state, synthetic, active, false, true),
      );
    });
  }

  private mutationWitnessSignature(
    state: FlowState,
    beforeOperations: ReadonlySet<FlowAtom>,
    finalAtom: FlowAtom,
  ): string | undefined {
    const attempts = new Map<FlowAtom, MutationAttempt>();
    for (const attempt of state.mutationAttempts.values()) {
      if (!beforeOperations.has(attempt.operation)) attempts.set(attempt.operation, attempt);
    }
    const final = state.mutationAttempts.get(finalAtom);
    if (!final) return attempts.size ? JSON.stringify({ invalid: true }) : undefined;
    const invalid = () => JSON.stringify({ invalid: true, kind: final.kind });
    if (final.intentInvalid || !final.attemptedIds?.size || !attempts.has(final.operation)) return invalid();
    if (final.kind === "update" || final.kind === "delete") {
      if (attempts.size !== 1) return invalid();
      const attempted = [...final.attemptedIds].sort();
      return JSON.stringify({
        kind: final.kind,
        mode: "combined",
        allowedAttemptIds: attempted,
        deniedAttemptIds: attempted,
      } satisfies MutationWitnessEvidence);
    }
    if (attempts.size !== 2) return invalid();
    const denied = [...attempts.values()].find((attempt) => attempt.operation !== final.operation);
    if (
      !denied ||
      denied.kind !== final.kind ||
      denied.intentInvalid ||
      !denied.attemptedIds?.size ||
      denied.resources.size !== final.resources.size ||
      [...denied.resources].some((resource) => !final.resources.has(resource)) ||
      !state.observedDeniedMutationOperations.has(denied.operation)
    ) return invalid();
    return JSON.stringify({
      kind: final.kind,
      mode: "split",
      allowedAttemptIds: [...final.attemptedIds].sort(),
      deniedAttemptIds: [...denied.attemptedIds].sort(),
    } satisfies MutationWitnessEvidence);
  }

  private invokeAtoms(
    callees: FlowValue,
    args: readonly FlowValue[],
    state: FlowState,
    call: ts.CallExpression,
    active: ReadonlySet<ts.FunctionLikeDeclaration>,
    awaited: boolean,
    construct: boolean,
  ): FlowEvaluation[] {
    const results: FlowEvaluation[] = [];
    for (const callee of callees) {
      const branch = this.cloneState(state);
      if (callee === NATIVE_PROMISE_REJECT_ATOM) {
        results.push({ state: branch, value: this.values(REJECTED_PROMISE_ATOM) });
        continue;
      }
      if (callee === NATIVE_PROMISE_RESOLVE_ATOM) {
        results.push({ state: branch, value: new Set(args[0] ?? [UNDEFINED_ATOM]) });
        continue;
      }
      if (callee.startsWith("promise-member:")) {
        const target = this.memberTargets.get(callee);
        const member = target?.member;
        const receiver = [...(target?.receiver ?? [])].find((atom) => atom === NATIVE_PROMISE_ATOM);
        if (!receiver || !member) {
          this.markUnsupported(branch, "unresolved Promise member call");
          results.push({ state: branch, value: this.values(UNKNOWN_ATOM) });
          continue;
        }
        const members = branch.members.get(receiver);
        const onceKey = this.onceImplementationKeys(members, member)[0];
        const queued = onceKey ? members?.get(onceKey) : undefined;
        if (onceKey) members?.delete(onceKey);
        const implementation = queued ?? members?.get(member) ?? this.values(NATIVE_PROMISE_ALL_ATOM);
        if (implementation.size === 1 && implementation.has(NATIVE_PROMISE_ALL_ATOM)) {
          this.recordMayThrow(branch);
          results.push({ state: branch, value: new Set(args[0] ?? [UNKNOWN_ATOM]) });
        } else {
          results.push(...this.invokeAtoms(implementation, args, branch, call, active, awaited, construct));
        }
        continue;
      }
      if (callee === SUPABASE_FACTORY_ATOM || callee === POSTGRES_FACTORY_ATOM) {
        if (branch.dirty.has(callee)) results.push({ state: branch, value: this.values(UNKNOWN_ATOM) });
        else {
          const kind = callee === SUPABASE_FACTORY_ATOM ? "supabase" : "postgres";
          results.push({ state: branch, value: this.values(this.atom(`client:${kind}`, call)) });
        }
        continue;
      }
      if (callee === ORIGINAL_LOADER_ATOM) {
        results.push({
          state: branch,
          value: branch.dirty.has(ORIGINAL_LOADER_ATOM) ? this.values(UNKNOWN_ATOM) : this.values(ORIGINAL_MODULE_ATOM),
        });
        continue;
      }
      if (callee === "framework:mocked") {
        const control = this.atom("control", call);
        this.controlTargets.set(control, new Set(args[0] ?? [UNKNOWN_ATOM]));
        results.push({ state: branch, value: this.values(control) });
        continue;
      }
      if (callee === "framework:mock" || callee === "framework:doMock") {
        results.push({ state: branch, value: this.values(UNDEFINED_ATOM) });
        continue;
      }
      if (callee === "framework:unsupportedReplaceProperty") {
        for (const target of args[0] ?? [UNKNOWN_ATOM]) {
          if (target.startsWith("client:supabase:") || target.startsWith("client:postgres:")) {
            branch.dirty.add(target);
          }
        }
        this.markUnsupported(branch, "Vitest does not provide replaceProperty");
        results.push({ state: branch, value: this.values(UNKNOWN_ATOM) });
        continue;
      }
      if (callee === "framework:beforeAll" || callee === "framework:beforeEach") {
        const callbacks = [...(args[0] ?? [])].flatMap((atom) => {
          const callback = this.functions.get(atom);
          return callback && !active.has(callback) ? [{ atom, callback }] : [];
        });
        if (!callbacks.length) {
          this.markUnsupported(branch, "unresolved setup callback");
          results.push({ state: branch, value: this.values(UNKNOWN_ATOM) });
        } else {
          for (const { atom, callback } of callbacks) {
            results.push(
              ...this.executeFunction(callback, [], branch, new Set(active).add(callback), atom).map((result) => ({
                state: result.state,
                value: this.values(UNDEFINED_ATOM),
              })),
            );
          }
        }
        continue;
      }
      if (callee === "framework:afterAll" || callee === "framework:afterEach") {
        results.push({ state: branch, value: this.values(UNDEFINED_ATOM) });
        continue;
      }
      if (
        callee === "framework:restoreAllMocks" ||
        callee === "framework:resetAllMocks" ||
        callee === "framework:clearAllMocks"
      ) {
        if (callee !== "framework:clearAllMocks") {
          for (const [control, lifecycle] of branch.mockControls) {
            if (lifecycle.kind !== "spy") continue;
            if (callee === "framework:restoreAllMocks") this.restoreControl(branch, control, true);
            else if (lifecycle.attached) this.restoreControl(branch, control, false);
          }
        }
        results.push({ state: branch, value: this.values(UNDEFINED_ATOM) });
        continue;
      }
      if (callee === "framework:spyOn" || callee === "framework:replaceProperty") {
        const target = new Set(args[0] ?? [UNKNOWN_ATOM]);
        const member = this.memberKey(call.arguments[1], branch, args[1]);
        for (const atom of target) {
          if (atom.startsWith("client:supabase:") || atom.startsWith("client:postgres:")) branch.dirty.add(atom);
        }
        const originals = new Map<FlowAtom, Set<FlowAtom>>();
        for (const receiver of target) {
          if (receiver === NATIVE_PROMISE_ATOM) {
            originals.set(receiver, this.promiseImplementation(branch, receiver, member));
          }
        }
        if (callee === "framework:replaceProperty") {
          const nativePromise = new Set([...target].filter((atom) => atom === NATIVE_PROMISE_ATOM));
          if (nativePromise.size) {
            this.replaceMember(branch, nativePromise, member, args[2] ?? this.values(UNKNOWN_ATOM));
          }
        }
        if (callee === "framework:spyOn") {
          const existing = [...branch.mockControls].find(([, lifecycle]) =>
            lifecycle.kind === "spy" &&
            lifecycle.attached &&
            lifecycle.member === member &&
            lifecycle.receivers.size === target.size &&
            [...lifecycle.receivers].every((receiver) => target.has(receiver))
          );
          if (existing) {
            results.push({ state: branch, value: this.values(existing[0]) });
            continue;
          }
        }
        const control = this.atom("control", call);
        this.controlTargets.set(control, target);
        this.memberTargets.set(control, { receiver: target, member });
        branch.mockControls.set(control, {
          attached: true,
          kind: callee === "framework:spyOn" ? "spy" : "replace",
          member,
          originals,
          receivers: new Set(target),
        });
        results.push({ state: branch, value: this.values(control) });
        continue;
      }
      const memberTarget = this.memberTargets.get(callee);
      if (
        callee.startsWith("client:postgres:") ||
        (callee.startsWith("postgres-operation:") &&
          [...(memberTarget?.receiver ?? [])].some((receiver) => receiver.startsWith("client:postgres:")))
      ) {
        this.invalidPostgresOperations.add(this.atom("postgres-invalid", call));
        this.recordMayThrow(branch);
        results.push({ state: branch, value: this.values(UNKNOWN_ATOM) });
        continue;
      }
      if (callee.startsWith("configure:")) {
        const method = this.controlMethods.get(callee);
        const owners = this.controlOwners.get(callee) ?? this.values(UNKNOWN_ATOM);
        if (method === "withImplementation") {
          const callback = args[1] ?? this.values(UNKNOWN_ATOM);
          for (const owner of owners) {
            const lifecycle = branch.mockControls.get(owner);
            const snapshots = new Map<FlowAtom, {
              implementation: Set<FlowAtom>;
              once: Map<string, Set<FlowAtom>>;
            }>();
            if (lifecycle?.attached) {
              for (const target of lifecycle.receivers) {
                if (target !== NATIVE_PROMISE_ATOM) continue;
                const member = lifecycle.member ?? "@unknown";
                const members = branch.members.get(target) ?? new Map<string, Set<FlowAtom>>();
                snapshots.set(target, {
                  implementation: this.promiseImplementation(branch, target, lifecycle.member),
                  once: new Map(
                    this.onceImplementationKeys(members, member).map((key) => [key, new Set(members.get(key)!)]),
                  ),
                });
                members.set(member, new Set(args[0] ?? [UNKNOWN_ATOM]));
                for (const key of this.onceImplementationKeys(members, member)) members.delete(key);
                branch.members.set(target, members);
              }
            }
            for (const evaluated of this.invokeAtoms(callback, [], branch, call, active, false, false)) {
              const rejected = evaluated.state.outcome === "throw" || evaluated.value.has(REJECTED_PROMISE_ATOM);
              if (!rejected) {
                for (const [target, snapshot] of snapshots) {
                  this.restorePromiseImplementation(
                    evaluated.state,
                    target,
                    lifecycle?.member,
                    snapshot.implementation,
                  );
                  const members = evaluated.state.members.get(target)!;
                  for (const [key, value] of snapshot.once) members.set(key, new Set(value));
                }
              }
              results.push({
                state: evaluated.state,
                value: rejected && evaluated.value.has(REJECTED_PROMISE_ATOM)
                  ? this.values(REJECTED_PROMISE_ATOM)
                  : this.values(owner),
              });
            }
          }
          continue;
        }
        for (const owner of owners) {
          const lifecycle = branch.mockControls.get(owner);
          if (!lifecycle) {
            for (const target of this.controlTargets.get(callee) ?? [UNKNOWN_ATOM]) branch.dirty.add(target);
            continue;
          }
          if (method === "mockRestore" || method === "restore") {
            this.restoreControl(branch, owner, true);
            continue;
          }
          if (method === "mockReset") {
            if (lifecycle.attached) this.restoreControl(branch, owner, false);
            continue;
          }
          if (!lifecycle.attached || method === "mockClear") continue;
          for (const target of lifecycle.receivers) {
            if (target !== NATIVE_PROMISE_ATOM) {
              branch.dirty.add(target);
              continue;
            }
            const member = lifecycle.member ?? "@unknown";
            const members = branch.members.get(target) ?? new Map<string, Set<FlowAtom>>();
            if (method === "mockImplementationOnce") {
              const queued = this.onceImplementationKeys(members, member);
              const lastKey = queued.at(-1);
              const nextIndex = lastKey === undefined
                ? 0
                : Number(lastKey.slice(`@once:${member}:`.length)) + 1;
              members.set(`@once:${member}:${nextIndex}`, new Set(args[0] ?? [UNKNOWN_ATOM]));
            } else {
              members.set(member, new Set(args[0] ?? [UNKNOWN_ATOM]));
            }
            branch.members.set(target, members);
          }
        }
        results.push({ state: branch, value: new Set(owners) });
        continue;
      }
      if (memberTarget?.member === "from" || memberTarget?.member === "rpc") {
        const resourceName = this.literalText(call.arguments[0]);
        if (!resourceName || [...memberTarget.receiver].some((receiver) => branch.dirty.has(receiver))) {
          results.push({ state: branch, value: this.values(UNKNOWN_ATOM) });
        } else if (memberTarget.member === "rpc") {
          const result = this.atom("result:query", call);
          this.queryResourcesByAtom.set(result, new Set([`rpc:public.${resourceName}`]));
          results.push({ state: branch, value: this.values(result) });
        } else {
          const query = this.atom("query:supabase", call);
          this.queryResourcesByAtom.set(query, new Set([`table:public.${resourceName}`]));
          results.push({ state: branch, value: this.values(query) });
        }
        continue;
      }
      if (callee.startsWith("supabase-mutation-select:")) {
        if (call.arguments.length !== 1 || this.literalText(call.arguments[0]) !== "id") {
          results.push({ state: branch, value: this.values(UNKNOWN_ATOM) });
          continue;
        }
        const result = this.atom("result:query", call);
        const resources = new Set<string>();
        const attempts: MutationAttempt[] = [];
        for (const mutation of memberTarget?.receiver ?? []) {
          for (const resource of this.mutationResourcesByAtom.get(mutation) ?? []) resources.add(resource);
          const candidate = branch.mutationAttempts.get(mutation);
          if (candidate) attempts.push(candidate);
        }
        const operations = new Set(attempts.map((attempt) => attempt.operation));
        const attempt = operations.size === 1 ? attempts[0] : undefined;
        this.queryResourcesByAtom.set(result, resources);
        if (attempt) {
          branch.mutationAttempts.set(result, {
            ...attempt,
            resources: new Set(attempt.resources),
            ...(attempt.attemptedIds ? { attemptedIds: new Set(attempt.attemptedIds) } : {}),
          });
        }
        results.push({ state: branch, value: resources.size ? this.values(result) : this.values(UNKNOWN_ATOM) });
        continue;
      }
      if (memberTarget && memberTarget.member && ["select", "insert", "update", "delete", "upsert"].includes(memberTarget.member)) {
        const result = this.atom("result:query", call);
        const resources = new Set<string>();
        for (const query of memberTarget.receiver) {
          for (const resource of this.queryResourcesByAtom.get(query) ?? []) resources.add(resource);
        }
        if (memberTarget.member === "select") this.queryResourcesByAtom.set(result, resources);
        else {
          const kind = memberTarget.member as MutationKind;
          this.mutationResourcesByAtom.set(result, resources);
          const attemptedIds = kind === "insert" || kind === "upsert"
            ? this.mutationRowIds(branch, args[0] ?? this.values(UNKNOWN_ATOM))
            : undefined;
          const repeatedOperation = branch.mutationAttempts.has(result);
          let upsertOptionsValid = true;
          const options = args[1];
          if (kind === "upsert" && options && !(options.size === 1 && options.has(UNDEFINED_ATOM))) {
            for (const option of options) {
              const members = branch.members.get(option);
              const onConflict = members?.get("onConflict");
              const targets = onConflict && this.stringValues(onConflict);
              if (
                !option.startsWith("object:") ||
                this.overwrittenObjectAtoms.has(option) ||
                this.unsafeOptionAtoms.has(option) ||
                !members ||
                members.has("@all") ||
                members.has("@unknown") ||
                members.has("__proto__") ||
                (onConflict !== undefined && (!targets || targets.size !== 1 || !targets.has("id")))
              ) upsertOptionsValid = false;
            }
          }
          branch.mutationAttempts.set(result, {
            kind,
            operation: result,
            resources: new Set(resources),
            ...(attemptedIds ? { attemptedIds } : {}),
            intentInvalid:
              repeatedOperation ||
              ((kind === "insert" || kind === "upsert") && !attemptedIds) ||
              !upsertOptionsValid,
          });
        }
        results.push({ state: branch, value: resources.size ? this.values(result) : this.values(UNKNOWN_ATOM) });
        continue;
      }
      if (callee.startsWith("supabase-chain:")) {
        for (const receiver of memberTarget?.receiver ?? []) {
          const attempt = branch.mutationAttempts.get(receiver);
          if (attempt && memberTarget?.member) this.applyMutationFilter(branch, attempt, memberTarget.member, args);
        }
        results.push({ state: branch, value: new Set(memberTarget?.receiver ?? [UNKNOWN_ATOM]) });
        continue;
      }
      if (callee === WITNESS_ATOM) {
        if (branch.dirty.has(WITNESS_ATOM)) {
          results.push({ state: branch, value: this.values(UNKNOWN_ATOM) });
          continue;
        }
        branch.witnessCount = Math.min(2, branch.witnessCount + 1);
        this.executedWitnessCalls.add(call);
        if (awaited) branch.awaitedWitnessCount = Math.min(2, branch.awaitedWitnessCount + 1);
        const queryValues = args[0]
          ? this.propertyFromValue(branch, args[0], "query")
          : this.values(UNKNOWN_ATOM);
        const beforeOperations = new Set(
          [...branch.mutationAttempts.values()].map((attempt) => attempt.operation),
        );
        const beforeInvalidPostgresOperations = new Set(this.invalidPostgresOperations);
        const queryResults = this.invokeAtoms(queryValues, [], branch, call, active, true, false);
        for (const queryResult of queryResults) {
          for (const atom of queryResult.value) {
            for (const resource of this.queryResourcesByAtom.get(atom) ?? []) {
              queryResult.state.witnessResources.add(resource);
            }
            const mutationSignature = [...this.invalidPostgresOperations]
              .some((operation) => !beforeInvalidPostgresOperations.has(operation))
              ? JSON.stringify({ invalid: true })
              : this.mutationWitnessSignature(queryResult.state, beforeOperations, atom);
            if (mutationSignature) queryResult.state.witnessMutationSignatures.add(mutationSignature);
          }
          results.push({ state: queryResult.state, value: this.values(UNDEFINED_ATOM) });
        }
        continue;
      }
      if (callee.startsWith("bind:")) {
        const bound = this.atom("bound", call);
        this.boundTargets.set(bound, new Set(this.boundTargets.get(callee) ?? [UNKNOWN_ATOM]));
        results.push({ state: branch, value: this.values(bound) });
        continue;
      }
      if (callee.startsWith("call:") || callee.startsWith("apply:") || callee.startsWith("bound:")) {
        const targets = this.boundTargets.get(callee) ?? this.values(UNKNOWN_ATOM);
        const forwarded = callee.startsWith("bound:") ? args : callee.startsWith("call:") ? args.slice(1) : args.slice(1, 2);
        results.push(...this.invokeAtoms(targets, forwarded, branch, call, active, awaited, construct));
        continue;
      }
      const fn = this.functions.get(callee);
      if (fn) {
        if (fn.asteriskToken && !construct) {
          const generator = `${this.atom("generator", call)}:instance:${branch.allocationSerial}`;
          branch.allocationSerial += 1;
          this.generatorTargets.set(generator, fn);
          branch.generatorArguments.set(generator, args.map((value) => new Set(value)));
          branch.generatorLocals.set(generator, new Map());
          branch.generatorSteps.set(generator, 0);
          results.push({ state: branch, value: this.values(generator) });
        } else if (active.has(fn)) {
          this.markUnsupported(branch, "recursive local call");
          results.push({ state: branch, value: this.values(UNKNOWN_ATOM) });
        } else {
          const directArgs = args.map((value) =>
            [...value].some((atom) => atom.startsWith("query:supabase:") || atom.startsWith("result:query:"))
              ? this.values(UNKNOWN_ATOM)
              : value,
          );
          results.push(...this.executeFunction(fn, directArgs, branch, new Set(active).add(fn), callee));
        }
        continue;
      }
      const generator = this.generatorInstances.get(callee);
      if (generator) {
        results.push(...this.executeGeneratorStep(generator, branch, active));
        continue;
      }
      if (construct && this.classes.has(callee)) {
        results.push(...this.executeClassConstruction(callee, args, branch, call, active, new Set()));
        continue;
      }
      const registration = this.registration(call);
      if (registration) {
        if (this.executeSuites && registration.kind === "suite" && registration.state !== "disabled") {
          const callbacks = args.flatMap((value) => [...value]).flatMap((atom) => {
            const callback = this.functions.get(atom);
            return callback && !active.has(callback) ? [{ atom, callback }] : [];
          });
          for (const { atom, callback } of callbacks) {
            results.push(
              ...this.executeFunction(callback, [], branch, new Set(active).add(callback), atom).map((result) => ({
                state: result.state,
                value: this.values(UNDEFINED_ATOM),
              })),
            );
          }
        }
        if (!results.length) results.push({ state: branch, value: this.values(UNKNOWN_ATOM) });
        continue;
      }
      if (this.applyMutationCall(call, args, branch)) {
        results.push({ state: branch, value: new Set(args[0] ?? [UNKNOWN_ATOM]) });
        continue;
      }
      if (ts.isIdentifier(call.expression) && call.expression.text === "eval") {
        this.markUnsupported(branch, "eval call");
      }
      this.markUnsafeOptions(args);
      this.recordMayThrow(branch);
      for (const callbackAtom of this.callbacksInValues(branch, args)) {
        const callback = this.functions.get(callbackAtom);
        if (callback && !active.has(callback)) {
          const callbackResults = this.executeFunction(
            callback,
            [],
            this.cloneState(branch),
            new Set(active).add(callback),
            callbackAtom,
          );
          for (const result of callbackResults) {
            if (result.state.outcome === "normal") this.recordMayThrow(result.state);
            results.push(result);
          }
        }
      }
      results.push({ state: branch, value: this.values(UNKNOWN_ATOM) });
    }
    return results.length ? results : [{ state, value: this.values(UNKNOWN_ATOM) }];
  }

  private executeGeneratorStep(
    generator: FlowAtom,
    state: FlowState,
    active: ReadonlySet<ts.FunctionLikeDeclaration>,
  ): FlowEvaluation[] {
    return this.advanceGeneratorFrame(generator, state, active).map((frame) => ({
      state: frame.state,
      value: this.values(UNKNOWN_ATOM),
    }));
  }

  private advanceGeneratorFrame(
    generator: FlowAtom,
    state: FlowState,
    active: ReadonlySet<ts.FunctionLikeDeclaration>,
  ): Array<{ state: FlowState; value: Set<FlowAtom>; done: boolean }> {
    const fn = this.generatorTargets.get(generator);
    if (!fn || !fn.body || !ts.isBlock(fn.body) || active.has(fn)) {
      this.markUnsupported(state, "invalid or recursive generator frame");
      return [{ state, value: this.values(UNKNOWN_ATOM), done: true }];
    }
    const segments: Array<{ statements: ts.Statement[]; yielded?: ts.Expression }> = [{ statements: [] }];
    for (const statement of fn.body.statements) {
      const expression = ts.isExpressionStatement(statement) ? unwrapExpression(statement.expression) : undefined;
      if (expression && ts.isYieldExpression(expression)) {
        if (expression.asteriskToken) {
          this.markUnsupported(state, "delegating generator yield");
          return [{ state, value: this.values(UNKNOWN_ATOM), done: true }];
        }
        segments[segments.length - 1]!.yielded = expression.expression;
        segments.push({ statements: [] });
        continue;
      }
      let nestedYield = false;
      const visit = (node: ts.Node) => {
        if (node !== statement && ts.isFunctionLike(node)) return;
        if (ts.isYieldExpression(node)) nestedYield = true;
        else ts.forEachChild(node, visit);
      };
      visit(statement);
      if (nestedYield) {
        this.markUnsupported(state, "nested generator yield");
        return [{ state, value: this.values(UNKNOWN_ATOM), done: true }];
      }
      segments[segments.length - 1]!.statements.push(statement);
    }
    const step = state.generatorSteps.get(generator) ?? 0;
    if (step >= segments.length) {
      return [{ state: this.cloneState(state), value: this.values(UNDEFINED_ATOM), done: true }];
    }
    const localSymbols = this.localSymbols(fn);
    const previousFrame = this.allocationFrame;
    const previousLexicalFrame = this.lexicalFrame;
    const previousLocals = this.lexicalLocals;
    this.allocationFrame = generator;
    this.lexicalFrame = generator;
    this.lexicalLocals = localSymbols;
    try {
      let entered: FlowState[];
      if (step === 0) {
        const args = state.generatorArguments.get(generator) ?? [];
        entered = this.bindParameters(fn.parameters, args, state, new Set(active).add(fn));
        for (const candidate of entered) this.initialiseHoisted(fn.body.statements, candidate);
      } else {
        const resumed = this.cloneState(state);
        for (const [symbol, value] of resumed.generatorLocals.get(generator) ?? []) {
          resumed.cells.set(symbol, new Set(value));
        }
        entered = [resumed];
      }
      const segment = segments[step]!;
      const afterStatements = this.evaluateStatements(segment.statements, entered, new Set(active).add(fn));
      const frames = afterStatements.flatMap((candidate) => {
        if (candidate.outcome === "return") {
          candidate.outcome = "normal";
          return [{ state: candidate, value: new Set(candidate.returned), done: true }];
        }
        if (candidate.outcome !== "normal" || !segment.yielded) {
          return [{ state: candidate, value: this.values(UNDEFINED_ATOM), done: true }];
        }
        return this.evaluateExpression(segment.yielded, candidate, new Set(active).add(fn)).map((evaluated) => ({
          state: evaluated.state,
          value: evaluated.value,
          done: false,
        }));
      });
      for (const frame of frames) {
        frame.state.generatorSteps.set(generator, step + 1);
        frame.state.generatorLocals.set(
          generator,
          new Map(
            [...localSymbols].map((symbol) => [
              symbol,
              new Set(frame.state.cells.get(symbol) ?? [UNDEFINED_ATOM]),
            ]),
          ),
        );
      }
      return frames;
    } finally {
      this.allocationFrame = previousFrame;
      this.lexicalFrame = previousLexicalFrame;
      this.lexicalLocals = previousLocals;
    }
  }

  private localSymbols(fn: ts.FunctionLikeDeclaration): Set<ts.Symbol> {
    const cached = this.functionLocals.get(fn);
    if (cached) return cached;
    const symbols = new Set<ts.Symbol>();
    const addName = (name: ts.BindingName): void => {
      if (ts.isIdentifier(name)) {
        const symbol = this.symbol(name);
        if (symbol) symbols.add(symbol);
      } else {
        for (const element of name.elements) if (!ts.isOmittedExpression(element)) addName(element.name);
      }
    };
    for (const parameter of fn.parameters) addName(parameter.name);
    if (fn.body) {
      const visit = (node: ts.Node): void => {
        if (node !== fn.body && ts.isFunctionLike(node)) return;
        if (ts.isVariableDeclaration(node)) addName(node.name);
        else if (ts.isFunctionDeclaration(node) && node.name) addName(node.name);
        else if (ts.isClassDeclaration(node) && node.name) addName(node.name);
        else if (ts.isCatchClause(node) && node.variableDeclaration) addName(node.variableDeclaration.name);
        ts.forEachChild(node, visit);
      };
      visit(fn.body);
    }
    this.functionLocals.set(fn, symbols);
    return symbols;
  }

  private functionCreatesIdentity(fn: ts.FunctionLikeDeclaration): boolean {
    const cached = this.identityFunctions.get(fn);
    if (cached !== undefined) return cached;
    let createsIdentity = false;
    const visit = (node: ts.Node): void => {
      if (createsIdentity) return;
      if (
        node !== fn &&
        (ts.isObjectLiteralExpression(node) ||
          ts.isArrayLiteralExpression(node) ||
          ts.isFunctionLike(node) ||
          ts.isClassLike(node) ||
          ts.isNewExpression(node))
      ) {
        createsIdentity = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(fn);
    this.identityFunctions.set(fn, createsIdentity);
    return createsIdentity;
  }

  private evaluateClass(
    declaration: ts.ClassLikeDeclaration,
    state: FlowState,
    active: ReadonlySet<ts.FunctionLikeDeclaration>,
  ): FlowEvaluation[] {
    const atom = this.classAtom(declaration, state);
    if (declaration.name) this.setCell(state, declaration.name, this.values(atom));
    let evaluations: FlowEvaluation[] = [{ state, value: this.values(atom) }];
    if (ts.canHaveDecorators(declaration) && ts.getDecorators(declaration)?.length) {
      this.markUnsupported(state, "class decorator");
    }
    const base = declaration.heritageClauses
      ?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)
      ?.types[0]?.expression;
    if (base) {
      evaluations = evaluations.flatMap((current) =>
        this.evaluateExpression(base, current.state, new Set(active)).map((evaluated) => {
          const bases = this.classBases.get(atom) ?? new Set<FlowAtom>();
          for (const candidate of evaluated.value) if (this.classes.has(candidate)) bases.add(candidate);
          this.classBases.set(atom, bases);
          return { state: evaluated.state, value: this.values(atom) };
        }),
      );
    }
    for (const member of declaration.members) {
      evaluations = evaluations.flatMap((current) => {
        if (ts.canHaveDecorators(member) && ts.getDecorators(member)?.length) {
          this.markUnsupported(current.state, "class member decorator");
        }
        if ("name" in member && ts.isPrivateIdentifier(member.name)) {
          this.markUnsupported(current.state, "private class member");
        }
        if (ts.isAccessor(member)) this.markUnsupported(current.state, "class accessor");
        if ("name" in member && ts.isComputedPropertyName(member.name)) {
          return this.evaluateExpression(member.name.expression, current.state, new Set(active)).map((evaluated) => ({
            state: evaluated.state,
            value: this.values(atom),
          }));
        }
        return [current];
      });
    }
    for (const member of declaration.members) {
      const isStatic = ts.canHaveModifiers(member) &&
        !!ts.getModifiers(member)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword);
      if (ts.isClassStaticBlockDeclaration(member)) {
        evaluations = evaluations.flatMap((current) =>
          this.evaluateStatements(member.body.statements, [current.state], active).map((finished) => ({
            state: finished,
            value: this.values(atom),
          })),
        );
      } else if (isStatic && ts.isPropertyDeclaration(member) && member.initializer) {
        evaluations = evaluations.flatMap((current) =>
          this.evaluateExpression(member.initializer!, current.state, new Set(active)).map((evaluated) => ({
            state: evaluated.state,
            value: this.values(atom),
          })),
        );
      }
    }
    return evaluations;
  }

  private evaluateInstanceFields(
    classAtom: FlowAtom,
    declaration: ts.ClassLikeDeclaration,
    instance: FlowAtom,
    states: readonly FlowState[],
    active: ReadonlySet<ts.FunctionLikeDeclaration>,
  ): FlowState[] {
    let evaluations = states.map((state) => {
      for (const [symbol, value] of state.closureEnvironments.get(classAtom)?.cells ?? []) {
        state.cells.set(symbol, new Set(value));
      }
      return state;
    });
    const classEnvironment = evaluations[0]?.closureEnvironments.get(classAtom);
    const previousFrame = this.allocationFrame;
    const previousLexicalFrame = this.lexicalFrame;
    const previousLocals = this.lexicalLocals;
    const previousCapturedFrame = this.capturedFrame;
    const previousLexicalThis = this.lexicalThis;
    this.allocationFrame = instance;
    this.lexicalFrame = classEnvironment?.frame ?? instance;
    this.lexicalLocals = classEnvironment ? new Set(classEnvironment.cells.keys()) : undefined;
    this.capturedFrame = classEnvironment?.frame;
    this.lexicalThis = this.values(instance);
    try {
      for (const member of declaration.members) {
        const isStatic = ts.canHaveModifiers(member) &&
          !!ts.getModifiers(member)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword);
        if (isStatic || !ts.isPropertyDeclaration(member)) continue;
        evaluations = evaluations.flatMap((candidate) => {
          const initialized = member.initializer
            ? this.evaluateExpression(member.initializer, candidate, new Set(active))
            : [{ state: candidate, value: this.values(UNDEFINED_ATOM) }];
          return initialized.map((evaluated) => {
            const key = this.staticKey(member.name);
            if (key === undefined) this.markUnsupported(evaluated.state, "dynamic instance field name");
            else this.setMember(evaluated.state, this.values(instance), key, evaluated.value);
            return evaluated.state;
          });
        });
      }
      return evaluations;
    } finally {
      this.allocationFrame = previousFrame;
      this.lexicalFrame = previousLexicalFrame;
      this.lexicalLocals = previousLocals;
      this.capturedFrame = previousCapturedFrame;
      this.lexicalThis = previousLexicalThis;
    }
  }

  private bindParameterProperties(
    constructor: ts.ConstructorDeclaration,
    instance: FlowAtom,
    states: readonly FlowState[],
  ): FlowState[] {
    const propertyParameters = constructor.parameters.filter((parameter) =>
      ts.canHaveModifiers(parameter) &&
      !!ts.getModifiers(parameter)?.some((modifier) => [
        ts.SyntaxKind.PublicKeyword,
        ts.SyntaxKind.PrivateKeyword,
        ts.SyntaxKind.ProtectedKeyword,
        ts.SyntaxKind.ReadonlyKeyword,
      ].includes(modifier.kind)),
    );
    if (!propertyParameters.length) return [...states];
    return states.map((state) => {
      if (constructor.body?.statements.length) {
        this.markUnsupported(state, "constructor parameter property with body effects");
      }
      for (const parameter of propertyParameters) {
        if (!ts.isIdentifier(parameter.name)) {
          this.markUnsupported(state, "destructured constructor parameter property");
          continue;
        }
        this.setMember(state, this.values(instance), parameter.name.text, this.cellValue(state, parameter.name));
      }
      return state;
    });
  }

  private executeClassConstruction(
    classAtom: FlowAtom,
    args: readonly FlowValue[],
    state: FlowState,
    call: ts.CallExpression,
    active: ReadonlySet<ts.FunctionLikeDeclaration>,
    seen: ReadonlySet<FlowAtom>,
    existingInstance?: FlowAtom,
  ): FlowEvaluation[] {
    const declaration = this.classes.get(classAtom);
    if (!declaration || seen.has(classAtom)) {
      this.markUnsupported(state, "unknown or recursive class construction");
      return [{ state, value: this.values(UNKNOWN_ATOM) }];
    }
    const instance = existingInstance ?? `${this.atom("instance", call)}:instance:${state.allocationSerial}`;
    if (!existingInstance) {
      state.allocationSerial += 1;
      this.instanceClasses.set(instance, classAtom);
    }
    const constructor = declaration.members.find(ts.isConstructorDeclaration);
    const bases = this.classBases.get(classAtom) ?? new Set<FlowAtom>();
    let evaluations: FlowEvaluation[];
    if (!constructor) {
      evaluations = [{ state, value: this.values(UNDEFINED_ATOM) }];
      if (bases.size > 0) {
        evaluations = [...bases].flatMap((base) =>
          this.executeClassConstruction(base, args, this.cloneState(state), call, active, new Set(seen).add(classAtom), instance),
        );
      }
      evaluations = this.evaluateInstanceFields(
        classAtom,
        declaration,
        instance,
        evaluations.map((evaluation) => evaluation.state),
        active,
      ).map((candidate) => ({ state: candidate, value: this.values(UNDEFINED_ATOM) }));
    } else if (bases.size === 0) {
      if (active.has(constructor)) {
        this.markUnsupported(state, "recursive base constructor");
        evaluations = [{ state, value: this.values(UNKNOWN_ATOM) }];
      } else {
        const withFields = this.evaluateInstanceFields(classAtom, declaration, instance, [state], active);
        evaluations = withFields.flatMap((candidate) =>
          this.executeFunction(constructor, args, candidate, new Set(active).add(constructor), classAtom),
        );
        evaluations = this.bindParameterProperties(
          constructor,
          instance,
          evaluations.map((evaluation) => evaluation.state),
        ).map((candidate) => ({ state: candidate, value: this.values(UNDEFINED_ATOM) }));
      }
    } else {
      const superStatements = constructor.body?.statements.flatMap((statement, index) => {
        const expression = ts.isExpressionStatement(statement) ? unwrapExpression(statement.expression) : undefined;
        return expression && ts.isCallExpression(expression) && expression.expression.kind === ts.SyntaxKind.SuperKeyword
          ? [{ index, call: expression }]
          : [];
      }) ?? [];
      let nestedSuper = false;
      if (constructor.body) {
        const visit = (node: ts.Node) => {
          if (node !== constructor.body && ts.isFunctionLike(node)) return;
          if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword) {
            const direct = superStatements.some((candidate) => candidate.call === node);
            if (!direct) nestedSuper = true;
            return;
          }
          ts.forEachChild(node, visit);
        };
        visit(constructor.body);
      }
      if (!constructor.body || superStatements.length !== 1 || nestedSuper || active.has(constructor)) {
        this.markUnsupported(state, "unsupported super form");
        evaluations = [{ state, value: this.values(UNKNOWN_ATOM) }];
      } else {
        const superStatement = superStatements[0]!;
        const constructorActive = new Set(active).add(constructor);
        const entered = this.bindParameters(constructor.parameters, args, state, constructorActive);
        for (const candidate of entered) this.initialiseHoisted(constructor.body.statements, candidate);
        const beforeSuper = this.evaluateStatements(
          constructor.body.statements.slice(0, superStatement.index),
          entered,
          constructorActive,
        );
        evaluations = beforeSuper.flatMap((before) => {
          if (before.outcome !== "normal") return [{ state: before, value: this.values(UNKNOWN_ATOM) }];
          let inputs: Array<{ state: FlowState; args: FlowValue[] }> = [{ state: before, args: [] }];
          for (const argument of superStatement.call.arguments) {
            if (ts.isSpreadElement(argument)) {
              inputs = inputs.map((input) => {
                this.markUnsupported(input.state, "spread super argument");
                return { state: input.state, args: [...input.args, this.values(UNKNOWN_ATOM)] };
              });
            } else {
              inputs = inputs.flatMap((input) =>
                this.evaluateExpression(argument, input.state, constructorActive).map((evaluated) => ({
                  state: evaluated.state,
                  args: [...input.args, evaluated.value],
                })),
              );
            }
          }
          return inputs.flatMap((input) =>
            [...bases].flatMap((base) =>
              this.executeClassConstruction(
                base,
                input.args,
                this.cloneState(input.state),
                call,
                constructorActive,
                new Set(seen).add(classAtom),
                instance,
              ),
            ),
          );
        });
        evaluations = this.evaluateInstanceFields(
          classAtom,
          declaration,
          instance,
          evaluations.map((evaluation) => evaluation.state),
          constructorActive,
        ).map((candidate) => ({ state: candidate, value: this.values(UNDEFINED_ATOM) }));
        evaluations = evaluations.flatMap((current) =>
          this.evaluateStatements(
            constructor.body!.statements.slice(superStatement.index + 1),
            [current.state],
            constructorActive,
          ).map((finished) => {
            if (finished.outcome === "return") finished.outcome = "normal";
            return { state: finished, value: this.values(UNDEFINED_ATOM) };
          }),
        );
        evaluations = this.bindParameterProperties(
          constructor,
          instance,
          evaluations.map((evaluation) => evaluation.state),
        ).map((candidate) => ({ state: candidate, value: this.values(UNDEFINED_ATOM) }));
      }
    }
    return evaluations.map((result) => ({ state: result.state, value: this.values(instance) }));
  }

  private callbacksInValues(state: FlowState, values: readonly FlowValue[]): Set<FlowAtom> {
    const callbacks = new Set<FlowAtom>();
    const visited = new Set<FlowAtom>();
    const visit = (atom: FlowAtom) => {
      if (visited.has(atom)) return;
      visited.add(atom);
      if (this.functions.has(atom)) callbacks.add(atom);
      for (const members of state.members.get(atom)?.values() ?? []) {
        for (const member of members) visit(member);
      }
    };
    for (const value of values) for (const atom of value) visit(atom);
    return callbacks;
  }

  private literalText(input: ts.Expression | undefined): string | undefined {
    if (!input) return undefined;
    const expression = unwrapExpression(input);
    return ts.isStringLiteralLike(expression) ? expression.text : undefined;
  }

  private applyMutationCall(call: ts.CallExpression, args: readonly FlowValue[], state: FlowState): boolean {
    if (!ts.isPropertyAccessExpression(call.expression) || !ts.isIdentifier(call.expression.expression)) return false;
    const owner = call.expression.expression.text;
    const method = call.expression.name.text;
    if (
      (owner === "Object" || owner === "Reflect") &&
      method === "setPrototypeOf"
    ) {
      this.markUnsafeOptions([args[0] ?? this.values(UNKNOWN_ATOM)]);
      return true;
    }
    if (owner === "Object" && method === "assign") {
      const targets = args[0] ?? this.values(UNKNOWN_ATOM);
      for (const source of args.slice(1)) {
        for (const target of targets) {
          for (const sourceAtom of source) {
            const sourceMembers = state.members.get(sourceAtom);
            if (!sourceMembers) {
              if (target === NATIVE_PROMISE_ATOM) {
                this.replaceMember(state, this.values(target), undefined, this.values(UNKNOWN_ATOM));
              } else if (target.startsWith("client:supabase:") || target.startsWith("client:postgres:")) {
                state.dirty.add(target);
              }
              continue;
            }
            for (const [name, value] of sourceMembers) {
              if (name.startsWith("@")) continue;
              this.replaceMember(state, this.values(target), name, value);
            }
            if (sourceMembers.has("@all") || sourceMembers.has("@unknown")) {
              this.replaceMember(state, this.values(target), undefined, this.values(UNKNOWN_ATOM));
            }
          }
        }
      }
      return true;
    }
    if (owner === "Object" && method === "defineProperties") {
      const targets = args[0] ?? this.values(UNKNOWN_ATOM);
      const descriptors = args[1] ?? this.values(UNKNOWN_ATOM);
      for (const target of targets) {
        for (const descriptor of descriptors) {
          const members = state.members.get(descriptor);
          if (!members) this.replaceMember(state, this.values(target), undefined, this.values(UNKNOWN_ATOM));
          else {
            for (const name of members.keys()) {
              if (!name.startsWith("@")) {
                this.replaceMember(state, this.values(target), name, this.values(UNKNOWN_ATOM));
              }
            }
          }
        }
      }
      return true;
    }
    if (
      (owner === "Object" && method === "defineProperty") ||
      (owner === "Reflect" && ["defineProperty", "set"].includes(method))
    ) {
      const key = this.memberKey(call.arguments[1], state, args[1]);
      this.replaceMember(
        state,
        args[0] ?? this.values(UNKNOWN_ATOM),
        key,
        owner === "Reflect" && method === "set" ? args[2] ?? this.values(UNKNOWN_ATOM) : this.values(UNKNOWN_ATOM),
      );
      return true;
    }
    return false;
  }

  private evaluateTaggedTemplate(
    expression: ts.TaggedTemplateExpression,
    state: FlowState,
    active: ReadonlySet<ts.FunctionLikeDeclaration>,
  ): FlowEvaluation[] {
    return this.evaluateExpression(expression.tag, state, new Set(active)).flatMap((tag) => {
      let inputs: { state: FlowState; values: Set<FlowAtom>[] }[] = [{ state: tag.state, values: [] }];
      if (ts.isTemplateExpression(expression.template)) {
        for (const span of expression.template.templateSpans) {
          inputs = inputs.flatMap((input) =>
            this.evaluateExpression(span.expression, input.state, new Set(active)).map((value) => ({
              state: value.state,
              values: [...input.values, value.value],
            })),
          );
        }
      }
      const sql = ts.isNoSubstitutionTemplateLiteral(expression.template)
        ? expression.template.text
        : [
            expression.template.head.text,
            ...expression.template.templateSpans.map((span) => ` ? ${span.literal.text}`),
          ].join("");
      return inputs.flatMap((input) => {
        const results: FlowEvaluation[] = [];
        for (const atom of tag.value) {
          const branch = this.cloneState(input.state);
          if (atom.startsWith("client:postgres:") && !branch.dirty.has(atom)) {
            const resources = this.sqlResources(sql);
            if (!resources) {
              this.invalidPostgresOperations.add(this.atom("postgres-invalid", expression));
              results.push({ state: branch, value: this.values(UNKNOWN_ATOM) });
            } else {
              const result = this.atom("result:query", expression);
              this.queryResourcesByAtom.set(result, new Set(resources));
              results.push({ state: branch, value: this.values(result) });
            }
          } else if (this.functions.has(atom) || this.boundTargets.has(atom)) {
            results.push(
              ...this.invokeAtoms(this.values(atom), [this.values(UNKNOWN_ATOM), ...input.values], branch, expression as unknown as ts.CallExpression, active, false, false),
            );
          } else {
            this.recordMayThrow(branch);
            results.push({ state: branch, value: this.values(UNKNOWN_ATOM) });
          }
        }
        return results;
      });
    });
  }

  private sqlResources(sql: string): string[] | undefined {
    const normalizedSql = normalizePostgresSql(sql);
    if (!normalizedSql) return undefined;
    const review = REVIEWED_POSTGRES_SQL.get(normalizedSql);
    if (!review) return undefined;
    type SqlToken = { kind: "word" | "quotedIdentifier" | "punctuation"; text: string };
    const tokens: SqlToken[] = [];
    const punctuation = (text: string) => ({ kind: "punctuation" as const, text });
    const isKeyword = (token: SqlToken | undefined, keyword: string) =>
      token?.kind === "word" && token.text.toUpperCase() === keyword;
    const isName = (token: SqlToken | undefined): token is SqlToken =>
      token?.kind === "word" || token?.kind === "quotedIdentifier";
    let index = 0;
    let parenthesisDepth = 0;
    while (index < sql.length) {
      const char = sql[index]!;
      const next = sql[index + 1];
      if (/\s/.test(char)) {
        index += 1;
        continue;
      }
      if (char === "-" && next === "-") {
        index += 2;
        while (index < sql.length && sql[index] !== "\n") index += 1;
        continue;
      }
      if (char === "/" && next === "*") {
        index += 2;
        let depth = 1;
        while (index < sql.length && depth > 0) {
          if (sql[index] === "/" && sql[index + 1] === "*") {
            depth += 1;
            index += 2;
          } else if (sql[index] === "*" && sql[index + 1] === "/") {
            depth -= 1;
            index += 2;
          } else index += 1;
        }
        if (depth !== 0) return undefined;
        continue;
      }
      const escapeString = (char === "E" || char === "e") && next === "'";
      if (char === "'" || escapeString) {
        index += escapeString ? 2 : 1;
        let terminated = false;
        while (index < sql.length) {
          if (sql[index] === "'" && sql[index + 1] === "'") index += 2;
          else if (escapeString && sql[index] === "\\" && index + 1 < sql.length) index += 2;
          else if (sql[index] === "'") {
            index += 1;
            terminated = true;
            break;
          } else index += 1;
        }
        if (!terminated) return undefined;
        continue;
      }
      if (char === "$") {
        const delimiter = /^\$[a-zA-Z_][a-zA-Z0-9_]*\$|^\$\$/.exec(sql.slice(index))?.[0];
        if (delimiter) {
          const end = sql.indexOf(delimiter, index + delimiter.length);
          if (end < 0) return undefined;
          index = end + delimiter.length;
          continue;
        }
      }
      if (char === '"') {
        let identifier = "";
        index += 1;
        let terminated = false;
        while (index < sql.length) {
          if (sql[index] === '"' && sql[index + 1] === '"') {
            identifier += '"';
            index += 2;
          } else if (sql[index] === '"') {
            index += 1;
            terminated = true;
            break;
          } else identifier += sql[index++]!;
        }
        if (!terminated) return undefined;
        tokens.push({ kind: "quotedIdentifier", text: identifier });
        continue;
      }
      const identifier = /^[a-zA-Z_][a-zA-Z0-9_$]*/.exec(sql.slice(index))?.[0];
      if (identifier) {
        tokens.push({ kind: "word", text: identifier });
        index += identifier.length;
        continue;
      }
      if (char === "." || char === "(" || char === ")" || char === "," || char === ";") {
        if (char === "(") parenthesisDepth += 1;
        else if (char === ")") {
          if (parenthesisDepth === 0) return undefined;
          parenthesisDepth -= 1;
        }
        tokens.push(punctuation(char));
      }
      index += 1;
    }
    if (parenthesisDepth !== 0) return undefined;
    const cteNames = new Set<string>();
    let depth = 0;
    for (let start = 0; start < tokens.length; start += 1) {
      if (!isKeyword(tokens[start], "WITH")) continue;
      let cursor = start + 1;
      if (isKeyword(tokens[cursor], "RECURSIVE")) cursor += 1;
      while (cursor < tokens.length) {
        const name = tokens[cursor];
        if (!isName(name)) break;
        cteNames.add(name.text.toLowerCase());
        cursor += 1;
        if (tokens[cursor]?.text === "(") {
          depth = 1;
          cursor += 1;
          while (cursor < tokens.length && depth > 0) {
            if (tokens[cursor]?.text === "(") depth += 1;
            else if (tokens[cursor]?.text === ")") depth -= 1;
            cursor += 1;
          }
        }
        if (!isKeyword(tokens[cursor], "AS") || tokens[cursor + 1]?.text !== "(") break;
        cursor += 2;
        depth = 1;
        while (cursor < tokens.length && depth > 0) {
          if (tokens[cursor]?.text === "(") depth += 1;
          else if (tokens[cursor]?.text === ")") depth -= 1;
          cursor += 1;
        }
        if (tokens[cursor]?.text !== ",") break;
        cursor += 1;
      }
    }
    const resources = new Set<string>();
    for (let cursor = 0; cursor < tokens.length; cursor += 1) {
      if (!isKeyword(tokens[cursor], "FROM") && !isKeyword(tokens[cursor], "JOIN")) continue;
      cursor += 1;
      while (isKeyword(tokens[cursor], "ONLY") || isKeyword(tokens[cursor], "LATERAL")) cursor += 1;
      const first = tokens[cursor];
      if (!isName(first)) continue;
      let schema = "public";
      let name = first.text;
      const qualified = tokens[cursor + 1]?.text === "." && isName(tokens[cursor + 2]);
      if (qualified) {
        schema = first.text;
        name = tokens[cursor + 2]!.text;
        cursor += 2;
      }
      if (!qualified && cteNames.has(name.toLowerCase())) continue;
      const kind = tokens[cursor + 1]?.text === "(" ? "rpc" : "table";
      resources.add(`${kind}:${schema.toLowerCase()}.${name.toLowerCase()}`);
    }
    const resolved = [...resources].sort();
    if (resolved.length !== review.resources.length || resolved.some((resource, at) => resource !== review.resources[at])) {
      return undefined;
    }
    if (review.target && !postgresProvenanceMatchesReview(review.target, resolved)) return undefined;
    return resolved;
  }

  private executeFunction(
    fn: ts.FunctionLikeDeclaration,
    args: readonly FlowValue[],
    state: FlowState,
    active: ReadonlySet<ts.FunctionLikeDeclaration>,
    closureAtom?: FlowAtom,
  ): FlowEvaluation[] {
    const invoked = this.cloneState(state);
    const invocationBase = this.atom("invocation", fn);
    const identityProducing = this.functionCreatesIdentity(fn);
    const invocation = identityProducing
      ? `${invocationBase}:instance:${invoked.allocationSerial}`
      : `${invocationBase}:ephemeral`;
    if (identityProducing) invoked.allocationSerial += 1;
    const closureEnvironment = closureAtom ? invoked.closureEnvironments.get(closureAtom) : undefined;
    for (const [symbol, value] of closureEnvironment?.cells ?? []) {
      invoked.cells.set(symbol, new Set(value));
    }
    const previousFrame = this.allocationFrame;
    const previousLexicalFrame = this.lexicalFrame;
    const previousLocals = this.lexicalLocals;
    const previousCapturedFrame = this.capturedFrame;
    const previousLexicalThis = this.lexicalThis;
    this.allocationFrame = invocation;
    this.lexicalFrame = invocation;
    this.lexicalLocals = this.localSymbols(fn);
    this.capturedFrame = closureEnvironment?.frame;
    this.lexicalThis = closureEnvironment?.lexicalThis;
    try {
      const entered = this.bindParameters(fn.parameters, args, invoked, active);
      let results: FlowEvaluation[];
      if (!fn.body) {
        results = entered.map((candidate) => ({ state: candidate, value: this.values(UNKNOWN_ATOM) }));
      } else if (!ts.isBlock(fn.body)) {
        results = entered.flatMap((candidate) =>
          this.evaluateExpression(fn.body as ts.Expression, candidate, new Set(active)),
        );
      } else {
        results = entered.flatMap((candidate) => {
          this.initialiseHoisted(fn.body!.statements, candidate);
          return this.evaluateStatements(fn.body!.statements, [candidate], active).map((finished) => {
            const value = finished.outcome === "return" ? new Set(finished.returned) : this.values(UNDEFINED_ATOM);
            const returned = this.cloneState(finished);
            if (returned.outcome === "return") returned.outcome = "normal";
            return { state: returned, value };
          });
        });
      }
      if (closureAtom) {
        for (const result of results) {
          const environment = result.state.closureEnvironments.get(closureAtom);
          if (!environment) continue;
          for (const [symbol, prior] of environment.cells) {
            const value = new Set(result.state.cells.get(symbol) ?? prior);
            for (const sibling of result.state.closureEnvironments.values()) {
              if (sibling.frame === environment.frame && sibling.cells.has(symbol)) {
                sibling.cells.set(symbol, new Set(value));
              }
            }
          }
        }
      }
      return results;
    } finally {
      this.allocationFrame = previousFrame;
      this.lexicalFrame = previousLexicalFrame;
      this.lexicalLocals = previousLocals;
      this.capturedFrame = previousCapturedFrame;
      this.lexicalThis = previousLexicalThis;
    }
  }

  private bindParameters(
    parameters: readonly ts.ParameterDeclaration[],
    args: readonly FlowValue[],
    state: FlowState,
    active: ReadonlySet<ts.FunctionLikeDeclaration>,
  ): FlowState[] {
    let states = [this.cloneState(state)];
    parameters.forEach((parameter, index) => {
      const supplied = args[index] ?? this.values(UNDEFINED_ATOM);
      states = states.flatMap((candidate) => {
        if (!parameter.initializer || (!supplied.has(UNDEFINED_ATOM) && !supplied.has(UNKNOWN_ATOM))) {
          return this.bindName(candidate, parameter.name, supplied, active);
        }
        const alternatives = this.evaluateExpression(
          parameter.initializer,
          this.cloneState(candidate),
          new Set(active),
        ).flatMap(
          (evaluated) => this.bindName(evaluated.state, parameter.name, evaluated.value, active),
        );
        const direct = new Set([...supplied].filter((atom) => atom !== UNDEFINED_ATOM));
        if (direct.size > 0) {
          const directState = this.cloneState(candidate);
          alternatives.push(...this.bindName(directState, parameter.name, direct, active));
        }
        return alternatives;
      });
    });
    return states;
  }

  private evaluateStatements(
    statements: readonly ts.Statement[],
    initial: readonly FlowState[],
    active: ReadonlySet<ts.FunctionLikeDeclaration>,
  ): FlowState[] {
    let states = [...initial];
    for (const statement of statements) {
      states = states.flatMap((state) =>
        state.outcome === "normal" ? this.evaluateStatement(statement, state, active) : [state],
      );
      if (states.length > 96) states = this.widenStates(states);
    }
    return states;
  }

  private deniedErrorGuardOperations(expression: ts.Expression, state: FlowState): Set<FlowAtom> {
    const condition = unwrapExpression(expression);
    if (
      !ts.isBinaryExpression(condition) ||
      ![
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
      ].includes(condition.operatorToken.kind)
    ) {
      return new Set();
    }
    const left = unwrapExpression(condition.left);
    const right = unwrapExpression(condition.right);
    const codeExpression = ts.isStringLiteralLike(left) && left.text === "42501"
      ? condition.right
      : ts.isStringLiteralLike(right) && right.text === "42501"
        ? condition.left
        : undefined;
    if (!codeExpression) return new Set();
    const evaluated = this.evaluateExpression(codeExpression, this.cloneState(state), new Set());
    return new Set(
      evaluated.flatMap((result) =>
        [...result.value].flatMap((atom) => {
          const operation = this.mutationErrorTargets.get(atom);
          return operation ? [operation] : [];
        })
      ),
    );
  }

  private isDirectThrow(statement: ts.Statement): boolean {
    return ts.isThrowStatement(statement) ||
      (ts.isBlock(statement) && statement.statements.length === 1 && ts.isThrowStatement(statement.statements[0]));
  }

  private evaluateStatement(
    statement: ts.Statement,
    state: FlowState,
    active: ReadonlySet<ts.FunctionLikeDeclaration>,
  ): FlowState[] {
    if (
      ts.isImportDeclaration(statement) ||
      ts.isImportEqualsDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)
    ) {
      return [state];
    }
    if (ts.isClassDeclaration(statement)) {
      return this.evaluateClass(statement, state, active).map((evaluated) => evaluated.state);
    }
    if (ts.isExpressionStatement(statement)) {
      return this.evaluateExpression(statement.expression, state, new Set(active)).map((evaluation) => evaluation.state);
    }
    if (ts.isVariableStatement(statement)) {
      let states = [state];
      for (const declaration of statement.declarationList.declarations) {
        states = states.flatMap((current) => {
          if (!declaration.initializer) {
            return this.bindName(current, declaration.name, this.values(UNDEFINED_ATOM), active);
          }
          return this.evaluateExpression(declaration.initializer, current, new Set(active)).flatMap((evaluated) =>
            this.bindName(evaluated.state, declaration.name, evaluated.value, active)
          );
        });
      }
      return states;
    }
    if (ts.isFunctionDeclaration(statement)) return [state];
    if (ts.isReturnStatement(statement)) {
      const values = statement.expression
        ? this.evaluateExpression(statement.expression, state, new Set(active))
        : [{ state, value: this.values(UNDEFINED_ATOM) }];
      return values.map((evaluation) => {
        evaluation.state.outcome = "return";
        evaluation.state.returned = new Set(evaluation.value);
        return evaluation.state;
      });
    }
    if (ts.isThrowStatement(statement)) {
      const values = this.evaluateExpression(statement.expression, state, new Set(active));
      return values.map((evaluation) => {
        evaluation.state.outcome = "throw";
        return evaluation.state;
      });
    }
    if (ts.isBreakStatement(statement)) {
      state.outcome = "break";
      return [state];
    }
    if (ts.isContinueStatement(statement)) {
      state.outcome = "continue";
      return [state];
    }
    if (ts.isBlock(statement)) {
      this.initialiseHoisted(statement.statements, state);
      return this.evaluateStatements(statement.statements, [state], active);
    }
    if (ts.isIfStatement(statement)) {
      const staticCondition = staticBoolean(statement.expression);
      return this.evaluateExpression(statement.expression, state, new Set(active)).flatMap((condition) => {
        if (staticCondition === true) return this.evaluateStatement(statement.thenStatement, condition.state, active);
        if (staticCondition === false) {
          return statement.elseStatement
            ? this.evaluateStatement(statement.elseStatement, condition.state, active)
            : [condition.state];
        }
        const deniedOperations = !statement.elseStatement && this.isDirectThrow(statement.thenStatement)
          ? this.deniedErrorGuardOperations(statement.expression, condition.state)
          : new Set<FlowAtom>();
        if (deniedOperations.size) {
          const normal = this.cloneState(condition.state);
          for (const operation of deniedOperations) normal.observedDeniedMutationOperations.add(operation);
          return [
            ...this.evaluateStatement(statement.thenStatement, this.cloneState(condition.state), active),
            normal,
          ];
        }
        return [
          ...this.evaluateStatement(statement.thenStatement, this.cloneState(condition.state), active),
          ...(statement.elseStatement
            ? this.evaluateStatement(statement.elseStatement, this.cloneState(condition.state), active)
            : [this.cloneState(condition.state)]),
        ];
      });
    }
    if (ts.isSwitchStatement(statement)) return this.evaluateSwitch(statement, state, active);
    if (ts.isWhileStatement(statement) || ts.isDoStatement(statement) || ts.isForStatement(statement)) {
      return this.evaluateLoop(statement, state, active);
    }
    if (ts.isForOfStatement(statement) || ts.isForInStatement(statement)) {
      return this.evaluateForEach(statement, state, active);
    }
    if (ts.isTryStatement(statement)) return this.evaluateTry(statement, state, active);
    if (ts.isEmptyStatement(statement) || ts.isDebuggerStatement(statement)) return [state];
    this.markUnsupported(state, `unsupported statement ${ts.SyntaxKind[statement.kind]}`);
    return [state];
  }

  private evaluateSwitch(
    statement: ts.SwitchStatement,
    state: FlowState,
    active: ReadonlySet<ts.FunctionLikeDeclaration>,
  ): FlowState[] {
    const discriminant = this.literalPrimitive(statement.expression);
    const clauses = statement.caseBlock.clauses;
    const runFrom = (start: number, initial: FlowState): FlowState[] => {
      let continuing = [initial];
      const exits: FlowState[] = [];
      for (let index = start; index < clauses.length && continuing.length; index += 1) {
        const evaluated = this.evaluateStatements(clauses[index]!.statements, continuing, active);
        continuing = [];
        for (const candidate of evaluated) {
          if (candidate.outcome === "break") {
            candidate.outcome = "normal";
            exits.push(candidate);
          } else if (candidate.outcome === "normal") continuing.push(candidate);
          else exits.push(candidate);
        }
      }
      return [...exits, ...continuing];
    };
    return this.evaluateExpression(statement.expression, state, new Set(active)).flatMap((evaluated) => {
      let labelStates = [evaluated.state];
      const starts: Array<{ index: number; state: FlowState }> = [];
      for (let index = 0; index < clauses.length; index += 1) {
        const clause = clauses[index]!;
        if (!ts.isCaseClause(clause)) continue;
        labelStates = labelStates.flatMap((candidate) =>
          this.evaluateExpression(clause.expression, candidate, new Set(active)).map((result) => result.state),
        );
        if (discriminant === undefined || this.literalPrimitive(clause.expression) === discriminant) {
          starts.push(...labelStates.map((candidate) => ({ index, state: this.cloneState(candidate) })));
          if (discriminant !== undefined) break;
        }
      }
      if (discriminant !== undefined && starts.length === 0) {
        const fallback = clauses.findIndex(ts.isDefaultClause);
        if (fallback >= 0) starts.push(...labelStates.map((candidate) => ({ index: fallback, state: candidate })));
      } else if (discriminant === undefined) {
        const fallback = clauses.findIndex(ts.isDefaultClause);
        if (fallback >= 0) starts.push(...labelStates.map((candidate) => ({ index: fallback, state: this.cloneState(candidate) })));
        else starts.push(...labelStates.map((candidate) => ({ index: -1, state: candidate })));
      }
      return starts.flatMap((entry) => entry.index < 0 ? [entry.state] : runFrom(entry.index, entry.state));
    });
  }

  private literalPrimitive(expression: ts.Expression): string | number | boolean | undefined {
    const value = unwrapExpression(expression);
    if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isStringLiteralLike(value)) return value.text;
    if (ts.isNumericLiteral(value)) return Number(value.text);
    return undefined;
  }

  private evaluateLoop(
    statement: ts.WhileStatement | ts.DoStatement | ts.ForStatement,
    state: FlowState,
    active: ReadonlySet<ts.FunctionLikeDeclaration>,
  ): FlowState[] {
    let before = state;
    if (ts.isForStatement(statement) && statement.initializer) {
      if (ts.isVariableDeclarationList(statement.initializer)) {
        const synthetic = ts.factory.createVariableStatement(undefined, statement.initializer);
        const initialized = this.evaluateStatement(synthetic, before, active);
        before = initialized[0] ?? before;
      } else {
        before = this.evaluateExpression(statement.initializer, before, new Set(active))[0]?.state ?? before;
      }
    }
    const condition = ts.isForStatement(statement) ? statement.condition : statement.expression;
    const staticCondition = condition ? staticBoolean(condition) : true;
    if (staticCondition === false && !ts.isDoStatement(statement)) return [before];
    if (staticCondition === undefined && ts.isDoStatement(statement)) {
      let frontier = [this.cloneState(before)];
      let exits: FlowState[] = [];
      let converged = false;
      for (let iteration = 0; iteration < 8; iteration += 1) {
        const next: FlowState[] = [];
        for (const candidate of frontier) {
          for (const body of this.evaluateStatement(statement.statement, candidate, active)) {
            if (body.outcome === "break") {
              body.outcome = "normal";
              exits.push(body);
              continue;
            }
            if (body.outcome === "return" || body.outcome === "throw") {
              exits.push(body);
              continue;
            }
            if (body.outcome === "continue") body.outcome = "normal";
            for (const checked of this.evaluateExpression(statement.expression, body, new Set(active))) {
              exits.push(this.cloneState(checked.state));
              next.push(checked.state);
            }
          }
        }
        const widened = next.length > 96 ? this.widenStates(next) : next;
        converged =
          widened.length === frontier.length &&
          widened.every((candidate) => frontier.some((prior) => this.statesEqual(candidate, prior)));
        frontier = widened;
        if (converged || frontier.length === 0) break;
      }
      if (!converged && frontier.length > 0) {
        for (const candidate of [...frontier, ...exits]) this.markUnsupported(candidate, "non-convergent do-while loop");
      }
      exits.push(...frontier.map((candidate) => this.cloneState(candidate)));
      return exits.length > 96 ? this.widenStates(exits) : exits;
    }
    if (staticCondition === undefined && !ts.isDoStatement(statement) && condition) {
      let frontier = [this.cloneState(before)];
      let exits: FlowState[] = [];
      let converged = false;
      for (let iteration = 0; iteration < 8; iteration += 1) {
        const next: FlowState[] = [];
        for (const candidate of frontier) {
          for (const checked of this.evaluateExpression(condition, candidate, new Set(active))) {
            exits.push(this.cloneState(checked.state));
            for (const body of this.evaluateStatement(statement.statement, this.cloneState(checked.state), active)) {
              if (body.outcome === "break") {
                body.outcome = "normal";
                exits.push(body);
                continue;
              }
              if (body.outcome === "return" || body.outcome === "throw") {
                exits.push(body);
                continue;
              }
              if (body.outcome === "continue") body.outcome = "normal";
              if (ts.isForStatement(statement) && statement.incrementor) {
                next.push(
                  ...this.evaluateExpression(statement.incrementor, body, new Set(active)).map((result) => result.state),
                );
              } else next.push(body);
            }
          }
        }
        const widened = next.length > 96 ? this.widenStates(next) : next;
        converged =
          widened.length === frontier.length &&
          widened.every((candidate) => frontier.some((prior) => this.statesEqual(candidate, prior)));
        frontier = widened;
        if (converged || frontier.length === 0) break;
      }
      if (!converged && frontier.length > 0) {
        for (const candidate of [...frontier, ...exits]) this.markUnsupported(candidate, "non-convergent loop");
      }
      exits.push(...frontier.map((candidate) => this.cloneState(candidate)));
      return exits.length > 96 ? this.widenStates(exits) : exits;
    }
    const bodyStates = this.evaluateStatement(statement.statement, this.cloneState(before), active);
    const finished: FlowState[] = [];
    for (const body of bodyStates) {
      if (body.outcome === "break") {
        body.outcome = "normal";
        finished.push(body);
      } else if (body.outcome === "return" || body.outcome === "throw") {
        finished.push(body);
      } else if (staticCondition === true) {
        body.outcome = "nonterminating";
        finished.push(body);
      } else {
        body.outcome = "normal";
        finished.push(body);
      }
    }
    if (staticCondition !== true && !ts.isDoStatement(statement)) finished.push(this.cloneState(before));
    return finished;
  }

  private evaluateForEach(
    statement: ts.ForOfStatement | ts.ForInStatement,
    state: FlowState,
    active: ReadonlySet<ts.FunctionLikeDeclaration>,
  ): FlowState[] {
    if (ts.isForInStatement(statement) || statement.awaitModifier) {
      const unsupported = this.cloneState(state);
      this.markUnsupported(unsupported, ts.isForInStatement(statement) ? "for-in enumeration" : "async for-of enumeration");
      return [unsupported];
    }
    return this.evaluateExpression(statement.expression, state, new Set(active)).flatMap((iterable) => {
      const results: FlowState[] = [];
      for (const atom of iterable.value) {
        const arrayLength = this.arrayLength(iterable.state, atom);
        if (arrayLength !== undefined) {
          results.push(...this.runArrayForEach(statement, atom, arrayLength, this.cloneState(iterable.state), active));
          continue;
        }
        if (atom.startsWith("generator:") && this.generatorTargets.has(atom)) {
          results.push(...this.runGeneratorForEach(statement, atom, this.cloneState(iterable.state), active));
          continue;
        }
        const unsupported = this.cloneState(iterable.state);
        this.markUnsupported(unsupported, "unresolved for-of iterable");
        results.push(unsupported);
      }
      return results;
    });
  }

  private arrayLength(state: FlowState, atom: FlowAtom): number | undefined {
    if (!atom.startsWith("array:")) return undefined;
    const members = state.members.get(atom);
    const lengthEntry = [...(members?.keys() ?? [])].find((key) => key.startsWith("@array-length:"));
    if (!members || !lengthEntry) return undefined;
    const length = Number(lengthEntry.slice("@array-length:".length));
    if (!Number.isSafeInteger(length) || length < 0) return undefined;
    return length;
  }

  private bindForEachValue(
    statement: ts.ForOfStatement,
    state: FlowState,
    value: FlowValue,
    active: ReadonlySet<ts.FunctionLikeDeclaration>,
  ): FlowState[] {
    if (ts.isVariableDeclarationList(statement.initializer)) {
      let states = [state];
      for (const declaration of statement.initializer.declarations) {
        states = states.flatMap((candidate) => this.bindName(candidate, declaration.name, value, active));
      }
      return states;
    }
    return this.assignTarget(state, statement.initializer, value, active);
  }

  private runArrayForEach(
    statement: ts.ForOfStatement,
    array: FlowAtom,
    length: number,
    state: FlowState,
    active: ReadonlySet<ts.FunctionLikeDeclaration>,
  ): FlowState[] {
    let frontier = [state];
    const finished: FlowState[] = [];
    for (let index = 0; index < length; index += 1) {
      const next: FlowState[] = [];
      for (const current of frontier) {
        const value = current.members.get(array)?.get(String(index));
        if (!value) {
          this.markUnsupported(current, "unresolved array element");
          finished.push(current);
          continue;
        }
        for (const bound of this.bindForEachValue(statement, current, value, active)) {
          for (const result of this.evaluateStatement(statement.statement, bound, active)) {
            if (result.outcome === "break") {
              result.outcome = "normal";
              finished.push(result);
            } else if (result.outcome === "return" || result.outcome === "throw") finished.push(result);
            else {
              if (result.outcome === "continue") result.outcome = "normal";
              next.push(result);
            }
          }
        }
      }
      frontier = next;
    }
    return [...finished, ...frontier];
  }

  private runGeneratorForEach(
    statement: ts.ForOfStatement,
    generator: FlowAtom,
    state: FlowState,
    active: ReadonlySet<ts.FunctionLikeDeclaration>,
  ): FlowState[] {
    let frontier = [state];
    const finished: FlowState[] = [];
    for (let iteration = 0; iteration < 64 && frontier.length; iteration += 1) {
      const next: FlowState[] = [];
      for (const current of frontier) {
        for (const frame of this.advanceGeneratorFrame(generator, current, active)) {
          if (frame.done) {
            finished.push(frame.state);
            continue;
          }
          for (const bound of this.bindForEachValue(statement, frame.state, frame.value, active)) {
            for (const result of this.evaluateStatement(statement.statement, bound, active)) {
              if (result.outcome === "break") {
                result.outcome = "normal";
                finished.push(result);
              } else if (result.outcome === "return" || result.outcome === "throw") finished.push(result);
              else {
                if (result.outcome === "continue") result.outcome = "normal";
                next.push(result);
              }
            }
          }
        }
      }
      frontier = next.length > 96 ? this.widenStates(next) : next;
    }
    if (frontier.length) {
      for (const candidate of frontier) this.markUnsupported(candidate, "non-convergent generator for-of");
      finished.push(...frontier);
    }
    return finished;
  }

  private evaluateTry(
    statement: ts.TryStatement,
    state: FlowState,
    active: ReadonlySet<ts.FunctionLikeDeclaration>,
  ): FlowState[] {
    const previousSnapshots = this.mayThrowSnapshots;
    const localSnapshots: FlowState[] = [];
    this.mayThrowSnapshots = localSnapshots;
    let tryStates: FlowState[];
    try {
      tryStates = this.evaluateStatement(statement.tryBlock, this.cloneState(state), active);
    } finally {
      this.mayThrowSnapshots = previousSnapshots;
    }
    let states = tryStates.filter((candidate) => candidate.outcome !== "throw");
    if (statement.catchClause) {
      const caught = [
        ...localSnapshots,
        ...tryStates.filter((candidate) => candidate.outcome === "throw"),
      ];
      states.push(...this.widenStates(caught).flatMap((candidate) => {
        const handled = this.cloneState(candidate);
        handled.outcome = "normal";
        const bound = statement.catchClause!.variableDeclaration
          ? this.bindName(
              handled,
              statement.catchClause!.variableDeclaration.name,
              this.values(UNKNOWN_ATOM),
              active,
            )
          : [handled];
        return bound.flatMap((candidateState) =>
          this.evaluateStatement(statement.catchClause!.block, candidateState, active)
        );
      }));
    } else states.push(...tryStates.filter((candidate) => candidate.outcome === "throw"));
    if (!statement.finallyBlock) return states;
    return states.flatMap((candidate) => {
      const prior = candidate.outcome;
      const finalState = this.cloneState(candidate);
      finalState.outcome = "normal";
      return this.evaluateStatement(statement.finallyBlock!, finalState, active).map((finished) => {
        if (finished.outcome === "normal") finished.outcome = prior;
        return finished;
      });
    });
  }

  private widenStates(states: readonly FlowState[]): FlowState[] {
    const widened: FlowState[] = [];
    for (const state of states) {
      if (!widened.some((candidate) => this.statesEqual(candidate, state))) widened.push(this.cloneState(state));
    }
    return widened;
  }

  private globalStates(executeSuites: boolean): FlowState[] {
    const previous = this.executeSuites;
    this.executeSuites = executeSuites;
    const state = this.seedImports();
    this.initialiseHoisted(this.sourceFile.statements, state);
    const states = this.evaluateStatements(this.sourceFile.statements, [state], new Set());
    this.executeSuites = previous;
    return states;
  }

  mockFactoryProof(
    factory: ts.Expression | undefined,
    protectedExport: string,
  ): { partial: boolean; replacesProtected: boolean } {
    if (!factory || (!ts.isArrowFunction(factory) && !ts.isFunctionExpression(factory))) {
      return { partial: false, replacesProtected: true };
    }
    const bases = this.globalStates(false);
    const results = bases.flatMap((base) =>
      this.executeFunction(factory, [this.values(ORIGINAL_LOADER_ATOM)], base, new Set([factory])),
    );
    const returnedObjects = results.map((result) => ({
      state: result.state,
      atom: [...result.value].find((atom) => atom.startsWith("object:")),
      abrupt: result.state.outcome !== "normal",
      unsupported: result.state.unsupported,
    }));
    const partial =
      returnedObjects.length > 0 &&
      returnedObjects.every(
        ({ state, atom, abrupt, unsupported }) =>
          !abrupt &&
          !unsupported &&
          !!atom &&
          state.members.get(atom)?.get("@seenOriginal")?.has(ORIGINAL_MODULE_ATOM),
      );
    const protectedPreserved =
      returnedObjects.length > 0 &&
      returnedObjects.every(({ state, atom, abrupt, unsupported }) => {
        if (abrupt || unsupported || !atom) return false;
        const members = state.members.get(atom);
        const value = members?.get(protectedExport) ?? members?.get("@all");
        return value?.size === 1 && value.has(ORIGINAL_MODULE_ATOM);
      });
    return { partial, replacesProtected: !protectedPreserved };
  }

  testFlowProof(testCall: ts.CallExpression): TestFlowProof {
    const callback = testCall.arguments.find(
      (argument): argument is ts.ArrowFunction | ts.FunctionExpression =>
        ts.isArrowFunction(argument) || ts.isFunctionExpression(argument),
    );
    if (!callback) {
      return {
        mockedWitness: false,
        queryResources: [],
        unsupported: true,
        normalPathWithoutWitness: true,
        mutationEvidenceInvalid: false,
      };
    }
    const bases = this.globalStates(true);
    const finished = bases.flatMap((base) => this.executeFunction(callback, [], base, new Set([callback])));
    const normal = finished.filter(
      (result) => result.state.outcome === "normal" || result.state.outcome === "return",
    );
    const allStates = finished.map((result) => result.state);
    const dirtySupabase = allStates.some((state) =>
      [...state.dirty].some((atom) => atom.startsWith("client:supabase:")),
    );
    const dirtyPostgres = allStates.some((state) =>
      [...state.dirty].some((atom) => atom.startsWith("client:postgres:")),
    );
    const witnessCounts = normal.map((result) => result.state.witnessCount);
    const awaitedCounts = normal.map((result) => result.state.awaitedWitnessCount);
    const resourceSets = normal.map((result) => [...result.state.witnessResources].sort().join(","));
    const queryResources =
      resourceSets.length > 0 && new Set(resourceSets).size === 1 && resourceSets[0]
        ? resourceSets[0].split(",")
        : [];
    const mutationSignatureSets = normal.map((result) =>
      [...result.state.witnessMutationSignatures].sort().join("\n"),
    );
    const mutationSignaturesConsistent =
      mutationSignatureSets.length > 0 &&
      normal.every((result) => result.state.witnessMutationSignatures.size <= 1) &&
      new Set(mutationSignatureSets).size === 1;
    const mutationSignature = mutationSignaturesConsistent ? mutationSignatureSets[0] : undefined;
    const parsedMutation = mutationSignature
      ? JSON.parse(mutationSignature) as MutationWitnessEvidence | { invalid: true }
      : undefined;
    return {
      ...(dirtySupabase ? { mockedReceiver: "Supabase" as const } : dirtyPostgres ? { mockedReceiver: "Postgres" as const } : {}),
      mockedWitness: allStates.some((state) => state.dirty.has(WITNESS_ATOM)),
      ...(witnessCounts.length ? { witnessCount: Math.max(...witnessCounts) } : {}),
      ...(awaitedCounts.length ? { awaitedWitnessCount: Math.max(...awaitedCounts) } : {}),
      queryResources,
      ...(parsedMutation && !("invalid" in parsedMutation) ? { mutationEvidence: parsedMutation } : {}),
      mutationEvidenceInvalid:
        mutationSignatureSets.some(Boolean) &&
        (!mutationSignaturesConsistent || !parsedMutation || "invalid" in parsedMutation),
      unsupported: allStates.some((state) => state.unsupported),
      normalPathWithoutWitness:
        normal.length === 0 ||
        normal.some(
          (result) => result.state.witnessCount !== 1 || result.state.awaitedWitnessCount !== 1,
        ),
      ...(this.executedWitnessCalls.size === 1 ? { witnessCall: [...this.executedWitnessCalls][0] } : {}),
    };
  }

  private importName(symbol: ts.Symbol | undefined): { module: string; imported: string } | undefined {
    const declaration = symbol?.declarations?.[0];
    if (!declaration) return undefined;
    if (ts.isImportSpecifier(declaration)) {
      const importDeclaration = declaration.parent.parent.parent;
      if (!ts.isStringLiteralLike(importDeclaration.moduleSpecifier)) return undefined;
      return {
        module: importDeclaration.moduleSpecifier.text,
        imported: declaration.propertyName?.text ?? declaration.name.text,
      };
    }
    if (ts.isNamespaceImport(declaration)) {
      const importDeclaration = declaration.parent.parent;
      if (!ts.isStringLiteralLike(importDeclaration.moduleSpecifier)) return undefined;
      return { module: importDeclaration.moduleSpecifier.text, imported: "*" };
    }
    return undefined;
  }

  private bindingSources(identifier: ts.Identifier): Array<{ source: ts.Expression; path?: string[]; unsupported?: boolean } | undefined> {
    const symbol = this.symbol(identifier);
    if (!symbol) return [];
    type Binding = { source: ts.Expression; path?: string[]; arrayOffset?: number; unsupported?: boolean } | undefined;
    type AliasState = { binding: Binding; outcome: FlowOutcome };
    type AliasEvaluation = { state: AliasState; value: Binding };
    const matches = (node: ts.Identifier) => this.symbol(node) === symbol;
    const bindingKey = (binding: Binding): string => binding
      ? `${binding.source.pos}:${binding.source.end}:${binding.path?.join(".") ?? ""}:${binding.arrayOffset ?? ""}:${binding.unsupported ? "unsupported" : ""}`
      : "undefined";
    const uniqueBindings = (bindings: Binding[]): Binding[] => {
      const seen = new Set<string>();
      return bindings.filter((binding) => {
        const key = bindingKey(binding);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };
    const uniqueStates = (states: AliasState[]): AliasState[] => {
      const seen = new Set<string>();
      return states.filter((state) => {
        const key = `${state.outcome}:${bindingKey(state.binding)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };
    const propertyName = (node: ts.PropertyName | undefined, fallback: string): string | undefined => {
      if (!node) return fallback;
      if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text;
      return this.staticKey(node);
    };
    const selected = (binding: Binding, key: string): Binding => {
      if (!binding) return undefined;
      if (binding.unsupported) return binding;
      const source = unwrapExpression(binding.source);
      const selectedKey = binding.arrayOffset !== undefined && /^\d+$/.test(key)
        ? String(binding.arrayOffset + Number(key))
        : key;
      if (!binding.path?.length && ts.isObjectLiteralExpression(source)) {
        const property = source.properties.find((candidate) =>
          (ts.isPropertyAssignment(candidate) || ts.isMethodDeclaration(candidate)) &&
          propertyName(candidate.name, "") === selectedKey,
        );
        if (property && ts.isPropertyAssignment(property)) return { source: property.initializer };
        if (property && ts.isMethodDeclaration(property)) return { source: property as unknown as ts.Expression };
        if (source.properties.some(ts.isSpreadAssignment)) return { source: binding.source, unsupported: true };
        return undefined;
      }
      if (!binding.path?.length && ts.isArrayLiteralExpression(source) && /^\d+$/.test(selectedKey)) {
        const element = source.elements[Number(selectedKey)];
        if (!element || ts.isOmittedExpression(element)) return undefined;
        return { source: ts.isSpreadElement(element) ? element.expression : element };
      }
      return { ...binding, arrayOffset: undefined, path: [...(binding.path ?? []), selectedKey] };
    };
    const bindingAvailability = (binding: Binding): "missing" | "present" | "unknown" => {
      if (!binding) return "missing";
      if (binding.unsupported || binding.path?.length || binding.arrayOffset !== undefined) return "unknown";
      const source = unwrapExpression(binding.source);
      if (ts.isIdentifier(source) && source.text === "undefined") return "missing";
      if (
        ts.isLiteralExpression(source) ||
        ts.isArrowFunction(source) ||
        ts.isFunctionExpression(source) ||
        ts.isClassExpression(source) ||
        ts.isObjectLiteralExpression(source) ||
        ts.isArrayLiteralExpression(source) ||
        source.kind === ts.SyntaxKind.TrueKeyword ||
        source.kind === ts.SyntaxKind.FalseKeyword ||
        source.kind === ts.SyntaxKind.NullKeyword
      ) return "present";
      return "unknown";
    };
    const containsTarget = (node: ts.Node): boolean => {
      let found = false;
      const visit = (candidate: ts.Node): void => {
        if (found || (candidate !== node && ts.isFunctionLike(candidate))) return;
        if (ts.isIdentifier(candidate) && matches(candidate)) found = true;
        else ts.forEachChild(candidate, visit);
      };
      visit(node);
      return found;
    };
    const bindName = (name: ts.BindingName, value: Binding, state: AliasState): AliasState[] => {
      if (ts.isIdentifier(name)) return matches(name) ? [{ ...state, binding: value }] : [state];
      let states = [state];
      name.elements.forEach((element, index) => {
        if (ts.isOmittedExpression(element)) return;
        states = states.flatMap((candidate) => {
          if (element.dotDotDotToken) {
            return containsTarget(element.name)
              ? [{
                  ...candidate,
                  binding: value
                    ? ts.isArrayBindingPattern(name)
                      ? { ...value, arrayOffset: (value.arrayOffset ?? 0) + index }
                      : { ...value, unsupported: true }
                    : undefined,
                }]
              : [candidate];
          }
          const key = ts.isArrayBindingPattern(name)
            ? String(index)
            : propertyName(element.propertyName, ts.isIdentifier(element.name) ? element.name.text : "");
          const choice = key === undefined ? (value ? { ...value, unsupported: true } : undefined) : selected(value, key);
          const bound = bindName(element.name, choice, candidate);
          if (!element.initializer) return bound;
          const fallback = bindName(element.name, { source: element.initializer }, candidate);
          const availability = bindingAvailability(choice);
          return availability === "missing" ? fallback : availability === "present" ? bound : [...bound, ...fallback];
        });
      });
      return uniqueStates(states);
    };
    const bindTarget = (target: ts.Expression, value: Binding, state: AliasState): AliasState[] => {
      const unwrapped = unwrapExpression(target);
      if (ts.isIdentifier(unwrapped)) return matches(unwrapped) ? [{ ...state, binding: value }] : [state];
      if (ts.isArrayLiteralExpression(unwrapped)) {
        let states = [state];
        unwrapped.elements.forEach((element, index) => {
          if (ts.isOmittedExpression(element)) return;
          states = states.flatMap((candidate) => {
            const item = ts.isSpreadElement(element) ? element.expression : element;
            if (ts.isSpreadElement(element) && containsTarget(item)) {
              return [{ ...candidate, binding: value ? { ...value, unsupported: true } : undefined }];
            }
            const choice = selected(value, String(index));
            if (ts.isBinaryExpression(item) && item.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
              const direct = bindTarget(item.left, choice, candidate);
              const fallback = bindTarget(item.left, { source: item.right }, candidate);
              const availability = bindingAvailability(choice);
              return availability === "missing" ? fallback : availability === "present" ? direct : [...direct, ...fallback];
            }
            return bindTarget(item, choice, candidate);
          });
        });
        return uniqueStates(states);
      }
      if (ts.isObjectLiteralExpression(unwrapped)) {
        let states = [state];
        for (const property of unwrapped.properties) {
          states = states.flatMap((candidate) => {
            if (ts.isSpreadAssignment(property)) {
              return containsTarget(property.expression)
                ? [{ ...candidate, binding: value ? { ...value, unsupported: true } : undefined }]
                : [candidate];
            }
            if (ts.isShorthandPropertyAssignment(property)) {
              return bindTarget(property.name, selected(value, property.name.text), candidate);
            }
            if (ts.isPropertyAssignment(property)) {
              const key = propertyName(property.name, "");
              const choice = key === undefined ? (value ? { ...value, unsupported: true } : undefined) : selected(value, key);
              if (
                ts.isBinaryExpression(property.initializer) &&
                property.initializer.operatorToken.kind === ts.SyntaxKind.EqualsToken
              ) {
                const direct = bindTarget(property.initializer.left, choice, candidate);
                const fallback = bindTarget(property.initializer.left, { source: property.initializer.right }, candidate);
                const availability = bindingAvailability(choice);
                return availability === "missing" ? fallback : availability === "present" ? direct : [...direct, ...fallback];
              }
              return bindTarget(property.initializer, choice, candidate);
            }
            return containsTarget(property) && value
              ? [{ ...candidate, binding: { ...value, unsupported: true } }]
              : [candidate];
          });
        }
        return uniqueStates(states);
      }
      return containsTarget(unwrapped) && value
        ? [{ ...state, binding: { ...value, unsupported: true } }]
        : [state];
    };
    const evaluateExpression = (
      input: ts.Expression,
      states: AliasState[],
      mayThrow = false,
    ): AliasEvaluation[] => {
      const expression = unwrapExpression(input);
      const normalStates = states.filter((state) => state.outcome === "normal");
      const abrupt = states.filter((state) => state.outcome !== "normal").map((state) => ({ state, value: undefined }));
      if (!normalStates.length) return abrupt;
      if (ts.isConditionalExpression(expression)) {
        const conditions = evaluateExpression(expression.condition, normalStates, mayThrow);
        const condition = staticBoolean(expression.condition);
        const branches = conditions.flatMap(({ state }) => {
          if (state.outcome !== "normal") return [{ state, value: undefined }];
          if (condition === true) return evaluateExpression(expression.whenTrue, [state], mayThrow);
          if (condition === false) return evaluateExpression(expression.whenFalse, [state], mayThrow);
          return [
            ...evaluateExpression(expression.whenTrue, [{ ...state }], mayThrow),
            ...evaluateExpression(expression.whenFalse, [{ ...state }], mayThrow),
          ];
        });
        return [...abrupt, ...branches];
      }
      if (ts.isBinaryExpression(expression)) {
        const operator = expression.operatorToken.kind;
        if (operator === ts.SyntaxKind.CommaToken) {
          const left = evaluateExpression(expression.left, normalStates, mayThrow);
          return [...abrupt, ...left.flatMap(({ state }) => evaluateExpression(expression.right, [state], mayThrow))];
        }
        if (operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment) {
          const logical = operator === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
            operator === ts.SyntaxKind.BarBarEqualsToken ||
            operator === ts.SyntaxKind.QuestionQuestionEqualsToken;
          const right = evaluateExpression(expression.right, normalStates.map((state) => ({ ...state })), mayThrow);
          const assigned = right.flatMap(({ state, value }) =>
            state.outcome === "normal"
              ? bindTarget(expression.left, value ?? { source: expression.right }, state).map((bound) => ({ state: bound, value }))
              : [{ state, value }],
          );
          return [...abrupt, ...(logical ? normalStates.map((state) => ({ state, value: { source: expression.left } })) : []), ...assigned];
        }
        if (
          operator === ts.SyntaxKind.AmpersandAmpersandToken ||
          operator === ts.SyntaxKind.BarBarToken ||
          operator === ts.SyntaxKind.QuestionQuestionToken
        ) {
          const left = evaluateExpression(expression.left, normalStates, mayThrow);
          const right = left.flatMap(({ state }) => evaluateExpression(expression.right, [{ ...state }], mayThrow));
          return [...abrupt, ...left, ...right];
        }
        const left = evaluateExpression(expression.left, normalStates, mayThrow);
        const right = left.flatMap(({ state }) => evaluateExpression(expression.right, [state], mayThrow));
        return [...abrupt, ...right.map(({ state }) => ({ state, value: { source: expression } }))];
      }
      if (ts.isCallExpression(expression) || ts.isNewExpression(expression)) {
        let evaluated = evaluateExpression(expression.expression, normalStates, mayThrow);
        for (const argument of expression.arguments ?? []) {
          evaluated = evaluated.flatMap(({ state }) =>
            evaluateExpression(ts.isSpreadElement(argument) ? argument.expression : argument, [state], mayThrow),
          );
        }
        const completed = evaluated.map(({ state }) => ({ state, value: { source: expression } as Binding }));
        if (mayThrow) {
          completed.push(...evaluated.filter(({ state }) => state.outcome === "normal").map(({ state }) => ({
            state: { ...state, outcome: "throw" as const },
            value: undefined,
          })));
        }
        return [...abrupt, ...completed];
      }
      if (ts.isPropertyAccessExpression(expression)) {
        return [...abrupt, ...evaluateExpression(expression.expression, normalStates, mayThrow).map(({ state }) => ({
          state,
          value: { source: expression },
        }))];
      }
      if (ts.isElementAccessExpression(expression)) {
        let evaluated = evaluateExpression(expression.expression, normalStates, mayThrow);
        if (expression.argumentExpression) {
          evaluated = evaluated.flatMap(({ state }) => evaluateExpression(expression.argumentExpression!, [state], mayThrow));
        }
        return [...abrupt, ...evaluated.map(({ state }) => ({
          state,
          value: { source: expression, ...(this.staticKey(expression.argumentExpression, true) === undefined ? { unsupported: true } : {}) },
        }))];
      }
      if (ts.isArrayLiteralExpression(expression)) {
        let evaluated: AliasEvaluation[] = normalStates.map((state) => ({ state, value: { source: expression } }));
        for (const element of expression.elements) {
          if (ts.isOmittedExpression(element)) continue;
          evaluated = evaluated.flatMap(({ state }) =>
            evaluateExpression(ts.isSpreadElement(element) ? element.expression : element, [state], mayThrow)
              .map((result) => ({ state: result.state, value: { source: expression } })),
          );
        }
        return [...abrupt, ...evaluated];
      }
      if (ts.isObjectLiteralExpression(expression)) {
        let evaluated: AliasEvaluation[] = normalStates.map((state) => ({ state, value: { source: expression } }));
        for (const property of expression.properties) {
          const children: ts.Expression[] = [];
          if ("name" in property && ts.isComputedPropertyName(property.name)) children.push(property.name.expression);
          if (ts.isPropertyAssignment(property)) children.push(property.initializer);
          else if (ts.isSpreadAssignment(property)) children.push(property.expression);
          evaluated = children.reduce(
            (current, child) => current.flatMap(({ state }) => evaluateExpression(child, [state], mayThrow)
              .map((result) => ({ state: result.state, value: { source: expression } }))),
            evaluated,
          );
        }
        return [...abrupt, ...evaluated];
      }
      if (ts.isTemplateExpression(expression)) {
        let evaluated: AliasEvaluation[] = normalStates.map((state) => ({ state, value: { source: expression } }));
        for (const span of expression.templateSpans) {
          evaluated = evaluated.flatMap(({ state }) => evaluateExpression(span.expression, [state], mayThrow)
            .map((result) => ({ state: result.state, value: { source: expression } })));
        }
        return [...abrupt, ...evaluated];
      }
      if (ts.isPrefixUnaryExpression(expression) || ts.isPostfixUnaryExpression(expression) || ts.isAwaitExpression(expression)) {
        const operand = ts.isAwaitExpression(expression) ? expression.expression : expression.operand;
        return [...abrupt, ...evaluateExpression(operand, normalStates, mayThrow).map(({ state }) => ({
          state,
          value: { source: expression },
        }))];
      }
      return [...abrupt, ...normalStates.map((state) => ({ state, value: { source: expression } }))];
    };
    const evaluateStatements = (
      statements: readonly ts.Statement[],
      initial: AliasState[],
      mayThrow = false,
    ): AliasState[] => {
      let states = initial;
      for (const statement of statements) {
        states = transferStatement(statement, states, mayThrow);
        states = uniqueStates(states);
      }
      return states;
    };
    const transferStatement = (statement: ts.Statement, states: AliasState[], mayThrow = false): AliasState[] => {
      const normal = states.filter((state) => state.outcome === "normal");
      const abrupt = states.filter((state) => state.outcome !== "normal");
      if (!normal.length) return states;
      if (ts.isBlock(statement)) return [...abrupt, ...evaluateStatements(statement.statements, normal, mayThrow)];
      if (ts.isExpressionStatement(statement)) {
        return [...abrupt, ...evaluateExpression(statement.expression, normal, mayThrow).map(({ state }) => state)];
      }
      if (ts.isVariableStatement(statement)) {
        let current = normal;
        for (const declaration of statement.declarationList.declarations) {
          const evaluated = declaration.initializer
            ? evaluateExpression(declaration.initializer, current, mayThrow)
            : current.map((state) => ({ state, value: undefined }));
          current = evaluated.flatMap(({ state, value }) =>
            state.outcome === "normal" ? bindName(declaration.name, value, state) : [state],
          );
        }
        return [...abrupt, ...current];
      }
      if (ts.isIfStatement(statement)) {
        const conditions = evaluateExpression(statement.expression, normal, mayThrow);
        const condition = staticBoolean(statement.expression);
        const branches = conditions.flatMap(({ state }) => {
          if (state.outcome !== "normal") return [state];
          if (condition === true) return transferStatement(statement.thenStatement, [state], mayThrow);
          if (condition === false) return statement.elseStatement
            ? transferStatement(statement.elseStatement, [state], mayThrow)
            : [state];
          return [
            ...transferStatement(statement.thenStatement, [{ ...state }], mayThrow),
            ...(statement.elseStatement ? transferStatement(statement.elseStatement, [{ ...state }], mayThrow) : [{ ...state }]),
          ];
        });
        return [...abrupt, ...branches];
      }
      if (ts.isSwitchStatement(statement)) {
        const discriminants = evaluateExpression(statement.expression, normal, mayThrow);
        const clauses = statement.caseBlock.clauses;
        const runFrom = (start: number, entry: AliasState): AliasState[] => {
          let current = [entry];
          for (let index = start; index < clauses.length; index += 1) {
            current = evaluateStatements(clauses[index]!.statements, current, mayThrow);
            const breaks = current.filter((candidate) => candidate.outcome === "break").map((candidate) => ({
              ...candidate,
              outcome: "normal" as const,
            }));
            const continuing = current.filter((candidate) => candidate.outcome === "normal");
            const other = current.filter((candidate) => candidate.outcome !== "normal" && candidate.outcome !== "break");
            if (breaks.length || other.length) {
              const rest = continuing.length && index + 1 < clauses.length
                ? continuing.flatMap((candidate) => runFrom(index + 1, candidate))
                : continuing;
              return [...breaks, ...other, ...rest];
            }
            if (!continuing.length) return current;
          }
          return current;
        };
        const alternatives = discriminants.flatMap(({ state }) => {
          if (state.outcome !== "normal") return [state];
          let labelStates = [state];
          const starts: Array<{ index: number; state: AliasState }> = [];
          for (let index = 0; index < clauses.length; index += 1) {
            const clause = clauses[index]!;
            if (ts.isCaseClause(clause)) {
              labelStates = evaluateExpression(clause.expression, labelStates, mayThrow).map(({ state: candidate }) => candidate);
              starts.push(...labelStates.filter((candidate) => candidate.outcome === "normal").map((candidate) => ({ index, state: { ...candidate } })));
            }
          }
          const fallback = clauses.findIndex(ts.isDefaultClause);
          if (fallback >= 0) starts.push(...labelStates.map((candidate) => ({ index: fallback, state: { ...candidate } })));
          else starts.push(...labelStates.map((candidate) => ({ index: -1, state: candidate })));
          return starts.flatMap((start) => start.index < 0 ? [start.state] : runFrom(start.index, start.state));
        });
        return [...abrupt, ...alternatives];
      }
      if (ts.isTryStatement(statement)) {
        const tried = transferStatement(statement.tryBlock, normal, true);
        let completed = tried.filter((candidate) => candidate.outcome !== "throw");
        if (statement.catchClause) {
          const caught = [
            ...normal.map((candidate) => ({ ...candidate })),
            ...tried.filter((candidate) => candidate.outcome === "throw").map((candidate) => ({
              ...candidate,
              outcome: "normal" as const,
            })),
          ];
          completed.push(...transferStatement(statement.catchClause.block, uniqueStates(caught), mayThrow));
        } else completed.push(...tried.filter((candidate) => candidate.outcome === "throw"));
        if (statement.finallyBlock) {
          completed = completed.flatMap((candidate) => {
            const prior = candidate.outcome;
            return transferStatement(statement.finallyBlock!, [{ ...candidate, outcome: "normal" }], mayThrow).map((finished) =>
              finished.outcome === "normal" ? { ...finished, outcome: prior } : finished,
            );
          });
        }
        return [...abrupt, ...completed];
      }
      if (ts.isWhileStatement(statement) || ts.isDoStatement(statement) || ts.isForStatement(statement)) {
        let entered = normal;
        if (ts.isForStatement(statement) && statement.initializer) {
          entered = ts.isVariableDeclarationList(statement.initializer)
            ? transferStatement(ts.factory.createVariableStatement(undefined, statement.initializer), entered, mayThrow)
            : evaluateExpression(statement.initializer, entered, mayThrow).map(({ state }) => state);
        }
        const condition = ts.isForStatement(statement) ? statement.condition : statement.expression;
        const staticCondition = condition ? staticBoolean(condition) : true;
        const exits = staticCondition === true || ts.isDoStatement(statement) ? [] : entered.map((candidate) => ({ ...candidate }));
        let frontier = entered.map((candidate) => ({ ...candidate }));
        for (let iteration = 0; iteration < 8 && frontier.length; iteration += 1) {
          const checked = condition && !ts.isDoStatement(statement)
            ? evaluateExpression(condition, frontier, mayThrow).map(({ state }) => state)
            : frontier;
          const body = transferStatement(statement.statement, checked, mayThrow);
          exits.push(...body.filter((candidate) => candidate.outcome === "break").map((candidate) => ({ ...candidate, outcome: "normal" as const })));
          exits.push(...body.filter((candidate) => candidate.outcome === "return" || candidate.outcome === "throw"));
          let next = body.filter((candidate) => candidate.outcome === "normal" || candidate.outcome === "continue")
            .map((candidate) => ({ ...candidate, outcome: "normal" as const }));
          if (ts.isForStatement(statement) && statement.incrementor) {
            next = evaluateExpression(statement.incrementor, next, mayThrow).map(({ state }) => state);
          }
          if (condition && ts.isDoStatement(statement)) {
            next = evaluateExpression(condition, next, mayThrow).map(({ state }) => state);
          }
          if (staticCondition !== true) exits.push(...next.map((candidate) => ({ ...candidate })));
          const widened = uniqueStates(next);
          if (widened.every((candidate) => frontier.some((prior) =>
            prior.outcome === candidate.outcome && bindingKey(prior.binding) === bindingKey(candidate.binding),
          ))) break;
          frontier = widened;
        }
        return [...abrupt, ...uniqueStates(exits.length ? exits : frontier)];
      }
      if (ts.isForOfStatement(statement) || ts.isForInStatement(statement)) {
        const iterables = evaluateExpression(statement.expression, normal, mayThrow);
        const expression = unwrapExpression(statement.expression);
        const elements = ts.isForOfStatement(statement) && ts.isArrayLiteralExpression(expression)
          ? expression.elements.filter((element): element is ts.Expression => !ts.isOmittedExpression(element))
          : [];
        const definitelyNonempty = elements.length > 0;
        const exits: AliasState[] = definitelyNonempty ? [] : iterables.map(({ state }) => ({ ...state }));
        let frontier = iterables.map(({ state }) => state);
        const values = elements.length ? elements : [undefined];
        for (const element of values) {
          const next: AliasState[] = [];
          for (const candidate of frontier) {
            const value = element
              ? evaluateExpression(ts.isSpreadElement(element) ? element.expression : element, [candidate], mayThrow)[0]?.value
              : { source: statement.expression, unsupported: true };
            let bound: AliasState[];
            if (ts.isVariableDeclarationList(statement.initializer)) {
              bound = [candidate];
              for (const declaration of statement.initializer.declarations) {
                bound = bound.flatMap((state) => bindName(declaration.name, value, state));
              }
            } else bound = bindTarget(statement.initializer, value, candidate);
            const body = transferStatement(statement.statement, bound, mayThrow);
            exits.push(...body.filter((state) => state.outcome === "break").map((state) => ({ ...state, outcome: "normal" as const })));
            exits.push(...body.filter((state) => state.outcome === "return" || state.outcome === "throw"));
            next.push(...body.filter((state) => state.outcome === "normal" || state.outcome === "continue")
              .map((state) => ({ ...state, outcome: "normal" as const })));
          }
          frontier = uniqueStates(next);
        }
        return [...abrupt, ...uniqueStates([...exits, ...frontier])];
      }
      if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
        const expression = statement.expression;
        const evaluated = expression ? evaluateExpression(expression, normal, mayThrow).map(({ state }) => state) : normal;
        const outcome = ts.isReturnStatement(statement) ? "return" : "throw";
        return [...abrupt, ...evaluated.map((state) => ({ ...state, outcome }))];
      }
      if (ts.isBreakStatement(statement) || ts.isContinueStatement(statement)) {
        const outcome = ts.isBreakStatement(statement) ? "break" : "continue";
        return [...abrupt, ...normal.map((state) => ({ ...state, outcome }))];
      }
      return states;
    };
    const scanContaining = (node: ts.Node, states: AliasState[]): AliasState[] => {
      if (ts.isSourceFile(node) || ts.isBlock(node)) {
        const statements = node.statements;
        let current = states;
        for (const statement of statements) {
          if (statement.end <= identifier.pos) current = transferStatement(statement, current);
          else if (statement.pos <= identifier.pos && identifier.pos < statement.end) return scanContaining(statement, current);
          else break;
        }
        return current;
      }
      if (ts.isFunctionLike(node) && node.body && node.pos <= identifier.pos && identifier.pos < node.end) {
        return scanContaining(node.body, states);
      }
      let current = states;
      const children: ts.Node[] = [];
      ts.forEachChild(node, (child) => { children.push(child); });
      for (const child of children) {
        if (child.end <= identifier.pos && ts.isExpression(child)) {
          current = evaluateExpression(child, current).map(({ state }) => state);
        } else if (child.pos <= identifier.pos && identifier.pos < child.end) {
          return scanContaining(child, current);
        }
      }
      return current;
    };
    const finished = scanContaining(this.sourceFile, [{ binding: undefined, outcome: "normal" }]);
    return uniqueBindings(finished.filter((state) => state.outcome === "normal").map((state) => state.binding));
  }

  frameworkTags(input: ts.Expression, checking = new Set<ts.Symbol>()): Set<FrameworkTag> {
    const expression = unwrapExpression(input);
    if (ts.isIdentifier(expression)) {
      const symbol = this.symbol(expression);
      const imported = this.importName(symbol);
      if (imported?.module === "vitest") {
        if (["vi", "vitest"].includes(imported.imported)) return new Set([imported.imported as FrameworkTag]);
        if (["it", "test", "describe"].includes(imported.imported)) return new Set();
      }
      if (!symbol && (expression.text === "vi" || expression.text === "jest")) {
        return new Set([expression.text as FrameworkTag]);
      }
      if (!symbol || checking.has(symbol)) return new Set();
      const bindings = this.bindingSources(expression);
      if (!bindings.length) return new Set();
      checking.add(symbol);
      const tags = new Set<FrameworkTag>();
      for (const binding of bindings) {
        if (!binding) continue;
        let resolved = binding.unsupported
          ? new Set<FrameworkTag>(["unknown"])
          : this.frameworkTags(binding.source, checking);
        for (const property of binding.path ?? []) resolved = this.frameworkMemberTags(resolved, property);
        for (const tag of resolved) tags.add(tag);
      }
      checking.delete(symbol);
      return tags;
    }
    if (ts.isPropertyAccessExpression(expression)) {
      return this.frameworkMemberTags(this.frameworkTags(expression.expression, checking), expression.name.text);
    }
    if (ts.isElementAccessExpression(expression) && expression.argumentExpression) {
      const key = unwrapExpression(expression.argumentExpression);
      if (!ts.isStringLiteralLike(key)) {
        const base = this.frameworkTags(expression.expression, checking);
        return base.has("vi") || base.has("vitest") || base.has("jest") || base.has("unknown")
          ? new Set(["unknown"])
          : new Set();
      }
      return ts.isStringLiteralLike(key)
        ? this.frameworkMemberTags(this.frameworkTags(expression.expression, checking), key.text)
        : new Set();
    }
    if (ts.isConditionalExpression(expression)) {
      return new Set([
        ...this.frameworkTags(expression.whenTrue, checking),
        ...this.frameworkTags(expression.whenFalse, checking),
      ]);
    }
    return new Set();
  }

  private frameworkMemberTags(base: ReadonlySet<FrameworkTag>, member: string): Set<FrameworkTag> {
    if (base.has("unknown")) return new Set(["unknown"]);
    if (member === "replaceProperty") {
      if (base.has("jest")) return new Set(["replaceProperty"]);
      return new Set();
    }
    if ((base.has("vi") || base.has("vitest") || base.has("jest")) && ["mock", "doMock", "mocked", "spyOn"].includes(member)) {
      return new Set([member as FrameworkTag]);
    }
    return new Set();
  }

  moduleMockKind(call: ts.CallExpression): "mock" | "doMock" | "unknown" | undefined {
    const tags = this.frameworkTags(call.expression);
    return tags.has("mock") ? "mock" : tags.has("doMock") ? "doMock" : tags.has("unknown") ? "unknown" : undefined;
  }

  private importedRegistration(identifier: ts.Identifier): RegistrationValue[] {
    const imported = this.importName(this.symbol(identifier));
    if (imported?.module !== "vitest") return [];
    if (imported.imported === "describe") return [{ kind: "suite", state: "enabled" }];
    if (imported.imported === "it" || imported.imported === "test") return [{ kind: "test", state: "enabled" }];
    if (imported.imported === "vitest") return [];
    return [];
  }

  registrationValues(input: ts.Expression, checking = new Set<ts.Symbol>()): RegistrationValue[] {
    const expression = unwrapExpression(input);
    if (ts.isIdentifier(expression)) {
      const imported = this.importedRegistration(expression);
      if (imported.length) return imported;
      const symbol = this.symbol(expression);
      if (!symbol && expression.text === "describe") return [{ kind: "suite", state: "enabled" }];
      if (!symbol && (expression.text === "it" || expression.text === "test")) {
        return [{ kind: "test", state: "enabled" }];
      }
      if (!symbol || checking.has(symbol)) return [];
      const bindings = this.bindingSources(expression);
      if (!bindings.length) return [];
      checking.add(symbol);
      const alternatives: RegistrationValue[] = [];
      let unresolved = false;
      for (const binding of bindings) {
        if (!binding) {
          unresolved = true;
          continue;
        }
        if (binding.unsupported) {
          unresolved = true;
          continue;
        }
        let resolved = this.registrationValues(binding.source, checking);
        for (const property of binding.path ?? []) {
          const frameworkProperty = this.frameworkTags(binding.source, checking).has("vitest");
          if (frameworkProperty && property === "describe") resolved = [{ kind: "suite", state: "enabled" }];
          else if (frameworkProperty && ["it", "test"].includes(property)) resolved = [{ kind: "test", state: "enabled" }];
          else resolved = this.registrationMember(resolved, property);
        }
        if (!resolved.length) {
          unresolved = true;
          continue;
        }
        alternatives.push(...resolved);
      }
      checking.delete(symbol);
      if (unresolved && alternatives.length) {
        for (const kind of new Set(alternatives.map((value) => value.kind))) {
          alternatives.push({ kind, state: "unknown" });
        }
      }
      return alternatives;
    }
    if (ts.isPropertyAccessExpression(expression)) {
      const baseTags = this.frameworkTags(expression.expression, checking);
      if (baseTags.has("vitest") && expression.name.text === "describe") return [{ kind: "suite", state: "enabled" }];
      if (baseTags.has("vitest") && ["it", "test"].includes(expression.name.text)) return [{ kind: "test", state: "enabled" }];
      return this.registrationMember(this.registrationValues(expression.expression, checking), expression.name.text);
    }
    if (ts.isElementAccessExpression(expression) && expression.argumentExpression) {
      const key = unwrapExpression(expression.argumentExpression);
      if (!ts.isStringLiteralLike(key)) return [];
      const baseTags = this.frameworkTags(expression.expression, checking);
      if (baseTags.has("vitest") && key.text === "describe") return [{ kind: "suite", state: "enabled" }];
      if (baseTags.has("vitest") && ["it", "test"].includes(key.text)) return [{ kind: "test", state: "enabled" }];
      return this.registrationMember(this.registrationValues(expression.expression, checking), key.text);
    }
    if (ts.isConditionalExpression(expression)) {
      const whenTrue = this.registrationValues(expression.whenTrue, checking);
      const whenFalse = this.registrationValues(expression.whenFalse, checking);
      if (whenTrue.length && whenFalse.length) return [...whenTrue, ...whenFalse];
      const known = whenTrue.length ? whenTrue : whenFalse;
      return known.map((value) => ({ kind: value.kind, state: "unknown" }));
    }
    if (ts.isCallExpression(expression)) {
      const values = this.registrationValues(expression.expression, checking);
      return values.map((value) => this.applyRegistrationCall(value, expression.arguments[0]));
    }
    return [];
  }

  private registrationMember(values: RegistrationValue[], member: string): RegistrationValue[] {
    return values.map((value) => {
      if (["skip", "todo", "fixme", "fails"].includes(member)) return { ...value, state: "disabled" };
      if (["concurrent", "sequential", "only"].includes(member)) return value;
      if (["skipIf", "runIf", "each", "for"].includes(member)) {
        return { ...value, pending: member as RegistrationValue["pending"] };
      }
      return { ...value, state: "unknown" };
    });
  }

  private applyRegistrationCall(value: RegistrationValue, argument: ts.Expression | undefined): RegistrationValue {
    if (!value.pending) return value;
    if (value.pending === "skipIf") {
      const condition = staticBoolean(argument);
      return {
        kind: value.kind,
        state:
          condition === false || this.requiredRunGuardRejects(argument)
            ? value.state
            : "disabled",
      };
    }
    if (value.pending === "runIf") {
      const condition = staticBoolean(argument);
      return { kind: value.kind, state: condition === true ? value.state : "disabled" };
    }
    const rows = argument && unwrapExpression(argument);
    const nonempty = !!rows && ts.isArrayLiteralExpression(rows) && rows.elements.length > 0 && !rows.elements.some(ts.isSpreadElement);
    return { kind: value.kind, state: nonempty ? value.state : "disabled" };
  }

  private requiredRunGuardRejects(condition: ts.Expression | undefined): boolean {
    if (!condition) return false;
    const conditionText = unwrapExpression(condition).getText(this.sourceFile).replace(/\s+/g, "");
    return this.sourceFile.statements.some((statement) => {
      if (!ts.isIfStatement(statement) || statement.pos >= condition.pos) return false;
      const guard = unwrapExpression(statement.expression);
      if (!ts.isBinaryExpression(guard) || guard.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) {
        return false;
      }
      const required = unwrapExpression(guard.left).getText(this.sourceFile).replace(/\s+/g, "");
      const rejected = unwrapExpression(guard.right).getText(this.sourceFile).replace(/\s+/g, "");
      if (!/^process\.env\.[A-Z0-9_]+_REQUIRED===["']true["']$/.test(required) || rejected !== conditionText) {
        return false;
      }
      const body = ts.isBlock(statement.thenStatement)
        ? statement.thenStatement.statements
        : [statement.thenStatement];
      return body.some(ts.isThrowStatement);
    });
  }

  private registrationOptionsEnabled(call: ts.CallExpression): boolean {
    const options = call.arguments[1];
    if (!options || !ts.isObjectLiteralExpression(unwrapExpression(options))) return true;
    const object = unwrapExpression(options) as ts.ObjectLiteralExpression;
    for (const property of object.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const name = ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) ? property.name.text : undefined;
      if (!name || !["skip", "todo", "fails"].includes(name)) continue;
      if (staticBoolean(property.initializer) !== false) return false;
    }
    return true;
  }

  registration(call: ts.CallExpression): { kind: RegistrationKind; state: RegistrationState } | undefined {
    const values = this.registrationValues(call.expression);
    if (!values.length) return undefined;
    const kinds = new Set(values.map((value) => value.kind));
    if (kinds.size !== 1) return undefined;
    const states = values.map((value) =>
      value.pending || !this.registrationOptionsEnabled(call) ? "disabled" : value.state,
    );
    return {
      kind: values[0]!.kind,
      state: states.every((state) => state === "enabled")
        ? "enabled"
        : states.every((state) => state === "disabled")
          ? "disabled"
          : "unknown",
    };
  }
}

interface RunnableTest {
  fullName: string;
  call: ts.CallExpression;
  state: RegistrationState;
}

function runnableTests(sf: ts.SourceFile): RunnableTest[] {
  const tests: RunnableTest[] = [];
  const describeStack: string[] = [];
  const describeStates: RegistrationState[] = [];
  const engine = new LocalFlowEngine(sf);
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const registration = engine.registration(node);
      if (registration?.state === "disabled") return;
      const titleArg = node.arguments[0];
      const title = titleArg && ts.isStringLiteralLike(titleArg) ? titleArg.text : "";
      if (registration?.kind === "suite") {
        describeStack.push(title);
        describeStates.push(registration.state);
        ts.forEachChild(node, visit);
        describeStack.pop();
        describeStates.pop();
        return;
      }
      if (registration?.kind === "test") {
        tests.push({
          fullName: [...describeStack, title].filter(Boolean).join(" "),
          call: node,
          state:
            registration.state === "unknown" || describeStates.includes("unknown")
              ? "unknown"
              : "enabled",
        });
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return tests;
}

function witnessBinding(sf: ts.SourceFile, targetPath: string): string | undefined {
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith(".")) continue;
    const resolved = path.posix
      .normalize(path.posix.join(path.posix.dirname(targetPath), specifier))
      .replace(/\.[cm]?[jt]sx?$/, "");
    if (resolved !== ISOLATION_WITNESS_PATH) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const imported = bindings.elements.find(
      (element) => (element.propertyName?.text ?? element.name.text) === "assertIsolationQuery",
    );
    if (imported) return imported.name.text;
  }
  return undefined;
}

function propertyInitializer(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  const property = object.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) &&
      ((ts.isIdentifier(candidate.name) || ts.isStringLiteralLike(candidate.name)) && candidate.name.text === name),
  );
  return property?.initializer;
}

function isolationWitnessError(
  testCall: ts.CallExpression,
  sf: ts.SourceFile,
  targetPath: string,
  expectedResources: string[],
  proof: TestFlowProof,
): string | undefined {
  const statementAlwaysExits = (statement: ts.Statement): boolean => {
    if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return true;
    if (ts.isBlock(statement)) return statement.statements.some(statementAlwaysExits);
    if (ts.isIfStatement(statement)) {
      const condition = staticBoolean(statement.expression);
      if (condition === true) return statementAlwaysExits(statement.thenStatement);
      if (condition === false && statement.elseStatement) return statementAlwaysExits(statement.elseStatement);
      if (statement.elseStatement) {
        return statementAlwaysExits(statement.thenStatement) && statementAlwaysExits(statement.elseStatement);
      }
    }
    return false;
  };
  const callback = testCall.arguments.find(
    (arg): arg is ts.ArrowFunction | ts.FunctionExpression => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg),
  );
  if (!callback) return "coverage test has no runnable callback";
  const binding = witnessBinding(sf, targetPath);
  if (!binding) return "coverage test does not import the canonical assertIsolationQuery witness";

  const witnesses: ts.CallExpression[] = proof.witnessCall ? [proof.witnessCall] : [];
  const visit = (node: ts.Node) => {
    if (node !== callback && ts.isFunctionLike(node)) return;
    if (
      witnesses.length === 0 &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === binding
    ) {
      witnesses.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(callback);
  if (witnesses.length !== 1) return `coverage test must execute exactly one canonical isolation witness (found ${witnesses.length})`;

  const witness = witnesses[0]!;
  const bindingNameContains = (name: ts.BindingName): boolean => {
    if (ts.isIdentifier(name)) return name.text === binding;
    return name.elements.some((element) => !ts.isOmittedExpression(element) && bindingNameContains(element.name));
  };
  const statementDeclaresBinding = (statement: ts.Statement): boolean => {
    if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)
    ) {
      return statement.name?.text === binding;
    }
    return (
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some((declaration) => bindingNameContains(declaration.name))
    );
  };
  const functionHasHoistedVar = (fn: ts.FunctionLikeDeclaration): boolean => {
    if (!fn.body) return false;
    let found = false;
    const visit = (node: ts.Node) => {
      if (found) return;
      if (
        node !== fn.body &&
        (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node))
      ) {
        return;
      }
      if (
        ts.isVariableDeclarationList(node) &&
        !(node.flags & ts.NodeFlags.BlockScoped) &&
        node.declarations.some((declaration) => bindingNameContains(declaration.name))
      ) {
        found = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(fn.body);
    return found;
  };
  let scope: ts.Node | undefined = witness.parent;
  while (scope && !ts.isSourceFile(scope)) {
    if (ts.isFunctionLike(scope)) {
      if (
        scope.parameters.some((parameter) => bindingNameContains(parameter.name)) ||
        functionHasHoistedVar(scope)
      ) {
        return "coverage test shadows the imported canonical isolation witness";
      }
    }
    if (
      ((ts.isFunctionExpression(scope) && scope.name?.text === binding) ||
        (ts.isClassExpression(scope) && scope.name?.text === binding))
    ) {
      return "coverage test shadows the imported canonical isolation witness";
    }
    if (ts.isBlock(scope) && scope.statements.some(statementDeclaresBinding)) {
      return "coverage test shadows the imported canonical isolation witness";
    }
    if (
      (ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) &&
      scope.initializer &&
      ts.isVariableDeclarationList(scope.initializer) &&
      scope.initializer.declarations.some((declaration) => bindingNameContains(declaration.name))
    ) {
      return "coverage test shadows the imported canonical isolation witness";
    }
    if (
      ts.isCaseBlock(scope) &&
      scope.clauses.some((clause) => clause.statements.some(statementDeclaresBinding))
    ) {
      return "coverage test shadows the imported canonical isolation witness";
    }
    if (ts.isCatchClause(scope) && scope.variableDeclaration && bindingNameContains(scope.variableDeclaration.name)) {
      return "coverage test shadows the imported canonical isolation witness";
    }
    scope = scope.parent;
  }
  let executionNode: ts.Node = witness;
  let awaited = false;
  while (executionNode.parent && executionNode.parent !== callback.body) {
    const parent = executionNode.parent;
    if (ts.isAwaitExpression(parent)) awaited = true;
    if (
      ts.isAwaitExpression(parent) ||
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isNonNullExpression(parent)
    ) {
      executionNode = parent;
      continue;
    }
    if (ts.isExpressionStatement(parent) && parent.parent === callback.body) {
      executionNode = parent;
      break;
    }
    return "coverage test must await its isolation witness as an unconditional top-level statement";
  }
  if (!awaited) return "coverage test does not await its isolation witness";
  if (!ts.isExpressionStatement(executionNode) || !ts.isBlock(callback.body)) {
    return "coverage test must await its isolation witness as an unconditional top-level statement";
  }
  const witnessIndex = callback.body.statements.indexOf(executionNode);
  if (
    witnessIndex < 0 ||
    callback.body.statements.slice(0, witnessIndex).some(statementAlwaysExits) ||
    proof.normalPathWithoutWitness
  ) {
    return "coverage test isolation witness is unreachable after an earlier return or throw";
  }
  const options = witness.arguments[0];
  if (!options || !ts.isObjectLiteralExpression(options)) return "isolation witness options must be an object literal";
  const query = propertyInitializer(options, "query");
  const allowedIds = propertyInitializer(options, "allowedIds");
  const deniedIds = propertyInitializer(options, "deniedIds");
  if (!query || (!ts.isArrowFunction(query) && !ts.isFunctionExpression(query))) {
    return "isolation witness query must be an inline function";
  }
  if (query.parameters.length !== 0) {
    return "isolation witness query must be a zero-argument inline function";
  }
  if (!allowedIds || !ts.isArrayLiteralExpression(allowedIds)) {
    return "isolation witness allowedIds must be an array literal";
  }
  if (!deniedIds || !ts.isArrayLiteralExpression(deniedIds) || deniedIds.elements.length === 0) {
    return "isolation witness deniedIds must be a non-empty array literal";
  }

  if (proof.mutationEvidenceInvalid) {
    return "mutation witness must prove authorized and denied attempted effects";
  }
  if (proof.mutationEvidence) {
    const literalIds = (array: ts.ArrayLiteralExpression): string[] | undefined => {
      const ids = array.elements.map((element) => {
        if (ts.isSpreadElement(element)) return undefined;
        const value = unwrapExpression(element);
        return ts.isStringLiteralLike(value) ? value.text : undefined;
      });
      return ids.every((id): id is string => id !== undefined) ? ids : undefined;
    };
    const allowed = literalIds(allowedIds);
    const denied = literalIds(deniedIds);
    if (!allowed?.length || !denied?.length) {
      return "mutation witness allowedIds and deniedIds must be non-empty string literals";
    }
    const allowedSet = new Set(allowed);
    const deniedSet = new Set(denied);
    if (
      allowedSet.size !== allowed.length ||
      deniedSet.size !== denied.length ||
      [...allowedSet].some((id) => deniedSet.has(id))
    ) {
      return "mutation witness allowedIds and deniedIds must be unique and disjoint";
    }
    const sameIds = (actual: readonly string[], expected: ReadonlySet<string>) =>
      actual.length === expected.size && actual.every((id) => expected.has(id));
    if (proof.mutationEvidence.mode === "combined") {
      const expected = new Set([...allowedSet, ...deniedSet]);
      if (!sameIds(proof.mutationEvidence.allowedAttemptIds, expected)) {
        return "mutation witness attempted IDs must exactly match allowedIds and deniedIds";
      }
    } else if (
      !sameIds(proof.mutationEvidence.allowedAttemptIds, allowedSet) ||
      !sameIds(proof.mutationEvidence.deniedAttemptIds, deniedSet)
    ) {
      return "mutation witness split attempts must exactly match allowedIds and deniedIds";
    }
  }

  if (proof.unsupported) return "coverage test uses unsupported relevant flow or effect syntax";
  const actualResources = proof.queryResources;
  if (actualResources.join(",") !== expectedResources.join(",")) {
    return `isolation witness resource mismatch (declared ${expectedResources.join(",")}; queried ${actualResources.join(",") || "none"})`;
  }
  return undefined;
}

interface CoveragePointer {
  file: string;
  testName: string;
  resources: string[];
  parseError?: string;
}

function coveragePointer(node: ts.CallExpression, sf: ts.SourceFile): CoveragePointer | undefined {
  const trivia = sf.text.slice(node.getFullStart(), node.getStart(sf));
  const matches = [...trivia.matchAll(COVERAGE_POINTER)];
  const match = matches.at(-1);
  if (!match?.[0]) return undefined;
  if (matches.length !== 1) {
    return { file: "", testName: "", resources: [], parseError: "multiple @rls-covered-by annotations attach to one test" };
  }
  const parsed = COVERAGE_POINTER_FORMAT.exec(match[0].trim());
  if (!parsed?.[1] || !parsed[2] || !parsed[3]) {
    return { file: "", testName: "", resources: [], parseError: "annotation must use resources=<kind:schema.name,...> target=<file>#<exact full title>" };
  }
  const resources = parsed[1].split(",").sort();
  if (resources.some((resource) => !COVERAGE_RESOURCE.test(resource))) {
    return { file: "", testName: "", resources, parseError: `invalid coverage resource list: ${parsed[1]}` };
  }
  if (new Set(resources).size !== resources.length) {
    return { file: "", testName: "", resources, parseError: `duplicate coverage resource: ${parsed[1]}` };
  }
  return { file: path.posix.normalize(parsed[2]), testName: parsed[3].trim(), resources };
}

function coveragePointerError(pointer: CoveragePointer, byPath: ReadonlyMap<string, string>): string | undefined {
  if (pointer.parseError) return pointer.parseError;
  if (!INTEGRATION_TEST_PATH.test(pointer.file) || pointer.file.includes("..")) {
    return `coverage target must be an apps/*/test/integration/*.test.* path, got "${pointer.file}"`;
  }
  const target = byPath.get(pointer.file);
  if (target === undefined) return `coverage target does not exist: ${pointer.file}`;
  if (!/from\s+["'](?:@supabase\/supabase-js|postgres)["']/.test(target) || !/SUPABASE_[A-Z_]*(?:DB_)?URL/.test(target)) {
    return `coverage target is not a real-DB integration test: ${pointer.file}`;
  }
  const targetSf = parse(pointer.file, target);
  const targetEngine = new LocalFlowEngine(targetSf);
  const targetMocks = collectModuleMocks(targetSf);
  const mockedDb = targetMocks
    .filter(
      (mock) =>
        !mock.partial ||
        mock.replacesCreateClient ||
        (mock.specifier === "postgres" && mock.replacesDefault),
    )
    .map((mock) => dbClientMockDescription(mock, pointer.file, byPath))
    .find((description): description is string => description !== undefined);
  if (mockedDb) return `coverage target mocks ${mockedDb}: ${pointer.file}`;
  const mockedWitness = targetMocks.find((mock) => {
    if (mock.partial && !mock.replacesWitness) return false;
    if (!mock.specifier.startsWith(".")) return false;
    const resolved = path.posix
      .normalize(path.posix.join(path.posix.dirname(pointer.file), mock.specifier))
      .replace(/\.[cm]?[jt]sx?$/, "");
    return resolved === ISOLATION_WITNESS_PATH;
  });
  if (mockedWitness) return `coverage target mocks the canonical isolation witness: ${pointer.file}`;
  const targetTests = runnableTests(targetSf).filter((test) => test.fullName === pointer.testName);
  if (targetTests.length === 0) {
    return `coverage test not found in ${pointer.file}: "${pointer.testName}"`;
  }
  if (targetTests.length > 1) {
    return `coverage test title is ambiguous in ${pointer.file}: "${pointer.testName}" (${targetTests.length} matches)`;
  }
  if (targetTests[0]!.state !== "enabled") {
    return `coverage test registration is not definitely enabled in ${pointer.file}: "${pointer.testName}"`;
  }
  const proof = targetEngine.testFlowProof(targetTests[0]!.call);
  if (proof.mockedReceiver) {
    return `coverage target mocks the ${proof.mockedReceiver} client receiver at instance level: ${pointer.file}`;
  }
  if (proof.mockedWitness) {
    return `coverage target mocks the canonical isolation witness: ${pointer.file}`;
  }
  const witnessError = isolationWitnessError(
    targetTests[0]!.call,
    targetSf,
    pointer.file,
    pointer.resources,
    proof,
  );
  if (witnessError) {
    return `${witnessError} in ${pointer.file}: "${pointer.testName}"`;
  }
  return undefined;
}

export function findMockedTenantTests(relPath: string, contents: string, byPath: ReadonlyMap<string, string>): MockedTenantTest[] {
  if (!/\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)__tests__\//.test(relPath)) return [];
  const sf = parse(relPath, contents);
  const dbMock = collectModuleMocks(sf)
    .filter(
      (mock) =>
        !mock.partial ||
        mock.replacesCreateClient ||
        (mock.specifier === "postgres" && mock.replacesDefault),
    )
    .map((m) => dbClientMockDescription(m, relPath, byPath))
    .find((d): d is string => d !== undefined);
  if (!dbMock) return [];

  const out: MockedTenantTest[] = [];
  const describeStack: string[] = [];
  const engine = new LocalFlowEngine(sf);
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const registration = engine.registration(node);
      if (registration?.state === "disabled") return;
      const titleArg = node.arguments[0];
      const title = titleArg && ts.isStringLiteralLike(titleArg) ? titleArg.text : "";
      if (registration?.kind === "suite") {
        describeStack.push(title);
        ts.forEachChild(node, visit);
        describeStack.pop();
        return;
      }
      if (registration?.kind === "test") {
        const fullName = [...describeStack, title].filter(Boolean).join(" ");
        if (TENANT_CLAIM.test(fullName)) {
          const pointer = coveragePointer(node, sf);
          const annotationError = pointer ? coveragePointerError(pointer, byPath) : undefined;
          if (pointer && annotationError === undefined) return;
          out.push({
            file: relPath,
            line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
            fullName,
            mockedModule: dbMock,
            ...(annotationError ? { annotationError } : {}),
          });
        }
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

// --- baseline plumbing (house FREEZE-EXISTING / BLOCK-NEW pattern) -----------

export function loadBaseline(file: string = BASELINE_FILE): Map<string, number> {
  const map = new Map<string, number>();
  let content: string;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return map;
    throw err;
  }
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const sp = line.indexOf(" ");
    const count = Number(line.slice(0, sp));
    const f = line.slice(sp + 1);
    if (Number.isFinite(count) && count > 0 && f) map.set(f, count);
  }
  return map;
}

export function walk(dir: string, swallowMissing = true): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // defaultDirs()/resolutionDirs() entries are optional (not every app has a
    // test dir); an explicit CLI dir argument is required input — fail loud on a
    // bad path (mirrors check-rls-policy-semantics.ts). Nested dirs discovered
    // by recursion always exist, so they keep the swallowing default.
    if ((err as NodeJS.ErrnoException).code === "ENOENT" && swallowMissing) return [];
    throw err;
  }
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".next") continue;
      out.push(...walk(full));
    } else if (/\.[cm]?[jt]sx?$/.test(e.name)) out.push(full);
  }
  return out;
}

function defaultDirs(): string[] {
  return fs
    .readdirSync(path.join(ROOT, "apps"), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(ROOT, "apps", e.name, "test"));
}

// The apps' src trees are loaded (never scanned for tests) so a mocked local
// wrapper module can be resolved and recognised as a Supabase-client wrapper.
function resolutionDirs(): string[] {
  return fs
    .readdirSync(path.join(ROOT, "apps"), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(ROOT, "apps", e.name, "src"));
}

function main(): void {
  const argDirs = process.argv.slice(2);
  const usingDefaults = argDirs.length === 0;
  const dirs = usingDefaults ? defaultDirs() : argDirs.map((d) => path.resolve(d));
  // With explicit CLI dirs, each must yield ≥1 file: a nonexistent path throws
  // in walk() (swallowMissing=false), an existing-but-empty path is caught here.
  // Otherwise a bad/empty explicit dir is silently dropped whenever a sibling
  // dir has files, masking a typo'd invocation (the usingDefaults gap this fixes).
  const perDir = dirs.map((dir) => ({ dir, files: walk(dir, usingDefaults) }));
  if (!usingDefaults) {
    const empty = perDir.filter((p) => p.files.length === 0);
    if (empty.length > 0) {
      console.error(
        "mocked-tenant-tests guard: explicit dir(s) yielded zero files — check paths:\n" +
          empty.map((e) => `  ${e.dir}`).join("\n"),
      );
      process.exit(1);
    }
  }
  const files = perDir.flatMap((p) => p.files);
  if (files.length === 0) {
    console.error("mocked-tenant-tests guard: no files found under scanned dirs — check paths.");
    process.exit(1);
  }
  // byPath spans the test set PLUS the apps' src trees so wrapper resolution
  // works; only files under the scanned test dirs are checked for findings.
  const byPath = new Map(files.map((abs) => [path.relative(ROOT, abs), fs.readFileSync(abs, "utf8")]));
  const testRels = new Set(byPath.keys());
  // Annotation targets may sit outside an explicitly scanned subtree. Load all
  // app tests for pointer resolution, but retain testRels as the only scan set.
  for (const abs of defaultDirs().flatMap((d) => walk(d))) {
    const rel = path.relative(ROOT, abs);
    if (!byPath.has(rel)) byPath.set(rel, fs.readFileSync(abs, "utf8"));
  }
  // Arrow (not bare `walk`): flatMap would pass the array index as walk's second
  // arg, forcing swallowMissing=0 and throwing on an app without a src/ tree.
  for (const abs of resolutionDirs().flatMap((d) => walk(d))) {
    const rel = path.relative(ROOT, abs);
    if (!byPath.has(rel)) byPath.set(rel, fs.readFileSync(abs, "utf8"));
  }

  const findings = [...testRels].flatMap((rel) => findMockedTenantTests(rel, byPath.get(rel)!, byPath));
  const annotationErrors = findings.filter((finding) => finding.annotationError !== undefined);
  if (annotationErrors.length > 0) {
    console.error("mocked-tenant-tests guard: invalid @rls-covered-by annotation(s):\n");
    for (const finding of annotationErrors) {
      console.error(`  ${finding.file}:${finding.line}  ${finding.annotationError}`);
    }
    process.exit(1);
  }
  const liveCounts = new Map<string, number>();
  for (const f of findings) liveCounts.set(f.file, (liveCounts.get(f.file) ?? 0) + 1);

  const baseline = loadBaseline();
  const fresh: { file: string; excess: number }[] = [];
  for (const [file, count] of liveCounts) {
    const based = baseline.get(file) ?? 0;
    if (count > based) fresh.push({ file, excess: count - based });
  }
  const stale = [...baseline].filter(([file, based]) => (liveCounts.get(file) ?? 0) < based);

  if (fresh.length > 0) {
    console.error(
      "mocked-tenant-tests guard: NEW tenant-isolation/RLS-claiming test(s) in a file that mocks" +
        " the Supabase client — the mock makes the claimed coverage structurally impossible." +
        " Run against a real local stack (two seeded tenants) or rename the claim:\n",
    );
    for (const f of findings) {
      if (fresh.some((e) => e.file === f.file)) console.error(`  ${f.file}:${f.line}  "${f.fullName}" (mocks ${f.mockedModule})`);
    }
    console.error(`\n${fresh.reduce((n, e) => n + e.excess, 0)} NEW finding(s) beyond scripts/mocked-tenant-tests-baseline.txt.`);
    process.exit(1);
  }
  const note = stale.length > 0 ? ` (${stale.length} stale baseline entr(y/ies) — trim them)` : "";
  console.log(`mocked-tenant-tests guard passed: ${findings.length} pre-existing test(s) baselined, 0 new${note}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
