const { methodNotAllowed, sendJson } = require('../_lib/http');
const { getAdminGroupId } = require('../_lib/roblox-groups');

const ROBLOX_GROUP_GAMES_PAGE_LIMIT = 100;
const ROBLOX_GROUP_GAMES_MAX_PAGES = 20;
const ROBLOX_GAME_DETAILS_BATCH_SIZE = 20;
const DEFAULT_MIN_VISITS = 100000;
const CACHE_TTL_MS = 60 * 1000;
const FAILURE_CACHE_TTL_MS = 15 * 1000;
const REQUEST_TIMEOUT_MS = 8000;

let groupGamesCache = {
    key: '',
    games: null,
    expiresAt: 0,
    pending: null
};

function parsePositiveInteger(value) {
    const parsed = Number.parseInt(String(value || '').trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseMinimumVisits(value) {
    const parsed = Number.parseInt(String(value || '').trim(), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MIN_VISITS;
}

async function fetchRobloxJson(endpoint) {
    const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
            Accept: 'application/json'
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
        const detail = payload && typeof payload.errors?.[0]?.message === 'string'
            ? payload.errors[0].message.trim()
            : `Roblox API returned ${response.status}`;
        throw new Error(detail || `Roblox API returned ${response.status}`);
    }

    return payload;
}

async function fetchGroupUniverseIds(groupId) {
    const universeIds = [];
    const seen = new Set();
    let cursor = '';

    for (let page = 0; page < ROBLOX_GROUP_GAMES_MAX_PAGES; page += 1) {
        const endpoint = new URL(`https://games.roblox.com/v2/groups/${encodeURIComponent(groupId)}/games`);
        endpoint.searchParams.set('accessFilter', 'All');
        endpoint.searchParams.set('limit', String(ROBLOX_GROUP_GAMES_PAGE_LIMIT));
        endpoint.searchParams.set('sortOrder', 'Asc');
        if (cursor) {
            endpoint.searchParams.set('cursor', cursor);
        }

        const payload = await fetchRobloxJson(endpoint);
        const games = Array.isArray(payload && payload.data) ? payload.data : [];
        games.forEach((game) => {
            const universeId = parsePositiveInteger(game && game.id);
            if (universeId && !seen.has(universeId)) {
                seen.add(universeId);
                universeIds.push(universeId);
            }
        });

        cursor = typeof (payload && payload.nextPageCursor) === 'string'
            ? payload.nextPageCursor.trim()
            : '';
        if (!cursor) {
            break;
        }
    }

    return universeIds;
}

async function fetchGameDetails(universeIds) {
    const games = [];
    for (let index = 0; index < universeIds.length; index += ROBLOX_GAME_DETAILS_BATCH_SIZE) {
        const batch = universeIds.slice(index, index + ROBLOX_GAME_DETAILS_BATCH_SIZE);
        const endpoint = new URL('https://games.roblox.com/v1/games');
        endpoint.searchParams.set('universeIds', batch.join(','));

        const payload = await fetchRobloxJson(endpoint);
        const rows = Array.isArray(payload && payload.data) ? payload.data : [];
        games.push(...rows);
    }

    return games;
}

function normalizeGame(row) {
    const universeId = Number(row && row.id);
    const rootPlaceId = Number(row && row.rootPlaceId);
    const updatedAt = typeof (row && row.updated) === 'string' ? row.updated.trim() : '';
    const description = typeof (row && row.description) === 'string' ? row.description.trim() : '';
    const isDiscontinued = /\bdiscontinued\b/i.test(description);

    return {
        universeId,
        rootPlaceId,
        name: typeof (row && row.name) === 'string' ? row.name.trim() : '',
        description,
        updatedAt,
        isDiscontinued,
        visits: Number(row && row.visits),
        playing: Number(row && row.playing),
        iconUrl: Number.isFinite(universeId) && universeId > 0
            ? `/api/roblox/game-icon?universeId=${encodeURIComponent(String(universeId))}&size=512x512`
            : '',
        robloxUrl: Number.isFinite(rootPlaceId) && rootPlaceId > 0
            ? `https://www.roblox.com/games/${encodeURIComponent(String(rootPlaceId))}`
            : ''
    };
}

function isGroupOwnedGame(row, groupId) {
    const creator = row && row.creator ? row.creator : null;
    return Number(creator && creator.id) === groupId
        && String(creator && creator.type || '').toLowerCase() === 'group';
}

function compareGamesByActivity(left, right) {
    const leftPlaying = Number.isFinite(left.playing) && left.playing >= 0 ? left.playing : 0;
    const rightPlaying = Number.isFinite(right.playing) && right.playing >= 0 ? right.playing : 0;
    if (rightPlaying !== leftPlaying) {
        return rightPlaying - leftPlaying;
    }

    const leftVisits = Number.isFinite(left.visits) && left.visits >= 0 ? left.visits : 0;
    const rightVisits = Number.isFinite(right.visits) && right.visits >= 0 ? right.visits : 0;
    if (rightVisits !== leftVisits) {
        return rightVisits - leftVisits;
    }

    return left.name.localeCompare(right.name);
}

async function fetchEligibleGroupGames(groupId, minVisits) {
    const universeIds = await fetchGroupUniverseIds(groupId);
    if (!universeIds.length) {
        return [];
    }

    const rows = await fetchGameDetails(universeIds);
    return rows
        .filter((row) => isGroupOwnedGame(row, groupId))
        .map(normalizeGame)
        .filter((game) => Number.isFinite(game.universeId) && game.universeId > 0)
        .filter((game) => Number.isFinite(game.rootPlaceId) && game.rootPlaceId > 0)
        .filter((game) => Number.isFinite(game.visits) && game.visits > minVisits)
        .sort(compareGamesByActivity);
}

async function getCachedGroupGames(groupId, minVisits) {
    const cacheKey = `${groupId}:${minVisits}`;
    const now = Date.now();
    if (groupGamesCache.key === cacheKey && groupGamesCache.games && groupGamesCache.expiresAt > now) {
        return groupGamesCache.games;
    }

    if (!groupGamesCache.pending || groupGamesCache.key !== cacheKey) {
        groupGamesCache = {
            key: cacheKey,
            games: groupGamesCache.key === cacheKey ? groupGamesCache.games : null,
            expiresAt: groupGamesCache.expiresAt,
            pending: fetchEligibleGroupGames(groupId, minVisits)
                .then((games) => {
                    groupGamesCache = {
                        key: cacheKey,
                        games,
                        expiresAt: Date.now() + CACHE_TTL_MS,
                        pending: null
                    };
                    return games;
                })
                .catch((error) => {
                    groupGamesCache = {
                        key: cacheKey,
                        games: groupGamesCache.games,
                        expiresAt: Date.now() + FAILURE_CACHE_TTL_MS,
                        pending: null
                    };
                    throw error;
                })
        };
    }

    return groupGamesCache.pending;
}

module.exports = async (req, res) => {
    if (req.method !== 'GET') {
        return methodNotAllowed(req, res, ['GET']);
    }

    const groupId = getAdminGroupId();
    const minVisits = parseMinimumVisits(req.query && req.query.minVisits);

    try {
        const games = await getCachedGroupGames(groupId, minVisits);
        res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
        return sendJson(res, 200, { groupId, minVisits, games });
    } catch (error) {
        return sendJson(res, 502, {
            error: 'Failed to fetch Roblox group games',
            details: error.message
        });
    }
};
