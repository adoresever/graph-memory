const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 529]);
// Only pause for errors that normally require a credential, endpoint, or
// model configuration change. 400/422 can be caused by one bad prompt and
// must not disable unrelated later calls.
const PAUSING_STATUSES = new Set([401, 403, 404]);
export function extractLlmStatus(error) {
    const text = String(error ?? "");
    const match = text.match(/\b(?:LLM|Anthropic) API (\d{3})\b/);
    if (!match)
        return null;
    return Number(match[1]);
}
export class LlmFailureGuard {
    cooldownMs;
    now;
    pausedUntil = 0;
    constructor(cooldownMs = 10 * 60_000, now = () => Date.now()) {
        this.cooldownMs = cooldownMs;
        this.now = now;
    }
    canRun() {
        return this.now() >= this.pausedUntil;
    }
    remainingMs() {
        return Math.max(0, this.pausedUntil - this.now());
    }
    reset() {
        this.pausedUntil = 0;
    }
    tripIfNeeded(error) {
        const status = extractLlmStatus(error);
        if (status == null || RETRYABLE_STATUSES.has(status) || !PAUSING_STATUSES.has(status)) {
            return false;
        }
        this.pausedUntil = Math.max(this.pausedUntil, this.now() + this.cooldownMs);
        return true;
    }
}
