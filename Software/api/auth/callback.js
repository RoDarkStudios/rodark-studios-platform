const { methodNotAllowed } = require('../_lib/http');
const { parseCookies, serializeCookie, appendSetCookie, SESSION_COOKIE, OAUTH_STATE_COOKIE } = require('../_lib/cookies');
const { issueSignedToken, verifySignedToken } = require('../_lib/signed-token');
const { getAuthSecret, getRobloxOAuthConfig } = require('../_lib/auth-config');
const { exchangeCodeForToken, fetchRobloxUserInfo, normalizeRobloxUser } = require('../_lib/roblox-oauth');

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

function readQuery(req) {
    if (req.query && typeof req.query === 'object') {
        return req.query;
    }

    const url = new URL(req.url, 'http://localhost');
    return Object.fromEntries(url.searchParams.entries());
}

function buildRedirectPath(pathname, status, reason) {
    const target = new URL(pathname, 'http://localhost');
    target.searchParams.set('auth', status);
    if (reason) {
        target.searchParams.set('reason', reason);
    }
    return `${target.pathname}${target.search}`;
}

function redirect(res, destination) {
    res.statusCode = 302;
    res.setHeader('Location', destination);
    res.end();
}

function clearOAuthStateCookie(res) {
    appendSetCookie(res, serializeCookie(OAUTH_STATE_COOKIE, '', {
        httpOnly: true,
        sameSite: 'Lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: 0
    }));
}

function setSessionCookie(res, sessionToken) {
    appendSetCookie(res, serializeCookie(SESSION_COOKIE, sessionToken, {
        httpOnly: true,
        sameSite: 'Lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: SESSION_TTL_SECONDS
    }));
}

function sanitizeReturnTo(value) {
    const raw = String(value || '').trim();
    if (!raw.startsWith('/') || raw.startsWith('//')) {
        return '/';
    }

    return raw.split('#')[0];
}

module.exports = async (req, res) => {
    if (req.method !== 'GET') {
        return methodNotAllowed(req, res, ['GET']);
    }

    try {
        const query = readQuery(req);
        const cookies = parseCookies(req);
        const cookieStateToken = cookies[OAUTH_STATE_COOKIE];
        const queryStateToken = String(query.state || '');

        if (!cookieStateToken || !queryStateToken || cookieStateToken !== queryStateToken) {
            clearOAuthStateCookie(res);
            return redirect(res, buildRedirectPath('/', 'error', 'state_mismatch'));
        }

        const statePayload = verifySignedToken(cookieStateToken, getAuthSecret());
        if (!statePayload || statePayload.type !== 'oauth_state') {
            clearOAuthStateCookie(res);
            return redirect(res, buildRedirectPath('/', 'error', 'invalid_state'));
        }

        const returnTo = sanitizeReturnTo(statePayload.returnTo || '/');
        clearOAuthStateCookie(res);

        if (query.error) {
            return redirect(res, buildRedirectPath(returnTo, 'error', String(query.error)));
        }

        const code = String(query.code || '').trim();
        if (!code) {
            return redirect(res, buildRedirectPath(returnTo, 'error', 'missing_code'));
        }

        const oauthConfig = getRobloxOAuthConfig(req);
        const tokenData = await exchangeCodeForToken({
            tokenEndpoint: oauthConfig.tokenEndpoint,
            clientId: oauthConfig.clientId,
            clientSecret: oauthConfig.clientSecret,
            redirectUri: oauthConfig.redirectUri,
            code
        });

        const rawUser = await fetchRobloxUserInfo({
            userInfoEndpoint: oauthConfig.userInfoEndpoint,
            accessToken: tokenData.access_token
        });
        const robloxUser = normalizeRobloxUser(rawUser);

        const sessionToken = issueSignedToken({
            type: 'session',
            provider: 'roblox',
            sub: robloxUser.id,
            username: robloxUser.username,
            displayName: robloxUser.displayName,
            profileUrl: robloxUser.profileUrl,
            createdAt: robloxUser.createdAt
        }, getAuthSecret(), SESSION_TTL_SECONDS);

        setSessionCookie(res, sessionToken);
        return redirect(res, buildRedirectPath(returnTo, 'success'));
    } catch (error) {
        clearOAuthStateCookie(res);
        return redirect(res, buildRedirectPath('/', 'error', 'callback_failed'));
    }
};
