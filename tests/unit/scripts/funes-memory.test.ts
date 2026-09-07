import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exportDecisionMemory,
  indexDecisionMemory,
  parseDecisionLog,
  parseIndex,
  recallDecisionMemory,
  renderDecisionJsonl,
  runCli,
  validateDecisionIndexes,
  type ChildInvocation,
  type ChildResult,
} from "../../../scripts/funes-memory";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "atc-funes-memory-"));
  roots.push(root);
  return root;
}

function decision(
  id: string,
  date: string,
  title: string,
  body: string,
): string {
  return `## ${id} — ${date} — ${title}\n\n${body}`;
}

function indexLine(id: string, date: string, title: string): string {
  return `- ${id} — ${date} — ${title}`;
}

function writeInputs(
  root: string,
  entries: Array<{ id: string; date: string; title: string; body: string }>,
  leanIds: string[] = entries.map((entry) => entry.id),
  archiveIds: string[] = [],
): void {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  writeFileSync(
    path.join(root, "MEMORY.md"),
    `# Decision log\n\n${entries
      .map((entry) => decision(entry.id, entry.date, entry.title, entry.body))
      .join("\n\n---\n\n")}\n`,
    "utf8",
  );
  writeFileSync(
    path.join(root, "MEMORY-INDEX.md"),
    `# Lean\n\n## Entries\n\n${leanIds
      .map((id) => {
        const entry = byId.get(id)!;
        return indexLine(id, entry.date, entry.title);
      })
      .join("\n")}\n`,
    "utf8",
  );
  writeFileSync(
    path.join(root, "MEMORY-INDEX-ARCHIVE.md"),
    `# Archive\n\n## Entries\n\n${archiveIds
      .map((id) => {
        const entry = byId.get(id)!;
        return indexLine(id, entry.date, entry.title);
      })
      .join("\n")}\n`,
    "utf8",
  );
}

function oneEntry(root: string): void {
  writeInputs(root, [
    {
      id: "D-091b",
      date: "2026-05-26",
      title: "Rules",
      body: "Keep the rationale.",
    },
  ]);
}

