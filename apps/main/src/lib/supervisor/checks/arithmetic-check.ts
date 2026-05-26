// §21.10 Layer 6 — arithmetic_check.
//
// Scans the candidate response for arithmetic expressions of the form
//   <number> <op> <number> [...] = <number>
// where op ∈ {+, -, *, ×, /, ÷}. Currency markers ($, €, £) and commas in
// numbers are tolerated.
//
// Tolerance:
//   - $0.01 for money expressions (one of the operands has a currency marker)
//   - 0.1% for percentage expressions (any operand has %)
//   - Exact otherwise (whole-number arithmetic)
//
// Action on mismatch: severity 'warning' → run-supervisor.ts triggers a regen
// with "your response contains an arithmetic error" instruction.

import type { CheckInput, SupervisorFinding } from "../types";

// Match a chain like "$129 × 7 = $903" or "5 + 3 + 2 = 10" or "$1,200.50 - $50 = $1,150.50"
// Operands may include $ € £ prefix, commas, decimal. Operators: + - * × / ÷
const EXPR_REGEX =
  /([$€£]?-?[\d,]+(?:\.\d+)?%?)\s*([+\-*×\/÷])\s*([$€£]?-?[\d,]+(?:\.\d+)?%?(?:\s*[+\-*×\/÷]\s*[$€£]?-?[\d,]+(?:\.\d+)?%?)*)\s*=\s*([$€£]?-?[\d,]+(?:\.\d+)?%?)/g;

const MONEY_TOLERANCE = 0.01;
const PCT_TOLERANCE = 0.001;

export function checkArithmetic(input: CheckInput): SupervisorFinding {
  const text = input.candidate_response;
  const mismatches: string[] = [];

  let m: RegExpExecArray | null;
  EXPR_REGEX.lastIndex = 0;
  while ((m = EXPR_REGEX.exec(text)) !== null) {
    const fullExpr = m[0];
    const left = m[1];
    const firstOp = m[2];
    const restChain = m[3];
    const claimed = m[4];
    if (!left || !firstOp || !restChain || !claimed) continue;

    const isMoney = /[$€£]/.test(fullExpr);
    const isPct = /%/.test(fullExpr);

    // Insert spaces around firstOp to prevent the tokenizer from absorbing
    // a binary `-` into the next number's optional `-?` prefix. Without
    // these spaces, "100 - 25" reconstructs to "100-25" and the tokenizer
    // produces [num:100, num:-25] instead of [num:100, op:-, num:25] —
    // evalChain then bails with null and the subtraction error is silently
    // skipped. Reproducer: `100 - 25 = 80` was previously not flagged.
    const fullChain = `${left} ${firstOp} ${restChain}`;
    const claimedNum = parseNumber(claimed);
    const actualNum = evalChain(fullChain);
    if (claimedNum === null || actualNum === null) continue;

    const diff = Math.abs(claimedNum - actualNum);
    let tol: number;
    if (isMoney) tol = MONEY_TOLERANCE;
    else if (isPct) tol = PCT_TOLERANCE * Math.max(1, Math.abs(actualNum));
    else tol = 0;

    if (diff > tol) {
      mismatches.push(`${fullExpr.trim()} (actual ${formatNum(actualNum)})`);
    }
  }

  if (mismatches.length === 0) {
    return {
      check: "arithmetic_check",
      severity: "info",
      details: "no arithmetic errors detected",
    };
  }
  return {
    check: "arithmetic_check",
    severity: "warning",
    details: `arithmetic error(s): ${mismatches.slice(0, 3).join(" | ")}`,
  };
}

function parseNumber(s: string): number | null {
  const cleaned = s.replace(/[$€£,%\s]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function evalChain(s: string): number | null {
  // Tokenize <number> <op> <number> [...] and evaluate left-to-right with
  // precedence (* / ÷ × first, then + -). No parentheses supported — the
  // regex doesn't produce them.
  const tokenRe = /([$€£]?-?[\d,]+(?:\.\d+)?%?)|([+\-*×\/÷])/g;
  const tokens: Array<{ kind: "num"; v: number } | { kind: "op"; v: string }> = [];
  let mt: RegExpExecArray | null;
  tokenRe.lastIndex = 0;
  while ((mt = tokenRe.exec(s)) !== null) {
    if (mt[1]) {
      const n = parseNumber(mt[1]);
      if (n === null) return null;
      tokens.push({ kind: "num", v: n });
    } else if (mt[2]) {
      tokens.push({ kind: "op", v: mt[2] });
    }
  }
  if (tokens.length === 0 || tokens[0]?.kind !== "num") return null;

  // First pass: multiplications and divisions
  for (let i = 1; i < tokens.length - 1; ) {
    const op = tokens[i];
    if (op?.kind === "op" && (op.v === "*" || op.v === "×" || op.v === "/" || op.v === "÷")) {
      const a = tokens[i - 1];
      const b = tokens[i + 1];
      if (a?.kind !== "num" || b?.kind !== "num") return null;
      const r = (op.v === "*" || op.v === "×") ? a.v * b.v : a.v / b.v;
      tokens.splice(i - 1, 3, { kind: "num", v: r });
    } else {
      i += 2;
    }
  }

  // Second pass: additions and subtractions
  let acc: number | null = null;
  let pendingOp: string | null = null;
  for (const t of tokens) {
    if (t.kind === "num") {
      if (acc === null) acc = t.v;
      else if (pendingOp === "+") acc = acc + t.v;
      else if (pendingOp === "-") acc = acc - t.v;
      else return null;
      pendingOp = null;
    } else {
      pendingOp = t.v;
    }
  }
  return acc;
}

function formatNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}
