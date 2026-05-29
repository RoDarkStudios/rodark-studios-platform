const SESSION_COOKIE = 'rd_session';
const OAUTH_STATE_COOKIE = 'rd_oauth_state';

function parseCookies(req) {
    const header = req.headers.cookie;
    if (!header) {
        return {};
    }

    return header.split(';').reduce((acc, part) => {
        const [rawKey, ...rawValue] = part.trim().split('=');
        if (!rawKey) {
            return acc;
        }
        acc[decodeURIComponent(rawKey)] = decodeURIComponent(rawValue.join('=') || '');
        return acc;
    }, {});
}

function serializeCookie(name, value, options = {}) {
    const {
        httpOnly = true,
        secure = process.env.NODE_ENV === 'production',
        sameSite = 'Lax',
        path = '/',
        maxAge
    } = options;

    const parts = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`];

    if (path) {
        parts.push(`Path=${path}`);
    }

    if (Number.isFinite(maxAge)) {
        parts.push(`Max-Age=${Math.floor(maxAge)}`);
    }

    if (sameSite) {
        parts.push(`SameSite=${sameSite}`);
    }

    if (httpOnly) {
        parts.push('HttpOnly');
    }

    if (secure) {
        parts.push('Secure');
    }

    return parts.join('; ');
}

function appendSetCookie(res, cookieValue) {
    const current = res.getHeader('Set-Cookie');
    if (!current) {
        res.setHeader('Set-Cookie', [cookieValue]);
        return;
    }

    if (Array.isArray(current)) {
        res.setHeader('Set-Cookie', [...current, cookieValue]);
        return;
    }

    res.setHeader('Set-Cookie', [current, cookieValue]);
}

function clearAuthCookies(res) {
    const expired = 'Thu, 01 Jan 1970 00:00:00 GMT';
    const sessionCookie = `${serializeCookie(SESSION_COOKIE, '', { maxAge: 0 })}; Expires=${expired}`;
    const oauthStateCookie = `${serializeCookie(OAUTH_STATE_COOKIE, '', { maxAge: 0 })}; Expires=${expired}`;
    // Legacy cleanup for previously used auth cookies.
    const legacyStateCookie = `${serializeCookie('rd_webauthn_state', '', { maxAge: 0 })}; Expires=${expired}`;
    const accessCookie = `${serializeCookie('rd_access_token', '', { maxAge: 0 })}; Expires=${expired}`;
    const refreshCookie = `${serializeCookie('rd_refresh_token', '', { maxAge: 0 })}; Expires=${expired}`;

    res.setHeader('Set-Cookie', [sessionCookie, oauthStateCookie, legacyStateCookie, accessCookie, refreshCookie]);
}

module.exports = {
    SESSION_COOKIE,
    OAUTH_STATE_COOKIE,
    parseCookies,
    serializeCookie,
    appendSetCookie,
    clearAuthCookies
};
