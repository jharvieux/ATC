// Shared across CruiseMapper parsers: last non-empty path segment of a
// CruiseMapper URL, sans .html — e.g. 'Norwegian-Bliss-1454'. Guards a
// malformed URL by returning "" so a single bad page can't crash a run.
export function shipSlugFromUrl(url: string): string {
  try {
    const segs = new URL(url).pathname.split("/").filter(Boolean);
    return (segs[segs.length - 1] ?? "").replace(/\.html?$/i, "");
  } catch {
    return "";
  }
}
