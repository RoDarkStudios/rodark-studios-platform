const { methodNotAllowed, sendJson } = require('../_lib/http');
const { requireUserFromSession } = require('../_lib/session');
const { getAdminGroupId, fetchUserGroupRole, getRoleRank } = require('../_lib/roblox-groups');

module.exports = async (req, res) => {
    if (req.method !== 'GET') {
        return methodNotAllowed(req, res, ['GET']);
    }

    try {
        const groupId = getAdminGroupId();
        const { user } = await requireUserFromSession(req, res);
        if (!user) {
            return sendJson(res, 401, { error: 'Not authenticated' });
        }

        const roleEntry = await fetchUserGroupRole(user.id, groupId);
        const rank = getRoleRank(roleEntry);
        const isAdmin = rank !== null && rank >= 254;

        return sendJson(res, 200, {
            isAdmin,
            groupId,
            rank,
            roleName: roleEntry && roleEntry.role && roleEntry.role.name ? String(roleEntry.role.name) : null
        });
    } catch (error) {
        return sendJson(res, 200, {
            isAdmin: false,
            groupId: null,
            rank: null,
            roleName: null
        });
    }
};
