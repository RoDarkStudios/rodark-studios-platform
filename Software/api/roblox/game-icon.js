const { methodNotAllowed, sendJson } = require('../_lib/http');

const ROBLOX_GAME_ICON_ENDPOINT = 'https://thumbnails.roblox.com/v1/games/icons';
const DEFAULT_SIZE = '512x512';
const ALLOWED_SIZES = new Set([
    '50x50',
    '128x128',
    '150x150',
    '256x256',
    '512x512'
]);

const ICON_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 200;
const iconCache = new Map();

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

function getCachedIconUrl(cacheKey) {
    const hit = iconCache.get(cacheKey);
    if (!hit) {
        return '';
    }

    if (Date.now() >= hit.expiresAt) {
        iconCache.delete(cacheKey);
        return '';
    }

    return hit.url;
}

function setCachedIconUrl(cacheKey, url) {
    if (iconCache.size >= MAX_CACHE_ENTRIES) {
        const oldestKey = iconCache.keys().next().value;
        if (oldestKey) {
            iconCache.delete(oldestKey);
        }
    }

    iconCache.set(cacheKey, {
        url,
        expiresAt: Date.now() + ICON_CACHE_TTL_MS
    });
}

function isSafeImageHost(urlString) {
    try {
        const url = new URL(urlString);
        return url.protocol === 'https:' && /(^|\.)rbxcdn\.com$/i.test(url.hostname);
    } catch (error) {
        return false;
    }
}

async function fetchGameIconUrl(universeId, size) {
    const requestUrl = new URL(ROBLOX_GAME_ICON_ENDPOINT);
    requestUrl.searchParams.set('universeIds', String(universeId));
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
        throw new Error(`Roblox game icon request failed (${response.status})`);
    }

    const payload = await response.json().catch(() => null);
    const rows = Array.isArray(payload && payload.data) ? payload.data : [];
    const row = rows.find((item) => Number(item && item.targetId) === universeId) || rows[0];
    const imageUrl = row && typeof row.imageUrl === 'string' ? row.imageUrl.trim() : '';

    if (!imageUrl) {
        throw new Error('Roblox game icon response did not include imageUrl');
    }

    if (!isSafeImageHost(imageUrl)) {
        throw new Error('Roblox game icon URL used an unexpected host');
    }

    return imageUrl;
}

function redirectToFallbackIcon(res) {
    res.statusCode = 307;
    res.setHeader('Location', '/GameIcon.png');
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
    return res.end();
}

module.exports = async (req, res) => {
    if (req.method !== 'GET') {
        return methodNotAllowed(req, res, ['GET']);
    }

    const universeId = parsePositiveInteger(req.query && req.query.universeId);
    if (!universeId) {
        return sendJson(res, 400, { error: 'universeId must be a positive integer' });
    }

    const size = resolveSize(req.query && req.query.size);
    if (!size) {
        return sendJson(res, 400, { error: 'size is invalid' });
    }

    const cacheKey = `${universeId}:${size}`;

    try {
        let imageUrl = getCachedIconUrl(cacheKey);
        if (!imageUrl) {
            imageUrl = await fetchGameIconUrl(universeId, size);
            setCachedIconUrl(cacheKey, imageUrl);
        }

        res.statusCode = 307;
        res.setHeader('Location', imageUrl);
        res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=86400, stale-while-revalidate=604800');
        return res.end();
    } catch (error) {
        console.error(`Game icon proxy failed for universe ${universeId}:`, error);
        return redirectToFallbackIcon(res);
    }
};
