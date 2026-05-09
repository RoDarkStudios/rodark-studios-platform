const { parseCookies, serializeCookie, appendSetCookie, DISCORD_VERIFY_COOKIE } = require('./cookies');
const { issueSignedToken, verifySignedToken } = require('./signed-token');
const { getAuthSecret } = require('./auth-config');

const DISCORD_VERIFY_TTL_SECONDS = 60 * 60 * 24 * 30;

function setDiscordVerifyCookie(res, discordUser) {
    const token = issueSignedToken({
        type: 'discord_verify',
        discordUserId: String(discordUser.id),
        username: String(discordUser.username),
        globalName: String(discordUser.globalName || discordUser.username)
    }, getAuthSecret(), DISCORD_VERIFY_TTL_SECONDS);

    appendSetCookie(res, serializeCookie(DISCORD_VERIFY_COOKIE, token, {
        httpOnly: true,
        sameSite: 'Lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: DISCORD_VERIFY_TTL_SECONDS
    }));
}

function clearDiscordVerifyCookie(res) {
    appendSetCookie(res, serializeCookie(DISCORD_VERIFY_COOKIE, '', {
        httpOnly: true,
        sameSite: 'Lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: 0
    }));
}

function getDiscordVerifyUser(req, res) {
    const cookies = parseCookies(req);
    const token = cookies[DISCORD_VERIFY_COOKIE];
    if (!token) {
        return null;
    }

    const payload = verifySignedToken(token, getAuthSecret());
    if (
        !payload ||
        payload.type !== 'discord_verify' ||
        !payload.discordUserId ||
        !/^\d{5,25}$/.test(String(payload.discordUserId))
    ) {
        if (res) {
            clearDiscordVerifyCookie(res);
        }
        return null;
    }

    return {
        id: String(payload.discordUserId),
        username: String(payload.username || ''),
        globalName: String(payload.globalName || payload.username || '')
    };
}

module.exports = {
    clearDiscordVerifyCookie,
    getDiscordVerifyUser,
    setDiscordVerifyCookie
};
