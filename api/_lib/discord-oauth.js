function buildDiscordAuthorizeUrl({ authorizeEndpoint, clientId, redirectUri, scopes, state }) {
    const url = new URL(authorizeEndpoint);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', scopes);
    url.searchParams.set('state', state);
    return url.toString();
}

function parseResponseError(payload, fallback) {
    if (!payload || typeof payload !== 'object') {
        return fallback;
    }

    return payload.error_description || payload.error || payload.message || fallback;
}

async function exchangeDiscordCodeForToken({ tokenEndpoint, clientId, clientSecret, redirectUri, code }) {
    const body = new URLSearchParams();
    body.set('client_id', clientId);
    body.set('client_secret', clientSecret);
    body.set('grant_type', 'authorization_code');
    body.set('code', code);
    body.set('redirect_uri', redirectUri);

    const response = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body,
        signal: AbortSignal.timeout(15000)
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(parseResponseError(data, 'Discord token exchange failed'));
    }

    if (!data || !data.access_token) {
        throw new Error('Discord token exchange did not return an access token');
    }

    return data;
}

async function fetchDiscordUserInfo({ userInfoEndpoint, accessToken }) {
    const response = await fetch(userInfoEndpoint, {
        method: 'GET',
        headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${accessToken}`
        },
        signal: AbortSignal.timeout(15000)
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(parseResponseError(data, 'Failed to fetch Discord profile'));
    }

    return data;
}

function normalizeDiscordUser(rawProfile) {
    const id = rawProfile && rawProfile.id ? String(rawProfile.id).trim() : '';
    const username = rawProfile && rawProfile.username ? String(rawProfile.username).trim() : '';
    const globalName = rawProfile && rawProfile.global_name ? String(rawProfile.global_name).trim() : '';

    if (!/^\d{5,25}$/.test(id) || !username) {
        throw new Error('Discord user profile response was missing required fields');
    }

    return {
        id,
        username,
        globalName: globalName || username
    };
}

module.exports = {
    buildDiscordAuthorizeUrl,
    exchangeDiscordCodeForToken,
    fetchDiscordUserInfo,
    normalizeDiscordUser
};
