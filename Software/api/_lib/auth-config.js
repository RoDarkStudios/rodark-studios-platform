function getHeaderValue(req, key) {
    const value = req.headers[key];
    if (Array.isArray(value)) {
        return String(value[0] || '').trim();
    }

    return String(value || '').split(',')[0].trim();
}

function getRequestHost(req) {
    return getHeaderValue(req, 'x-forwarded-host') || getHeaderValue(req, 'host');
}

function getRequestProtocol(req) {
    return getHeaderValue(req, 'x-forwarded-proto') || (process.env.NODE_ENV === 'production' ? 'https' : 'http');
}

function getRequestOrigin(req) {
    const host = getRequestHost(req);
    if (!host) {
        throw new Error('Unable to determine request host');
    }

    return `${getRequestProtocol(req)}://${host}`.replace(/\/+$/g, '');
}

function getAuthSecret() {
    const secret = process.env.AUTH_SECRET || process.env.SESSION_SECRET;
    if (!secret) {
        throw new Error('AUTH_SECRET must be set');
    }

    return secret;
}

function getRobloxOAuthConfig(req) {
    const clientId = String(process.env.ROBLOX_OAUTH_CLIENT_ID || '').trim();
    const clientSecret = String(process.env.ROBLOX_OAUTH_CLIENT_SECRET || '').trim();
    const baseUrl = String(process.env.ROBLOX_OAUTH_BASE_URL || 'https://apis.roblox.com/oauth').replace(/\/+$/g, '');
    const redirectUri = String(
        process.env.ROBLOX_OAUTH_REDIRECT_URI || `${getRequestOrigin(req)}/api/auth/callback`
    ).trim();
    const scopes = String(process.env.ROBLOX_OAUTH_SCOPES || 'openid profile')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .join(' ');

    if (!clientId || !clientSecret) {
        throw new Error('ROBLOX_OAUTH_CLIENT_ID and ROBLOX_OAUTH_CLIENT_SECRET must be set');
    }

    return {
        clientId,
        clientSecret,
        redirectUri,
        scopes,
        authorizeEndpoint: `${baseUrl}/v1/authorize`,
        tokenEndpoint: `${baseUrl}/v1/token`,
        userInfoEndpoint: `${baseUrl}/v1/userinfo`
    };
}

module.exports = {
    getAuthSecret,
    getRobloxOAuthConfig,
    getRequestOrigin
};
