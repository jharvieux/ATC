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
// mocks (importActual/importOriginal factories) are exempt: the real code
// still runs.
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

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

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

function parse(p: string, text: string): ts.SourceFile {
  return ts.createSourceFile(p, text, ts.ScriptTarget.Latest, true, /x$/.test(p) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

interface MockCall {
  specifier: string;
  partial: boolean; // importActual/requireActual/importOriginal factory — real code still runs
  replacesCreateClient: boolean;
  replacesWitness: boolean;
}

function collectModuleMocks(sf: ts.SourceFile): MockCall[] {
  const out: MockCall[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const { expression: obj, name } = node.expression;
      if (ts.isIdentifier(obj) && (obj.text === "vi" || obj.text === "jest") && (name.text === "mock" || name.text === "doMock")) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteralLike(arg)) {
          const factory = node.arguments[1];
          const factoryText = factory?.getText(sf) ?? "";
          out.push({
            specifier: arg.text,
            partial: /importActual|requireActual|importOriginal/.test(factoryText),
            replacesCreateClient: /\bcreateClient\s*(?=:|,|\})/.test(factoryText),
            replacesWitness: /\bassertIsolationQuery\s*(?=:|,|\})/.test(factoryText),
          });
        }
      }
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
  fullName: string; // enclosing describe titles + own title
  mockedModule: string;
  annotationError?: string;
}

// Walk describe/it/test registrations recording the title stack; skip/todo
// subtrees can't fail by design and are exempt (same allowlists as Harvey).
const EXEMPT_MODS = new Set(["skip", "todo", "fixme"]);

function callHead(node: ts.CallExpression): { base: string; mod?: string } | undefined {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return { base: callee.text };
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    return { base: callee.expression.text, mod: callee.name.text };
  }
  if (ts.isCallExpression(callee)) return callHead(callee); // it.each(rows)("name", fn)
  return undefined;
}

interface RunnableTest {
  fullName: string;
  call: ts.CallExpression;
}

function runnableTests(sf: ts.SourceFile): RunnableTest[] {
  const tests: RunnableTest[] = [];
  const describeStack: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const head = callHead(node);
      if (head && EXEMPT_MODS.has(head.mod ?? "")) return;
      const titleArg = node.arguments[0];
      const title = titleArg && ts.isStringLiteralLike(titleArg) ? titleArg.text : "";
      if (head?.base === "describe") {
        describeStack.push(title);
        ts.forEachChild(node, visit);
        describeStack.pop();
        return;
      }
      if (head && (head.base === "it" || head.base === "test")) {
        tests.push({ fullName: [...describeStack, title].filter(Boolean).join(" "), call: node });
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return tests;
}

function isAwaitedWithin(node: ts.Node, boundary: ts.Node): boolean {
  for (let current = node.parent; current && current !== boundary; current = current.parent) {
    if (ts.isAwaitExpression(current)) return true;
  }
  return false;
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

type DbClientKind = "supabase" | "postgres";

interface DbClientProvenance {
  bindings: Map<string, DbClientKind>;
  expressionKind: (expression: ts.Expression) => DbClientKind | undefined;
}

interface PostgresBinding {
  name: string;
  declaration: ts.Identifier;
  scope: ts.Node;
  values: ts.Expression[];
}

function postgresProvenance(sf: ts.SourceFile): (identifier: ts.Identifier) => boolean {
  const factories = new Set<string>();
  for (const statement of sf.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteralLike(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "postgres" &&
      statement.importClause?.name
    ) {
      factories.add(statement.importClause.name.text);
    }
  }

  const bindings: PostgresBinding[] = [];
  const bindingScope = (node: ts.Node): ts.Node => {
    for (let current = node.parent; current; current = current.parent) {
      if (ts.isBlock(current) || ts.isSourceFile(current) || ts.isFunctionLike(current)) return current;
    }
    return sf;
  };
  const contains = (scope: ts.Node, node: ts.Node) => scope.pos <= node.pos && node.end <= scope.end;
  const resolve = (identifier: ts.Identifier): PostgresBinding | undefined =>
    bindings
      .filter(
        (binding) =>
          binding.name === identifier.text &&
          contains(binding.scope, identifier) &&
          binding.declaration.pos <= identifier.pos,
      )
      .sort((a, b) => (a.scope.end - a.scope.pos) - (b.scope.end - b.scope.pos) || b.declaration.pos - a.declaration.pos)[0];

  const collectDeclarations = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      bindings.push({
        name: node.name.text,
        declaration: node.name,
        scope: bindingScope(node),
        values: node.initializer ? [node.initializer] : [],
      });
    }
    ts.forEachChild(node, collectDeclarations);
  };
  collectDeclarations(sf);

  const collectAssignments = (node: ts.Node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      resolve(node.left)?.values.push(node.right);
    }
    ts.forEachChild(node, collectAssignments);
  };
  collectAssignments(sf);

  const proven = (identifier: ts.Identifier, checking = new Set<PostgresBinding>()): boolean => {
    const binding = resolve(identifier);
    if (!binding || binding.values.length === 0 || checking.has(binding)) return false;
    checking.add(binding);
    const result = binding.values.every((input) => {
      let expression = input;
      while (
        ts.isParenthesizedExpression(expression) ||
        ts.isAsExpression(expression) ||
        ts.isTypeAssertionExpression(expression) ||
        ts.isNonNullExpression(expression)
      ) {
        expression = expression.expression;
      }
      if (ts.isIdentifier(expression)) return proven(expression, checking);
      return ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) && factories.has(expression.expression.text);
    });
    checking.delete(binding);
    return result;
  };
  return proven;
}

