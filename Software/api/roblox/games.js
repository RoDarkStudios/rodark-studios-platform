const { methodNotAllowed, sendJson } = require('../_lib/http');

const ROBLOX_GAMES_ENDPOINT = 'https://games.roblox.com/v1/games';
const MAX_UNIVERSE_IDS = 20;

function parsePositiveInteger(value) {
    const parsed = Number.parseInt(String(value || '').trim(), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return null;
    }

    return parsed;
}

function parseUniverseIds(rawUniverseIds) {
    const rawValue = Array.isArray(rawUniverseIds)
        ? rawUniverseIds.join(',')
        : String(rawUniverseIds || '').trim();

    if (!rawValue) {
        return [];
    }

    const ids = [];
    const seen = new Set();

    rawValue.split(',').forEach((value) => {
        const parsed = parsePositiveInteger(value);
        if (!parsed || seen.has(parsed)) {
            return;
        }

        seen.add(parsed);
        ids.push(parsed);
    });

    return ids;
}

async function fetchRobloxGames(universeIds) {
    const requestUrl = new URL(ROBLOX_GAMES_ENDPOINT);
    requestUrl.searchParams.set('universeIds', universeIds.join(','));

    const response = await fetch(requestUrl, {
        method: 'GET',
        headers: {
            Accept: 'application/json'
        }
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
        const detail = payload && typeof payload.errors?.[0]?.message === 'string'
            ? payload.errors[0].message.trim()
            : `Roblox API returned ${response.status}`;
        throw new Error(detail || `Roblox API returned ${response.status}`);
    }

    const rows = Array.isArray(payload && payload.data) ? payload.data : [];
    return rows.map((row) => ({
        universeId: Number(row && row.id),
        rootPlaceId: Number(row && row.rootPlaceId),
        name: typeof (row && row.name) === 'string' ? row.name.trim() : '',
        description: typeof (row && row.description) === 'string' ? row.description.trim() : '',
        visits: Number(row && row.visits),
        playing: Number(row && row.playing)
    }));
}

module.exports = async (req, res) => {
    if (req.method !== 'GET') {
        return methodNotAllowed(req, res, ['GET']);
    }

    const universeIds = parseUniverseIds(req.query && req.query.universeIds);
    if (!universeIds.length) {
        return sendJson(res, 400, { error: 'universeIds must include at least one positive integer' });
    }

    if (universeIds.length > MAX_UNIVERSE_IDS) {
        return sendJson(res, 400, { error: `universeIds supports at most ${MAX_UNIVERSE_IDS} values per request` });
    }

    try {
        const games = await fetchRobloxGames(universeIds);
        res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
        return sendJson(res, 200, { games });
    } catch (error) {
        return sendJson(res, 502, {
            error: 'Failed to fetch Roblox game metadata',
            details: error.message
        });
    }
};
