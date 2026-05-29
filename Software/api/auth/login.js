const { methodNotAllowed, sendJson } = require('../_lib/http');
const { serializeCookie, appendSetCookie, OAUTH_STATE_COOKIE } = require('../_lib/cookies');
const { issueSignedToken } = require('../_lib/signed-token');
const { getAuthSecret, getRobloxOAuthConfig } = require('../_lib/auth-config');
const { buildAuthorizeUrl } = require('../_lib/roblox-oauth');

const OAUTH_STATE_TTL_SECONDS = 60 * 10;

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
        return '/';
    }
    return raw;
}

module.exports = async (req, res) => {
    if (req.method !== 'GET') {
        return methodNotAllowed(req, res, ['GET']);
    }

    try {
        const query = readQuery(req);
        const returnTo = sanitizeReturnTo(query.returnTo || '/');
        const oauthConfig = getRobloxOAuthConfig(req);

        const stateToken = issueSignedToken({
            type: 'oauth_state',
            returnTo
        }, getAuthSecret(), OAUTH_STATE_TTL_SECONDS);

        appendSetCookie(res, serializeCookie(OAUTH_STATE_COOKIE, stateToken, {
            httpOnly: true,
            sameSite: 'Lax',
            secure: process.env.NODE_ENV === 'production',
            path: '/',
            maxAge: OAUTH_STATE_TTL_SECONDS
        }));

        const authorizeUrl = buildAuthorizeUrl({
            authorizeEndpoint: oauthConfig.authorizeEndpoint,
            clientId: oauthConfig.clientId,
            redirectUri: oauthConfig.redirectUri,
            scopes: oauthConfig.scopes,
            state: stateToken
        });

        return redirect(res, authorizeUrl);
    } catch (error) {
        return sendJson(res, 500, { error: 'Failed to start Roblox login', details: error.message });
    }
};