function dbClientProvenance(sf: ts.SourceFile): DbClientProvenance {
  const supabaseFactories = new Set<string>();
  const postgresFactories = new Set<string>();
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text === "postgres" && statement.importClause?.name) {
      postgresFactories.add(statement.importClause.name.text);
      continue;
    }
    if (statement.moduleSpecifier.text !== "@supabase/supabase-js") continue;
    const imports = statement.importClause?.namedBindings;
    if (!imports || !ts.isNamedImports(imports)) continue;
    for (const element of imports.elements) {
      if ((element.propertyName?.text ?? element.name.text) === "createClient") {
        supabaseFactories.add(element.name.text);
      }
    }
  }

  const bindings = new Map<string, DbClientKind>();
  const helpers = new Map<string, { returns: ts.Expression[]; kind?: DbClientKind }>();
  const candidates: { name: string; value: ts.Expression }[] = [];

  const returnedExpressions = (fn: ts.FunctionLikeDeclaration): ts.Expression[] => {
    if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) return [fn.body];
    if (!fn.body) return [];
    const returns: ts.Expression[] = [];
    const collect = (node: ts.Node) => {
      if (node !== fn.body && ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node) && node.expression) returns.push(node.expression);
      ts.forEachChild(node, collect);
    };
    collect(fn.body);
    return returns;
  };

  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      helpers.set(node.name.text, { returns: returnedExpressions(node) });
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
        helpers.set(node.name.text, { returns: returnedExpressions(node.initializer) });
      } else {
        candidates.push({ name: node.name.text, value: node.initializer });
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      candidates.push({ name: node.left.text, value: node.right });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  const expressionKind = (input: ts.Expression): DbClientKind | undefined => {
    let expression = input;
    while (
      ts.isAwaitExpression(expression) ||
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression) ||
      ts.isNonNullExpression(expression)
    ) {
      expression = expression.expression;
    }
    if (ts.isIdentifier(expression)) return bindings.get(expression.text);
    if (!ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression)) return undefined;
    if (supabaseFactories.has(expression.expression.text)) return "supabase";
    if (postgresFactories.has(expression.expression.text)) return "postgres";
    return helpers.get(expression.expression.text)?.kind;
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const helper of helpers.values()) {
      if (helper.kind || helper.returns.length === 0) continue;
      const kinds = helper.returns.map(expressionKind);
      if (kinds[0] && kinds.every((kind) => kind === kinds[0])) {
        helper.kind = kinds[0];
        changed = true;
      }
    }
    for (const candidate of candidates) {
      const kind = expressionKind(candidate.value);
      if (kind && bindings.get(candidate.name) !== kind) {
        bindings.set(candidate.name, kind);
        changed = true;
      }
    }
  }
  return { bindings, expressionKind };
}

