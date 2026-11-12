/** Access failures must hide cached private content, even when a refetch retains data. */
export function isQueryAccessError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? error.code : undefined;
  const status = "status" in error ? error.status : undefined;
  const data = "data" in error ? error.data : undefined;
  const dataCode = data && typeof data === "object" && "code" in data ? data.code : undefined;
  return (
    [code, dataCode].some(
      (value) => value === "UNAUTHORIZED" || value === "FORBIDDEN" || value === "NOT_FOUND",
    ) ||
    status === 401 ||
    status === 403 ||
    status === 404
  );
}
