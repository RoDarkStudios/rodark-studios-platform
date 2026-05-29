const fs = require('fs');
const http = require('http');
const path = require('path');

const authAdmin = require('./api/auth/admin');
const authCallback = require('./api/auth/callback');
const authLogin = require('./api/auth/login');
const authLogout = require('./api/auth/logout');
const authMe = require('./api/auth/me');
const robloxAvatarHeadshot = require('./api/roblox/avatar-headshot');
const robloxGameIcon = require('./api/roblox/game-icon');
const robloxGames = require('./api/roblox/games');
const robloxGroupGames = require('./api/roblox/group-games');
const robloxGroupStats = require('./api/roblox/group-stats');
const adminCopyMonetization = require('./api/admin/roblox-copy-monetization');
const adminListMonetizationItems = require('./api/admin/roblox-list-monetization-items');
const adminSyncExperienceConfigs = require('./api/admin/roblox-sync-experience-configs');
const adminDiscordBotControl = require('./api/admin/discord-bot-control');
const adminPlatformSettings = require('./api/admin/platform-settings');
const { getAdminGroupId } = require('./api/_lib/roblox-groups');

const rootDir = __dirname;
const port = process.env.PORT || 3000;
const socialPreviewFallbackDescription = '6.5M visits, 2.2K active players, and 460K community members.';
const socialPreviewCacheTtlMs = 5 * 60 * 1000;
const socialPreviewFailureTtlMs = 60 * 1000;
const socialPreviewRequestTimeoutMs = 5000;
const activePlayersDisplayThreshold = 1000;
const robloxGroupGamesPageLimit = 100;
const robloxGameDetailsBatchSize = 20;
const robloxGroupGamesMaxPages = 20;
let studioStatsCache = {
    stats: null,
    expiresAt: 0,
    pending: null
};
let socialPreviewCache = {
    description: socialPreviewFallbackDescription,
    expiresAt: 0,
    pending: null
};

const pageRoutes = {
    '/privacy': 'privacy.html',
    '/terms': 'terms.html',
    '/admin': 'admin.html',
    '/admin/tools': 'admin-tools.html',
    '/admin/discord-bot': 'admin-discord-bot.html',
    '/admin/tools/copy-monetization': 'admin-copy-monetization.html',
    '/admin/tools/list-monetization-ids': 'admin-list-monetization-ids.html',
    '/admin/tools/sync-game-description': 'admin-sync-game-description.html',
    '/admin/tools/sync-live-configs': 'admin-sync-live-configs.html',
    '/admin/tools/game-configuration': 'admin-game-configuration.html'
};

const htmlRedirects = {
    '/privacy.html': '/privacy',
    '/terms.html': '/terms',
    '/admin.html': '/admin',
    '/admin-tools.html': '/admin/tools',
    '/admin-discord-bot.html': '/admin/discord-bot',
    '/admin-copy-monetization.html': '/admin/tools/copy-monetization',
    '/admin-list-monetization-ids.html': '/admin/tools/list-monetization-ids',
    '/admin-sync-game-description.html': '/admin/tools/sync-game-description',
    '/admin-sync-live-configs.html': '/admin/tools/sync-live-configs',
    '/admin-game-configuration.html': '/admin/tools/game-configuration'
};

const apiRoutes = {
    '/api/auth/admin': authAdmin,
    '/api/auth/callback': authCallback,
    '/api/auth/login': authLogin,
    '/api/auth/logout': authLogout,
    '/api/auth/me': authMe,
    '/api/profile': authMe,
    '/api/roblox/avatar-headshot': robloxAvatarHeadshot,
    '/api/roblox/game-icon': robloxGameIcon,
    '/api/roblox/games': robloxGames,
    '/api/roblox/group-games': robloxGroupGames,
    '/api/roblox/group-stats': robloxGroupStats,
    '/api/roblox/studio-stats': sendStudioStats,
    '/api/admin/roblox-copy-monetization': adminCopyMonetization,
    '/api/admin/roblox-list-monetization-items': adminListMonetizationItems,
    '/api/admin/roblox-sync-experience-configs': adminSyncExperienceConfigs,
    '/api/admin/discord-bot-control': adminDiscordBotControl,
    '/api/admin/platform-settings': adminPlatformSettings
};

const mimeTypes = {
    '.css': 'text/css; charset=utf-8',
    '.gif': 'image/gif',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.webp': 'image/webp'
};

