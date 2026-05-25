import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const FIXTURES_DIR = join(process.cwd(), "tests", "contracts", "fixtures");

interface Fixture {
  _note?: string;
  request: {
    method: string;
    url: string;
    body?: unknown;
  };
  response: {
    status: number;
    headers?: Record<string, string>;
    body: unknown;
  };
}

function loadFixtures(dir: string): Fixture[] {
  // Use withFileTypes so each entry carries its own kind — avoids the
  // TOCTOU pattern of stat-then-read (CodeQL js/file-system-race).
  const fixtures: Fixture[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const dirent of entries) {
    const full = join(dir, dirent.name);
    if (dirent.isDirectory()) {
      fixtures.push(...loadFixtures(full));
    } else if (dirent.isFile() && dirent.name.endsWith(".json")) {
      const raw = JSON.parse(readFileSync(full, "utf8")) as Fixture;
      if (raw.request && raw.response) {
        fixtures.push(raw);
      }
    }
  }
  return fixtures;
}

export function buildHandlers() {
  const fixtures = loadFixtures(FIXTURES_DIR);

  return fixtures.map((fixture) => {
    const method = fixture.request.method.toLowerCase() as
      | "get"
      | "post"
      | "put"
      | "delete"
      | "patch"
      | "head";

    return http[method](fixture.request.url, () => {
      return HttpResponse.json(
        fixture.response.body as Record<string, unknown>,
        {
          status: fixture.response.status,
          headers: fixture.response.headers,
        },
      );
    });
  });
}

export const server = setupServer(...buildHandlers());
