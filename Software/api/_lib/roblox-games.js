const ROBLOX_GAMES_ENDPOINT = 'https://games.roblox.com/v1/games';
const ROBLOX_OPEN_CLOUD_UNIVERSES_ENDPOINT = 'https://apis.roblox.com/cloud/v2/universes';
const ROBLOX_REQUEST_TIMEOUT_MS = 8000;

async function fetchRobloxGames(universeIds) {
    const requestUrl = new URL(ROBLOX_GAMES_ENDPOINT);
    requestUrl.searchParams.set('universeIds', universeIds.join(','));

    const response = await fetch(requestUrl, {
        method: 'GET',
        headers: {
            Accept: 'application/json'
        },
        signal: AbortSignal.timeout(ROBLOX_REQUEST_TIMEOUT_MS)
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

async function fetchRobloxUniverse(universeId, apiKey) {
    const requestUrl = `${ROBLOX_OPEN_CLOUD_UNIVERSES_ENDPOINT}/${encodeURIComponent(String(universeId))}`;
    const response = await fetch(requestUrl, {
        method: 'GET',
        headers: {
            Accept: 'application/json',
            'x-api-key': apiKey
        },
        signal: AbortSignal.timeout(ROBLOX_REQUEST_TIMEOUT_MS)
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
        const detail = payload && typeof payload.message === 'string'
            ? payload.message.trim()
            : `Roblox Open Cloud returned ${response.status}`;
        const error = new Error(detail || `Roblox Open Cloud returned ${response.status}`);
        error.robloxStatus = response.status;
        throw error;
    }

    return {
        universeId: String(universeId),
        name: typeof (payload && payload.displayName) === 'string'
            ? payload.displayName.trim()
            : '',
        description: typeof (payload && payload.description) === 'string'
            ? payload.description.trim()
            : '',
        visibility: typeof (payload && payload.visibility) === 'string'
            ? payload.visibility.trim()
            : ''
    };
}

module.exports = {
    fetchRobloxGames,
    fetchRobloxUniverse
};
