const ROBLOX_ANALYTICS_BASE_URL = 'https://apis.roblox.com/analytics-query-api';
const ROBLOX_GAMES_URL = 'https://games.roblox.com/v1/games';
const STANDARD_DEVEX_USD_PER_ROBUX = 0.0038;
const ANALYTICS_RETENTION_DAYS = 1468;
const REVENUE_CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_OPERATION_POLLS = 20;
const OPERATION_POLL_DELAY_MS = 500;

const SALES_REVENUE_SOURCE_PATTERNS = Object.freeze([
    /developerproduct/,
    /gameproduct/,
    /gameshop/,
    /gamepass/,
    /privateserver/,
    /vipserver/,
    /paidaccess/,
    /subscription/,
    /commission/,
    /affiliate/,
    /avataritem/,
    /experienceitem/,
    /experiencepurchase/,
    /marketplace/,
    /immersivead/,
    /advertisingrevenue/,
    /adrevenue/
]);

const revenueCache = new Map();
const pendingRevenueRequests = new Map();

class RobloxAnalyticsError extends Error {
    constructor(message, code, statusCode) {
        super(message);
        this.name = 'RobloxAnalyticsError';
        this.code = code || 'ROBLOX_ANALYTICS_ERROR';
        this.statusCode = statusCode || 502;
    }
}

function getRobloxOpenCloudApiKey() {
    const apiKey = String(process.env.ROBLOX_OPEN_CLOUD_API_KEY || '').trim();
    if (!apiKey) {
        throw new RobloxAnalyticsError(
            'ROBLOX_OPEN_CLOUD_API_KEY is not configured',
            'ROBLOX_API_KEY_MISSING',
            503
        );
    }
    return apiKey;
}

async function parseJsonSafely(response) {
    try {
        return await response.json();
    } catch (error) {
        return null;
    }
}

function extractErrorMessage(payload, fallback) {
    if (!payload || typeof payload !== 'object') {
        return fallback;
    }

    const direct = [
        payload.message,
        payload.errorMessage,
        typeof payload.error === 'string' ? payload.error : null,
        payload.detail
    ].find((value) => typeof value === 'string' && value.trim());
    if (direct) {
        return direct.trim();
    }

    if (payload.error && typeof payload.error === 'object') {
        const nested = [payload.error.message, payload.error.errorMessage, payload.error.detail]
            .find((value) => typeof value === 'string' && value.trim());
        if (nested) {
            return nested.trim();
        }
    }

    return fallback;
}

function mapHttpError(response, payload) {
    if (response.status === 401 || response.status === 403) {
        return new RobloxAnalyticsError(
            'The Roblox API key is invalid or needs universe.analytics:read access to this universe',
            'ROBLOX_ANALYTICS_PERMISSION_REQUIRED',
            502
        );
    }
    if (response.status === 404) {
        return new RobloxAnalyticsError(
            'Roblox could not find this universe or analytics operation',
            'ROBLOX_UNIVERSE_NOT_FOUND',
            502
        );
    }
    if (response.status === 429) {
        return new RobloxAnalyticsError(
            'Roblox analytics is temporarily rate limited; try refreshing shortly',
            'ROBLOX_ANALYTICS_RATE_LIMITED',
            503
        );
    }

    return new RobloxAnalyticsError(
        extractErrorMessage(payload, `Roblox analytics request failed (${response.status})`),
        'ROBLOX_ANALYTICS_REQUEST_FAILED',
        502
    );
}

