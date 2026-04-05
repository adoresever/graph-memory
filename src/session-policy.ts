/**
 * graph-memory — session policy
 *
 * Subagent sessions should be able to consume inherited recall context
 * without writing new long-term memory into the shared graph.
 */

function normalizeSessionKey(sessionKey?: string | null): string {
  return sessionKey?.trim() ?? "";
}

export function isHelperSessionKey(sessionKey?: string | null): boolean {
  const normalized = normalizeSessionKey(sessionKey).toLowerCase();
  if (!normalized) return false;
  return (
    normalized.startsWith("temp:") ||
    normalized.startsWith("slug-generator-") ||
    normalized === "slug-gen"
  );
}

export function isSubagentSessionKey(sessionKey?: string | null): boolean {
  const normalized = normalizeSessionKey(sessionKey).toLowerCase();
  if (!normalized) return false;
  return normalized.startsWith("subagent:") || normalized.includes(":subagent:");
}

export class ReadonlySessionRegistry {
  private readonlySessions = new Set<string>();

  markReadonly(sessionKey?: string | null): void {
    const normalized = normalizeSessionKey(sessionKey);
    if (!normalized) return;
    this.readonlySessions.add(normalized);
  }

  clear(sessionKey?: string | null): void {
    const normalized = normalizeSessionKey(sessionKey);
    if (!normalized) return;
    this.readonlySessions.delete(normalized);
  }

  has(sessionKey?: string | null): boolean {
    const normalized = normalizeSessionKey(sessionKey);
    if (!normalized) return false;
    return (
      this.readonlySessions.has(normalized) ||
      isSubagentSessionKey(normalized) ||
      isHelperSessionKey(normalized)
    );
  }

  clearAll(): void {
    this.readonlySessions.clear();
  }
}
