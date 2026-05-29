const { methodNotAllowed, sendJson } = require('../_lib/http');

const ROBLOX_AVATAR_HEADSHOT_ENDPOINT = 'https://thumbnails.roblox.com/v1/users/avatar-headshot';
const DEFAULT_SIZE = '150x150';
const ALLOWED_SIZES = new Set([
    '48x48',
    '50x50',
    '60x60',
    '75x75',
    '100x100',
    '110x110',
    '150x150',
    '180x180',
    '352x352',
    '420x420',
    '720x720'
]);

const AVATAR_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 200;
const avatarCache = new Map();

function parsePositiveInteger(value) {
    const parsed = Number.parseInt(String(value || '').trim(), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return null;
    }

    return parsed;
}

function resolveSize(rawSize) {
    const size = String(rawSize || '').trim();
    if (!size) {
        return DEFAULT_SIZE;
    }

    if (!ALLOWED_SIZES.has(size)) {
        return null;
    }

    return size;
}

function getCachedAvatarUrl(cacheKey) {
    const hit = avatarCache.get(cacheKey);
    if (!hit) {
        return '';
    }

    if (Date.now() >= hit.expiresAt) {
        avatarCache.delete(cacheKey);
        return '';
    }

    return hit.url;
}

function setCachedAvatarUrl(cacheKey, url) {
    if (avatarCache.size >= MAX_CACHE_ENTRIES) {
        const oldestKey = avatarCache.keys().next().value;
        if (oldestKey) {
            avatarCache.delete(oldestKey);
        }
    }

    avatarCache.set(cacheKey, {
        url,
        expiresAt: Date.now() + AVATAR_CACHE_TTL_MS
    });
}

function createFallbackAvatarSvg() {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="150" viewBox="0 0 150 150" role="img" aria-label="Avatar unavailable"><defs><linearGradient id="rd-gradient" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#06b6d4"/><stop offset="100%" stop-color="#22d3ee"/></linearGradient></defs><rect width="150" height="150" rx="75" fill="#0d1117"/><circle cx="75" cy="56" r="24" fill="url(#rd-gradient)"/><path d="M34 126c0-23 18-41 41-41s41 18 41 41" fill="none" stroke="url(#rd-gradient)" stroke-width="12" stroke-linecap="round"/></svg>`;
}

function isSafeAvatarHost(urlString) {
    try {
        const url = new URL(urlString);
        return url.protocol === 'https:' && /(^|\.)rbxcdn\.com$/i.test(url.hostname);
    } catch (error) {
        return false;
    }
}

async function fetchAvatarUrl(userId, size) {
    const requestUrl = new URL(ROBLOX_AVATAR_HEADSHOT_ENDPOINT);
    requestUrl.searchParams.set('userIds', String(userId));
    requestUrl.searchParams.set('size', size);
    requestUrl.searchParams.set('format', 'Png');
    requestUrl.searchParams.set('isCircular', 'false');

    const response = await fetch(requestUrl, {
        method: 'GET',
        headers: {
            Accept: 'application/json'
        }
    });

    if (!response.ok) {
        throw new Error(`Roblox avatar request failed (${response.status})`);
    }

    const payload = await response.json().catch(() => null);
    const rows = Array.isArray(payload && payload.data) ? payload.data : [];
    const row = rows.find((item) => Number(item && item.targetId) === userId) || rows[0];
    const imageUrl = row && typeof row.imageUrl === 'string' ? row.imageUrl.trim() : '';

    if (!imageUrl) {
        throw new Error('Roblox avatar response did not include imageUrl');
    }

    if (!isSafeAvatarHost(imageUrl)) {
        throw new Error('Roblox avatar URL used an unexpected host');
    }

    return imageUrl;
}

module.exports = async (req, res) => {
    if (req.method !== 'GET') {
        return methodNotAllowed(req, res, ['GET']);
    }

    const userId = parsePositiveInteger(req.query && req.query.userId);
    if (!userId) {
        return sendJson(res, 400, { error: 'userId must be a positive integer' });
    }

    const size = resolveSize(req.query && req.query.size);
    if (!size) {
        return sendJson(res, 400, { error: 'size is invalid' });
    }

    const cacheKey = `${userId}:${size}`;

    try {
        let imageUrl = getCachedAvatarUrl(cacheKey);
        if (!imageUrl) {
            imageUrl = await fetchAvatarUrl(userId, size);
            setCachedAvatarUrl(cacheKey, imageUrl);
        }

        res.statusCode = 307;
        res.setHeader('Location', imageUrl);
        res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=86400, stale-while-revalidate=604800');
        return res.end();
    } catch (error) {
        console.error(`Avatar proxy failed for user ${userId}:`, error);

        res.statusCode = 200;
        res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
        return res.end(createFallbackAvatarSvg());
    }
};