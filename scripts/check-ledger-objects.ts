import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { redactSecrets } from "./lib/redact-secrets";

type Target = "main" | "rag";
type ObjectKind =
  | "table"
  | "materialized_view"
  | "view"
  | "index"
  | "function"
  | "type"
  | "column"
  | "constraint"
  | "trigger"
  | "enum_value";

export interface LedgerObject {
  kind: ObjectKind;
  schema: string;
  name: string;
  parent?: string;
  identityArgs?: string;
  migration: string;
}

interface CatalogObject {
  kind: ObjectKind;
  schema: string;
  name: string;
  parent?: string;
  identityArgs?: string;
}

interface LedgerState {
  expected: LedgerObject[];
  mentionedPublicTables: Set<string>;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALL_TARGETS: readonly Target[] = ["main", "rag"];
const IDENT = '(?:"[^"]+"|[a-zA-Z_][a-zA-Z0-9_$]*)';
const QUALIFIED = `(?:${IDENT}\\.)?${IDENT}`;

function unquote(value: string): string {
  return value.replace(/^"|"$/g, "").replace(/""/g, '"');
}

function qualifiedName(value: string): { schema: string; name: string } {
  const parts = value.split(".");
  return parts.length === 1
    ? { schema: "public", name: unquote(parts[0]) }
    : { schema: unquote(parts[0]), name: unquote(parts[1]) };
}

function key(object: Pick<CatalogObject, "kind" | "schema" | "name" | "parent" | "identityArgs">): string {
  return [object.kind, object.schema, object.parent ?? "", object.name, object.identityArgs ?? ""].join("\u0000");
}

const TYPE_STARTERS = new Set([
  "bigint", "bigserial", "bit", "boolean", "box", "bytea", "char", "character",
  "cidr", "circle", "date", "decimal", "double", "inet", "int", "int2", "int4",
  "int8", "integer", "interval", "json", "jsonb", "line", "lseg", "macaddr",
  "money", "numeric", "path", "point", "polygon", "real", "record", "serial",
  "serial2", "serial4", "serial8", "smallint", "smallserial", "text", "time",
  "timestamp", "timestamptz", "timetz", "tsquery", "tsvector", "uuid", "varbit",
  "varchar", "vector", "void", "xml",
]);

export function normalizeIdentityArguments(value: string): string {
  const argumentsList: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === quote && value[index + 1] === quote) index += 1;
      else if (char === quote) quote = null;
    } else if (char === "'" || char === '"') quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      argumentsList.push(value.slice(start, index));
      start = index + 1;
    }
  }
  argumentsList.push(value.slice(start));
  return argumentsList.map((rawArgument) => rawArgument.trim()).filter(Boolean).map((rawArgument) => {
    let argument = rawArgument;
    depth = 0;
    quote = null;
    for (let index = 0; index < argument.length; index += 1) {
      const char = argument[index];
      if (quote) {
        if (char === quote && argument[index + 1] === quote) index += 1;
        else if (char === quote) quote = null;
      } else if (char === "'" || char === '"') quote = char;
      else if (char === "(") depth += 1;
      else if (char === ")") depth -= 1;
      else if (depth === 0 && (char === "=" || /^default\b/i.test(argument.slice(index)))) {
        argument = argument.slice(0, index).trim();
        break;
      }
    }
    argument = argument.replace(/^(?:inout|in|out|variadic)\s+/i, "").trim();
    const firstSpace = argument.search(/\s/);
    if (firstSpace > 0) {
      const first = unquote(argument.slice(0, firstSpace)).toLowerCase();
      const remainder = argument.slice(firstSpace).trim();
      if (!TYPE_STARTERS.has(first) && !first.includes(".") && !first.endsWith("[]")) argument = remainder;
    }
    return argument.toLowerCase()
      .replace(/^int$/, "integer")
      .replace(/^int4$/, "integer")
      .replace(/^int8$/, "bigint")
      .replace(/^bool$/, "boolean")
      .replace(/^varchar$/, "character varying")
      .replace(/^timestamptz$/, "timestamp with time zone")
      .replace(/^timetz$/, "time with time zone")
      .replace(/^float8$/, "double precision")
      .replace(/\s+/g, " ")
      .replace(/\s*([()[\],])\s*/g, "$1");
  }).join(", ");
}

function parenthesizedContent(sql: string, openAt: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let index = openAt; index < sql.length; index += 1) {
    const char = sql[index];
    if (quote) {
      if (char === quote && sql[index + 1] === quote) index += 1;
      else if (char === quote) quote = null;
    } else if (char === "'" || char === '"') quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")" && --depth === 0) return sql.slice(openAt + 1, index);
  }
  return sql.slice(openAt + 1);
}

