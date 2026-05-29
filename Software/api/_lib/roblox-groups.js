const REQUEST_TIMEOUT_MS = 5000;

function getAdminGroupId() {
    const raw = String(process.env.ROBLOX_GROUP_ID || '5545660').trim();
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error('ROBLOX_GROUP_ID must be a positive integer');
    }

    return parsed;
}

async function fetchUserGroupRole(userId, groupId) {
    const safeUserId = encodeURIComponent(String(userId).trim());
    const endpoint = `https://groups.roblox.com/v2/users/${safeUserId}/groups/roles`;
    const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
            Accept: 'application/json'
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    if (!response.ok) {
        throw new Error(`Roblox groups API failed (${response.status})`);
    }

    const payload = await response.json();
    const groups = Array.isArray(payload && payload.data) ? payload.data : [];
    return groups.find((entry) => {
        return Number(entry && entry.group && entry.group.id) === groupId;
    }) || null;
}

function getRoleRank(roleEntry) {
    const rank = Number(roleEntry && roleEntry.role && roleEntry.role.rank);
    if (!Number.isFinite(rank)) {
        return null;
    }

    return rank;
}

module.exports = {
    getAdminGroupId,
    fetchUserGroupRole,
    getRoleRank
};
