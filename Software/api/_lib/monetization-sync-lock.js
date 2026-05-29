const LOCK_TTL_MS = 60 * 60 * 1000;

function getLockStore() {
    if (!globalThis.__rdMonetizationSyncLocks) {
        globalThis.__rdMonetizationSyncLocks = new Map();
    }

    return globalThis.__rdMonetizationSyncLocks;
}

function cleanupExpiredLocks(store, nowMs) {
    for (const [key, entry] of store.entries()) {
        if (!entry || !Number.isFinite(entry.expiresAt) || entry.expiresAt <= nowMs) {
            store.delete(key);
        }
    }
}

function normalizeUniverseIds(universeIds) {
    const unique = new Set();
    for (const universeId of universeIds || []) {
        const numericId = Number(universeId);
        if (!Number.isFinite(numericId) || numericId <= 0) {
            continue;
        }
        unique.add(Math.round(numericId));
    }

    return Array.from(unique).sort((a, b) => a - b);
}

function buildMonetizationLockKeys(universeIds) {
    return normalizeUniverseIds(universeIds).map((id) => `universe:${id}`);
}

function tryAcquireMonetizationLock(universeIds, ownerHint) {
    const store = getLockStore();
    const nowMs = Date.now();
    cleanupExpiredLocks(store, nowMs);

    const lockKeys = buildMonetizationLockKeys(universeIds);
    if (lockKeys.length === 0) {
        return {
            acquired: true,
            ownerId: null,
            lockKeys: []
        };
    }

    const conflicts = [];
    for (const key of lockKeys) {
        const current = store.get(key);
        if (current) {
            conflicts.push({
                key,
                ownerHint: current.ownerHint || null,
                createdAt: current.createdAt || null
            });
        }
    }

    if (conflicts.length > 0) {
        return {
            acquired: false,
            ownerId: null,
            lockKeys,
            conflicts
        };
    }

    const ownerId = `lock_${nowMs}_${Math.random().toString(36).slice(2, 10)}`;
    const lockEntry = {
        ownerId,
        ownerHint: String(ownerHint || ''),
        createdAt: new Date(nowMs).toISOString(),
        expiresAt: nowMs + LOCK_TTL_MS
    };

    for (const key of lockKeys) {
        store.set(key, lockEntry);
    }

    return {
        acquired: true,
        ownerId,
        lockKeys
    };
}

function releaseMonetizationLock(ownerId) {
    if (!ownerId) {
        return;
    }

    const store = getLockStore();
    for (const [key, entry] of store.entries()) {
        if (entry && entry.ownerId === ownerId) {
            store.delete(key);
        }
    }
}

module.exports = {
    tryAcquireMonetizationLock,
    releaseMonetizationLock
};
