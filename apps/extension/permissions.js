// Request optional host access only while handling an explicit user action.
export async function ensureHostPermission(tenantUrl, { requestIfMissing }, permissions = chrome.permissions) {
  const origin = `${new URL(tenantUrl).origin}/*`;
  if (await permissions.contains({ origins: [origin] })) return true;
  if (!requestIfMissing) return false;
  return permissions.request({ origins: [origin] });
}
