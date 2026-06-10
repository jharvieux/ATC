// #963 — Deterministic {{variable}} template engine for tenant email overrides.
//
// Two enforcement points, both fail-loud:
//   - validateTemplate: save-time. An override referencing an unknown
//     variable (or with stray {{ / }} braces) is rejected with a 400 before
//     it can ever reach a send path.
//   - renderTemplate: send-time. Throws TemplateRenderError if a template
//     names a variable the sender didn't supply — a send must never go out
//     with a hole where a value should be.
//
// Client-safe: pure string functions, shared by the settings-page preview.

const VAR_TOKEN_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

export function extractVariableNames(template: string): string[] {
  const names = new Set<string>();
  for (const match of template.matchAll(VAR_TOKEN_RE)) {
    names.add(match[1] as string);
  }
  return [...names];
}

export interface TemplateValidationIssue {
  code: "unknown_variable" | "malformed_braces";
  detail: string;
}

export function validateTemplate(
  template: string,
  allowedVariables: readonly string[],
): TemplateValidationIssue[] {
  const issues: TemplateValidationIssue[] = [];
  const allowed = new Set(allowedVariables);
  for (const name of extractVariableNames(template)) {
    if (!allowed.has(name)) {
      issues.push({
        code: "unknown_variable",
        detail: `Unknown variable {{${name}}} — allowed: ${allowedVariables.map((v) => `{{${v}}}`).join(", ")}`,
      });
    }
  }
  // Any braces left after removing well-formed tokens indicate a typo like
  // "{{name}" or "{ {name}}" that would otherwise reach customers verbatim.
  const residue = template.replace(VAR_TOKEN_RE, "");
  if (residue.includes("{{") || residue.includes("}}")) {
    issues.push({
      code: "malformed_braces",
      detail: "Template contains unmatched {{ or }} — variables must be written exactly as {{variable_name}}",
    });
  }
  return issues;
}

export class TemplateRenderError extends Error {
  readonly variable: string;
  constructor(variable: string) {
    super(`template references unknown variable {{${variable}}}`);
    this.name = "TemplateRenderError";
    this.variable = variable;
  }
}

export function renderTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(VAR_TOKEN_RE, (_, name: string) => {
    const value = variables[name];
    if (value === undefined) throw new TemplateRenderError(name);
    return value;
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Plain-text body → email-safe HTML. Blank lines separate paragraphs,
 * single newlines become <br>. Everything is HTML-escaped: override bodies
 * are plain text by design, so tenant-typed markup (or a variable value
 * containing markup) renders as literal text instead of injecting tags.
 */
export function bodyTextToHtml(bodyText: string): string {
  return bodyText
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    .map((paragraph) => `<p>${paragraph.split(/\r?\n/).map(escapeHtml).join("<br>")}</p>`)
    .join("");
}
