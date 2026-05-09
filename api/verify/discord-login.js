const { methodNotAllowed, sendJson } = require('../_lib/http');
const { serializeCookie, appendSetCookie, DISCORD_OAUTH_STATE_COOKIE } = require('../_lib/cookies');
const { issueSignedToken } = require('../_lib/signed-token');
const { getAuthSecret, getDiscordOAuthConfig } = require('../_lib/auth-config');
const { buildDiscordAuthorizeUrl } = require('../_lib/discord-oauth');

const DISCORD_STATE_TTL_SECONDS = 60 * 10;

function redirect(res, destination) {
    res.statusCode = 302;
    res.setHeader('Location', destination);
    res.end();
}

function readQuery(req) {
    if (req.query && typeof req.query === 'object') {
        return req.query;
    }

    const url = new URL(req.url, 'http://localhost');
    return Object.fromEntries(url.searchParams.entries());
}

function sanitizeReturnTo(value) {
    const raw = String(value || '').trim();
    if (!raw.startsWith('/') || raw.startsWith('//')) {
        return '/verify';
    }
    return raw.split('#')[0];
}

module.exports = async (req, res) => {
    if (req.method !== 'GET') {
        return methodNotAllowed(req, res, ['GET']);
    }

    try {
        const query = readQuery(req);
        const returnTo = sanitizeReturnTo(query.returnTo || '/verify');
        const oauthConfig = getDiscordOAuthConfig(req);
        const stateToken = issueSignedToken({
            type: 'discord_oauth_state',
            returnTo
        }, getAuthSecret(), DISCORD_STATE_TTL_SECONDS);

        appendSetCookie(res, serializeCookie(DISCORD_OAUTH_STATE_COOKIE, stateToken, {
            httpOnly: true,
            sameSite: 'Lax',
            secure: process.env.NODE_ENV === 'production',
            path: '/',
            maxAge: DISCORD_STATE_TTL_SECONDS
        }));

        return redirect(res, buildDiscordAuthorizeUrl({
            authorizeEndpoint: oauthConfig.authorizeEndpoint,
            clientId: oauthConfig.clientId,
            redirectUri: oauthConfig.redirectUri,
            scopes: oauthConfig.scopes,
            state: stateToken
        }));
    } catch (error) {
        return sendJson(res, 500, { error: 'Failed to start Discord verification', details: error.message });
    }
};
