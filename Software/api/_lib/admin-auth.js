const { requireUserFromSession } = require('./session');
const { getAdminGroupId, fetchUserGroupRole, getRoleRank } = require('./roblox-groups');

async function requireAdmin(req, res) {
    const groupId = getAdminGroupId();
    const { user } = await requireUserFromSession(req, res);
    if (!user) {
        return { user: null, isAdmin: false, groupId, rank: null };
    }

    const roleEntry = await fetchUserGroupRole(user.id, groupId);
    const rank = getRoleRank(roleEntry);
    return {
        user,
        groupId,
        rank,
        roleName: roleEntry && roleEntry.role && roleEntry.role.name ? String(roleEntry.role.name) : null,
        isAdmin: rank !== null && rank >= 254
    };
}

module.exports = {
    requireAdmin
};
