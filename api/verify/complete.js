const { methodNotAllowed, sendJson } = require('../_lib/http');
const { requireUserFromSession } = require('../_lib/session');
const { getDiscordVerifyUser } = require('../_lib/discord-verify-session');
const { upsertDiscordRobloxVerification } = require('../_lib/discord-roblox-verification-store');

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return methodNotAllowed(req, res, ['POST']);
    }

    try {
        const { user: robloxUser } = await requireUserFromSession(req, res);
        if (!robloxUser) {
            return sendJson(res, 401, { error: 'Sign in with Roblox first' });
        }

        const discordUser = getDiscordVerifyUser(req, res);
        if (!discordUser) {
            return sendJson(res, 401, { error: 'Connect Discord first' });
        }

        const verification = await upsertDiscordRobloxVerification({
            robloxUser,
            discordUser
        });

        return sendJson(res, 200, { verification });
    } catch (error) {
        return sendJson(res, 500, { error: 'Failed to save verification', details: error.message });
    }
};
