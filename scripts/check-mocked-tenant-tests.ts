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
  fullName: string; // enclosing describe titles + own title
  mockedModule: string;
  annotationError?: string;
}

// Walk describe/it/test registrations recording the title stack; skip/todo
// subtrees can't fail by design and are exempt (same allowlists as Harvey).

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

type FrameworkTag = "vi" | "jest" | "vitest" | "mock" | "doMock" | "mocked" | "spyOn" | "replaceProperty";
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

interface FlowState {
  cells: Map<ts.Symbol, Set<FlowAtom>>;
  members: Map<FlowAtom, Map<string, Set<FlowAtom>>>;
  dirty: Set<FlowAtom>;
  outcome: FlowOutcome;
  returned: Set<FlowAtom>;
  witnessCount: number;
  awaitedWitnessCount: number;
  witnessResources: Set<string>;
  unsupported: boolean;
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
}

const UNKNOWN_ATOM = "unknown";
const UNDEFINED_ATOM = "undefined";
const ORIGINAL_LOADER_ATOM = "loader:original";
const ORIGINAL_MODULE_ATOM = "module:original";
const SUPABASE_FACTORY_ATOM = "factory:supabase";
const POSTGRES_FACTORY_ATOM = "factory:postgres";
const WITNESS_ATOM = "witness:canonical";