function queryResources(query: ts.ArrowFunction | ts.FunctionExpression, sf: ts.SourceFile): string[] {
  const resources = new Set<string>();
  const provenance = dbClientProvenance(sf);
  const isProvenPostgres = postgresProvenance(sf);
  const returned: ts.Expression[] = [];
  if (ts.isArrowFunction(query) && !ts.isBlock(query.body)) {
    returned.push(query.body);
  } else {
    const collectReturns = (node: ts.Node) => {
      if (node !== query.body && ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node) && node.expression) returned.push(node.expression);
      ts.forEachChild(node, collectReturns);
    };
    collectReturns(query.body);
  }

  const isSupabaseFromOperation = (fromCall: ts.CallExpression): boolean => {
    const access = fromCall.parent;
    return (
      ts.isPropertyAccessExpression(access) &&
      access.expression === fromCall &&
      ["select", "insert", "update", "delete", "upsert"].includes(access.name.text) &&
      ts.isCallExpression(access.parent) &&
      access.parent.expression === access
    );
  };
  const conditionallyEvaluated = (node: ts.Node, returnedExpression: ts.Expression): boolean => {
    for (let current = node; current !== returnedExpression; current = current.parent) {
      const parent = current.parent;
      if (
        (ts.isConditionalExpression(parent) && (parent.whenTrue === current || parent.whenFalse === current)) ||
        (ts.isBinaryExpression(parent) &&
          parent.right === current &&
          [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(
            parent.operatorToken.kind,
          ))
      ) {
        return true;
      }
    }
    return false;
  };
  const visit = (node: ts.Node, returnedExpression: ts.Expression) => {
    if (ts.isFunctionLike(node)) return;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === "from" || node.expression.name.text === "rpc")
    ) {
      const name = node.arguments[0];
      if (
        name &&
        ts.isStringLiteralLike(name) &&
        !conditionallyEvaluated(node, returnedExpression) &&
        provenance.expressionKind(node.expression.expression) === "supabase" &&
        (node.expression.name.text === "rpc" || isSupabaseFromOperation(node))
      ) {
        const kind = node.expression.name.text === "from" ? "table" : "rpc";
        resources.add(`${kind}:public.${name.text}`);
      }
    }
    if (
      ts.isTaggedTemplateExpression(node) &&
      ts.isIdentifier(node.tag) &&
      !conditionallyEvaluated(node, returnedExpression) &&
      isProvenPostgres(node.tag)
    ) {
      const sql = node.template.getText(sf);
      const relation = /\b(?:FROM|JOIN)\s+(?:ONLY\s+)?(?:([a-z_][a-z0-9_]*)\.)?([a-z_][a-z0-9_]*)(\s*\()?/gi;
      for (const match of sql.matchAll(relation)) {
        const schema = match[1] ?? "public";
        const name = match[2];
        if (!name) continue;
        resources.add(`${match[3] ? "rpc" : "table"}:${schema}.${name}`);
      }
    }
    ts.forEachChild(node, (child) => visit(child, returnedExpression));
  };
  for (const expression of returned) visit(expression, expression);
  return [...resources].sort();
}

function isolationWitnessError(
  testCall: ts.CallExpression,
  sf: ts.SourceFile,
  targetPath: string,
  expectedResources: string[],
): string | undefined {
  const callback = testCall.arguments.find(
    (arg): arg is ts.ArrowFunction | ts.FunctionExpression => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg),
  );
  if (!callback) return "coverage test has no runnable callback";
  const binding = witnessBinding(sf, targetPath);
  if (!binding) return "coverage test does not import the canonical assertIsolationQuery witness";

  const witnesses: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (node !== callback && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === binding) witnesses.push(node);
    ts.forEachChild(node, visit);
  };
  visit(callback);
  if (witnesses.length !== 1) return `coverage test must execute exactly one canonical isolation witness (found ${witnesses.length})`;

  const witness = witnesses[0]!;
  if (!isAwaitedWithin(witness, callback)) return "coverage test does not await its isolation witness";
  const options = witness.arguments[0];
  if (!options || !ts.isObjectLiteralExpression(options)) return "isolation witness options must be an object literal";
  const query = propertyInitializer(options, "query");
  const allowedIds = propertyInitializer(options, "allowedIds");
  const deniedIds = propertyInitializer(options, "deniedIds");
  if (!query || (!ts.isArrowFunction(query) && !ts.isFunctionExpression(query))) {
    return "isolation witness query must be an inline function";
  }
  if (!allowedIds || !ts.isArrayLiteralExpression(allowedIds)) {
    return "isolation witness allowedIds must be an array literal";
  }
  if (!deniedIds || !ts.isArrayLiteralExpression(deniedIds) || deniedIds.elements.length === 0) {
    return "isolation witness deniedIds must be a non-empty array literal";
  }

  const actualResources = queryResources(query, sf);
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
  const targetMocks = collectModuleMocks(targetSf);
  const mockedDb = targetMocks
    .filter(
      (mock) =>
        !mock.partial ||
        (mock.specifier === "@supabase/supabase-js" && mock.replacesCreateClient),
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
  const witnessError = isolationWitnessError(targetTests[0]!.call, targetSf, pointer.file, pointer.resources);
  if (witnessError) {
    return `${witnessError} in ${pointer.file}: "${pointer.testName}"`;
  }
  return undefined;
}

export function findMockedTenantTests(relPath: string, contents: string, byPath: ReadonlyMap<string, string>): MockedTenantTest[] {
  if (!/\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)__tests__\//.test(relPath)) return [];
  if (!/\b(vi|jest)\.(mock|doMock)\s*\(/.test(contents)) return [];
  const sf = parse(relPath, contents);
  const dbMock = collectModuleMocks(sf)
    .filter((m) => !m.partial)
    .map((m) => dbClientMockDescription(m, relPath, byPath))
    .find((d): d is string => d !== undefined);
  if (!dbMock) return [];

  const out: MockedTenantTest[] = [];
  const describeStack: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const head = callHead(node);
      if (head && EXEMPT_MODS.has(head.mod ?? "")) return;
      const titleArg = node.arguments[0];
      const title = titleArg && ts.isStringLiteralLike(titleArg) ? titleArg.text : "";
      if (head?.base === "describe") {
        describeStack.push(title);
        ts.forEachChild(node, visit);
        describeStack.pop();
        return;
      }
      if (head && (head.base === "it" || head.base === "test")) {
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
