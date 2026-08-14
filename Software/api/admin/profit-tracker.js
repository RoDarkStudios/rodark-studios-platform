const { methodNotAllowed, readJsonBody, sendJson } = require('../_lib/http');
const { requireAdmin } = require('../_lib/admin-auth');
const {
    EXPENSE_CATEGORIES,
    createProfitTrackerExpense,
    createProfitTrackerGame,
    deleteProfitTrackerExpense,
    deleteProfitTrackerGame,
    listProfitTrackerGames,
    updateProfitTrackerExpense,
    updateProfitTrackerGame
} = require('../_lib/admin-profit-tracker-store');
const {
    ANALYTICS_RETENTION_DAYS,
    STANDARD_DEVEX_USD_PER_ROBUX,
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
            : 'Revenue is temporarily unavailable'
    };
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
        let estimatedRevenueCents = null;
        if (revenue.status === 'available') {
            const robloxSalesRevenueRobux = Number(revenue.revenueRobux || 0);
            const combinedRevenueRobux = robloxSalesRevenueRobux + creatorRewardsRobux;
            estimatedRevenueCents = Math.round(
                combinedRevenueRobux * STANDARD_DEVEX_USD_PER_ROBUX * 100
            );
            revenue = {
                ...revenue,
                robloxSalesRevenueRobux,
                creatorRewardsRobux,
                revenueRobux: combinedRevenueRobux,
                estimatedRevenueCents
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

async function handleGet(req, res) {
    const games = await listProfitTrackerGames();
    const forceRevenueRefresh = String(req.query && req.query.refresh || '') === '1';
    const gamesWithRevenue = await addRevenueToGames(games, forceRevenueRefresh);

    return sendJson(res, 200, {
        games: gamesWithRevenue,
        expenseCategories: EXPENSE_CATEGORIES,
        exchangeRate: {
            usdPerRobux: STANDARD_DEVEX_USD_PER_ROBUX,
            label: 'Current standard Roblox DevEx rate',
            isEstimate: true
        },
        analyticsRetentionDays: ANALYTICS_RETENTION_DAYS
    });
}

async function handlePost(body, user, res) {
    const action = getAction(body);
    if (action === 'createGame') {
        const result = await createProfitTrackerGame({
            displayName: body.displayName,
            universeId: body.universeId,
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
        const result = await updateProfitTrackerGame({
            gameId: body.gameId,
            expectedVersion: body.expectedVersion,
            displayName: body.displayName,
            universeId: body.universeId,
            creatorRewardsRobux: body.creatorRewardsRobux,
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

        return sendJson(res, safeStatusCode, {
            error: isSafeClientError
                ? String(error.message || 'Invalid profit tracker request')
                : 'Failed to manage the game profit tracker',
            code: error && error.code ? String(error.code) : undefined,
            currentVersion: error && error.currentVersion !== undefined
                ? error.currentVersion
                : undefined,
            details: isSafeClientError ? undefined : String(error && error.message || '')
        });
    }
};
