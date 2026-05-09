const { methodNotAllowed, sendJson } = require('../_lib/http');
const { requireUserFromSession } = require('../_lib/session');
const { getDiscordVerifyUser } = require('../_lib/discord-verify-session');
const {
    getVerificationByDiscordUserId,
    getVerificationByRobloxUserId
} = require('../_lib/discord-roblox-verification-store');

function serializeRobloxUser(user) {
    if (!user) {
        return null;
    }

    return {
        id: user.id,
        username: user.username,
        displayName: user.display_name || user.username,
        profileUrl: user.profile_url || null
    };
}

function serializeDiscordUser(user) {
    if (!user) {
        return null;
    }

    return {
        id: user.id,
        username: user.username,
        globalName: user.globalName || user.username
    };
}

module.exports = async (req, res) => {
    if (req.method !== 'GET') {
        return methodNotAllowed(req, res, ['GET']);
    }

    try {
        const { user: robloxUser } = await requireUserFromSession(req, res);
        const discordUser = getDiscordVerifyUser(req, res);

        let verification = null;
        if (robloxUser) {
            verification = await getVerificationByRobloxUserId(robloxUser.id);
        }
        if (!verification && discordUser) {
            verification = await getVerificationByDiscordUserId(discordUser.id);
        }

        const robloxMatches = Boolean(
            robloxUser &&
            verification &&
            String(verification.robloxUserId) === String(robloxUser.id)
        );
        const discordMatches = Boolean(
            discordUser &&
            verification &&
            String(verification.discordUserId) === String(discordUser.id)
        );

        return sendJson(res, 200, {
            robloxUser: serializeRobloxUser(robloxUser),
            discordUser: serializeDiscordUser(discordUser),
            verification,
            canComplete: Boolean(robloxUser && discordUser),
            isVerified: Boolean(verification && (robloxMatches || discordMatches))
        });
    } catch (error) {
        return sendJson(res, 500, { error: 'Failed to load verification status', details: error.message });
    }
};
