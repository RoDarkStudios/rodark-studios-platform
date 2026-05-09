const { methodNotAllowed } = require('../_lib/http');
const { parseCookies, serializeCookie, appendSetCookie, DISCORD_OAUTH_STATE_COOKIE } = require('../_lib/cookies');
const { verifySignedToken } = require('../_lib/signed-token');
const { getAuthSecret, getDiscordOAuthConfig } = require('../_lib/auth-config');
const {
    exchangeDiscordCodeForToken,
    fetchDiscordUserInfo,
    normalizeDiscordUser
} = require('../_lib/discord-oauth');
const { setDiscordVerifyCookie } = require('../_lib/discord-verify-session');

function readQuery(req) {
    if (req.query && typeof req.query === 'object') {
        return req.query;
    }

    const url = new URL(req.url, 'http://localhost');
    return Object.fromEntries(url.searchParams.entries());
}

function redirect(res, destination) {
    res.statusCode = 302;
    res.setHeader('Location', destination);
    res.end();
}

function buildRedirectPath(pathname, status, reason) {
    const target = new URL(pathname, 'http://localhost');
    target.searchParams.set('discord', status);
    if (reason) {
        target.searchParams.set('reason', reason);
    }
    return `${target.pathname}${target.search}`;
}

function clearDiscordStateCookie(res) {
    appendSetCookie(res, serializeCookie(DISCORD_OAUTH_STATE_COOKIE, '', {
        httpOnly: true,
        sameSite: 'Lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: 0
    }));
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
        const cookies = parseCookies(req);
        const cookieStateToken = cookies[DISCORD_OAUTH_STATE_COOKIE];
        const queryStateToken = String(query.state || '');

        if (!cookieStateToken || !queryStateToken || cookieStateToken !== queryStateToken) {
            clearDiscordStateCookie(res);
            return redirect(res, buildRedirectPath('/verify', 'error', 'state_mismatch'));
        }

        const statePayload = verifySignedToken(cookieStateToken, getAuthSecret());
        if (!statePayload || statePayload.type !== 'discord_oauth_state') {
            clearDiscordStateCookie(res);
            return redirect(res, buildRedirectPath('/verify', 'error', 'invalid_state'));
        }

        const returnTo = sanitizeReturnTo(statePayload.returnTo || '/verify');
        clearDiscordStateCookie(res);

        if (query.error) {
            return redirect(res, buildRedirectPath(returnTo, 'error', String(query.error)));
        }

        const code = String(query.code || '').trim();
        if (!code) {
            return redirect(res, buildRedirectPath(returnTo, 'error', 'missing_code'));
        }

        const oauthConfig = getDiscordOAuthConfig(req);
        const tokenData = await exchangeDiscordCodeForToken({
            tokenEndpoint: oauthConfig.tokenEndpoint,
            clientId: oauthConfig.clientId,
            clientSecret: oauthConfig.clientSecret,
            redirectUri: oauthConfig.redirectUri,
            code
        });
        const rawUser = await fetchDiscordUserInfo({
            userInfoEndpoint: oauthConfig.userInfoEndpoint,
            accessToken: tokenData.access_token
        });
        const discordUser = normalizeDiscordUser(rawUser);

        setDiscordVerifyCookie(res, discordUser);
        return redirect(res, buildRedirectPath(returnTo, 'success'));
    } catch (error) {
        clearDiscordStateCookie(res);
        return redirect(res, buildRedirectPath('/verify', 'error', 'callback_failed'));
    }
};
