export function parseApplyPatch(command) {
  if (typeof command !== "string") throw new Error("tool_input.command must be a string");

  const lines = command.replaceAll("\r\n", "\n").trimEnd().split("\n");
  if (lines[0] !== "*** Begin Patch" || lines.at(-1) !== "*** End Patch") {
    throw new Error("missing Begin Patch or End Patch marker");
  }

  const sections = [];
  let current;
  for (const line of lines.slice(1, -1)) {
    const header = line.match(/^\*\*\* (Add|Delete|Update) File: (.+)$/);
    if (header) {
      current = { operation: header[1], path: header[2].trim(), lines: [] };
      if (!current.path) throw new Error("patch contains an empty file path");
      sections.push(current);
      continue;
    }
    const move = line.match(/^\*\*\* Move to: (.+)$/);
    if (move) {
      if (!current || current.operation !== "Update" || current.moveTo) {
        throw new Error("invalid Move to marker");
      }
      current.moveTo = move[1].trim();
      if (!current.moveTo) throw new Error("patch contains an empty move target");
      continue;
    }
    if (!current) {
      if (line.trim()) throw new Error("content appears before the first file header");
      continue;
    }
    current.lines.push(line);
  }

  if (sections.length === 0) throw new Error("patch contains no file sections");
  return sections;
}

export function editTargetPaths(input) {
  const { tool_name: toolName, tool_input: toolInput } = input ?? {};
  if (["Edit", "Write", "NotebookEdit"].includes(toolName)) {
    const filePath = toolInput?.file_path ?? toolInput?.notebook_path;
    return typeof filePath === "string" ? [filePath] : [];
  }
  if (toolName !== "apply_patch") return [];
  return parseApplyPatch(toolInput?.command).flatMap((section) =>
    section.moveTo ? [section.path, section.moveTo] : [section.path],
  );
}
