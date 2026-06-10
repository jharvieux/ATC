// #963 — Template engine: save-time validation + send-time rendering.
//
// Intent under test: an override referencing an unknown variable must be
// caught at SAVE time (validateTemplate), and any residual mismatch at SEND
// time must THROW (renderTemplate) rather than produce a hole — a customer
// must never receive "Hi ," or an empty body.

import { describe, it, expect } from "vitest";
import {
  extractVariableNames,
  validateTemplate,
  renderTemplate,
  bodyTextToHtml,
  TemplateRenderError,
} from "@/lib/email/template-engine";

describe("extractVariableNames", () => {
  it("finds each variable once, tolerating inner whitespace", () => {
    expect(extractVariableNames("Hi {{name}}, your {{ ship_name }} sails {{name}}").sort()).toEqual([
      "name",
      "ship_name",
    ]);
  });

  it("returns empty for a template with no variables", () => {
    expect(extractVariableNames("Just a plain subject")).toEqual([]);
  });
});

describe("validateTemplate — save-time gate", () => {
  it("accepts a template using only allowed variables", () => {
    expect(validateTemplate("Hi {{customer_name}}, see {{ship_name}}", ["customer_name", "ship_name"])).toEqual([]);
  });

  it("rejects an unknown variable, naming it in the detail", () => {
    const issues = validateTemplate("Hi {{custmer_name}}", ["customer_name"]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe("unknown_variable");
    expect(issues[0]!.detail).toContain("custmer_name");
    expect(issues[0]!.detail).toContain("{{customer_name}}"); // tells the user what IS allowed
  });

  it("rejects unmatched braces that would reach customers verbatim", () => {
    expect(validateTemplate("Hi {{customer_name}", ["customer_name"]).some((i) => i.code === "malformed_braces")).toBe(true);
    expect(validateTemplate("Hi {{customer_name}} }}", ["customer_name"]).some((i) => i.code === "malformed_braces")).toBe(true);
  });
});

describe("renderTemplate — send-time substitution", () => {
  it("substitutes all variables", () => {
    expect(renderTemplate("{{a}} and {{ b }}", { a: "1", b: "2" })).toBe("1 and 2");
  });

  it("throws TemplateRenderError on a variable the sender did not supply", () => {
    expect(() => renderTemplate("Hi {{missing}}", {})).toThrow(TemplateRenderError);
  });
});

describe("bodyTextToHtml — plain text to email HTML", () => {
  it("splits blank-line paragraphs and converts single newlines to <br>", () => {
    expect(bodyTextToHtml("line one\nline two\n\npara two")).toBe(
      "<p>line one<br>line two</p><p>para two</p>",
    );
  });

  it("HTML-escapes content so tenant-typed markup renders as literal text", () => {
    const html = bodyTextToHtml('<script>alert("x")</script> & <b>bold</b>');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
  });

  it("drops empty paragraphs from extra blank lines", () => {
    expect(bodyTextToHtml("a\n\n\n\nb")).toBe("<p>a</p><p>b</p>");
  });
});
