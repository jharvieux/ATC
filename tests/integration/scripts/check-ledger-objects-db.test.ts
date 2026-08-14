import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { resolveRoutineArgumentOid, type RoutineArgument } from "../../../scripts/check-ledger-objects";

const dbUrl = process.env.SUPABASE_TEST_DB_URL;
const describeIf = dbUrl ? describe : describe.skip;

function argument(type: string): RoutineArgument {
  return { declaration: type, typeCandidates: [type] };
}

async function withDatabase(run: (sql: ReturnType<typeof postgres>) => Promise<void>): Promise<void> {
  const sql = postgres(dbUrl!, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    application_name: "atc-ledger-object-test",
  });
  try {
    await run(sql);
  } finally {
    await sql.end();
  }
}

describeIf("ledger routine identity PostgreSQL resolution", () => {
  it("uses PostgreSQL identity for aliases, typmods, float precision, custom types, and %TYPE", async () => {
    await withDatabase(async (sql) => {
      const schema = `ledger_identity_${randomUUID().replaceAll("-", "")}`;
      class Rollback extends Error {}
      try {
        await sql.begin(async (tx) => {
          await tx`CREATE SCHEMA ${tx(schema)}`;
          await tx`CREATE DOMAIN ${tx(schema)}.${tx("email_domain")} AS varchar(320)`;
          await tx`CREATE TYPE ${tx(schema)}.${tx("Payload")} AS (value integer)`;
          await tx`CREATE TABLE ${tx(schema)}.${tx("accounts")} (email ${tx(schema)}.${tx("email_domain")})`;

          const [expected] = await tx<Array<{
            intArray: number;
            varchar: number;
            float20: number;
            float30: number;
            domain: number;
            domainArray: number;
            composite: number;
          }>>`
            SELECT
              to_regtype('integer[]')::oid::int AS "intArray",
              to_regtype('character varying')::oid::int AS varchar,
              to_regtype('real')::oid::int AS "float20",
              to_regtype('double precision')::oid::int AS "float30",
              to_regtype(${`${schema}.email_domain`})::oid::int AS domain,
              to_regtype(${`${schema}.email_domain[]`})::oid::int AS "domainArray",
              to_regtype(${`${schema}.\"Payload\"`})::oid::int AS composite
          `;
          expect(expected).toBeDefined();

          await expect(resolveRoutineArgumentOid(tx, argument("int4[][]"))).resolves.toBe(expected!.intArray);
          await expect(resolveRoutineArgumentOid(tx, argument("varchar(20)"))).resolves.toBe(expected!.varchar);
          await expect(resolveRoutineArgumentOid(tx, argument("float(20)"))).resolves.toBe(expected!.float20);
          await expect(resolveRoutineArgumentOid(tx, argument("float(30)"))).resolves.toBe(expected!.float30);
          await expect(resolveRoutineArgumentOid(tx, argument(`${schema}.email_domain`))).resolves.toBe(expected!.domain);
          await expect(resolveRoutineArgumentOid(tx, argument(`${schema}.email_domain[][]`))).resolves.toBe(expected!.domainArray);
          await expect(resolveRoutineArgumentOid(tx, argument(`"${schema}"."Payload"`))).resolves.toBe(expected!.composite);
          await expect(resolveRoutineArgumentOid(tx, argument(`${schema}.accounts.email%TYPE`))).resolves.toBe(expected!.domain);

          throw new Rollback();
        });
      } catch (error) {
        if (!(error instanceof Rollback)) throw error;
      }

      const [remaining] = await sql<Array<{ schema: string | null }>>`
        SELECT to_regnamespace(${schema})::text AS schema
      `;
      expect(remaining?.schema).toBeNull();
    });
  }, 30000);

  it("fails loud when a custom type depends on search_path", async () => {
    await withDatabase(async (sql) => {
      const suffix = randomUUID().replaceAll("-", "");
      const schemaA = `ledger_a_${suffix}`;
      const schemaB = `ledger_b_${suffix}`;
      const typeName = `shared_${suffix}`;
      class Rollback extends Error {}
      try {
        await sql.begin(async (tx) => {
          await tx`CREATE SCHEMA ${tx(schemaA)}`;
          await tx`CREATE SCHEMA ${tx(schemaB)}`;
          await tx`CREATE DOMAIN ${tx(schemaA)}.${tx(typeName)} AS text`;
          await tx`CREATE DOMAIN ${tx(schemaB)}.${tx(typeName)} AS text`;
          await tx`SET LOCAL search_path = ${tx(schemaA)}, ${tx(schemaB)}, pg_catalog`;

          await expect(resolveRoutineArgumentOid(tx, argument(typeName)))
            .rejects.toThrow(/search-path-dependent/);
          await expect(resolveRoutineArgumentOid(tx, argument("missing_identity_type")))
            .rejects.toThrow(/unresolved routine argument/);

          throw new Rollback();
        });
      } catch (error) {
        if (!(error instanceof Rollback)) throw error;
      }
    });
  }, 30000);
});