function ok(stdout = ""): ChildResult {
  return { status: 0, signal: null, stdout, stderr: "" };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("decision and index parsing", () => {
  it("accepts suffixed IDs and slices entries at the next header without requiring separators", () => {
    const text =
      "# Log\n\n" +
      decision(
        "D-091b",
        "2026-05-26",
        "First",
        "before\n\n---\n\na separator inside the entry",
      ) +
      "\n\n" +
      decision("D-092", "2026-05-27", "Second", "second body") +
      "\n";

    const entries = parseDecisionLog(text);

    expect(entries.map((entry) => entry.id)).toEqual(["D-091b", "D-092"]);
    expect(entries[0]!.text).toContain("a separator inside the entry");
    expect(entries[0]!.text).not.toContain("## D-092");
    expect(entries[1]!.text).toContain("second body");
  });

  it("rejects duplicate and malformed decision IDs instead of silently dropping them", () => {
    expect(() =>
      parseDecisionLog(
        `${decision("D-101", "2026-06-01", "One", "a")}\n${decision(
          "D-101",
          "2026-06-02",
          "Two",
          "b",
        )}`,
      ),
    ).toThrow(/duplicate.*D-101/i);
    expect(() =>
      parseDecisionLog("## D-091B — 2026-05-26 — Wrong suffix\n\nbody\n"),
    ).toThrow(/malformed decision header.*D-091B/i);
    expect(() =>
      parseDecisionLog("## D-nope — 2026-05-26 — Wrong id\n\nbody\n"),
    ).toThrow(/malformed decision header.*D-nope/i);
  });

  it("requires each index to be internally unique", () => {
    expect(() =>
      parseIndex(
        `${indexLine("D-101", "2026-06-01", "One")}\n${indexLine("D-101", "2026-06-01", "One again")}\n`,
        "MEMORY-INDEX.md",
      ),
    ).toThrow(/duplicate.*D-101/i);
  });

  it("rejects lean/archive overlap and a union that differs from MEMORY.md", () => {
    expect(() =>
      validateDecisionIndexes(
        ["D-101", "D-100"],
        ["D-101"],
        ["D-101", "D-100"],
      ),
    ).toThrow(/both.*D-101/i);
    expect(() =>
      validateDecisionIndexes(["D-101", "D-100"], ["D-101"], []),
    ).toThrow(/missing.*D-100/i);
    expect(() =>
      validateDecisionIndexes(["D-101"], ["D-101", "D-099"], []),
    ).toThrow(/not in MEMORY\.md.*D-099/i);
  });
});

describe("synthetic Codex export", () => {
  it("renders exactly the two records consumed by Funes 1.3.0 with stable key order", () => {
    const entry = parseDecisionLog(
      `${decision("D-091b", "2026-05-26", "Rules", "Keep it.")}\n`,
    )[0]!;

    const rendered = renderDecisionJsonl(entry);
    const lines = rendered.trimEnd().split("\n");

    expect(rendered.endsWith("\n")).toBe(true);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      '{"timestamp":"2026-05-26T00:00:00.000Z","type":"session_meta","payload":{"id":"atc-memory-D-091b","timestamp":"2026-05-26T00:00:00.000Z","cwd":"/ai-travel-concierge"}}',
    );
    const meta = JSON.parse(lines[0]!);
    const message = JSON.parse(lines[1]!);
    expect(Object.keys(meta)).toEqual(["timestamp", "type", "payload"]);
    expect(Object.keys(meta.payload)).toEqual(["id", "timestamp", "cwd"]);
    expect(message).toEqual({
      timestamp: "2026-05-26T00:00:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: entry.text }],
      },
    });
  });

  it("keeps unchanged files byte-identical and preserves their mtimes", () => {
    const root = tempRoot();
    oneEntry(root);
    const first = exportDecisionMemory(root);
    const file = path.join(first.sourceDir, "D-091b.jsonl");
    const old = new Date("2020-01-02T03:04:05.000Z");
    utimesSync(file, old, old);
    const before = readFileSync(file);
    const beforeMtime = statSync(file).mtimeMs;

    const second = exportDecisionMemory(root);

    expect(second.created).toEqual([]);
    expect(second.unchanged).toEqual(["D-091b"]);
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(statSync(file).mtimeMs).toBe(beforeMtime);
  });

  it("allows append-only additions without rewriting historical files", () => {
    const root = tempRoot();
    const oldEntry = {
      id: "D-100",
      date: "2026-06-01",
      title: "Old",
      body: "old body",
    };
    writeInputs(root, [oldEntry]);
    const first = exportDecisionMemory(root);
    const oldFile = path.join(first.sourceDir, "D-100.jsonl");
    const oldTime = new Date("2020-01-02T03:04:05.000Z");
    utimesSync(oldFile, oldTime, oldTime);

    writeInputs(root, [
      { id: "D-101", date: "2026-06-02", title: "New", body: "new body" },
      oldEntry,
    ]);
    const second = exportDecisionMemory(root);

    expect(second.created).toEqual(["D-101"]);
    expect(second.unchanged).toEqual(["D-100"]);
    expect(statSync(oldFile).mtimeMs).toBe(oldTime.getTime());
    expect(
      readFileSync(path.join(first.sourceDir, "D-101.jsonl"), "utf8"),
    ).toContain("new body");
  });

  it("refuses source mutations before overwriting an existing historical export", () => {
    const root = tempRoot();
    oneEntry(root);
    const first = exportDecisionMemory(root);
    const file = path.join(first.sourceDir, "D-091b.jsonl");
    const before = readFileSync(file);
    writeInputs(root, [
      {
        id: "D-091b",
        date: "2026-05-26",
        title: "Rules",
        body: "mutated rationale",
      },
    ]);

    expect(() => exportDecisionMemory(root)).toThrow(
      /changed historical.*D-091b.*rebuild/i,
    );
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it("refuses a changed historical generated file", () => {
    const root = tempRoot();
    oneEntry(root);
    const result = exportDecisionMemory(root);
    writeFileSync(
      path.join(result.sourceDir, "D-091b.jsonl"),
      "manually changed\n",
      "utf8",
    );

    expect(() => exportDecisionMemory(root)).toThrow(
      /changed historical.*D-091b.*rebuild/i,
    );
  });

  it("refuses removed IDs and unexplained source-directory extras", () => {
    const removedRoot = tempRoot();
    const old = {
      id: "D-100",
      date: "2026-06-01",
      title: "Old",
      body: "old body",
    };
    const keep = {
      id: "D-101",
      date: "2026-06-02",
      title: "Keep",
      body: "keep body",
    };
    writeInputs(removedRoot, [keep, old]);
    exportDecisionMemory(removedRoot);
    writeInputs(removedRoot, [keep]);
    expect(() => exportDecisionMemory(removedRoot)).toThrow(
      /removed IDs.*D-100\.jsonl.*rebuild/i,
    );

    const extraRoot = tempRoot();
    oneEntry(extraRoot);
    const result = exportDecisionMemory(extraRoot);
    writeFileSync(
      path.join(result.sourceDir, "surprise.jsonl"),
      "{}\n",
      "utf8",
    );
    expect(() => exportDecisionMemory(extraRoot)).toThrow(
      /removed IDs or unexplained extras.*surprise\.jsonl.*rebuild/i,
    );
  });

  it("uses the independent manifest to reject missing historical witnesses", () => {
    const removedRoot = tempRoot();
    const old = {
      id: "D-100",
      date: "2026-06-01",
      title: "Old",
      body: "old body",
    };
    const keep = {
      id: "D-101",
      date: "2026-06-02",
      title: "Keep",
      body: "keep body",
    };
    writeInputs(removedRoot, [keep, old]);
    const removedExport = exportDecisionMemory(removedRoot);
    rmSync(path.join(removedExport.sourceDir, "D-100.jsonl"));
    writeInputs(removedRoot, [keep]);
    expect(() => exportDecisionMemory(removedRoot)).toThrow(
      /historical generated files are missing.*D-100\.jsonl.*rebuild/i,
    );

    const mutatedRoot = tempRoot();
    oneEntry(mutatedRoot);
    const mutatedExport = exportDecisionMemory(mutatedRoot);
    rmSync(path.join(mutatedExport.sourceDir, "D-091b.jsonl"));
    writeInputs(mutatedRoot, [
      {
        id: "D-091b",
        date: "2026-05-26",
        title: "Rules",
        body: "mutated rationale",
      },
    ]);
    expect(() => exportDecisionMemory(mutatedRoot)).toThrow(
      /historical generated files are missing.*D-091b\.jsonl.*rebuild/i,
    );
  });

  it("rejects selective witness cleanup while the old Funes index survives", () => {
    const root = tempRoot();
    const old = {
      id: "D-100",
      date: "2026-06-01",
      title: "Old",
      body: "old body",
    };
    const keep = {
      id: "D-101",
      date: "2026-06-02",
      title: "Keep",
      body: "keep body",
    };
    writeInputs(root, [keep, old]);
    exportDecisionMemory(root);
    const state = path.join(root, ".funes-atc");
    mkdirSync(path.join(state, "memory"));
    writeFileSync(path.join(state, "memory", "state.json"), "old index\n");
    rmSync(path.join(state, "source"), { recursive: true });
    rmSync(path.join(state, "export-manifest.json"));
    writeInputs(root, [
      { ...keep, body: "mutated body" },
    ]);

    expect(() => exportDecisionMemory(root)).toThrow(
      /pre-existing local Funes state without its export manifest.*rebuild/i,
    );
  });

  it("reads only the decision log and its two indexes, never SESSION.md", () => {
    const root = tempRoot();
    oneEntry(root);
    writeFileSync(path.join(root, "SESSION.md"), "must not be indexed", "utf8");
    const reads: string[] = [];
    const realRead = fs.readFileSync.bind(fs);
    vi.spyOn(fs, "readFileSync").mockImplementation(((
      file: fs.PathOrFileDescriptor,
      ...args: unknown[]
    ) => {
      reads.push(String(file));
      return Reflect.apply(realRead, fs, [file, ...args]);
    }) as typeof fs.readFileSync);

    exportDecisionMemory(root);

    expect(reads.some((file) => path.basename(file) === "SESSION.md")).toBe(
      false,
    );
    expect(new Set(reads.map((file) => path.basename(file)))).toEqual(
      new Set(["MEMORY.md", "MEMORY-INDEX.md", "MEMORY-INDEX-ARCHIVE.md"]),
    );
  });
});

describe("local-only Funes commands", () => {
  it("exports first, pins Funes 1.3.0, and uses sanitized local paths and argv without a shell", () => {
    const root = tempRoot();
    oneEntry(root);
    const calls: ChildInvocation[] = [];
    const run = (invocation: ChildInvocation): ChildResult => {
      calls.push(invocation);
      expect(
        readFileSync(path.join(root, ".funes-atc/source/D-091b.jsonl"), "utf8"),
      ).toContain("Keep the rationale");
      return calls.length === 1 ? ok("funes 1.3.0\n") : ok();
    };

    indexDecisionMemory({
      repoRoot: root,
      env: {
        PATH: process.env.PATH,
        SAFE: "kept",
        HF_TOKEN: "secret-1",
        HF_TOKEN_PATH: "/tmp/operator-token",
        HF_ENDPOINT: "https://attacker.invalid",
        HF_HUB_CACHE: "/outside/hub",
        HUGGINGFACE_HUB_CACHE: "/outside/legacy",
        HF_XET_CACHE: "/outside/xet",
        HF_ASSETS_CACHE: "/outside/assets",
        HF_HUB_DISABLE_IMPLICIT_TOKEN: "0",
        HUGGING_FACE_HUB_TOKEN: "secret-2",
        HUGGINGFACE_TOKEN: "secret-3",
        FUNES_MEMORY: "owner/remote-memory",
        HF_FUTURE_ESCAPE: "/outside/future-cache",
        HUGGINGFACE_FUTURE_ESCAPE: "/outside/future-huggingface",
        HUGGING_FACE_FUTURE_ESCAPE: "/outside/future-hugging-face",
      },
      run,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.command).toBe("funes");
    expect(calls[0]!.args).toEqual(["--version"]);
    expect(calls[1]!.args).toEqual([
      "index",
      path.join(root, ".funes-atc/source"),
      "--harness",
      "codex",
      "--yes",
      "--no-thinking",
    ]);
    for (const call of calls) {
      expect(call.shell).toBe(false);
      expect(call.env.SAFE).toBe("kept");
      expect(call.env.FUNES_HOME).toBe(path.join(root, ".funes-atc"));
      expect(call.env.HF_HOME).toBe(path.join(root, ".funes-atc/hf-home"));
      expect(call.env.HF_HUB_CACHE).toBe(
        path.join(root, ".funes-atc/hf-home/hub"),
      );
      expect(call.env.HUGGINGFACE_HUB_CACHE).toBe(
        path.join(root, ".funes-atc/hf-home/hub"),
      );
      expect(call.env.HF_XET_CACHE).toBe(
        path.join(root, ".funes-atc/hf-home/xet"),
      );
      expect(call.env.HF_ASSETS_CACHE).toBe(
        path.join(root, ".funes-atc/hf-home/assets"),
      );
      expect(call.env.HF_HUB_DISABLE_IMPLICIT_TOKEN).toBe("1");
      for (const secret of [
        "HF_TOKEN",
        "HF_TOKEN_PATH",
        "HF_ENDPOINT",
        "HUGGING_FACE_HUB_TOKEN",
        "HUGGINGFACE_TOKEN",
        "FUNES_MEMORY",
        "HF_FUTURE_ESCAPE",
        "HUGGINGFACE_FUTURE_ESCAPE",
        "HUGGING_FACE_FUTURE_ESCAPE",
      ]) {
        expect(call.env).not.toHaveProperty(secret);
      }
    }
  });

  it("refuses any Funes version other than 1.3.0 before indexing", () => {
    const root = tempRoot();
    oneEntry(root);
    const calls: ChildInvocation[] = [];

    expect(() =>
      indexDecisionMemory({
        repoRoot: root,
        run: (invocation) => {
          calls.push(invocation);
          return ok("funes 1.3.1\n");
        },
      }),
    ).toThrow(/requires Funes 1\.3\.0.*1\.3\.1/i);
    expect(calls).toHaveLength(1);
  });

  it("refuses nested state symlinks before Funes can write through them", () => {
    const root = tempRoot();
    const outside = tempRoot();
    const state = path.join(root, ".funes-atc");
    mkdirSync(state);
    symlinkSync(outside, path.join(state, "hf-home"));
    let called = false;

    expect(() =>
      recallDecisionMemory("why?", {
        repoRoot: root,
        run: () => {
          called = true;
          return ok();
        },
      }),
    ).toThrow(/Funes symlink that escapes state.*hf-home/i);
    expect(called).toBe(false);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("refuses a symlinked local state root before invoking Funes", () => {
    const root = tempRoot();
    const outside = tempRoot();
    symlinkSync(outside, path.join(root, ".funes-atc"));
    let called = false;

    expect(() =>
      recallDecisionMemory("why?", {
        repoRoot: root,
        run: () => {
          called = true;
          return ok();
        },
      }),
    ).toThrow(/state root that is not a real directory/i);
    expect(called).toBe(false);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("allows Hugging Face-style symlinks that stay inside local state", () => {
    const root = tempRoot();
    const huggingface = path.join(root, ".funes-atc", "hf-home");
    const model = path.join(huggingface, "hub", "models--BAAI--bge-small");
    mkdirSync(path.join(model, "blobs"), { recursive: true });
    mkdirSync(path.join(model, "snapshots", "commit"), { recursive: true });
    writeFileSync(path.join(model, "blobs", "hash"), "local model\n");
    symlinkSync(
      path.join("..", "..", "blobs", "hash"),
      path.join(model, "snapshots", "commit", "model"),
    );
    const calls: ChildInvocation[] = [];

    recallDecisionMemory("why?", {
      repoRoot: root,
      run: (invocation) => {
        calls.push(invocation);
        return ok();
      },
    });

    expect(calls).toHaveLength(1);
  });

  it("pins recall to local memory with no recency decay and rejects blank queries", () => {
    const root = tempRoot();
    const calls: ChildInvocation[] = [];
    expect(() =>
      recallDecisionMemory("  ", { repoRoot: root, run: () => ok() }),
    ).toThrow(/non-empty query/i);

    recallDecisionMemory("  --memory owner/remote why was this chosen?  ", {
      repoRoot: root,
      env: {
        PATH: process.env.PATH,
        HF_TOKEN: "secret",
        FUNES_MEMORY: "owner/remote",
      },
      run: (invocation) => {
        calls.push(invocation);
        return ok();
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual([
      "recall",
      "--memory",
      "local",
      "--half-life",
      "0",
      "--",
      "--memory owner/remote why was this chosen?",
    ]);
    expect(calls[0]!.env).not.toHaveProperty("HF_TOKEN");
    expect(calls[0]!.env).not.toHaveProperty("FUNES_MEMORY");
  });

  it("exposes only export, index, and recall subcommands", () => {
    const root = tempRoot();
    expect(() =>
      runCli(["push", "owner/memory"], { repoRoot: root, run: () => ok() }),
    ).toThrow(/unknown subcommand.*push.*export.*index.*recall/i);
  });

  it("tells recall operators to verify every hit against MEMORY.md", () => {
    const root = tempRoot();
    const notice = vi.spyOn(console, "error").mockImplementation(() => {});

    runCli(["recall", "why was this chosen?"], {
      repoRoot: root,
      run: () => ok(),
    });

    expect(notice).toHaveBeenCalledWith(
      expect.stringMatching(/navigation only.*verify every hit.*MEMORY\.md/i),
    );
  });
});