function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

export function parseMigrations(
  migrations: Array<{ version: string; sql: string }>,
): LedgerState {
  const objects = new Map<string, LedgerObject>();
  const indexParents = new Map<string, string>();
  const mentionedPublicTables = new Set<string>();

  const put = (object: LedgerObject): void => {
    objects.set(key(object), object);
  };
  const remove = (object: Omit<LedgerObject, "migration">): void => {
    objects.delete(key(object));
  };
  const removeTableDependents = (schema: string, table: string): void => {
    for (const [objectKey, object] of objects) {
      if (object.schema === schema && object.parent === table) objects.delete(objectKey);
    }
  };

  for (const migration of migrations) {
    const sql = stripComments(migration.sql);
    const events: Array<{ at: number; run: () => void }> = [];
    const matches = (
      expression: RegExp,
      action: (match: RegExpExecArray) => void,
    ): void => {
      for (const match of sql.matchAll(expression)) {
        events.push({ at: match.index, run: () => action(match) });
      }
    };

    matches(new RegExp(`\\bCREATE\\s+(?:OR\\s+REPLACE\\s+)?(TABLE|MATERIALIZED\\s+VIEW|VIEW|TYPE)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${QUALIFIED})`, "gi"), (match) => {
      const { schema, name } = qualifiedName(match[2]);
      const kind = match[1].toUpperCase().replace(/\s+/g, "_").toLowerCase() as ObjectKind;
      put({ kind, schema, name, migration: migration.version });
      if (kind === "table" && schema === "public") mentionedPublicTables.add(name);
    });
    matches(new RegExp(`\\bDROP\\s+(TABLE|MATERIALIZED\\s+VIEW|VIEW|TYPE)\\s+(?:IF\\s+EXISTS\\s+)?(${QUALIFIED})`, "gi"), (match) => {
      const { schema, name } = qualifiedName(match[2]);
      const kind = match[1].toUpperCase().replace(/\s+/g, "_").toLowerCase() as ObjectKind;
      remove({ kind, schema, name });
      if (kind === "table") {
        removeTableDependents(schema, name);
        if (schema === "public") mentionedPublicTables.add(name);
      } else if (kind === "type") {
        for (const [objectKey, object] of objects) {
          if (object.kind === "enum_value" && object.schema === schema && object.parent === name) objects.delete(objectKey);
        }
      }
    });
    matches(new RegExp(`\\bCREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?(${QUALIFIED})\\s+ON\\s+(?:ONLY\\s+)?(${QUALIFIED})`, "gi"), (match) => {
      const index = qualifiedName(match[1]);
      const table = qualifiedName(match[2]);
      const schema = match[1].includes(".") ? index.schema : table.schema;
      put({ kind: "index", schema, name: index.name, parent: table.name, migration: migration.version });
      indexParents.set(`${schema}.${index.name}`, table.name);
    });
    matches(new RegExp(`\\bDROP\\s+INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+EXISTS\\s+)?(${QUALIFIED})`, "gi"), (match) => {
      const index = qualifiedName(match[1]);
      const parent = indexParents.get(`${index.schema}.${index.name}`);
      remove({ kind: "index", schema: index.schema, name: index.name, parent });
    });
    matches(new RegExp(`\\bCREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(${QUALIFIED})\\s*\\(`, "gi"), (match) => {
      const name = qualifiedName(match[1]);
      const openAt = match.index + match[0].lastIndexOf("(");
      put({ kind: "function", ...name, identityArgs: normalizeIdentityArguments(parenthesizedContent(sql, openAt)), migration: migration.version });
    });
    matches(new RegExp(`\\bDROP\\s+FUNCTION\\s+(?:IF\\s+EXISTS\\s+)?(${QUALIFIED})\\s*\\(`, "gi"), (match) => {
      const openAt = match.index + match[0].lastIndexOf("(");
      remove({ kind: "function", ...qualifiedName(match[1]), identityArgs: normalizeIdentityArguments(parenthesizedContent(sql, openAt)) });
    });
    matches(new RegExp(`\\bCREATE\\s+(?:OR\\s+REPLACE\\s+)?TRIGGER\\s+(${IDENT})[\\s\\S]*?\\bON\\s+(${QUALIFIED})`, "gi"), (match) => {
      const table = qualifiedName(match[2]);
      put({ kind: "trigger", schema: table.schema, name: unquote(match[1]), parent: table.name, migration: migration.version });
    });
    matches(new RegExp(`\\bDROP\\s+TRIGGER\\s+(?:IF\\s+EXISTS\\s+)?(${IDENT})\\s+ON\\s+(${QUALIFIED})`, "gi"), (match) => {
      const table = qualifiedName(match[2]);
      remove({ kind: "trigger", schema: table.schema, name: unquote(match[1]), parent: table.name });
    });
    matches(new RegExp(`\\bALTER\\s+TABLE\\s+(?:ONLY\\s+)?(${QUALIFIED})([\\s\\S]*?);`, "gi"), (match) => {
      const table = qualifiedName(match[1]);
      const operations: Array<{ at: number; run: () => void }> = [];
      const clauses = (
        expression: RegExp,
        action: (clause: RegExpExecArray) => void,
      ): void => {
        for (const clause of match[2].matchAll(expression)) {
          operations.push({ at: clause.index, run: () => action(clause) });
        }
      };
      clauses(new RegExp(`\\bADD\\s+(?:COLUMN\\s+)?(?!CONSTRAINT\\b)(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENT})`, "gi"), (clause) => {
        put({ kind: "column", schema: table.schema, name: unquote(clause[1]), parent: table.name, migration: migration.version });
      });
      clauses(new RegExp(`\\bDROP\\s+COLUMN\\s+(?:IF\\s+EXISTS\\s+)?(${IDENT})`, "gi"), (clause) => {
        remove({ kind: "column", schema: table.schema, name: unquote(clause[1]), parent: table.name });
      });
      clauses(new RegExp(`\\bADD\\s+CONSTRAINT\\s+(${IDENT})`, "gi"), (clause) => {
        put({ kind: "constraint", schema: table.schema, name: unquote(clause[1]), parent: table.name, migration: migration.version });
      });
      clauses(new RegExp(`\\bDROP\\s+CONSTRAINT\\s+(?:IF\\s+EXISTS\\s+)?(${IDENT})`, "gi"), (clause) => {
        remove({ kind: "constraint", schema: table.schema, name: unquote(clause[1]), parent: table.name });
      });
      operations.sort((a, b) => a.at - b.at);
      for (const operation of operations) operation.run();
    });
    matches(new RegExp(`\\bALTER\\s+TYPE\\s+(${QUALIFIED})\\s+ADD\\s+VALUE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?'((?:''|[^'])*)'`, "gi"), (match) => {
      const type = qualifiedName(match[1]);
      put({ kind: "enum_value", schema: type.schema, name: match[2].replace(/''/g, "'"), parent: type.name, migration: migration.version });
    });

    events.sort((a, b) => a.at - b.at);
    for (const event of events) event.run();
  }

  return { expected: [...objects.values()].sort((a, b) => key(a).localeCompare(key(b))), mentionedPublicTables };
}