function enhanceResponse(res) {
    res.status = (statusCode) => {
        res.statusCode = statusCode;
        return res;
    };

    res.json = (data) => {
        if (!res.getHeader('Content-Type')) {
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
        }
        res.end(JSON.stringify(data));
    };

    return res;
}

function sendJson(res, statusCode, data) {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(data));
}

function sendRedirect(res, statusCode, location) {
    res.statusCode = statusCode;
    res.setHeader('Location', location);
    res.end();
}

function escapeHtmlAttribute(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function formatInteger(value) {
    return Math.trunc(value).toLocaleString('en-US');
}

function formatCompactVisits(value) {
    const visits = Math.trunc(value);
    if (visits >= 1000000) {
        const millions = visits / 1000000;
        return `${millions.toFixed(millions >= 10 ? 0 : 1).replace(/\.0$/, '')}M`;
    }

    if (visits >= 1000) {
        const thousands = visits / 1000;
        return `${thousands.toFixed(thousands >= 10 ? 0 : 1).replace(/\.0$/, '')}K`;
    }

    return formatInteger(visits);
}

function formatCompactCount(value) {
    const count = Math.trunc(value);
    if (count >= 1000000) {
        const millions = count / 1000000;
        return `${millions.toFixed(millions >= 10 ? 0 : 1).replace(/\.0$/, '')}M`;
    }

    if (count >= 1000) {
        const thousands = count / 1000;
        return `${thousands.toFixed(thousands >= 10 ? 0 : 1).replace(/\.0$/, '')}K`;
    }

    return formatInteger(count);
}

function shouldDisplayActivePlayers(value) {
    const count = Number(value);
    return Number.isFinite(count) && count > activePlayersDisplayThreshold;
}

function serializeStudioStats(stats) {
    const totalVisits = Number(stats && stats.totalVisits);
    const totalPlaying = Number(stats && stats.totalPlaying);
    const memberCount = Number(stats && stats.memberCount);

    return {
        groupId: Number(stats && stats.groupId),
        totalVisits: Number.isFinite(totalVisits) && totalVisits >= 0 ? Math.trunc(totalVisits) : null,
        totalPlaying: Number.isFinite(totalPlaying) && totalPlaying >= 0 ? Math.trunc(totalPlaying) : null,
        memberCount: Number.isFinite(memberCount) && memberCount >= 0 ? Math.trunc(memberCount) : null,
        activePlayersDisplayThreshold,
        showActivePlayers: shouldDisplayActivePlayers(totalPlaying)
    };
}

async function fetchRobloxJson(endpoint) {
    const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
            Accept: 'application/json'
        },
        signal: AbortSignal.timeout(socialPreviewRequestTimeoutMs)
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
        throw new Error(`Roblox API returned ${response.status}`);
    }

    return payload;
}

function refreshSocialPreviewDescription() {
    if (!socialPreviewCache.pending) {
        socialPreviewCache.pending = fetchSocialPreviewDescription()
            .then((description) => {
                socialPreviewCache = {
                    description,
                    expiresAt: Date.now() + socialPreviewCacheTtlMs,
                    pending: null
                };
                return description;
            })
            .catch((error) => {
                console.error('Failed to refresh social preview stats:', error);
                const description = socialPreviewCache.description || socialPreviewFallbackDescription;
                socialPreviewCache = {
                    description,
                    expiresAt: Date.now() + socialPreviewFailureTtlMs,
                    pending: null
                };
                return description;
            });
    }

    return socialPreviewCache.pending;
}

