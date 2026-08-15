const ROBLOX_GAMES_ENDPOINT = 'https://games.roblox.com/v1/games';
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

module.exports = {
    fetchRobloxGames
};