export function reconcile(
  ledger: LedgerState,
  catalog: CatalogObject[],
  publicTables: string[],
): { missing: LedgerObject[]; outOfBandTables: string[] } {
  const actual = new Set(catalog.map(key));
  return {
    missing: ledger.expected.filter((object) => !actual.has(key(object))),
    outOfBandTables: publicTables.filter((table) => !ledger.mentionedPublicTables.has(table)).sort(),
  };
}

export function formatDivergence(
  target: Target,
  divergence: ReturnType<typeof reconcile>,
): string {
  const lines = [`[${target}] LEDGER OBJECT DRIFT DETECTED`];
  for (const object of divergence.missing) {
    const objectName = `${object.schema}.${object.parent ? `${object.parent}.` : ""}${object.name}`;
    lines.push(`  MISSING ${object.kind} ${objectName} (${object.migration})`);
  }
  for (const table of divergence.outOfBandTables) lines.push(`  OUT-OF-BAND table public.${table}`);
  return lines.join("\n");
}

function migrationsDir(target: Target): string {
  return path.join(REPO_ROOT, "apps", target, "supabase", "migrations");
}

export function readMigrations(dir: string): Array<{ version: string; sql: string }> {
  return fs.readdirSync(dir).filter((file) => file.endsWith(".sql")).sort().map((file) => ({
    version: file.replace(/\.sql$/, "").replace(/_.*$/, ""),
    sql: fs.readFileSync(path.join(dir, file), "utf8"),
  }));
}

