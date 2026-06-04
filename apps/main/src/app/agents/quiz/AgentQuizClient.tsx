// Client component for the quiz UI. State is local — each question is a
// radio group; submit calls the pure pickAgentFromTags scorer and
// router.push's to the winning agent's profile.

"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { QUIZ_QUESTIONS, pickAgentFromTags } from "@/lib/agents/quiz";

export function AgentQuizClient(): React.ReactElement {
  const router = useRouter();
  const [selections, setSelections] = React.useState<Record<string, number>>(
    {},
  );

  const allAnswered = QUIZ_QUESTIONS.every((q) => selections[q.id] !== undefined);

  function onSubmit(e: React.FormEvent): void {
    e.preventDefault();
    const tags: string[] = [];
    for (const q of QUIZ_QUESTIONS) {
      const idx = selections[q.id];
      if (idx === undefined) continue;
      const option = q.options[idx];
      if (option) tags.push(...option.tags);
    }
    const slug = pickAgentFromTags(tags);
    router.push(`/agents/${slug}`);
  }

  return (
    <form onSubmit={onSubmit} className="mt-8 flex flex-col gap-8">
      {QUIZ_QUESTIONS.map((q) => (
        <fieldset key={q.id} className="flex flex-col gap-3">
          <legend className="text-base font-semibold">{q.prompt}</legend>
          <div className="flex flex-col gap-2">
            {q.options.map((opt, i) => {
              const id = `${q.id}-${i}`;
              const checked = selections[q.id] === i;
              return (
                <label
                  key={id}
                  htmlFor={id}
                  className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 hover:bg-accent"
                >
                  <input
                    id={id}
                    type="radio"
                    name={q.id}
                    value={i}
                    checked={checked}
                    onChange={() =>
                      setSelections((prev) => ({ ...prev, [q.id]: i }))
                    }
                    className="h-4 w-4"
                  />
                  <span className="text-sm">{opt.label}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
      ))}
      <Button
        type="submit"
        disabled={!allAnswered}
        className="h-11 self-start px-8 text-base"
      >
        Show my agent
      </Button>
    </form>
  );
}
