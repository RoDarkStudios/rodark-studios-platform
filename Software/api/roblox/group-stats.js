const { methodNotAllowed, sendJson } = require('../_lib/http');
const { getAdminGroupId } = require('../_lib/roblox-groups');

const REQUEST_TIMEOUT_MS = 5000;

module.exports = async (req, res) => {
    if (req.method !== 'GET') {
        return methodNotAllowed(req, res, ['GET']);
    }

    try {
        const groupId = getAdminGroupId();
        const endpoint = `https://groups.roblox.com/v1/groups/${encodeURIComponent(groupId)}`;
        const robloxResponse = await fetch(endpoint, {
            method: 'GET',
            headers: {
                Accept: 'application/json'
            },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });

        if (!robloxResponse.ok) {
            return sendJson(res, 502, {
                error: 'Failed to fetch Roblox group stats',
                details: `Roblox API returned ${robloxResponse.status}`
            });
        }

        const payload = await robloxResponse.json();
        const memberCount = Number(payload && payload.memberCount);
        if (!Number.isFinite(memberCount) || memberCount < 0) {
            return sendJson(res, 502, {
                error: 'Roblox group stats response was missing a valid memberCount'
            });
        }

        res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
        return sendJson(res, 200, {
            groupId,
            memberCount: Math.trunc(memberCount)
        });
    } catch (error) {
        return sendJson(res, 500, {
            error: 'Failed to load group stats',
            details: error.message
        });
    }
};