class LocalFlowEngine {
  readonly checker: ts.TypeChecker;
  private readonly functions = new Map<FlowAtom, ts.FunctionLikeDeclaration>();
  private readonly boundTargets = new Map<FlowAtom, Set<FlowAtom>>();
  private readonly controlTargets = new Map<FlowAtom, Set<FlowAtom>>();
  private readonly memberTargets = new Map<FlowAtom, { receiver: Set<FlowAtom>; member: string }>();
  private readonly queryResourcesByAtom = new Map<FlowAtom, Set<string>>();
  private readonly executedWitnessCalls = new Set<ts.CallExpression>();
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
    return `${prefix}:${node.pos}:${node.end}`;
  }

  private functionAtom(fn: ts.FunctionLikeDeclaration): FlowAtom {
    const atom = this.atom("function", fn);
    this.functions.set(atom, fn);
    return atom;
  }

  private cloneState(state: FlowState): FlowState {
    return {
      cells: new Map([...state.cells].map(([symbol, value]) => [symbol, new Set(value)])),
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
      unsupported: state.unsupported,
    };
  }

  private emptyState(): FlowState {
    return {
      cells: new Map(),
      members: new Map(),
      dirty: new Set(),
      outcome: "normal",
      returned: new Set(),
      witnessCount: 0,
      awaitedWitnessCount: 0,
      witnessResources: new Set(),
      unsupported: false,
    };
  }

  private values(...atoms: FlowAtom[]): Set<FlowAtom> {
    return new Set(atoms.length ? atoms : [UNKNOWN_ATOM]);
  }

  private cellValue(state: FlowState, node: ts.Identifier): Set<FlowAtom> {
    const symbol = this.symbol(node);
    if (symbol) return new Set(state.cells.get(symbol) ?? [UNKNOWN_ATOM]);
    if (node.text === "vi" || node.text === "jest") return this.values(`framework:${node.text}`);
    return this.values(UNKNOWN_ATOM);
  }

  private setCell(state: FlowState, node: ts.Identifier, value: FlowValue): void {
    const symbol = this.symbol(node);
    if (symbol) state.cells.set(symbol, new Set(value));
  }

  private staticKey(node: ts.Node | undefined): string | undefined {
    if (!node) return undefined;
    const computed = ts.isComputedPropertyName(node);
    const expression = computed ? unwrapExpression(node.expression) : unwrapExpression(node as ts.Expression);
    if ((!computed && ts.isIdentifier(expression)) || ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression)) {
      return expression.text;
    }
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = this.staticKey(expression.left);
      const right = this.staticKey(expression.right);
      return left === undefined || right === undefined ? undefined : left + right;
    }
    return undefined;
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

  private assignTarget(state: FlowState, target: ts.Expression, value: FlowValue): void {
    const expression = unwrapExpression(target);
    if (ts.isIdentifier(expression)) {
      this.setCell(state, expression, value);
      return;
    }
    if (ts.isPropertyAccessExpression(expression)) {
      const receiver = this.evaluateExpression(expression.expression, this.cloneState(state))[0];
      if (receiver) {
        state.cells = receiver.state.cells;
        state.members = receiver.state.members;
        state.dirty = receiver.state.dirty;
        this.setMember(state, receiver.value, expression.name.text, value);
      }
      return;
    }
    if (ts.isElementAccessExpression(expression)) {
      const receiver = this.evaluateExpression(expression.expression, this.cloneState(state))[0];
      if (receiver) {
        state.cells = receiver.state.cells;
        state.members = receiver.state.members;
        state.dirty = receiver.state.dirty;
        this.setMember(state, receiver.value, this.staticKey(expression.argumentExpression), value);
      }
      return;
    }
    if (ts.isArrayLiteralExpression(expression)) {
      for (const element of expression.elements) {
        if (ts.isOmittedExpression(element)) continue;
        const item = ts.isSpreadElement(element) ? element.expression : element;
        if (ts.isBinaryExpression(item) && item.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          const fallback = this.evaluateExpression(item.right, this.cloneState(state))[0]?.value ?? this.values(UNKNOWN_ATOM);
          this.assignTarget(state, item.left, fallback);
        } else {
          this.assignTarget(state, item, this.values(UNKNOWN_ATOM));
        }
      }
      return;
    }
    if (ts.isObjectLiteralExpression(expression)) {
      for (const property of expression.properties) {
        if (ts.isShorthandPropertyAssignment(property)) this.setCell(state, property.name, this.values(UNKNOWN_ATOM));
        else if (ts.isPropertyAssignment(property)) this.assignTarget(state, property.initializer, this.values(UNKNOWN_ATOM));
        else if (ts.isSpreadAssignment(property)) this.assignTarget(state, property.expression, this.values(UNKNOWN_ATOM));
      }
    }
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
        if (module === "@supabase/supabase-js" && imported === "createClient") atom = SUPABASE_FACTORY_ATOM;
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
      const explicit = state.members.get(receiver)?.get(member ?? "@unknown");
      if (explicit) {
        for (const atom of explicit) value.add(atom);
        continue;
      }
      if (receiver === "framework:vi" || receiver === "framework:vitest" || receiver === "framework:jest") {
        if (member && ["mock", "doMock", "mocked", "spyOn", "replaceProperty"].includes(member)) {
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
      if (receiver.startsWith("client:supabase:") && member && ["from", "rpc"].includes(member)) {
        if (state.dirty.has(receiver)) value.add(UNKNOWN_ATOM);
        else {
          const method = this.atom(`supabase-${member}`, node);
          this.memberTargets.set(method, { receiver: new Set([receiver]), member });
          value.add(method);
        }
        continue;
      }
      if (receiver.startsWith("query:supabase:") && member && ["select", "insert", "update", "delete", "upsert"].includes(member)) {
        const method = this.atom("supabase-operation", node);
        this.memberTargets.set(method, { receiver: new Set([receiver]), member });
        value.add(method);
        continue;
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
      if (receiver.startsWith("control:") && member && /^(?:mock|withImplementation)/.test(member)) {
        const configure = this.atom("configure", node);
        this.controlTargets.set(configure, new Set(this.controlTargets.get(receiver) ?? [UNKNOWN_ATOM]));
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
      atom.startsWith("function:") ||
      atom.startsWith("bound:") ||
      atom.startsWith("call:") ||
      atom.startsWith("apply:") ||
      atom.startsWith("bind:") ||
      atom.startsWith("supabase-") ||
      atom.startsWith("configure:")
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
      return this.evaluateExpression(expression.expression, state, active, true);
    }
    if (ts.isIdentifier(expression)) return [{ state, value: this.cellValue(state, expression) }];
    if (expression.kind === ts.SyntaxKind.UndefinedKeyword || expression.kind === ts.SyntaxKind.VoidExpression) {
      return [{ state, value: this.values(UNDEFINED_ATOM) }];
    }
    if (
      ts.isStringLiteralLike(expression) ||
      ts.isNumericLiteral(expression) ||
      expression.kind === ts.SyntaxKind.TrueKeyword ||
      expression.kind === ts.SyntaxKind.FalseKeyword ||
      expression.kind === ts.SyntaxKind.NullKeyword
    ) {
      return [{ state, value: this.values(this.atom("literal", expression)) }];
    }
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
      const atom = this.functionAtom(expression);
      if (ts.isFunctionExpression(expression) && expression.name) this.setCell(state, expression.name, this.values(atom));
      return [{ state, value: this.values(atom) }];
    }
    if (ts.isPropertyAccessExpression(expression)) {
      return this.evaluateExpression(expression.expression, state, active).map((base) => ({
        state: base.state,
        value: this.memberValue(base.state, base.value, expression.name.text, expression),
      }));
    }
    if (ts.isElementAccessExpression(expression)) {
      return this.evaluateExpression(expression.expression, state, active).map((base) => ({
        state: base.state,
        value: this.memberValue(base.state, base.value, this.staticKey(expression.argumentExpression), expression),
      }));
    }
    if (ts.isConditionalExpression(expression)) {
      const condition = staticBoolean(expression.condition);
      const conditions = this.evaluateExpression(expression.condition, state, active);
      return conditions.flatMap((after) => {
        if (condition === true) return this.evaluateExpression(expression.whenTrue, after.state, active, awaited);
        if (condition === false) return this.evaluateExpression(expression.whenFalse, after.state, active, awaited);
        return [
          ...this.evaluateExpression(expression.whenTrue, this.cloneState(after.state), active, awaited),
          ...this.evaluateExpression(expression.whenFalse, this.cloneState(after.state), active, awaited),
        ];
      });
    }
    if (ts.isBinaryExpression(expression)) return this.evaluateBinary(expression, state, active, awaited);
    if (ts.isObjectLiteralExpression(expression)) return this.evaluateObject(expression, state, active);
    if (ts.isArrayLiteralExpression(expression)) {
      let evaluations: FlowEvaluation[] = [{ state, value: this.values(this.atom("array", expression)) }];
      for (const element of expression.elements) {
        if (ts.isOmittedExpression(element)) continue;
        const item = ts.isSpreadElement(element) ? element.expression : element;
        evaluations = evaluations.flatMap((current) =>
          this.evaluateExpression(item, current.state, active).map((evaluated) => ({
            state: evaluated.state,
            value: current.value,
          })),
        );
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
        this.assignTarget(state, expression.operand, this.values(UNKNOWN_ATOM));
      }
      return [{ state, value: this.values(UNKNOWN_ATOM) }];
    }
    if (ts.isTemplateExpression(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
      return [{ state, value: this.values(this.atom("literal", expression)) }];
    }
    state.unsupported = true;
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
        const assigned = this.evaluateExpression(expression.right, this.cloneState(state), new Set(active)).map((right) => {
          this.assignTarget(right.state, expression.left, right.value);
          return { state: right.state, value: right.value };
        });
        return [{ state: unchanged, value: this.values(UNKNOWN_ATOM) }, ...assigned];
      }
      return this.evaluateExpression(expression.right, state, new Set(active)).map((right) => {
        this.assignTarget(
          right.state,
          expression.left,
          operator === ts.SyntaxKind.EqualsToken ? right.value : this.values(UNKNOWN_ATOM),
        );
        return { state: right.state, value: right.value };
      });
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
        if (ts.isSpreadAssignment(property)) {
          return this.evaluateExpression(property.expression, current.state, new Set(active)).map((spread) => {
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
          this.setMember(current.state, this.values(objectAtom), key, this.values(this.functionAtom(property)));
          if (key === undefined) current.state.members.get(objectAtom)?.set("@all", this.values(UNKNOWN_ATOM));
          return [current];
        }
        if (ts.isShorthandPropertyAssignment(property)) {
          this.setMember(current.state, this.values(objectAtom), property.name.text, this.cellValue(current.state, property.name));
          return [current];
        }
        if (ts.isPropertyAssignment(property)) {
          return this.evaluateExpression(property.initializer, current.state, new Set(active)).map((value) => {
            const key = this.staticKey(property.name);
            this.setMember(value.state, this.values(objectAtom), key, value.value);
            if (key === undefined) value.state.members.get(objectAtom)?.set("@all", this.values(UNKNOWN_ATOM));
            return { state: value.state, value: this.values(objectAtom) };
          });
        }
        current.state.unsupported = true;
        return [current];
      });
    }
    return evaluations;
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

  private bindName(state: FlowState, name: ts.BindingName, value: FlowValue): void {
    if (ts.isIdentifier(name)) {
      this.setCell(state, name, value);
      return;
    }
    if (ts.isObjectBindingPattern(name)) {
      for (const element of name.elements) {
        if (ts.isOmittedExpression(element)) continue;
        const key = this.staticKey(element.propertyName ?? (ts.isIdentifier(element.name) ? element.name : undefined));
        let selected =
          key === undefined
            ? this.values(UNKNOWN_ATOM)
            : this.memberValue(state, value, key, element);
        if (element.initializer && (selected.has(UNDEFINED_ATOM) || selected.has(UNKNOWN_ATOM))) {
          selected = this.evaluateExpression(element.initializer, this.cloneState(state))[0]?.value ?? this.values(UNKNOWN_ATOM);
        }
        this.bindName(state, element.name, selected);
      }
      return;
    }
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) this.bindName(state, element.name, this.values(UNKNOWN_ATOM));
    }
  }

  private initialiseHoisted(statements: readonly ts.Statement[], state: FlowState): void {
    const visitVar = (node: ts.Node) => {
      if (node !== this.sourceFile && ts.isFunctionLike(node)) return;
      if (ts.isVariableDeclarationList(node) && !(node.flags & ts.NodeFlags.BlockScoped)) {
        for (const declaration of node.declarations) this.bindName(state, declaration.name, this.values(UNDEFINED_ATOM));
      }
      ts.forEachChild(node, visitVar);
    };
    for (const statement of statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        this.setCell(state, statement.name, this.values(this.functionAtom(statement)));
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
    return this.evaluateExpression(call.expression, state, new Set(active)).flatMap((callee) => {
      type CallInputs = { state: FlowState; args: Set<FlowAtom>[] };
      let inputs: CallInputs[] = [{ state: callee.state, args: [] }];
      for (const argument of call.arguments) {
        if (ts.isSpreadElement(argument)) {
          inputs = inputs.map((input) => {
            input.state.unsupported = true;
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
      return inputs.flatMap((input) =>
        this.invokeAtoms(callee.value, input.args, input.state, call, active, awaited, construct),
      );
    });
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
      if (callee === "framework:beforeAll" || callee === "framework:beforeEach") {
        const callbacks = [...(args[0] ?? [])]
          .map((atom) => this.functions.get(atom))
          .filter((fn): fn is ts.FunctionLikeDeclaration => fn !== undefined && !active.has(fn));
        if (!callbacks.length) {
          branch.unsupported = true;
          results.push({ state: branch, value: this.values(UNKNOWN_ATOM) });
        } else {
          for (const callback of callbacks) {
            results.push(
              ...this.executeFunction(callback, [], branch, new Set(active).add(callback)).map((result) => ({
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
      if (callee === "framework:spyOn" || callee === "framework:replaceProperty") {
        const target = new Set(args[0] ?? [UNKNOWN_ATOM]);
        for (const atom of target) {
          if (atom.startsWith("client:supabase:") || atom.startsWith("client:postgres:")) branch.dirty.add(atom);
        }
        const control = this.atom("control", call);
        this.controlTargets.set(control, target);
        results.push({ state: branch, value: this.values(control) });
        continue;
      }
      if (callee.startsWith("configure:")) {
        for (const target of this.controlTargets.get(callee) ?? [UNKNOWN_ATOM]) branch.dirty.add(target);
        results.push({ state: branch, value: this.values(UNKNOWN_ATOM) });
        continue;
      }
      const memberTarget = this.memberTargets.get(callee);
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
      if (memberTarget && memberTarget.member && ["select", "insert", "update", "delete", "upsert"].includes(memberTarget.member)) {
        const result = this.atom("result:query", call);
        const resources = new Set<string>();
        for (const query of memberTarget.receiver) {
          for (const resource of this.queryResourcesByAtom.get(query) ?? []) resources.add(resource);
        }
        this.queryResourcesByAtom.set(result, resources);
        results.push({ state: branch, value: resources.size ? this.values(result) : this.values(UNKNOWN_ATOM) });
        continue;
      }
      if (callee.startsWith("supabase-chain:")) {
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
        const queryResults = this.invokeAtoms(queryValues, [], branch, call, active, true, false);
        for (const queryResult of queryResults) {
          for (const atom of queryResult.value) {
            for (const resource of this.queryResourcesByAtom.get(atom) ?? []) {
              queryResult.state.witnessResources.add(resource);
            }
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
          results.push({ state: branch, value: this.values(this.atom("generator", call)) });
        } else if (active.has(fn)) {
          branch.unsupported = true;
          results.push({ state: branch, value: this.values(UNKNOWN_ATOM) });
        } else {
          const directArgs = args.map((value) =>
            [...value].some((atom) => atom.startsWith("query:supabase:") || atom.startsWith("result:query:"))
              ? this.values(UNKNOWN_ATOM)
              : value,
          );
          results.push(...this.executeFunction(fn, directArgs, branch, new Set(active).add(fn)));
        }
        continue;
      }
      const registration = this.registration(call);
      if (registration) {
        if (this.executeSuites && registration.kind === "suite" && registration.state === "enabled") {
          const callbacks = args
            .flatMap((value) => [...value])
            .map((atom) => this.functions.get(atom))
            .filter((fn): fn is ts.FunctionLikeDeclaration => fn !== undefined && !active.has(fn));
          for (const callback of callbacks) {
            results.push(
              ...this.executeFunction(callback, [], branch, new Set(active).add(callback)).map((result) => ({
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
      if (ts.isIdentifier(call.expression) && call.expression.text === "eval") branch.unsupported = true;
      for (const value of args) {
        for (const atom of value) {
          const callback = this.functions.get(atom);
          if (callback && !active.has(callback)) {
            results.push(...this.executeFunction(callback, [], this.cloneState(branch), new Set(active).add(callback)));
          }
        }
      }
      results.push({ state: branch, value: this.values(UNKNOWN_ATOM) });
    }
    return results.length ? results : [{ state, value: this.values(UNKNOWN_ATOM) }];
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
    if (owner === "Object" && method === "assign") {
      const targets = args[0] ?? this.values(UNKNOWN_ATOM);
      for (const source of args.slice(1)) {
        for (const target of targets) {
          for (const sourceAtom of source) {
            const sourceMembers = state.members.get(sourceAtom);
            if (!sourceMembers) {
              if (target.startsWith("client:supabase:") || target.startsWith("client:postgres:")) state.dirty.add(target);
              continue;
            }
            for (const [name, value] of sourceMembers) {
              if (name.startsWith("@")) continue;
              this.setMember(state, this.values(target), name, value);
            }
            if (sourceMembers.has("@all") || sourceMembers.has("@unknown")) {
              this.setMember(state, this.values(target), undefined, this.values(UNKNOWN_ATOM));
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
          if (!members) this.setMember(state, this.values(target), undefined, this.values(UNKNOWN_ATOM));
          else {
            for (const name of members.keys()) {
              if (!name.startsWith("@")) this.setMember(state, this.values(target), name, this.values(UNKNOWN_ATOM));
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
      const key = this.literalText(call.arguments[1]);
      this.setMember(state, args[0] ?? this.values(UNKNOWN_ATOM), key, this.values(UNKNOWN_ATOM));
      return true;
    }
    return false;
  }

  private evaluateTaggedTemplate(
    expression: ts.TaggedTemplateExpression,
    state: FlowState,
    active: ReadonlySet<ts.FunctionLikeDeclaration>,
  ): FlowEvaluation[] {
    return this.evaluateExpression(expression.tag, state, new Set(active)).map((tag) => {
      const isRealPostgres = [...tag.value].some(
        (atom) => atom.startsWith("client:postgres:") && !tag.state.dirty.has(atom),
      );
      if (!isRealPostgres) {
        return { state: tag.state, value: this.values(UNKNOWN_ATOM) };
      }
      const sql = ts.isNoSubstitutionTemplateLiteral(expression.template)
        ? expression.template.text
        : [
            expression.template.head.text,
            ...expression.template.templateSpans.map((span) => ` ? ${span.literal.text}`),
          ].join("");
      const resources = this.sqlResources(sql);
      if (!resources.length) return { state: tag.state, value: this.values(UNKNOWN_ATOM) };
      const result = this.atom("result:query", expression);
      this.queryResourcesByAtom.set(result, new Set(resources));
      return { state: tag.state, value: this.values(result) };
    });
  }

  private sqlResources(sql: string): string[] {
    const tokens: string[] = [];
    let index = 0;
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
        continue;
      }
      if (char === "'") {
        index += 1;
        while (index < sql.length) {
          if (sql[index] === "'" && sql[index + 1] === "'") index += 2;
          else if (sql[index] === "'") {
            index += 1;
            break;
          } else index += 1;
        }
        continue;
      }
      if (char === "$") {
        const delimiter = /^\$[a-zA-Z_][a-zA-Z0-9_]*\$|^\$\$/.exec(sql.slice(index))?.[0];
        if (delimiter) {
          const end = sql.indexOf(delimiter, index + delimiter.length);
          index = end < 0 ? sql.length : end + delimiter.length;
          continue;
        }
      }
      if (char === '"') {
        let identifier = "";
        index += 1;
        while (index < sql.length) {
          if (sql[index] === '"' && sql[index + 1] === '"') {
            identifier += '"';
            index += 2;
          } else if (sql[index] === '"') {
            index += 1;
            break;
          } else identifier += sql[index++]!;
        }
        tokens.push(identifier);
        continue;
      }
      const identifier = /^[a-zA-Z_][a-zA-Z0-9_$]*/.exec(sql.slice(index))?.[0];
      if (identifier) {
        tokens.push(identifier);
        index += identifier.length;
        continue;
      }
      if (char === "." || char === "(") tokens.push(char);
      index += 1;
    }
    const resources = new Set<string>();
    for (let cursor = 0; cursor < tokens.length; cursor += 1) {
      const keyword = tokens[cursor]?.toUpperCase();
      if (keyword !== "FROM" && keyword !== "JOIN") continue;
      cursor += 1;
      if (tokens[cursor]?.toUpperCase() === "ONLY") cursor += 1;
      const first = tokens[cursor];
      if (!first || first === "(") continue;
      let schema = "public";
      let name = first;
      if (tokens[cursor + 1] === "." && tokens[cursor + 2]) {
        schema = first;
        name = tokens[cursor + 2]!;
        cursor += 2;
      }
      const kind = tokens[cursor + 1] === "(" ? "rpc" : "table";
      resources.add(`${kind}:${schema.toLowerCase()}.${name.toLowerCase()}`);
    }
    return [...resources].sort();
  }

  private executeFunction(
    fn: ts.FunctionLikeDeclaration,
    args: readonly FlowValue[],
    state: FlowState,
    active: ReadonlySet<ts.FunctionLikeDeclaration>,
  ): FlowEvaluation[] {
    const entered = this.cloneState(state);
    fn.parameters.forEach((parameter, index) => {
      const supplied = args[index] ?? this.values(UNKNOWN_ATOM);
      let value = supplied;
      if (parameter.initializer && (supplied.has(UNDEFINED_ATOM) || supplied.has(UNKNOWN_ATOM))) {
        value = this.evaluateExpression(parameter.initializer, this.cloneState(entered), new Set(active))[0]?.value ?? supplied;
      }
      this.bindName(entered, parameter.name, value);
    });
    if (!fn.body) return [{ state: entered, value: this.values(UNKNOWN_ATOM) }];
    if (!ts.isBlock(fn.body)) return this.evaluateExpression(fn.body, entered, new Set(active));
    this.initialiseHoisted(fn.body.statements, entered);
    return this.evaluateStatements(fn.body.statements, [entered], active).map((finished) => {
      const value = finished.outcome === "return" ? new Set(finished.returned) : this.values(UNDEFINED_ATOM);
      const returned = this.cloneState(finished);
      if (returned.outcome === "return") returned.outcome = "normal";
      return { state: returned, value };
    });
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
      ts.isModuleDeclaration(statement) ||
      ts.isClassDeclaration(statement)
    ) {
      return [state];
    }
    if (ts.isExpressionStatement(statement)) {
      return this.evaluateExpression(statement.expression, state, new Set(active)).map((evaluation) => evaluation.state);
    }
    if (ts.isVariableStatement(statement)) {
      let states = [state];
      for (const declaration of statement.declarationList.declarations) {
        states = states.flatMap((current) => {
          if (!declaration.initializer) {
            this.bindName(current, declaration.name, this.values(UNDEFINED_ATOM));
            return [current];
          }
          return this.evaluateExpression(declaration.initializer, current, new Set(active)).map((evaluated) => {
            this.bindName(evaluated.state, declaration.name, evaluated.value);
            return evaluated.state;
          });
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
    state.unsupported = true;
    return [state];
  }

  private evaluateSwitch(
    statement: ts.SwitchStatement,
    state: FlowState,
    active: ReadonlySet<ts.FunctionLikeDeclaration>,
  ): FlowState[] {
    const discriminant = this.literalPrimitive(statement.expression);
    const possible: ts.CaseOrDefaultClause[] = [];
    if (discriminant !== undefined) {
      const matching = statement.caseBlock.clauses.find(
        (clause) => ts.isCaseClause(clause) && this.literalPrimitive(clause.expression) === discriminant,
      );
      const fallback = statement.caseBlock.clauses.find(ts.isDefaultClause);
      if (matching) possible.push(matching);
      else if (fallback) possible.push(fallback);
    } else {
      possible.push(...statement.caseBlock.clauses);
    }
    if (!possible.length) return [state];
    const results = possible.flatMap((clause) =>
      this.evaluateStatements(clause.statements, [this.cloneState(state)], active).map((result) => {
        if (result.outcome === "break") result.outcome = "normal";
        return result;
      }),
    );
    if (discriminant === undefined && !statement.caseBlock.clauses.some(ts.isDefaultClause)) {
      results.push(this.cloneState(state));
    }
    return results;
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
    return this.evaluateExpression(statement.expression, state, new Set(active)).flatMap((iterable) => {
      const one = this.cloneState(iterable.state);
      const element =
        ts.isArrayLiteralExpression(unwrapExpression(statement.expression)) &&
        unwrapExpression(statement.expression).elements.length > 0
          ? this.evaluateExpression(
              (unwrapExpression(statement.expression) as ts.ArrayLiteralExpression).elements[0] as ts.Expression,
              this.cloneState(one),
              new Set(active),
            )[0]?.value ?? this.values(UNKNOWN_ATOM)
          : this.values(UNKNOWN_ATOM);
      if (ts.isVariableDeclarationList(statement.initializer)) {
        for (const declaration of statement.initializer.declarations) this.bindName(one, declaration.name, element);
      } else {
        this.assignTarget(one, statement.initializer, element);
      }
      const body = this.evaluateStatement(statement.statement, one, active).map((result) => {
        if (result.outcome === "break" || result.outcome === "continue") result.outcome = "normal";
        return result;
      });
      const definitelyNonempty =
        ts.isArrayLiteralExpression(unwrapExpression(statement.expression)) &&
        unwrapExpression(statement.expression).elements.length > 0;
      return definitelyNonempty ? body : [this.cloneState(iterable.state), ...body];
    });
  }

  private evaluateTry(
    statement: ts.TryStatement,
    state: FlowState,
    active: ReadonlySet<ts.FunctionLikeDeclaration>,
  ): FlowState[] {
    const tryStates = this.evaluateStatement(statement.tryBlock, this.cloneState(state), active);
    let states = [...tryStates];
    if (statement.catchClause) {
      const caught = this.cloneState(state);
      if (statement.catchClause.variableDeclaration) {
        this.bindName(caught, statement.catchClause.variableDeclaration.name, this.values(UNKNOWN_ATOM));
      }
      states.push(...this.evaluateStatement(statement.catchClause.block, caught, active));
      states = states.flatMap((candidate) => {
        if (candidate.outcome !== "throw") return [candidate];
        const handled = this.cloneState(candidate);
        handled.outcome = "normal";
        if (statement.catchClause?.variableDeclaration) {
          this.bindName(handled, statement.catchClause.variableDeclaration.name, this.values(UNKNOWN_ATOM));
        }
        return this.evaluateStatement(statement.catchClause!.block, handled, active);
      });
    }
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
    const byOutcome = new Map<FlowOutcome, FlowState>();
    for (const state of states) {
      const merged = byOutcome.get(state.outcome);
      if (!merged) {
        byOutcome.set(state.outcome, this.cloneState(state));
        continue;
      }
      for (const [symbol, value] of state.cells) {
        const target = merged.cells.get(symbol) ?? new Set<FlowAtom>();
        for (const atom of value) target.add(atom);
        merged.cells.set(symbol, target);
      }
      for (const dirty of state.dirty) merged.dirty.add(dirty);
      merged.witnessCount = Math.max(merged.witnessCount, state.witnessCount);
      merged.awaitedWitnessCount = Math.max(merged.awaitedWitnessCount, state.awaitedWitnessCount);
      for (const resource of state.witnessResources) merged.witnessResources.add(resource);
      merged.unsupported ||= state.unsupported;
    }
    return [...byOutcome.values()];
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
    return {
      ...(dirtySupabase ? { mockedReceiver: "Supabase" as const } : dirtyPostgres ? { mockedReceiver: "Postgres" as const } : {}),
      mockedWitness: allStates.some((state) => state.dirty.has(WITNESS_ATOM)),
      ...(witnessCounts.length ? { witnessCount: Math.max(...witnessCounts) } : {}),
      ...(awaitedCounts.length ? { awaitedWitnessCount: Math.max(...awaitedCounts) } : {}),
      queryResources,
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

  private bindingSource(identifier: ts.Identifier): { source: ts.Expression; property?: string } | undefined {
    const symbol = this.symbol(identifier);
    const declaration = symbol?.declarations?.find(
      (candidate): candidate is ts.VariableDeclaration | ts.BindingElement =>
        ts.isVariableDeclaration(candidate) || ts.isBindingElement(candidate),
    );
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
      return { source: declaration.initializer };
    }
    if (declaration && ts.isBindingElement(declaration)) {
      let current: ts.Node = declaration.parent;
      while (!ts.isVariableDeclaration(current) && current.parent) current = current.parent;
      if (!ts.isVariableDeclaration(current) || !current.initializer) return undefined;
      const property = declaration.propertyName;
      return {
        source: current.initializer,
        property:
          property && (ts.isIdentifier(property) || ts.isStringLiteralLike(property))
            ? property.text
            : declaration.name.getText(this.sourceFile),
      };
    }
    return undefined;
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
      const binding = this.bindingSource(expression);
      if (!binding) return new Set();
      checking.add(symbol);
      const base = this.frameworkTags(binding.source, checking);
      checking.delete(symbol);
      return binding.property ? this.frameworkMemberTags(base, binding.property) : base;
    }
    if (ts.isPropertyAccessExpression(expression)) {
      return this.frameworkMemberTags(this.frameworkTags(expression.expression, checking), expression.name.text);
    }
    if (ts.isElementAccessExpression(expression) && expression.argumentExpression) {
      const key = unwrapExpression(expression.argumentExpression);
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
    if ((base.has("vi") || base.has("jest")) && ["mock", "doMock", "mocked", "spyOn", "replaceProperty"].includes(member)) {
      return new Set([member as FrameworkTag]);
    }
    return new Set();
  }

  moduleMockKind(call: ts.CallExpression): "mock" | "doMock" | undefined {
    const tags = this.frameworkTags(call.expression);
    return tags.has("mock") ? "mock" : tags.has("doMock") ? "doMock" : undefined;
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
      const binding = this.bindingSource(expression);
      if (!binding) return [];
      checking.add(symbol);
      const values =
        binding.property && this.frameworkTags(binding.source, checking).has("vitest")
          ? binding.property === "describe"
            ? [{ kind: "suite", state: "enabled" } satisfies RegistrationValue]
            : ["it", "test"].includes(binding.property)
              ? [{ kind: "test", state: "enabled" } satisfies RegistrationValue]
              : []
          : this.registrationValues(binding.source, checking);
      checking.delete(symbol);
      return binding.property ? this.registrationMember(values, binding.property) : values;
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
      return [
        ...this.registrationValues(expression.whenTrue, checking),
        ...this.registrationValues(expression.whenFalse, checking),
      ];
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
}

function runnableTests(sf: ts.SourceFile): RunnableTest[] {
  const tests: RunnableTest[] = [];
  const describeStack: string[] = [];
  const engine = new LocalFlowEngine(sf);
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const registration = engine.registration(node);
      if (registration && registration.state !== "enabled") return;
      const titleArg = node.arguments[0];
      const title = titleArg && ts.isStringLiteralLike(titleArg) ? titleArg.text : "";
      if (registration?.kind === "suite") {
        describeStack.push(title);
        ts.forEachChild(node, visit);
        describeStack.pop();
        return;
      }
      if (registration?.kind === "test") {
        tests.push({ fullName: [...describeStack, title].filter(Boolean).join(" "), call: node });
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
