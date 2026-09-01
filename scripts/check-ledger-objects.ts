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
  identityArgOids?: number[];
  migration: string;
}

interface CatalogObject {
  kind: ObjectKind;
  schema: string;
  name: string;
  parent?: string;
  identityArgs?: string;
  identityArgOids?: number[];
}

interface LedgerState {
  expected: LedgerObject[];
  mentionedPublicTables: Set<string>;
  routineEvents: RoutineEvent[];
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALL_TARGETS: readonly Target[] = ["main", "rag"];
const IDENT = '(?:"(?:""|[^"])+"|[a-zA-Z_][a-zA-Z0-9_$]*)';
const QUALIFIED = `(?:${IDENT}\\s*\\.\\s*)?${IDENT}`;

function unquote(value: string): string {
  return value.replace(/^"|"$/g, "").replace(/""/g, '"');
}

function qualifiedName(value: string): { schema: string; name: string } {
  const tokens = lexSql(value);
  if (isIdentifierToken(tokens[0]) && tokens.length === 1) {
    return { schema: "public", name: tokens[0].value };
  }
  if (isIdentifierToken(tokens[0]) && tokens[1]?.value === "." && isIdentifierToken(tokens[2]) && tokens.length === 3) {
    return { schema: tokens[0].value, name: tokens[2].value };
  }
  throw new Error(`invalid qualified object name "${value}"`);
}

function key(object: Pick<CatalogObject, "kind" | "schema" | "name" | "parent" | "identityArgOids">): string {
  return [object.kind, object.schema, object.parent ?? "", object.name, object.identityArgOids?.join(",") ?? ""].join("\u0000");
}

type SqlTokenKind = "word" | "identifier" | "symbol" | "literal";

interface SqlToken {
  kind: SqlTokenKind;
  raw: string;
  value: string;
  start: number;
  end: number;
}

export interface RoutineArgument {
  declaration: string;
  typeCandidates: string[];
}

export interface RoutineEvent {
  action: "create" | "drop";
  schema: string;
  name: string;
  arguments: RoutineArgument[];
  migration: string;
}

function lexSql(source: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let index = 0;
  while (index < source.length) {
    const start = index;
    const char = source[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (source.startsWith("--", index)) {
      index = source.indexOf("\n", index + 2);
      if (index < 0) break;
      continue;
    }
    if (source.startsWith("/*", index)) {
      let depth = 1;
      index += 2;
      while (index < source.length && depth > 0) {
        if (source.startsWith("/*", index)) {
          depth += 1;
          index += 2;
        } else if (source.startsWith("*/", index)) {
          depth -= 1;
          index += 2;
        } else index += 1;
      }
      if (depth > 0) throw new Error(`unterminated block comment at offset ${start}`);
      continue;
    }
    const escapeString = (char === "e" || char === "E") && source[index + 1] === "'";
    if (char === "'" || escapeString) {
      index += escapeString ? 2 : 1;
      let closed = false;
      while (index < source.length) {
        if (escapeString && source[index] === "\\") index += Math.min(2, source.length - index);
        else if (source[index] === "'" && source[index + 1] === "'") index += 2;
        else if (source[index] === "'") {
          index += 1;
          closed = true;
          break;
        } else index += 1;
      }
      if (!closed) throw new Error(`unterminated string literal at offset ${start}`);
      tokens.push({ kind: "literal", raw: source.slice(start, index), value: source.slice(start, index), start, end: index });
      continue;
    }
    if (char === "$") {
      const delimiter = /^\$[a-zA-Z_][a-zA-Z0-9_]*\$|^\$\$/.exec(source.slice(index))?.[0];
      if (delimiter) {
        const closeAt = source.indexOf(delimiter, index + delimiter.length);
        if (closeAt < 0) throw new Error(`unterminated dollar-quoted string at offset ${start}`);
        index = closeAt + delimiter.length;
        tokens.push({ kind: "literal", raw: source.slice(start, index), value: source.slice(start, index), start, end: index });
        continue;
      }
    }
    if (char === '"') {
      index += 1;
      let value = "";
      let closed = false;
      while (index < source.length) {
        if (source[index] === '"' && source[index + 1] === '"') {
          value += '"';
          index += 2;
        } else if (source[index] === '"') {
          index += 1;
          closed = true;
          break;
        } else {
          value += source[index];
          index += 1;
        }
      }
      if (!closed) throw new Error(`unterminated quoted identifier at offset ${start}`);
      tokens.push({ kind: "identifier", raw: source.slice(start, index), value, start, end: index });
      continue;
    }
    if (/[a-zA-Z_]/.test(char)) {
      index += 1;
      while (index < source.length && /[a-zA-Z0-9_$]/.test(source[index])) index += 1;
      const raw = source.slice(start, index);
      tokens.push({ kind: "word", raw, value: raw.toLowerCase(), start, end: index });
      continue;
    }
    index += 1;
    tokens.push({ kind: "symbol", raw: char, value: char, start, end: index });
  }
  return tokens;
}

function topLevelStatements(source: string): SqlToken[][] {
  const statements: SqlToken[][] = [];
  let statement: SqlToken[] = [];
  let parentheses = 0;
  let brackets = 0;
  for (const token of lexSql(source)) {
    if (token.value === ";" && parentheses === 0 && brackets === 0) {
      if (statement.length > 0) statements.push(statement);
      statement = [];
      continue;
    }
    statement.push(token);
    if (token.value === "(") parentheses += 1;
    else if (token.value === ")") parentheses -= 1;
    else if (token.value === "[") brackets += 1;
    else if (token.value === "]") brackets -= 1;
  }
  if (statement.length > 0) statements.push(statement);
  return statements;
}

function statementSource(tokens: SqlToken[], retainLiterals = false): string {
  return tokens.map((token) => token.kind === "literal" && !retainLiterals ? "NULL" : token.raw).join(" ");
}

function isKeyword(token: SqlToken | undefined, keyword: string): boolean {
  return token?.kind === "word" && token.value === keyword;
}

function isIdentifierToken(token: SqlToken | undefined): token is SqlToken {
  return token?.kind === "word" || token?.kind === "identifier";
}

function tokenSource(source: string, tokens: SqlToken[]): string {
  const first = tokens[0];
  const last = tokens.at(-1);
  return first && last ? source.slice(first.start, last.end).trim() : "";
}

function qualifiedRoutineName(tokens: SqlToken[], start: number): { schema: string; name: string; next: number } | undefined {
  const first = tokens[start];
  if (!isIdentifierToken(first)) return undefined;
  if (tokens[start + 1]?.value === "." && isIdentifierToken(tokens[start + 2])) {
    return { schema: first.value, name: tokens[start + 2].value, next: start + 3 };
  }
  return { schema: "public", name: first.value, next: start + 1 };
}

function argumentGroups(tokens: SqlToken[]): SqlToken[][] {
  const groups: SqlToken[][] = [];
  let current: SqlToken[] = [];
  let parentheses = 0;
  let brackets = 0;
  for (const token of tokens) {
    if (token.value === "(") parentheses += 1;
    else if (token.value === ")") parentheses -= 1;
    else if (token.value === "[") brackets += 1;
    else if (token.value === "]") brackets -= 1;
    if (token.value === "," && parentheses === 0 && brackets === 0) {
      groups.push(current);
      current = [];
    } else current.push(token);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function closingParenthesis(tokens: SqlToken[], open: number): number | undefined {
  let depth = 0;
  for (let index = open; index < tokens.length; index += 1) {
    if (tokens[index].value === "(") depth += 1;
    else if (tokens[index].value === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

function inlineTableMembers(
  tokens: SqlToken[],
  table: { schema: string; name: string },
  migration: string,
  put: (object: LedgerObject) => void,
): void {
  const tableAt = tokens.findIndex((token) => isKeyword(token, "table"));
  const open = tokens.findIndex((token, index) => index > tableAt && token.value === "(");
  if (tableAt < 0 || open < 0) return;
  const close = closingParenthesis(tokens, open);
  if (close === undefined) throw new Error(`unterminated CREATE TABLE definition for ${table.schema}.${table.name}`);

  const tableConstraints = new Set(["constraint", "primary", "unique", "check", "foreign", "exclude", "like"]);
  for (const definition of argumentGroups(tokens.slice(open + 1, close))) {
    const first = definition[0];
    if (isIdentifierToken(first) && !(first.kind === "word" && tableConstraints.has(first.value))) {
      put({ kind: "column", schema: table.schema, name: first.value, parent: table.name, migration });
    }

    let depth = 0;
    for (let index = 0; index < definition.length - 1; index += 1) {
      const token = definition[index];
      if (token.value === "(") depth += 1;
      else if (token.value === ")") depth -= 1;
      if (depth === 0 && isKeyword(token, "constraint") && isIdentifierToken(definition[index + 1])) {
        put({
          kind: "constraint",
          schema: table.schema,
          name: definition[index + 1].value,
          parent: table.name,
          migration,
        });
      }
    }
  }
}

function decodeEnumLabel(token: SqlToken): string {
  if (token.kind !== "literal" || !token.raw.startsWith("'")) {
    throw new Error(`unsupported enum label ${token.raw}; expected a standard string literal`);
  }
  return token.raw.slice(1, -1).replace(/''/g, "'");
}

function initialEnumValues(
  tokens: SqlToken[],
  type: { schema: string; name: string },
  migration: string,
  put: (object: LedgerObject) => void,
): void {
  const enumAt = tokens.findIndex((token) => isKeyword(token, "enum"));
  if (enumAt < 0) return;
  const open = tokens.findIndex((token, index) => index > enumAt && token.value === "(");
  if (open < 0) throw new Error(`missing enum values for ${type.schema}.${type.name}`);
  const close = closingParenthesis(tokens, open);
  if (close === undefined) throw new Error(`unterminated enum values for ${type.schema}.${type.name}`);
  for (const value of argumentGroups(tokens.slice(open + 1, close))) {
    if (value.length !== 1) throw new Error(`unsupported enum value for ${type.schema}.${type.name}`);
    put({ kind: "enum_value", schema: type.schema, name: decodeEnumLabel(value[0]), parent: type.name, migration });
  }
}

function routineArguments(source: string, tokens: SqlToken[]): RoutineArgument[] {
  const output: RoutineArgument[] = [];
  for (const group of argumentGroups(tokens)) {
    let declaration = group;
    let depth = 0;
    const defaultAt = declaration.findIndex((token) => {
      if (token.value === "(") depth += 1;
      else if (token.value === ")") depth -= 1;
      return depth === 0 && (token.value === "=" || isKeyword(token, "default"));
    });
    if (defaultAt >= 0) declaration = declaration.slice(0, defaultAt);
    let mode: "in" | "out" | "inout" | "variadic" = "in";
    if (["in", "out", "inout", "variadic"].some((keyword) => isKeyword(declaration[0], keyword))) {
      mode = declaration[0].value as typeof mode;
      declaration = declaration.slice(1);
    }
    if (mode === "out" || declaration.length === 0) continue;
    const candidates = [tokenSource(source, declaration)];
    if (isIdentifierToken(declaration[0]) && declaration.length > 1) {
      const withoutName = tokenSource(source, declaration.slice(1));
      if (withoutName && withoutName !== candidates[0]) candidates.push(withoutName);
    }
    output.push({ declaration: tokenSource(source, group), typeCandidates: candidates });
  }
  return output;
}

export function parseRoutineEvents(source: string, migration: string): RoutineEvent[] {
  const tokens = lexSql(source);
  const events: RoutineEvent[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    let action: RoutineEvent["action"] | undefined;
    let cursor = index;
    if (isKeyword(tokens[cursor], "create")) {
      action = "create";
      cursor += 1;
      if (isKeyword(tokens[cursor], "or") && isKeyword(tokens[cursor + 1], "replace")) cursor += 2;
      if (!isKeyword(tokens[cursor], "function")) continue;
    } else if (isKeyword(tokens[cursor], "drop")) {
      action = "drop";
      cursor += 1;
      if (!isKeyword(tokens[cursor], "function")) continue;
      cursor += 1;
      if (isKeyword(tokens[cursor], "if") && isKeyword(tokens[cursor + 1], "exists")) cursor += 2;
      const routine = qualifiedRoutineName(tokens, cursor);
      if (!routine || tokens[routine.next]?.value !== "(") continue;
      let close = routine.next + 1;
      let depth = 1;
      while (close < tokens.length && depth > 0) {
        if (tokens[close].value === "(") depth += 1;
        else if (tokens[close].value === ")") depth -= 1;
        close += 1;
      }
      if (depth !== 0) throw new Error(`unterminated DROP FUNCTION argument list for ${routine.schema}.${routine.name}`);
      events.push({ action, schema: routine.schema, name: routine.name, arguments: routineArguments(source, tokens.slice(routine.next + 1, close - 1)), migration });
      index = close - 1;
      continue;
    } else continue;

    cursor += 1;
    const routine = qualifiedRoutineName(tokens, cursor);
    if (!routine || tokens[routine.next]?.value !== "(") continue;
    let close = routine.next + 1;
    let depth = 1;
    while (close < tokens.length && depth > 0) {
      if (tokens[close].value === "(") depth += 1;
      else if (tokens[close].value === ")") depth -= 1;
      close += 1;
    }
    if (depth !== 0) throw new Error(`unterminated CREATE FUNCTION argument list for ${routine.schema}.${routine.name}`);
    events.push({ action, schema: routine.schema, name: routine.name, arguments: routineArguments(source, tokens.slice(routine.next + 1, close - 1)), migration });
    index = close - 1;
  }
  return events;
}

export async function materializeRoutineIdentities(
  ledger: LedgerState,
  resolveArgument: (argument: RoutineArgument) => Promise<number>,
): Promise<LedgerState> {
  const routines = new Map<string, LedgerObject>();
  for (const event of ledger.routineEvents) {
    const identityArgOids = await Promise.all(event.arguments.map(resolveArgument));
    const identityArgs = event.arguments.map((argument) => argument.typeCandidates.at(-1)).join(", ");
    const object: LedgerObject = {
      kind: "function",
      schema: event.schema,
      name: event.name,
      identityArgs,
      identityArgOids,
      migration: event.migration,
    };
    if (event.action === "create") routines.set(key(object), object);
    else routines.delete(key(object));
  }
  return {
    ...ledger,
    expected: [...ledger.expected, ...routines.values()].sort((a, b) => key(a).localeCompare(key(b))),
  };
}

export function parseMigrations(
  migrations: Array<{ version: string; sql: string }>,
): LedgerState {
  const objects = new Map<string, LedgerObject>();
  const indexParents = new Map<string, string>();
  const mentionedPublicTables = new Set<string>();
  const routineEvents: RoutineEvent[] = [];

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
    routineEvents.push(...parseRoutineEvents(migration.sql, migration.version));
    for (const statement of topLevelStatements(migration.sql)) {
      const sql = statementSource(statement);
      const sqlWithLiterals = statementSource(statement, true);
      const events: Array<{ at: number; run: () => void }> = [];
      const matches = (
        expression: RegExp,
        action: (match: RegExpExecArray) => void,
      ): void => {
        for (const match of sql.matchAll(expression)) {
          events.push({ at: match.index, run: () => action(match) });
        }
      };

      matches(new RegExp(`^CREATE\\s+(?:OR\\s+REPLACE\\s+)?(TABLE|MATERIALIZED\\s+VIEW|VIEW|TYPE)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${QUALIFIED})`, "gi"), (match) => {
        const { schema, name } = qualifiedName(match[2]);
        const kind = match[1].toUpperCase().replace(/\s+/g, "_").toLowerCase() as ObjectKind;
        put({ kind, schema, name, migration: migration.version });
        if (kind === "table" && schema === "public") mentionedPublicTables.add(name);
        if (kind === "table") inlineTableMembers(statement, { schema, name }, migration.version, put);
        if (kind === "type") initialEnumValues(statement, { schema, name }, migration.version, put);
      });
      matches(new RegExp(`^DROP\\s+(TABLE|MATERIALIZED\\s+VIEW|VIEW|TYPE)\\s+(?:IF\\s+EXISTS\\s+)?(${QUALIFIED})`, "gi"), (match) => {
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
      matches(new RegExp(`^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?(${QUALIFIED})\\s+ON\\s+(?:ONLY\\s+)?(${QUALIFIED})`, "gi"), (match) => {
        const index = qualifiedName(match[1]);
        const table = qualifiedName(match[2]);
        const schema = match[1].includes(".") ? index.schema : table.schema;
        put({ kind: "index", schema, name: index.name, parent: table.name, migration: migration.version });
        indexParents.set(`${schema}.${index.name}`, table.name);
      });
      matches(new RegExp(`^DROP\\s+INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+EXISTS\\s+)?(${QUALIFIED})`, "gi"), (match) => {
        const index = qualifiedName(match[1]);
        const parent = indexParents.get(`${index.schema}.${index.name}`);
        remove({ kind: "index", schema: index.schema, name: index.name, parent });
      });
      matches(new RegExp(`^CREATE\\s+(?:OR\\s+REPLACE\\s+)?TRIGGER\\s+(${IDENT})[\\s\\S]*?\\bON\\s+(${QUALIFIED})`, "gi"), (match) => {
        const table = qualifiedName(match[2]);
        put({ kind: "trigger", schema: table.schema, name: unquote(match[1]), parent: table.name, migration: migration.version });
      });
      matches(new RegExp(`^DROP\\s+TRIGGER\\s+(?:IF\\s+EXISTS\\s+)?(${IDENT})\\s+ON\\s+(${QUALIFIED})`, "gi"), (match) => {
        const table = qualifiedName(match[2]);
        remove({ kind: "trigger", schema: table.schema, name: unquote(match[1]), parent: table.name });
      });
      matches(new RegExp(`^ALTER\\s+TABLE\\s+(?:ONLY\\s+)?(${QUALIFIED})([\\s\\S]*)$`, "gi"), (match) => {
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
      for (const match of sqlWithLiterals.matchAll(new RegExp(`^ALTER\\s+TYPE\\s+(${QUALIFIED})\\s+ADD\\s+VALUE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?'((?:''|[^'])*)'`, "gi"))) {
        events.push({
          at: match.index,
          run: () => {
            const type = qualifiedName(match[1]);
            put({ kind: "enum_value", schema: type.schema, name: match[2].replace(/''/g, "'"), parent: type.name, migration: migration.version });
          },
        });
      }

      events.sort((a, b) => a.at - b.at);
      for (const event of events) event.run();
    }
  }

  return {
    expected: [...objects.values()].sort((a, b) => key(a).localeCompare(key(b))),
    mentionedPublicTables,
    routineEvents,
  };
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

type QuerySql = postgres.Sql | postgres.TransactionSql;

export async function readCatalogFunctions(sql: QuerySql): Promise<Array<{
  kind: ObjectKind;
  schema: string;
  name: string;
  identityArgs: string;
  identityArgOids: number[];
}>> {
  return sql`
    SELECT 'function' AS kind, n.nspname AS schema, p.proname AS name,
           pg_catalog.pg_get_function_identity_arguments(p.oid) AS "identityArgs",
           ARRAY(
             SELECT arg_oid::int
             FROM unnest(p.proargtypes) WITH ORDINALITY AS input(arg_oid, position)
             ORDER BY position
           ) AS "identityArgOids"
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE p.prokind IN ('f', 'w')
  `;
}

function percentTypeReference(candidate: string): { schema: string; table: string; column: string; array: boolean } | undefined {
  const tokens = lexSql(candidate);
  let array = false;
  while (tokens.at(-2)?.value === "[" && tokens.at(-1)?.value === "]") {
    array = true;
    tokens.splice(-2);
  }
  if (
    tokens.length !== 7 ||
    !isIdentifierToken(tokens[0]) || tokens[1].value !== "." ||
    !isIdentifierToken(tokens[2]) || tokens[3].value !== "." ||
    !isIdentifierToken(tokens[4]) || tokens[5].value !== "%" ||
    !isKeyword(tokens[6], "type")
  ) return undefined;
  return { schema: tokens[0].value, table: tokens[2].value, column: tokens[4].value, array };
}

async function resolvePercentType(sql: QuerySql, reference: ReturnType<typeof percentTypeReference>): Promise<number | undefined> {
  if (!reference) return undefined;
  const [row] = await sql<Array<{ oid: number; arrayOid: number }>>`
    SELECT a.atttypid::int AS oid, t.typarray::int AS "arrayOid"
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
    WHERE n.nspname = ${reference.schema}
      AND c.relname = ${reference.table}
      AND a.attname = ${reference.column}
      AND a.attnum > 0
      AND NOT a.attisdropped
  `;
  if (!row) return undefined;
  if (reference.array && row.arrayOid === 0) {
    throw new Error(`%TYPE column ${reference.schema}.${reference.table}.${reference.column} has no array type`);
  }
  return reference.array ? row.arrayOid : row.oid;
}

async function resolveRegularType(sql: QuerySql, candidate: string): Promise<number | undefined> {
  let row: { oid: number; namespace: string; typeName: string } | undefined;
  try {
    [row] = await sql<Array<{ oid: number; namespace: string; typeName: string }>>`
      SELECT t.oid::int AS oid, n.nspname AS namespace, t.typname AS "typeName"
      FROM pg_catalog.pg_type t
      JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      WHERE t.oid = pg_catalog.to_regtype(${candidate})
    `;
  } catch (error) {
    if (error instanceof postgres.PostgresError && ["22P02", "42601", "42704"].includes(error.code)) return undefined;
    throw error;
  }
  if (!row) return undefined;
  const explicitlyQualified = lexSql(candidate).some((token) => token.value === ".");
  if (row.namespace !== "pg_catalog" && !explicitlyQualified) {
    const [count] = await sql<Array<{ matches: number }>>`
      SELECT count(*)::int AS matches
      FROM pg_catalog.pg_type t
      JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      WHERE t.typname = ${row.typeName}
        AND n.nspname !~ '^pg_(?:toast|temp_)'
    `;
    if (!count || count.matches !== 1) {
      throw new Error(`search-path-dependent routine argument type "${candidate}"; qualify its schema`);
    }
  }
  return row.oid;
}

export async function resolveRoutineArgumentOid(sql: QuerySql, argument: RoutineArgument): Promise<number> {
  const resolved = new Set<number>();
  for (const candidate of argument.typeCandidates) {
    const percentType = percentTypeReference(candidate);
    const oid = percentType
      ? await resolvePercentType(sql, percentType)
      : await resolveRegularType(sql, candidate);
    if (oid !== undefined) resolved.add(oid);
  }
  if (resolved.size === 0) {
    throw new Error(`unresolved routine argument declaration "${argument.declaration}"`);
  }
  if (resolved.size > 1) {
    throw new Error(`ambiguous routine argument declaration "${argument.declaration}"`);
  }
  return [...resolved][0];
}

async function catalogObjects(
  target: Target,
  dbUrl: string,
): Promise<{ ledger: LedgerState; objects: CatalogObject[]; publicTables: string[] }> {
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
    const functions = await readCatalogFunctions(sql);
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
    const parsed = parseMigrations(
      readMigrations(migrationsDir(target)).filter((migration) => migrationRows.some((row) => row.version === migration.version)),
    );
    const ledger = await materializeRoutineIdentities(parsed, (argument) => resolveRoutineArgumentOid(sql, argument));
    return {
      ledger,
      objects: [...relations, ...indexes, ...functions.map((row) => ({
        ...row,
        identityArgOids: row.identityArgOids.map(Number),
      })), ...types, ...columns, ...constraints, ...triggers, ...enumValues],
      publicTables: relations.filter((row) => row.kind === "table" && row.schema === "public").map((row) => row.name),
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

export async function checkTarget(target: Target, dbUrl: string | null): Promise<{ status: "ok" | "drift"; message: string }> {
  const envName = target === "main" ? "SUPABASE_DB_URL" : "SUPABASE_RAG_DB_URL";
  const resolvedUrl = dbUrl ?? process.env[envName] ?? null;
  if (!resolvedUrl) return { status: "drift", message: `[${target}] LEDGER CHECK FAILED — ${envName} not set and --db-url not provided` };
  const catalog = await catalogObjects(target, resolvedUrl);
  const divergence = reconcile(catalog.ledger, catalog.objects, catalog.publicTables);
  if (divergence.missing.length === 0 && divergence.outOfBandTables.length === 0) {
    return { status: "ok", message: `[${target}] no object drift — ${catalog.ledger.expected.length} ledger object(s) verified` };
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
      console.error(`[${target}] LEDGER CHECK FAILED: ${redactSecrets(error)}`);
      drift = true;
    }
  }
  if (drift) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("check-ledger-objects failed:", redactSecrets(error));
    process.exit(1);
  });
}
