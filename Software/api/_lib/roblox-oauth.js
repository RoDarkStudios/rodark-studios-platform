function buildAuthorizeUrl({ authorizeEndpoint, clientId, redirectUri, scopes, state }) {
    const url = new URL(authorizeEndpoint);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', scopes);
    url.searchParams.set('state', state);
    return url.toString();
}

function parseResponseError(data, fallbackMessage) {
    const detail = data && (data.error_description || data.error || data.message || data.detail);
    if (!detail) {
        return fallbackMessage;
    }

    return `${fallbackMessage}: ${detail}`;
}

async function exchangeCodeForToken({ tokenEndpoint, clientId, clientSecret, redirectUri, code }) {
    const body = new URLSearchParams();
    body.set('grant_type', 'authorization_code');
    body.set('client_id', clientId);
    body.set('client_secret', clientSecret);
    body.set('redirect_uri', redirectUri);
    body.set('code', code);

    const response = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: body.toString()
    });

    let data = {};
    try {
        data = await response.json();
    } catch (error) {
        data = {};
    }

    if (!response.ok) {
        throw new Error(parseResponseError(data, 'Roblox token exchange failed'));
    }

    if (!data.access_token) {
        throw new Error('Roblox token exchange did not return an access token');
    }

    return data;
}

async function fetchRobloxUserInfo({ userInfoEndpoint, accessToken }) {
    const response = await fetch(userInfoEndpoint, {
        method: 'GET',
        headers: {
            Authorization: `Bearer ${accessToken}`
        }
    });

    let data = {};
    try {
        data = await response.json();
    } catch (error) {
        data = {};
    }

    if (!response.ok) {
        throw new Error(parseResponseError(data, 'Failed to fetch Roblox user profile'));
    }

    return data;
}

function normalizeRobloxUser(rawProfile) {
    const id = String(rawProfile && rawProfile.sub ? rawProfile.sub : '').trim();
    const username = String(
        (rawProfile && (rawProfile.preferred_username || rawProfile.nickname || rawProfile.name)) || ''
    ).trim();
    const displayName = String((rawProfile && (rawProfile.name || rawProfile.nickname || username)) || '').trim();
    const profileUrl = rawProfile && rawProfile.profile ? String(rawProfile.profile).trim() : '';
    const createdAt = rawProfile && rawProfile.created_at ? String(rawProfile.created_at).trim() : null;

    if (!id || !username) {
        throw new Error('Roblox user profile response was missing required fields');
    }

    return {
        id,
        username,
        displayName: displayName || username,
        profileUrl: profileUrl || null,
        createdAt
    };
}

module.exports = {
    buildAuthorizeUrl,
    exchangeCodeForToken,
    fetchRobloxUserInfo,
    normalizeRobloxUser
};
