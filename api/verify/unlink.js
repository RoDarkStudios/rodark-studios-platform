const { methodNotAllowed, sendJson } = require('../_lib/http');
const { requireUserFromSession } = require('../_lib/session');
const { getDiscordVerifyUser } = require('../_lib/discord-verify-session');
const { deleteDiscordRobloxVerification } = require('../_lib/discord-roblox-verification-store');

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return methodNotAllowed(req, res, ['POST']);
    }

    try {
        const { user: robloxUser } = await requireUserFromSession(req, res);
        const discordUser = getDiscordVerifyUser(req, res);
        if (!robloxUser && !discordUser) {
            return sendJson(res, 401, { error: 'Connect Discord or sign in with Roblox first' });
        }

        const deletedCount = await deleteDiscordRobloxVerification({
            robloxUserId: robloxUser ? robloxUser.id : '',
            discordUserId: discordUser ? discordUser.id : ''
        });

        return sendJson(res, 200, {
            unlinked: deletedCount > 0,
            deletedCount
        });
    } catch (error) {
        return sendJson(res, 500, { error: 'Failed to unlink accounts', details: error.message });
    }
};
