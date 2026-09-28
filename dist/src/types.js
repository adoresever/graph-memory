/**
 * graph-memory
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 */
export const DEFAULT_CONFIG = {
    dbPath: "~/.openclaw/graph-memory.db",
    compactTurnCount: 6,
    recallMaxNodes: 6,
    // Automatic prompt injection optimizes for precision. On the existing
    // text-embedding-v4 20-turn corpus, 0.70 sits above the p90 different-turn
    // similarity (0.669) and near the same-turn median (0.721). Other embedding
    // providers can override this single documented policy value.
    semanticScoreThreshold: 0.70,
    freshTurnCount: 5,
    pagerankDamping: 0.85,
    pagerankIterations: 20,
};
