// §11.5 / §12 — DOB display rules for contacts.
// Estimated DOBs show a confirmation prompt in the UI and are suppressed from PDFs.

export interface DobDisplayEntry {
  date_of_birth?: string | null | undefined;
  date_of_birth_is_estimated?: boolean | null | undefined;
}

export function dobDisplayLabel(entry: DobDisplayEntry): string | null {
  if (!entry.date_of_birth) return null;
  if (entry.date_of_birth_is_estimated) return `${entry.date_of_birth} (estimated, click to confirm)`;
  return entry.date_of_birth;
}

export function shouldSuppressDobInPdf(entry: DobDisplayEntry): boolean {
  return entry.date_of_birth_is_estimated === true;
}