async function catalogObjects(dbUrl: string): Promise<{ objects: CatalogObject[]; publicTables: string[]; appliedVersions: Set<string> }> {
  const sql = postgres(dbUrl, { max: 1, idle_timeout: 10, connect_timeout: 10, application_name: "atc-ledger-object-check" });
  try {
    await sql`SET default_transaction_read_only = on`;
    const migrationRows = await sql<Array<{ version: string }>>`
      SELECT version FROM supabase_migrations.schema_migrations ORDER BY version
    `;
    const relations = await sql<Array<{ kind: ObjectKind; schema: string; name: string }>>`
      SELECT CASE c.relkind WHEN 'r' THEN 'table' WHEN 'v' THEN 'view' ELSE 'materialized_view' END AS kind,
             n.nspname AS schema, c.relname AS name
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'v', 'm')
    `;
    const indexes = await sql<Array<{ kind: ObjectKind; schema: string; name: string; parent: string }>>`
      SELECT 'index' AS kind, schemaname AS schema, indexname AS name, tablename AS parent FROM pg_catalog.pg_indexes
    `;
    const functions = await sql<Array<{ kind: ObjectKind; schema: string; name: string; identityArgs: string }>>`
      SELECT 'function' AS kind, n.nspname AS schema, p.proname AS name,
             pg_catalog.pg_get_function_identity_arguments(p.oid) AS "identityArgs"
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    `;
    const types = await sql<Array<{ kind: ObjectKind; schema: string; name: string }>>`
      SELECT 'type' AS kind, n.nspname AS schema, t.typname AS name
      FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    `;
    const columns = await sql<Array<{ kind: ObjectKind; schema: string; name: string; parent: string }>>`
      SELECT 'column' AS kind, table_schema AS schema, column_name AS name, table_name AS parent
      FROM information_schema.columns
    `;
    const constraints = await sql<Array<{ kind: ObjectKind; schema: string; name: string; parent: string }>>`
      SELECT 'constraint' AS kind, n.nspname AS schema, c.conname AS name, r.relname AS parent
      FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class r ON r.oid = c.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = r.relnamespace
    `;
    const triggers = await sql<Array<{ kind: ObjectKind; schema: string; name: string; parent: string }>>`
      SELECT 'trigger' AS kind, n.nspname AS schema, t.tgname AS name, c.relname AS parent
      FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE NOT t.tgisinternal
    `;
    const enumValues = await sql<Array<{ kind: ObjectKind; schema: string; name: string; parent: string }>>`
      SELECT 'enum_value' AS kind, n.nspname AS schema, e.enumlabel AS name, t.typname AS parent
      FROM pg_catalog.pg_enum e JOIN pg_catalog.pg_type t ON t.oid = e.enumtypid
      JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    `;
    return {
      objects: [...relations, ...indexes, ...functions.map((row) => ({
        ...row,
        identityArgs: normalizeIdentityArguments(row.identityArgs),
      })), ...types, ...columns, ...constraints, ...triggers, ...enumValues],
      publicTables: relations.filter((row) => row.kind === "table" && row.schema === "public").map((row) => row.name),
      appliedVersions: new Set(migrationRows.map((row) => row.version)),
    };
  } finally {
    await sql.end();
  }
}

function parseArgs(argv: string[]): { target: Target | "all"; dbUrl: string | null } {
  const targetValue = argv.find((arg) => arg.startsWith("--target="))?.slice("--target=".length) ?? "all";
  if (targetValue !== "all" && targetValue !== "main" && targetValue !== "rag") throw new Error("--target must be 'main' or 'rag'");
  const inline = argv.find((arg) => arg.startsWith("--db-url="))?.slice("--db-url=".length);
  const index = argv.indexOf("--db-url");
  return { target: targetValue, dbUrl: inline ?? (index >= 0 ? argv[index + 1] : null) ?? null };
}

export async function checkTarget(target: Target, dbUrl: string | null): Promise<{ status: "ok" | "drift" | "skipped"; message: string }> {
  const envName = target === "main" ? "SUPABASE_DB_URL" : "SUPABASE_RAG_DB_URL";
  const resolvedUrl = dbUrl ?? process.env[envName] ?? null;
  if (!resolvedUrl) return { status: "skipped", message: `[${target}] SKIPPED — ${envName} not set and --db-url not provided` };
  const catalog = await catalogObjects(resolvedUrl);
  const ledger = parseMigrations(
    readMigrations(migrationsDir(target)).filter((migration) => catalog.appliedVersions.has(migration.version)),
  );
  const divergence = reconcile(ledger, catalog.objects, catalog.publicTables);
  if (divergence.missing.length === 0 && divergence.outOfBandTables.length === 0) {
    return { status: "ok", message: `[${target}] no object drift — ${ledger.expected.length} ledger object(s) verified` };
  }
  return { status: "drift", message: formatDivergence(target, divergence) };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const targets = args.target === "all" ? [...ALL_TARGETS] : [args.target];
  let drift = false;
  for (const target of targets) {
    try {
      const result = await checkTarget(target, args.dbUrl);
      console[result.status === "drift" ? "error" : "log"](result.message);
      drift ||= result.status === "drift";
    } catch (error) {
      console.error(`[${target}] ERROR connecting to DB: ${redactSecrets(error)}`);
      drift = true;
    }
  }
  if (drift) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("check-ledger-objects: unexpected error:", redactSecrets(error));
    process.exit(1);
  });
}
