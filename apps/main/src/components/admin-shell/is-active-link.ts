// Pure predicate for "is this nav item active given the current
// pathname?" Extracted so the two distinct rules — exact match and
// descendant-path match — can be unit-tested without a Next.js
// router. Used by AdminSidebar (#668).

/**
 * True when `currentPath` is exactly `href` or a true descendant of it.
 *
 * The `+ "/"` suffix in the descendant check prevents accidental
 * sibling matches — e.g. visiting `/admin/personas-legacy` must NOT
 * light up the `/admin/personas` item.
 *
 * `currentPath` may be null on first render before usePathname resolves.
 */
export function isActiveLink(currentPath: string | null, href: string): boolean {
  if (currentPath === null) return false;
  if (currentPath === href) return true;
  return currentPath.startsWith(href + "/");
}
