import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");

describe("Codex project configuration", () => {
  it("keeps the Codex reviewer policy aligned with the canonical Claude reviewer", () => {
    const claude = readFileSync(join(ROOT, ".claude/agents/pre-pr-reviewer.md"), "utf8");
    const codex = readFileSync(join(ROOT, ".codex/agents/pre-pr-reviewer.toml"), "utf8");
    const claudeBody = claude
      .slice(claude.indexOf("# Pre-PR Reviewer"))
      .replaceAll("CLAUDE.md", "AGENTS.md")
      .trimEnd();
    const prefix = "developer_instructions = '''\n";
    const codexBody = codex.slice(codex.indexOf(prefix) + prefix.length, codex.lastIndexOf("\n'''"));

    expect(codexBody.trimEnd()).toBe(claudeBody);
  });

  it("uses portable commands that target the canonical hook scripts", () => {
    const config = JSON.parse(readFileSync(join(ROOT, ".codex/hooks.json"), "utf8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const commands = Object.values(config.hooks).flatMap((groups) =>
      groups.flatMap((group) => group.hooks.map((hook) => hook.command)),
    );

    expect(commands).toHaveLength(5);
    expect(commands.every((command) => command.includes("$(git rev-parse --show-toplevel)"))).toBe(true);
    expect(commands.every((command) => command.includes('CLAUDE_PROJECT_DIR="$repo_root"'))).toBe(true);
    expect(commands.every((command) => !command.includes("/Users/"))).toBe(true);
    for (const command of commands) {
      const target = command.match(/\/(\.claude\/hooks\/[^\"]+)/)?.[1];
      if (!target) throw new Error(`Codex hook command has no canonical target: ${command}`);
      expect(existsSync(join(ROOT, target))).toBe(true);
    }
  });
});
