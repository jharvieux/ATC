import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import { redactSecrets } from "./lib/redact-secrets";

const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/;
const EXTENSIONS = ["pg_trgm", "vector"] as const;

interface ProbeConnection {
  unsafe(query: string): PromiseLike<readonly Record<string, unknown>[]>;
  release(): void;
}

interface TargetIdentity {
  hostFingerprint: string;
  projectRef: string;
  projectRefFingerprint: string;
}

interface ProbeSnapshot {
  identity: readonly Record<string, unknown>[];
  memberships: readonly Record<string, unknown>[];
  extensions: readonly Record<string, unknown>[];
  schemas: readonly Record<string, unknown>[];
  migrationLedger: {
    count: number;
    digest: string;
  };
}

interface AlterResult {
  extension: (typeof EXTENSIONS)[number];
  status: "succeeded" | "failed";
  error?: string;
}

interface ProbeEvidence {
  revision: string;
  target: TargetIdentity;
  before: ProbeSnapshot;
  transactional: ProbeSnapshot | null;
  after: ProbeSnapshot;
  alters: AlterResult[];
  rollbackEqual: boolean;
  outcome: "success" | "failure";
  error?: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function digestLedgerRows(rows: readonly unknown[]): string {
  return sha256(rows.map(canonicalJson).sort().join("\n"));
}

export function snapshotsEqual(before: ProbeSnapshot, after: ProbeSnapshot): boolean {
  return canonicalJson(before) === canonicalJson(after);
}

export function assertExpectedTarget(dbUrl: string, expectedProjectRef: string): TargetIdentity {
  if (!PROJECT_REF_PATTERN.test(expectedProjectRef)) {
    throw new Error("PROBE_ALLOWED_PROJECT_REF must be an exact 20-character project ref");
  }
  let parsed: URL;
  try {
    parsed = new URL(dbUrl);
  } catch {
    throw new Error("PROBE_DB_URL is not a valid URL");
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("PROBE_DB_URL must use postgres:// or postgresql://");
  }

  const directHost = parsed.hostname.match(/^db\.([a-z0-9]{20})\.supabase\.co$/);
  const projectRef =
    directHost?.[1] ??
    decodeURIComponent(parsed.username)
      .split(".")
      .findLast((segment) => PROJECT_REF_PATTERN.test(segment)) ??
    null;
  if (!projectRef) {
    throw new Error("Could not prove the Supabase project ref from PROBE_DB_URL; refusing target");
  }
  if (projectRef !== expectedProjectRef) {
    throw new Error("PROBE_DB_URL does not match the explicitly authorized project ref");
  }

  return {
    hostFingerprint: sha256(parsed.hostname).slice(0, 16),
    projectRef: `${projectRef.slice(0, 4)}…${projectRef.slice(-4)}`,
    projectRefFingerprint: sha256(projectRef).slice(0, 16),
  };
}

function sanitizeError(error: unknown): string {
  return redactSecrets(error).replace(/[a-z0-9]{20}/g, "[redacted-project-ref]");
}

async function captureSnapshot(connection: ProbeConnection): Promise<ProbeSnapshot> {
  const identity = await connection.unsafe(`
    SELECT
      current_user::text AS current_user,
      session_user::text AS session_user,
      current_database()::text AS database,
      current_setting('server_version')::text AS server_version,
      r.rolsuper,
      r.rolinherit,
      r.rolcreaterole,
      r.rolcreatedb,
      r.rolcanlogin,
      r.rolreplication,
      r.rolbypassrls
    FROM pg_roles r
    WHERE r.rolname = current_user
  `);

  const memberships = await connection.unsafe(`
    SELECT
      member_role.rolname::text AS member,
      granted_role.rolname::text AS granted_role,
      grantor_role.rolname::text AS grantor,
      to_jsonb(m) - 'roleid' - 'member' - 'grantor' AS options
    FROM pg_auth_members m
    JOIN pg_roles member_role ON member_role.oid = m.member
    JOIN pg_roles granted_role ON granted_role.oid = m.roleid
    JOIN pg_roles grantor_role ON grantor_role.oid = m.grantor
    WHERE member_role.rolname IN (current_user, session_user)
    ORDER BY member_role.rolname, granted_role.rolname, grantor_role.rolname
  `);

  const extensions = await connection.unsafe(`
    SELECT
      e.extname::text AS extension,
      n.nspname::text AS schema,
      owner_role.rolname::text AS owner,
      e.extversion::text AS version,
      e.extrelocatable AS relocatable
    FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
    JOIN pg_roles owner_role ON owner_role.oid = e.extowner
    WHERE e.extname IN ('pg_trgm', 'vector')
    ORDER BY e.extname
  `);

  const schemas = await connection.unsafe(`
    SELECT
      n.nspname::text AS schema,
      owner_role.rolname::text AS owner,
      COALESCE(n.nspacl::text, '') AS acl,
      has_schema_privilege(current_user, n.oid, 'USAGE') AS current_role_has_usage,
      has_schema_privilege(current_user, n.oid, 'CREATE') AS current_role_has_create
    FROM pg_namespace n
    JOIN pg_roles owner_role ON owner_role.oid = n.nspowner
    WHERE n.nspname IN ('extensions', 'public')
    ORDER BY n.nspname
  `);

  const ledgerRows = await connection.unsafe(`
    SELECT to_jsonb(m) AS row
    FROM supabase_migrations.schema_migrations m
  `);
  const normalizedLedgerRows = ledgerRows.map((entry) => entry.row);

  return {
    identity,
    memberships,
    extensions,
    schemas,
    migrationLedger: {
      count: normalizedLedgerRows.length,
      digest: digestLedgerRows(normalizedLedgerRows),
    },
  };
}

function fingerprint(value: unknown): string {
  return sha256(canonicalJson(value));
}

function redactedSnapshot(snapshot: ProbeSnapshot): Record<string, unknown> {
  return {
    identity: {
      count: snapshot.identity.length,
      digest: fingerprint(snapshot.identity),
    },
    memberships: {
      count: snapshot.memberships.length,
      digest: fingerprint(snapshot.memberships),
    },
    extensions: snapshot.extensions.map((extension) => ({
      extension: extension.extension,
      schema: extension.schema,
      ownerFingerprint: fingerprint(extension.owner),
      version: extension.version,
      relocatable: extension.relocatable,
    })),
    schemas: snapshot.schemas.map((schema) => ({
      schema: schema.schema,
      ownerFingerprint: fingerprint(schema.owner),
      aclFingerprint: fingerprint(schema.acl),
      currentRoleHasUsage: schema.current_role_has_usage,
      currentRoleHasCreate: schema.current_role_has_create,
    })),
    migrationLedger: snapshot.migrationLedger,
    fullSnapshotDigest: fingerprint(snapshot),
  };
}

async function runProbe(
  dbUrl: string,
  revision: string,
  allowedProjectRef: string,
): Promise<ProbeEvidence> {
  const target = assertExpectedTarget(dbUrl, allowedProjectRef);
  const client = postgres(dbUrl, {
    connect_timeout: 15,
    idle_timeout: 5,
    max: 1,
    prepare: false,
  });
  const connection = (await client.reserve()) as unknown as ProbeConnection;

  try {
    const before = await captureSnapshot(connection);
    if (before.extensions.length !== EXTENSIONS.length) {
      throw new Error("Both pg_trgm and vector must be installed before probing");
    }
    for (const extension of before.extensions) {
      if (extension.schema !== "extensions") {
        throw new Error(`${String(extension.extension)} is not in extensions; refusing stale probe`);
      }
    }
    if (!before.schemas.some((schema) => schema.schema === "extensions")) {
      throw new Error("The extensions schema does not exist; ALTER authorization cannot be isolated");
    }

    const alters: AlterResult[] = [];
    let transactional: ProbeSnapshot | null = null;
    let transactionError: unknown = null;
    let transactionOpen = false;

    try {
      await connection.unsafe("BEGIN");
      transactionOpen = true;
      await connection.unsafe("SET LOCAL lock_timeout = '10s'");
      await connection.unsafe("SET LOCAL statement_timeout = '60s'");

      for (const extension of EXTENSIONS) {
        try {
          await connection.unsafe(`ALTER EXTENSION ${extension} SET SCHEMA public`);
          alters.push({ extension, status: "succeeded" });
        } catch (error) {
          alters.push({ extension, status: "failed", error: sanitizeError(error) });
          throw error;
        }
      }

      transactional = await captureSnapshot(connection);
      for (const extensionName of EXTENSIONS) {
        const extension = transactional.extensions.find(
          (entry) => entry.extension === extensionName,
        );
        if (extension?.schema !== "public") {
          throw new Error(`${extensionName} did not resolve to public inside the transaction`);
        }
      }
    } catch (error) {
      transactionError = error;
    } finally {
      if (transactionOpen) await connection.unsafe("ROLLBACK");
    }

    const after = await captureSnapshot(connection);
    const rollbackEqual = snapshotsEqual(before, after);
    const failure = transactionError
      ? sanitizeError(transactionError)
      : rollbackEqual
        ? null
        : "Before/after state differs after ROLLBACK";

    return {
      revision,
      target,
      before,
      transactional,
      after,
      alters,
      rollbackEqual,
      outcome: failure ? "failure" : "success",
      ...(failure ? { error: failure } : {}),
    };
  } finally {
    connection.release();
    await client.end();
  }
}

async function main(): Promise<void> {
  const dbUrl = process.env.PROBE_DB_URL;
  const allowedProjectRef = process.env.PROBE_ALLOWED_PROJECT_REF;
  const expectedRevision = process.env.PROBE_EXPECTED_REVISION;
  const actualRevision = process.env.PROBE_ACTUAL_REVISION;

  if (!dbUrl) throw new Error("PROBE_DB_URL is required; refusing to skip the authorization probe");
  if (!allowedProjectRef) {
    throw new Error("PROBE_ALLOWED_PROJECT_REF is required; refusing an unattested target");
  }
  if (!expectedRevision || !/^[0-9a-f]{40}$/.test(expectedRevision)) {
    throw new Error("PROBE_EXPECTED_REVISION must be a full lowercase SHA");
  }
  if (actualRevision !== expectedRevision) {
    throw new Error("PROBE_ACTUAL_REVISION does not match the requested content address");
  }

  const evidence = await runProbe(dbUrl, expectedRevision, allowedProjectRef);
  console.log(`probe.revision=${evidence.revision}`);
  console.log(`probe.target=${canonicalJson(evidence.target)}`);
  console.log(`probe.before=${canonicalJson(redactedSnapshot(evidence.before))}`);
  for (const alter of evidence.alters) {
    console.log(`probe.alter.${alter.extension}=${alter.status}${alter.error ? `:${alter.error}` : ""}`);
  }
  if (evidence.transactional) {
    console.log(`probe.transactional=${canonicalJson(redactedSnapshot(evidence.transactional))}`);
  }
  console.log(`probe.after=${canonicalJson(redactedSnapshot(evidence.after))}`);
  console.log(`probe.rollback_equality=${evidence.rollbackEqual ? "PASS" : "FAIL"}`);
  console.log(`probe.outcome=${evidence.outcome.toUpperCase()}`);

  if (evidence.outcome !== "success") {
    throw new Error(evidence.error ?? "RAG extension relocation probe failed");
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((error) => {
    console.error(`probe-rag-extension-relocation: ${sanitizeError(error)}`);
    process.exit(1);
  });
}
