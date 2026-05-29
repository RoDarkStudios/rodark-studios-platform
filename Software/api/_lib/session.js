const { SESSION_COOKIE, parseCookies, clearAuthCookies } = require('./cookies');
const { verifySignedToken } = require('./signed-token');
const { getAuthSecret } = require('./auth-config');

async function requireUserFromSession(req, res) {
    const cookies = parseCookies(req);
    const sessionToken = cookies[SESSION_COOKIE];

    if (!sessionToken) {
        return { user: null, accessToken: null };
    }

    let payload;
    try {
        payload = verifySignedToken(sessionToken, getAuthSecret());
    } catch (error) {
        clearAuthCookies(res);
        return { user: null, accessToken: null };
    }

    if (!payload || payload.type !== 'session' || payload.provider !== 'roblox' || !payload.sub || !payload.username) {
        clearAuthCookies(res);
        return { user: null, accessToken: null };
    }

    const user = {
        id: String(payload.sub),
        username: String(payload.username),
        display_name: String(payload.displayName || payload.username),
        provider: 'roblox',
        profile_url: payload.profileUrl ? String(payload.profileUrl) : null,
        created_at: payload.createdAt ? String(payload.createdAt) : null
    };

    return { user, accessToken: null };
}

module.exports = {
    requireUserFromSession
};