function parsePositiveId(value) {
    const parsed = Number.parseInt(String(value || '').trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function fetchGroupUniverseIds(groupId) {
    const universeIds = [];
    const seen = new Set();
    let cursor = '';

    for (let page = 0; page < robloxGroupGamesMaxPages; page += 1) {
        const endpoint = new URL(`https://games.roblox.com/v2/groups/${encodeURIComponent(groupId)}/games`);
        endpoint.searchParams.set('accessFilter', 'All');
        endpoint.searchParams.set('limit', String(robloxGroupGamesPageLimit));
        endpoint.searchParams.set('sortOrder', 'Asc');
        if (cursor) {
            endpoint.searchParams.set('cursor', cursor);
        }

        const payload = await fetchRobloxJson(endpoint);
        const games = Array.isArray(payload && payload.data) ? payload.data : [];
        games.forEach((game) => {
            const universeId = parsePositiveId(game && game.id);
            if (universeId && !seen.has(universeId)) {
                seen.add(universeId);
                universeIds.push(universeId);
            }
        });

        cursor = typeof (payload && payload.nextPageCursor) === 'string'
            ? payload.nextPageCursor.trim()
            : '';
        if (!cursor) {
            break;
        }
    }

    return universeIds;
}

async function fetchGameDetails(universeIds) {
    const games = [];
    for (let index = 0; index < universeIds.length; index += robloxGameDetailsBatchSize) {
        const batch = universeIds.slice(index, index + robloxGameDetailsBatchSize);
        const endpoint = new URL('https://games.roblox.com/v1/games');
        endpoint.searchParams.set('universeIds', batch.join(','));

        const payload = await fetchRobloxJson(endpoint);
        if (Array.isArray(payload && payload.data)) {
            games.push(...payload.data);
        }
    }

    return games;
}

async function fetchFreshStudioStats() {
    const groupId = getAdminGroupId();
    const groupEndpoint = `https://groups.roblox.com/v1/groups/${encodeURIComponent(groupId)}`;

    const [universeIds, groupPayload] = await Promise.all([
        fetchGroupUniverseIds(groupId),
        fetchRobloxJson(groupEndpoint)
    ]);

    if (!universeIds.length) {
        throw new Error('Roblox group games response did not include any universe IDs');
    }

    const games = await fetchGameDetails(universeIds);
    const totalVisits = games.reduce((sum, game) => {
        const visits = Number(game && game.visits);
        return Number.isFinite(visits) && visits >= 0 ? sum + Math.trunc(visits) : sum;
    }, 0);
    const totalPlaying = games.reduce((sum, game) => {
        const playing = Number(game && game.playing);
        return Number.isFinite(playing) && playing >= 0 ? sum + Math.trunc(playing) : sum;
    }, 0);
    const memberCount = Number(groupPayload && groupPayload.memberCount);

    if (!Number.isFinite(totalVisits) || totalVisits <= 0) {
        throw new Error('Roblox games response was missing visit counts');
    }

    if (!Number.isFinite(memberCount) || memberCount < 0) {
        throw new Error('Roblox group response was missing memberCount');
    }

    return serializeStudioStats({
        groupId,
        totalVisits,
        totalPlaying,
        memberCount
    });
}

function refreshStudioStats() {
    if (!studioStatsCache.pending) {
        studioStatsCache.pending = fetchFreshStudioStats()
            .then((stats) => {
                studioStatsCache = {
                    stats,
                    expiresAt: Date.now() + socialPreviewCacheTtlMs,
                    pending: null
                };
                return stats;
            })
            .catch((error) => {
                const staleStats = studioStatsCache.stats;
                studioStatsCache = {
                    stats: staleStats,
                    expiresAt: staleStats ? Date.now() + socialPreviewFailureTtlMs : 0,
                    pending: null
                };

                if (staleStats) {
                    return staleStats;
                }

                throw error;
            });
    }

    return studioStatsCache.pending;
}

function getStudioStats() {
    const now = Date.now();
    if (studioStatsCache.stats && studioStatsCache.expiresAt > now) {
        return Promise.resolve(studioStatsCache.stats);
    }

    return refreshStudioStats();
}

function buildSocialPreviewDescription(stats) {
    const visitsText = `${formatCompactVisits(stats.totalVisits)} visits`;
    const membersText = `${formatCompactCount(stats.memberCount)} community members`;

    if (stats.showActivePlayers) {
        return `${visitsText}, ${formatCompactCount(stats.totalPlaying)} active players, and ${membersText}.`;
    }

    return `${visitsText} and ${membersText}.`;
}

async function fetchSocialPreviewDescription() {
    const stats = await getStudioStats();
    return buildSocialPreviewDescription(stats);
}

async function getSocialPreviewDescription() {
    const now = Date.now();
    if (socialPreviewCache.description && socialPreviewCache.expiresAt > now) {
        return socialPreviewCache.description;
    }

    refreshSocialPreviewDescription();
    return socialPreviewCache.description || socialPreviewFallbackDescription;
}

function injectSocialPreviewDescription(html, description) {
    const escapedDescription = escapeHtmlAttribute(description);
    return String(html)
        .replace(
            /(<meta\s+name="description"\s+content=")[^"]*(")/i,
            `$1${escapedDescription}$2`
        )
        .replace(
            /(<meta\s+property="og:description"\s+content=")[^"]*(")/i,
            `$1${escapedDescription}$2`
        )
        .replace(
            /(<meta\s+name="twitter:description"\s+content=")[^"]*(")/i,
            `$1${escapedDescription}$2`
        );
}

async function sendStudioStats(req, res) {
    if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        sendJson(res, 405, { error: 'Method Not Allowed' });
        return;
    }

    try {
        const stats = await getStudioStats();
        res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
        sendJson(res, 200, stats);
    } catch (error) {
        sendJson(res, 502, {
            error: 'Failed to fetch Roblox studio stats',
            details: error.message
        });
    }
}

async function sendIndexHtml(req, res) {
    const filePath = path.join(rootDir, 'index.html');
    const [html, description] = await Promise.all([
        fs.promises.readFile(filePath, 'utf8'),
        getSocialPreviewDescription()
    ]);
    const body = injectSocialPreviewDescription(html, description);
    const buffer = Buffer.from(body, 'utf8');

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');

    if (req.method === 'HEAD') {
        res.end();
        return;
    }

    res.end(buffer);
}

function resolveStaticPath(urlPath) {
    let decodedPath;
    try {
        decodedPath = decodeURIComponent(urlPath);
    } catch (error) {
        return null;
    }

    const normalizedPath = path.normalize(decodedPath).replace(/^(\.\.[/\\])+/, '');
    const filePath = path.join(rootDir, normalizedPath);

    if (!filePath.startsWith(rootDir)) {
        return null;
    }

    return filePath;
}

function sendFile(res, filename) {
    const filePath = path.isAbsolute(filename) ? filename : path.join(rootDir, filename);
    const extension = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[extension] || 'application/octet-stream';

    fs.stat(filePath, (statError, stats) => {
        if (statError || !stats.isFile()) {
            sendJson(res, 404, { error: 'Not Found' });
            return;
        }

        res.statusCode = 200;
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Length', stats.size);
        if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico'].includes(extension)) {
            res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
        } else if (['.css', '.js'].includes(extension)) {
            res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400');
        } else if (extension === '.html') {
            res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
        }
        fs.createReadStream(filePath).pipe(res);
    });
}

async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }

    if (!chunks.length) {
        return undefined;
    }

    const rawBody = Buffer.concat(chunks).toString('utf8');
    if (!rawBody.trim()) {
        return {};
    }

    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    if (contentType.includes('application/json')) {
        return JSON.parse(rawBody);
    }

    return rawBody;
}

async function handleApi(req, res, pathname) {
    const handler = apiRoutes[pathname];
    if (!handler) {
        sendJson(res, 404, { error: 'Not Found' });
        return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
        req.body = await readBody(req);
    }

    await handler(req, res);
}

async function handleRequest(req, res) {
    enhanceResponse(res);

    const requestUrl = new URL(req.url, 'http://localhost');
    const pathname = requestUrl.pathname;
    const routePath = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
    req.query = Object.fromEntries(requestUrl.searchParams.entries());

    if (routePath === '/health' || routePath === '/api/health') {
        sendJson(res, 200, { ok: true });
        return;
    }

    if (htmlRedirects[routePath]) {
        sendRedirect(res, 301, `${htmlRedirects[routePath]}${requestUrl.search}`);
        return;
    }

    if (routePath !== pathname && (pageRoutes[routePath] || apiRoutes[routePath])) {
        sendRedirect(res, 301, `${routePath}${requestUrl.search}`);
        return;
    }

    if (pageRoutes[routePath]) {
        sendFile(res, pageRoutes[routePath]);
        return;
    }

    if (routePath === '/' || routePath === '/index.html') {
        await sendIndexHtml(req, res);
        return;
    }

    if (routePath.startsWith('/api/')) {
        await handleApi(req, res, routePath);
        return;
    }

    const staticPath = resolveStaticPath(pathname === '/' ? '/index.html' : pathname);
    if (staticPath && fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
        sendFile(res, staticPath);
        return;
    }

    await sendIndexHtml(req, res);
}

const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
        console.error(error);
        if (res.headersSent) {
            res.end();
            return;
        }

        sendJson(res, 500, {
            error: 'Internal Server Error',
            details: process.env.NODE_ENV === 'production' ? undefined : error.message
        });
    });
});

server.listen(port, () => {
    console.log(`RoDark Studios platform listening on port ${port}`);
});
