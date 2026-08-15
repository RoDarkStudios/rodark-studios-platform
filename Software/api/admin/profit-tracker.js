const { methodNotAllowed, readJsonBody, sendJson } = require('../_lib/http');
const { requireAdmin } = require('../_lib/admin-auth');
const {
    DEFAULT_DEVEX_USD_PER_1000_ROBUX,
    EXPENSE_CATEGORIES,
    createProfitTrackerExpense,
    createProfitTrackerGame,
    deleteProfitTrackerExpense,
    deleteProfitTrackerGame,
    listProfitTrackerGames,
    normalizeUniverseId,
    updateProfitTrackerExpense,
    updateProfitTrackerGame
} = require('../_lib/admin-profit-tracker-store');
const { fetchRobloxUniverse } = require('../_lib/roblox-games');
const {
    ANALYTICS_RETENTION_DAYS,
    getRobloxOpenCloudApiKey,
    getUniverseRevenue,
    invalidateUniverseRevenue
} = require('../_lib/roblox-analytics');

const ALLOWED_METHODS = ['GET', 'POST', 'PATCH', 'DELETE'];
const REVENUE_FETCH_CONCURRENCY = 3;

async function mapWithConcurrency(items, concurrency, mapper) {
    const results = new Array(items.length);
    let nextIndex = 0;

    async function worker() {
        while (nextIndex < items.length) {
            const currentIndex = nextIndex;
            nextIndex += 1;
            results[currentIndex] = await mapper(items[currentIndex], currentIndex);
        }
    }

    const workerCount = Math.min(Math.max(1, concurrency), items.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
}

function serializeRevenueError(error) {
    return {
        status: 'error',
        code: error && error.code ? String(error.code) : 'ROBLOX_ANALYTICS_ERROR',
        message: error && error.message
            ? String(error.message)
            : 'Revenue is temporarily unavailable',
        robloxGameCreatedAt: error && error.robloxGameCreatedAt
            ? String(error.robloxGameCreatedAt)
            : null
    };
}

function calculateDevExCents(robux, usdPer1000Robux) {
    return Math.round((robux * usdPer1000Robux * 100) / 1000);
}

function parseDateTimestamp(value) {
    const timestamp = Date.parse(String(value || ''));
    return Number.isFinite(timestamp) ? timestamp : null;
}

function compareGamesByUniverseCreatedAt(left, right) {
    const leftUniverseCreatedAt = parseDateTimestamp(
        left && left.revenue && left.revenue.robloxGameCreatedAt
    );
    const rightUniverseCreatedAt = parseDateTimestamp(
        right && right.revenue && right.revenue.robloxGameCreatedAt
    );

    if (leftUniverseCreatedAt !== rightUniverseCreatedAt) {
        if (leftUniverseCreatedAt === null) {
            return 1;
        }
        if (rightUniverseCreatedAt === null) {
            return -1;
        }
        return rightUniverseCreatedAt - leftUniverseCreatedAt;
    }

    const leftTrackedAt = parseDateTimestamp(left && left.createdAt) || 0;
    const rightTrackedAt = parseDateTimestamp(right && right.createdAt) || 0;
    if (leftTrackedAt !== rightTrackedAt) {
        return rightTrackedAt - leftTrackedAt;
    }

    return String(left && left.displayName || '').localeCompare(
        String(right && right.displayName || ''),
        'en',
        { sensitivity: 'base' }
    );
}

async function addRevenueToGames(games, force) {
    return mapWithConcurrency(games, REVENUE_FETCH_CONCURRENCY, async (game) => {
        let revenue;
        try {
            revenue = await getUniverseRevenue(game.universeId, { force });
        } catch (error) {
            revenue = serializeRevenueError(error);
        }

        const creatorRewardsRobux = Number(game.creatorRewardsRobux || 0);
        const configuredDevExRate = Number(game.devExUsdPer1000Robux);
        const devExUsdPer1000Robux = Number.isFinite(configuredDevExRate) && configuredDevExRate > 0
            ? configuredDevExRate
            : DEFAULT_DEVEX_USD_PER_1000_ROBUX;
        let estimatedRevenueCents = null;
        if (revenue.status === 'available') {
            const robloxSalesRevenueRobux = Number(revenue.revenueRobux || 0);
            const combinedRevenueRobux = robloxSalesRevenueRobux + creatorRewardsRobux;
            estimatedRevenueCents = calculateDevExCents(combinedRevenueRobux, devExUsdPer1000Robux);
            revenue = {
                ...revenue,
                robloxSalesRevenueRobux,
                creatorRewardsRobux,
                revenueRobux: combinedRevenueRobux,
                estimatedRevenueCents,
                devExUsdPer1000Robux
            };
        }
        return {
            ...game,
            revenue,
            estimatedProfitCents: estimatedRevenueCents === null
                ? null
                : estimatedRevenueCents - game.totalExpenseCents
        };
    });
}

function getAction(body) {
    return String(body && body.action || '').trim();
}

async function resolveRobloxGame(universeId) {
    const normalizedUniverseId = normalizeUniverseId(universeId);
    let game;

    try {
        game = await fetchRobloxUniverse(
            normalizedUniverseId,
            getRobloxOpenCloudApiKey()
        );
    } catch (error) {
        const lookupError = new Error(error && error.message
            ? String(error.message)
            : 'Roblox Open Cloud universe lookup failed');
        lookupError.statusCode = error && error.code === 'ROBLOX_API_KEY_MISSING' ? 503 : 502;
        if (error && error.code === 'ROBLOX_API_KEY_MISSING') {
            lookupError.code = 'ROBLOX_API_KEY_MISSING';
            lookupError.publicMessage = 'The Roblox Open Cloud API key is not configured.';
        } else if (error && (error.robloxStatus === 401 || error.robloxStatus === 403)) {
            lookupError.code = 'ROBLOX_UNIVERSE_READ_PERMISSION_REQUIRED';
            lookupError.publicMessage = 'The Roblox Open Cloud API key needs universe:read access to this game.';
        } else {
            lookupError.code = 'ROBLOX_UNIVERSE_LOOKUP_FAILED';
            lookupError.publicMessage = 'The game name could not be loaded from Roblox Open Cloud. Try again.';
        }
        throw lookupError;
    }

    if (!game || !game.name) {
        const nameError = new Error('Roblox Open Cloud did not return a name for that universe ID');
        nameError.statusCode = 502;
        nameError.code = 'ROBLOX_UNIVERSE_NAME_UNAVAILABLE';
        nameError.publicMessage = 'Roblox Open Cloud did not return a name for that universe ID.';
        throw nameError;
    }

    return {
        displayName: game.name,
        universeId: normalizedUniverseId
    };
}

async function addRobloxNamesToGames(games) {
    return mapWithConcurrency(games, REVENUE_FETCH_CONCURRENCY, async (game) => {
        const robloxGame = await resolveRobloxGame(game.universeId);
        return {
            ...game,
            displayName: robloxGame.displayName
        };
    });
}

async function handleGet(req, res) {
    const games = await listProfitTrackerGames();
    const forceRevenueRefresh = String(req.query && req.query.refresh || '') === '1';
    const gamesWithRobloxNames = await addRobloxNamesToGames(games);
    const gamesWithRevenue = await addRevenueToGames(gamesWithRobloxNames, forceRevenueRefresh);
    gamesWithRevenue.sort(compareGamesByUniverseCreatedAt);

    return sendJson(res, 200, {
        games: gamesWithRevenue,
        expenseCategories: EXPENSE_CATEGORIES,
        analyticsRetentionDays: ANALYTICS_RETENTION_DAYS
    });
}

async function handlePost(body, user, res) {
    const action = getAction(body);
    if (action === 'createGame') {
        const robloxGame = await resolveRobloxGame(body.universeId);
        const result = await createProfitTrackerGame({
            displayName: robloxGame.displayName,
            universeId: robloxGame.universeId,
            devExUsdPer1000Robux: body.devExUsdPer1000Robux,
            user
        });
        return sendJson(res, 201, { ok: true, ...result });
    }

    if (action === 'createExpense') {
        const result = await createProfitTrackerExpense({
            gameId: body.gameId,
            expectedVersion: body.expectedVersion,
            amountUsd: body.amountUsd,
            description: body.description,
            category: body.category,
            user
        });
        return sendJson(res, 201, { ok: true, ...result });
    }

    return sendJson(res, 400, { error: 'Invalid create action', code: 'INVALID_ACTION' });
}

async function handlePatch(body, user, res) {
    const action = getAction(body);
    if (action === 'updateGame') {
        const robloxGame = await resolveRobloxGame(body.universeId);
        const result = await updateProfitTrackerGame({
            gameId: body.gameId,
            expectedVersion: body.expectedVersion,
            displayName: robloxGame.displayName,
            universeId: robloxGame.universeId,
            creatorRewardsRobux: body.creatorRewardsRobux,
            devExUsdPer1000Robux: body.devExUsdPer1000Robux,
            user
        });
        invalidateUniverseRevenue(result.previousUniverseId);
        invalidateUniverseRevenue(result.value && result.value.universeId);
        return sendJson(res, 200, { ok: true, ...result });
    }

    if (action === 'updateExpense') {
        const result = await updateProfitTrackerExpense({
            gameId: body.gameId,
            expenseId: body.expenseId,
            expectedVersion: body.expectedVersion,
            amountUsd: body.amountUsd,
            description: body.description,
            category: body.category,
            user
        });
        return sendJson(res, 200, { ok: true, ...result });
    }

    return sendJson(res, 400, { error: 'Invalid update action', code: 'INVALID_ACTION' });
}

async function handleDelete(body, user, res) {
    const action = getAction(body);
    if (action === 'deleteGame') {
        const result = await deleteProfitTrackerGame({
            gameId: body.gameId,
            expectedVersion: body.expectedVersion,
            user
        });
        invalidateUniverseRevenue(result.previousUniverseId);
        return sendJson(res, 200, { ok: true, ...result });
    }

    if (action === 'deleteExpense') {
        const result = await deleteProfitTrackerExpense({
            gameId: body.gameId,
            expenseId: body.expenseId,
            expectedVersion: body.expectedVersion,
            user
        });
        return sendJson(res, 200, { ok: true, ...result });
    }

    return sendJson(res, 400, { error: 'Invalid delete action', code: 'INVALID_ACTION' });
}

module.exports = async (req, res) => {
    if (!ALLOWED_METHODS.includes(req.method)) {
        return methodNotAllowed(req, res, ALLOWED_METHODS);
    }

    try {
        const auth = await requireAdmin(req, res);
        if (!auth.user) {
            return sendJson(res, 401, { error: 'Not authenticated' });
        }
        if (!auth.isAdmin) {
            return sendJson(res, 403, { error: 'Admin access required' });
        }

        if (req.method === 'GET') {
            return handleGet(req, res);
        }

        const body = await readJsonBody(req);
        if (req.method === 'POST') {
            return handlePost(body, auth.user, res);
        }
        if (req.method === 'PATCH') {
            return handlePatch(body, auth.user, res);
        }
        return handleDelete(body, auth.user, res);
    } catch (error) {
        const statusCode = Number(error && error.statusCode);
        const safeStatusCode = Number.isFinite(statusCode) && statusCode >= 400 && statusCode < 600
            ? statusCode
            : error instanceof SyntaxError
                ? 400
                : 500;
        const isSafeClientError = safeStatusCode >= 400 && safeStatusCode < 500;
        const publicMessage = error && typeof error.publicMessage === 'string'
            ? error.publicMessage
            : null;

        return sendJson(res, safeStatusCode, {
            error: publicMessage || (isSafeClientError
                ? String(error.message || 'Invalid profit tracker request')
                : 'Failed to manage the game profit tracker'),
            code: error && error.code ? String(error.code) : undefined,
            currentVersion: error && error.currentVersion !== undefined
                ? error.currentVersion
                : undefined,
            details: isSafeClientError ? undefined : String(error && error.message || '')
        });
    }
};