async function analyticsRequest({ method, url, apiKey, body }) {
    let response;
    try {
        response = await fetch(url, {
            method,
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                'x-api-key': apiKey
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
    } catch (error) {
        const timedOut = error && (error.name === 'TimeoutError' || error.name === 'AbortError');
        throw new RobloxAnalyticsError(
            timedOut
                ? 'Roblox analytics timed out; try refreshing shortly'
                : 'Roblox analytics could not be reached',
            timedOut ? 'ROBLOX_ANALYTICS_TIMEOUT' : 'ROBLOX_ANALYTICS_UNREACHABLE',
            503
        );
    }

    const payload = await parseJsonSafely(response);
    if (!response.ok) {
        throw mapHttpError(response, payload);
    }

    if (payload && payload.error) {
        throw new RobloxAnalyticsError(
            extractErrorMessage(payload, 'Roblox analytics could not complete the revenue query'),
            'ROBLOX_ANALYTICS_QUERY_FAILED',
            502
        );
    }

    return payload || {};
}

function buildOperationUrl(path) {
    const rawPath = String(path || '').trim();
    if (!rawPath) {
        throw new RobloxAnalyticsError(
            'Roblox returned an invalid analytics operation',
            'ROBLOX_ANALYTICS_INVALID_OPERATION',
            502
        );
    }

    if (/^https:\/\//i.test(rawPath)) {
        const parsed = new URL(rawPath);
        if (parsed.origin !== 'https://apis.roblox.com') {
            throw new RobloxAnalyticsError(
                'Roblox returned an invalid analytics operation',
                'ROBLOX_ANALYTICS_INVALID_OPERATION',
                502
            );
        }
        return parsed.toString();
    }

    return `${ROBLOX_ANALYTICS_BASE_URL}/${rawPath.replace(/^\/+/, '')}`;
}

function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function resolveAnalyticsOperation(initialPayload, apiKey) {
    let payload = initialPayload || {};
    for (let attempt = 0; attempt <= MAX_OPERATION_POLLS; attempt += 1) {
        if (payload.error) {
            throw new RobloxAnalyticsError(
                extractErrorMessage(payload, 'Roblox analytics could not complete the revenue query'),
                'ROBLOX_ANALYTICS_QUERY_FAILED',
                502
            );
        }
        if (payload.done !== false) {
            return payload;
        }
        if (attempt === MAX_OPERATION_POLLS) {
            break;
        }

        await sleep(OPERATION_POLL_DELAY_MS);
        payload = await analyticsRequest({
            method: 'GET',
            url: buildOperationUrl(payload.path),
            apiKey
        });
    }

    throw new RobloxAnalyticsError(
        'Roblox analytics is still preparing this revenue query; refresh again shortly',
        'ROBLOX_ANALYTICS_OPERATION_PENDING',
        503
    );
}

async function fetchUniverseMetadata(universeId) {
    const endpoint = new URL(ROBLOX_GAMES_URL);
    endpoint.searchParams.set('universeIds', String(universeId));

    let response;
    try {
        response = await fetch(endpoint, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
    } catch (error) {
        throw new RobloxAnalyticsError(
            'Roblox could not be reached to validate this universe',
            'ROBLOX_UNIVERSE_LOOKUP_FAILED',
            503
        );
    }

    const payload = await parseJsonSafely(response);
    if (!response.ok) {
        throw new RobloxAnalyticsError(
            `Roblox universe lookup failed (${response.status})`,
            'ROBLOX_UNIVERSE_LOOKUP_FAILED',
            502
        );
    }

    const game = payload && Array.isArray(payload.data) ? payload.data[0] : null;
    if (!game) {
        throw new RobloxAnalyticsError(
            'Roblox could not find a game with this universe ID',
            'ROBLOX_UNIVERSE_NOT_FOUND',
            502
        );
    }

    const createdAt = game.created ? new Date(game.created) : null;
    return {
        name: typeof game.name === 'string' ? game.name : null,
        createdAt: createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt : null
    };
}

function normalizeRevenueSource(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function isSalesRevenueSource(sourceName) {
    const normalized = normalizeRevenueSource(sourceName);
    return normalized.length > 0
        && SALES_REVENUE_SOURCE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function extractSalesRevenueRobux(payload) {
    const response = payload && payload.response && typeof payload.response === 'object'
        ? payload.response
        : payload;
    const series = response && Array.isArray(response.values) ? response.values : [];
    let total = 0;

    for (const item of series) {
        const breakdowns = item && Array.isArray(item.breakdowns) ? item.breakdowns : [];
        const sourceBreakdown = breakdowns.find(
            (breakdown) => String(breakdown && breakdown.dimension || '').toLowerCase() === 'revenuesource'
        );
        const sourceNames = sourceBreakdown
            ? [sourceBreakdown.value, sourceBreakdown.displayValue]
            : [];
        const isSalesSource = sourceNames.some(isSalesRevenueSource);
        const dataPoints = item && Array.isArray(item.dataPoints) ? item.dataPoints : [];

        for (const dataPoint of dataPoints) {
            const value = Number(dataPoint && dataPoint.value);
            if (isSalesSource && Number.isFinite(value)) {
                total += value;
            }
        }
    }

    if (!Number.isFinite(total) || total < 0) {
        throw new RobloxAnalyticsError(
            'Roblox returned an invalid sales revenue total',
            'ROBLOX_ANALYTICS_INVALID_RESPONSE',
            502
        );
    }

    return Math.round(total);
}

function calculateHistoryWindow(gameCreatedAt) {
    const now = new Date();
    const cutoff = new Date(now.getTime() - (ANALYTICS_RETENTION_DAYS * 24 * 60 * 60 * 1000) + (10 * 60 * 1000));
    const hasKnownCreationDate = gameCreatedAt instanceof Date && !Number.isNaN(gameCreatedAt.getTime());
    const historyComplete = hasKnownCreationDate && gameCreatedAt >= cutoff;
    const start = historyComplete ? gameCreatedAt : cutoff;

    return {
        start,
        end: now,
        historyComplete
    };
}

async function fetchUniverseRevenue(universeId) {
    const apiKey = getRobloxOpenCloudApiKey();
    const metadata = await fetchUniverseMetadata(universeId);
    const history = calculateHistoryWindow(metadata.createdAt);
    const initialPayload = await analyticsRequest({
        method: 'POST',
        url: `${ROBLOX_ANALYTICS_BASE_URL}/v1/universes/${encodeURIComponent(String(universeId))}/metrics`,
        apiKey,
        body: {
            metric: 'DailyRevenue',
            granularity: 'None',
            breakdown: ['RevenueSource'],
            limit: 100,
            startTime: history.start.toISOString(),
            endTime: history.end.toISOString()
        }
    });
    const completedPayload = await resolveAnalyticsOperation(initialPayload, apiKey);
    const revenueRobux = extractSalesRevenueRobux(completedPayload);

    return {
        status: 'available',
        revenueRobux,
        estimatedRevenueCents: Math.round(revenueRobux * STANDARD_DEVEX_USD_PER_ROBUX * 100),
        standardDevExUsdPerRobux: STANDARD_DEVEX_USD_PER_ROBUX,
        historyStart: history.start.toISOString(),
        historyEnd: history.end.toISOString(),
        historyComplete: history.historyComplete,
        robloxGameCreatedAt: metadata.createdAt ? metadata.createdAt.toISOString() : null,
        fetchedAt: new Date().toISOString()
    };
}

async function getUniverseRevenue(universeId, options) {
    const cacheKey = String(universeId);
    const force = Boolean(options && options.force);
    const cached = revenueCache.get(cacheKey);
    if (!force && cached && cached.expiresAt > Date.now()) {
        return cached.value;
    }

    if (!force && pendingRevenueRequests.has(cacheKey)) {
        return pendingRevenueRequests.get(cacheKey);
    }

    const pending = fetchUniverseRevenue(cacheKey)
        .then((value) => {
            revenueCache.set(cacheKey, {
                value,
                expiresAt: Date.now() + REVENUE_CACHE_TTL_MS
            });
            return value;
        })
        .finally(() => {
            pendingRevenueRequests.delete(cacheKey);
        });

    pendingRevenueRequests.set(cacheKey, pending);
    return pending;
}

function invalidateUniverseRevenue(universeId) {
    revenueCache.delete(String(universeId));
}

module.exports = {
    ANALYTICS_RETENTION_DAYS,
    RobloxAnalyticsError,
    STANDARD_DEVEX_USD_PER_ROBUX,
    calculateHistoryWindow,
    extractSalesRevenueRobux,
    getUniverseRevenue,
    isSalesRevenueSource,
    invalidateUniverseRevenue
};
