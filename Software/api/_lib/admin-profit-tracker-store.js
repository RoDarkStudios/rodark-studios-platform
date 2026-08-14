const crypto = require('crypto');
const { getPostgresPool, postgresQuery } = require('./postgres');

const EXPENSE_CATEGORIES = Object.freeze([
    'animations',
    'models',
    'vfx',
    'map',
    'advertising',
    'other'
]);
const EXPENSE_CATEGORY_SET = new Set(EXPENSE_CATEGORIES);
const MAX_UNIVERSE_ID = 9223372036854775807n;
const MAX_EXPENSE_CENTS = 99999999999n;
const MAX_CREATOR_REWARDS_ROBUX = 999999999999n;
const DEFAULT_DEVEX_USD_PER_1000_ROBUX = 3.8;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let schemaPromise = null;

class ProfitTrackerStoreError extends Error {
    constructor(message, statusCode, code, details) {
        super(message);
        this.name = 'ProfitTrackerStoreError';
        this.statusCode = statusCode;
        this.code = code;
        if (details && typeof details === 'object') {
            Object.assign(this, details);
        }
    }
}

function cleanRequiredText(value, fieldName, maxLength) {
    const cleaned = String(value || '').trim();
    if (!cleaned) {
        throw new ProfitTrackerStoreError(`${fieldName} is required`, 400, 'INVALID_INPUT');
    }
    if (cleaned.length > maxLength) {
        throw new ProfitTrackerStoreError(
            `${fieldName} must be ${maxLength} characters or fewer`,
            400,
            'INVALID_INPUT'
        );
    }
    return cleaned;
}

function normalizeUuid(value, fieldName) {
    const cleaned = String(value || '').trim();
    if (!UUID_PATTERN.test(cleaned)) {
        throw new ProfitTrackerStoreError(`${fieldName} is invalid`, 400, 'INVALID_INPUT');
    }
    return cleaned.toLowerCase();
}

function normalizeUniverseId(value) {
    const cleaned = String(value || '').trim();
    if (!/^\d+$/.test(cleaned)) {
        throw new ProfitTrackerStoreError('Universe ID must be a positive integer', 400, 'INVALID_INPUT');
    }

    const parsed = BigInt(cleaned);
    if (parsed <= 0n || parsed > MAX_UNIVERSE_ID) {
        throw new ProfitTrackerStoreError('Universe ID must be a positive integer', 400, 'INVALID_INPUT');
    }

    return parsed.toString();
}

function normalizeExpectedVersion(value) {
    const cleaned = String(value === undefined || value === null ? '' : value).trim();
    if (!/^\d+$/.test(cleaned)) {
        throw new ProfitTrackerStoreError('A valid game version is required', 400, 'INVALID_INPUT');
    }

    const parsed = BigInt(cleaned);
    if (parsed <= 0n) {
        throw new ProfitTrackerStoreError('A valid game version is required', 400, 'INVALID_INPUT');
    }
    return parsed;
}

function normalizeCreatorRewardsRobux(value) {
    const cleaned = String(value === undefined || value === null ? '' : value).trim();
    if (!/^\d+$/.test(cleaned)) {
        throw new ProfitTrackerStoreError(
            'Creator Rewards total must be a non-negative whole number of Robux',
            400,
            'INVALID_INPUT'
        );
    }

    const parsed = BigInt(cleaned);
    if (parsed > MAX_CREATOR_REWARDS_ROBUX) {
        throw new ProfitTrackerStoreError(
            'Creator Rewards total must be 999,999,999,999 Robux or less',
            400,
            'INVALID_INPUT'
        );
    }
    return parsed;
}

function normalizeDevExUsdPer1000Robux(value) {
    const cleaned = String(value === undefined || value === null ? '' : value).trim();
    if (!/^\d{1,4}(?:\.\d{1,4})?$/.test(cleaned)) {
        throw new ProfitTrackerStoreError(
            'DevEx rate must be a positive USD amount with no more than four decimal places',
            400,
            'INVALID_INPUT'
        );
    }

    const parsed = Number(cleaned);
    if (!Number.isFinite(parsed) || parsed < 0.0001 || parsed > 1000) {
        throw new ProfitTrackerStoreError(
            'DevEx rate must be between $0.0001 and $1,000 per 1,000 Earned Robux',
            400,
            'INVALID_INPUT'
        );
    }
    return cleaned;
}

function normalizeCategory(value) {
    const category = String(value || '').trim().toLowerCase();
    if (!EXPENSE_CATEGORY_SET.has(category)) {
        throw new ProfitTrackerStoreError('Select a valid expense category', 400, 'INVALID_INPUT');
    }
    return category;
}

function parseUsdAmountToCents(value) {
    const cleaned = String(value === undefined || value === null ? '' : value).trim();
    const match = cleaned.match(/^(\d{1,9})(?:\.(\d{1,2}))?$/);
    if (!match) {
        throw new ProfitTrackerStoreError(
            'Amount must be a positive USD value with no more than two decimal places',
            400,
            'INVALID_INPUT'
        );
    }

    const dollars = BigInt(match[1]);
    const fractional = String(match[2] || '').padEnd(2, '0');
    const cents = (dollars * 100n) + BigInt(fractional || '0');
    if (cents <= 0n || cents > MAX_EXPENSE_CENTS) {
        throw new ProfitTrackerStoreError(
            'Amount must be between $0.01 and $999,999,999.99',
            400,
            'INVALID_INPUT'
        );
    }
    return cents;
}

function toIsoString(value) {
    if (value instanceof Date) {
        return value.toISOString();
    }
    return typeof value === 'string' && value ? value : null;
}

function normalizeUserAudit(user) {
    return {
        id: user && user.id ? String(user.id) : null,
        username: user && user.username ? String(user.username) : null
    };
}

async function ensureProfitTrackerSchema() {
    if (!schemaPromise) {
        schemaPromise = (async () => {
            await postgresQuery(`
                create table if not exists admin_profit_tracker_games (
                    id uuid primary key,
                    display_name text not null,
                    universe_id bigint not null unique,
                    creator_rewards_robux bigint not null default 0 check (creator_rewards_robux >= 0),
                    devex_usd_per_1000_robux numeric(12, 4) not null default 3.8000 check (devex_usd_per_1000_robux > 0),
                    version bigint not null default 1 check (version > 0),
                    created_by_user_id text,
                    created_by_username text,
                    updated_by_user_id text,
                    updated_by_username text,
                    created_at timestamptz not null default now(),
                    updated_at timestamptz not null default now()
                )
            `);

            await postgresQuery(`
                alter table admin_profit_tracker_games
                add column if not exists creator_rewards_robux bigint not null default 0
            `);

            await postgresQuery(`
                alter table admin_profit_tracker_games
                add column if not exists devex_usd_per_1000_robux numeric(12, 4) not null default 3.8000
            `);

            await postgresQuery(`
                create table if not exists admin_profit_tracker_expenses (
                    id uuid primary key,
                    game_id uuid not null references admin_profit_tracker_games(id) on delete cascade,
                    amount_cents bigint not null check (amount_cents > 0),
                    description text not null,
                    category text not null check (category in ('animations', 'models', 'vfx', 'map', 'advertising', 'other')),
                    created_by_user_id text,
                    created_by_username text,
                    updated_by_user_id text,
                    updated_by_username text,
                    created_at timestamptz not null default now(),
                    updated_at timestamptz not null default now()
                )
            `);

            await postgresQuery(`
                create index if not exists admin_profit_tracker_expenses_game_id_idx
                on admin_profit_tracker_expenses (game_id, created_at desc)
            `);
        })().catch((error) => {
            schemaPromise = null;
            throw error;
        });
    }

    return schemaPromise;
}

function mapExpenseFromJoinedRow(row) {
    if (!row || !row.expense_id) {
        return null;
    }

    return {
        id: String(row.expense_id),
        amountCents: Number(row.expense_amount_cents),
        description: String(row.expense_description || ''),
        category: String(row.expense_category || ''),
        createdAt: toIsoString(row.expense_created_at),
        updatedAt: toIsoString(row.expense_updated_at),
        updatedByUsername: row.expense_updated_by_username
            ? String(row.expense_updated_by_username)
            : null
    };
}

async function listProfitTrackerGames() {
    await ensureProfitTrackerSchema();
    const result = await postgresQuery(`
        select
            games.id as game_id,
            games.display_name as game_display_name,
            games.universe_id as game_universe_id,
            games.creator_rewards_robux as game_creator_rewards_robux,
            games.devex_usd_per_1000_robux as game_devex_usd_per_1000_robux,
            games.version as game_version,
            games.created_at as game_created_at,
            games.updated_at as game_updated_at,
            games.updated_by_username as game_updated_by_username,
            expenses.id as expense_id,
            expenses.amount_cents as expense_amount_cents,
            expenses.description as expense_description,
            expenses.category as expense_category,
            expenses.created_at as expense_created_at,
            expenses.updated_at as expense_updated_at,
            expenses.updated_by_username as expense_updated_by_username
        from admin_profit_tracker_games as games
        left join admin_profit_tracker_expenses as expenses
            on expenses.game_id = games.id
        order by games.created_at desc, expenses.created_at desc
    `);

    const gamesById = new Map();
    for (const row of result.rows) {
        const gameId = String(row.game_id);
        let game = gamesById.get(gameId);
        if (!game) {
            game = {
                id: gameId,
                displayName: String(row.game_display_name || ''),
                universeId: String(row.game_universe_id),
                creatorRewardsRobux: Number(row.game_creator_rewards_robux || 0),
                devExUsdPer1000Robux: Number(
                    row.game_devex_usd_per_1000_robux || DEFAULT_DEVEX_USD_PER_1000_ROBUX
                ),
                version: Number(row.game_version),
                createdAt: toIsoString(row.game_created_at),
                updatedAt: toIsoString(row.game_updated_at),
                updatedByUsername: row.game_updated_by_username
                    ? String(row.game_updated_by_username)
                    : null,
                totalExpenseCents: 0,
                expenses: []
            };
            gamesById.set(gameId, game);
        }

        const expense = mapExpenseFromJoinedRow(row);
        if (expense) {
            game.expenses.push(expense);
            game.totalExpenseCents += expense.amountCents;
        }
    }

    return Array.from(gamesById.values());
}

function translateUniqueUniverseError(error) {
    if (error && error.code === '23505') {
        return new ProfitTrackerStoreError(
            'A game with that universe ID already exists',
            409,
            'DUPLICATE_UNIVERSE'
        );
    }
    return error;
}

async function createProfitTrackerGame({ displayName, universeId, devExUsdPer1000Robux, user }) {
    await ensureProfitTrackerSchema();
    const normalizedDisplayName = cleanRequiredText(displayName, 'Display name', 120);
    const normalizedUniverseId = normalizeUniverseId(universeId);
    const normalizedDevExRate = normalizeDevExUsdPer1000Robux(
        devExUsdPer1000Robux === undefined
            ? DEFAULT_DEVEX_USD_PER_1000_ROBUX
            : devExUsdPer1000Robux
    );
    const audit = normalizeUserAudit(user);

    try {
        const result = await postgresQuery(`
            insert into admin_profit_tracker_games (
                id,
                display_name,
                universe_id,
                devex_usd_per_1000_robux,
                created_by_user_id,
                created_by_username,
                updated_by_user_id,
                updated_by_username
            )
            values ($1, $2, $3, $4, $5, $6, $5, $6)
            returning id, version
        `, [
            crypto.randomUUID(),
            normalizedDisplayName,
            normalizedUniverseId,
            normalizedDevExRate,
            audit.id,
            audit.username
        ]);

        return {
            id: String(result.rows[0].id),
            version: Number(result.rows[0].version)
        };
    } catch (error) {
        throw translateUniqueUniverseError(error);
    }
}

async function mutateLockedGame({ gameId, expectedVersion, user, deleteGame, mutate }) {
    await ensureProfitTrackerSchema();
    const normalizedGameId = normalizeUuid(gameId, 'Game ID');
    const normalizedExpectedVersion = normalizeExpectedVersion(expectedVersion);
    const audit = normalizeUserAudit(user);
    const pool = getPostgresPool();
    const client = await pool.connect();

    try {
        await client.query('begin');
        const locked = await client.query(`
            select id, universe_id, version
            from admin_profit_tracker_games
            where id = $1
            for update
        `, [normalizedGameId]);

        const gameRow = locked.rows[0];
        if (!gameRow) {
            throw new ProfitTrackerStoreError('Game not found', 404, 'GAME_NOT_FOUND');
        }

        const currentVersion = BigInt(String(gameRow.version));
        if (currentVersion !== normalizedExpectedVersion) {
            throw new ProfitTrackerStoreError(
                'This game was changed by another admin',
                409,
                'VERSION_CONFLICT',
                {
                    gameId: normalizedGameId,
                    currentVersion: Number(currentVersion)
                }
            );
        }

        const value = await mutate(client, {
            id: normalizedGameId,
            universeId: String(gameRow.universe_id),
            version: currentVersion
        });

        let nextVersion = null;
        if (!deleteGame) {
            const versionResult = await client.query(`
                update admin_profit_tracker_games
                set
                    version = version + 1,
                    updated_by_user_id = $2,
                    updated_by_username = $3,
                    updated_at = now()
                where id = $1
                returning version
            `, [normalizedGameId, audit.id, audit.username]);
            nextVersion = Number(versionResult.rows[0].version);
        }

        await client.query('commit');
        return {
            gameId: normalizedGameId,
            previousUniverseId: String(gameRow.universe_id),
            version: nextVersion,
            value
        };
    } catch (error) {
        await client.query('rollback').catch(() => {});
        throw translateUniqueUniverseError(error);
    } finally {
        client.release();
    }
}

async function updateProfitTrackerGame({
    gameId,
    expectedVersion,
    displayName,
    universeId,
    creatorRewardsRobux,
    devExUsdPer1000Robux,
    user
}) {
    const normalizedDisplayName = cleanRequiredText(displayName, 'Display name', 120);
    const normalizedUniverseId = normalizeUniverseId(universeId);
    const normalizedCreatorRewardsRobux = normalizeCreatorRewardsRobux(creatorRewardsRobux);
    const normalizedDevExRate = normalizeDevExUsdPer1000Robux(devExUsdPer1000Robux);

    return mutateLockedGame({
        gameId,
        expectedVersion,
        user,
        mutate: async (client, game) => {
            await client.query(`
                update admin_profit_tracker_games
                set
                    display_name = $2,
                    universe_id = $3,
                    creator_rewards_robux = $4,
                    devex_usd_per_1000_robux = $5
                where id = $1
            `, [
                game.id,
                normalizedDisplayName,
                normalizedUniverseId,
                normalizedCreatorRewardsRobux.toString(),
                normalizedDevExRate
            ]);
            return {
                universeId: normalizedUniverseId,
                creatorRewardsRobux: Number(normalizedCreatorRewardsRobux),
                devExUsdPer1000Robux: Number(normalizedDevExRate)
            };
        }
    });
}

async function deleteProfitTrackerGame({ gameId, expectedVersion, user }) {
    return mutateLockedGame({
        gameId,
        expectedVersion,
        user,
        deleteGame: true,
        mutate: async (client, game) => {
            await client.query('delete from admin_profit_tracker_games where id = $1', [game.id]);
            return { deleted: true };
        }
    });
}

async function createProfitTrackerExpense({
    gameId,
    expectedVersion,
    amountUsd,
    description,
    category,
    user
}) {
    const amountCents = parseUsdAmountToCents(amountUsd);
    const normalizedDescription = cleanRequiredText(description, 'Description', 500);
    const normalizedCategory = normalizeCategory(category);
    const audit = normalizeUserAudit(user);

    return mutateLockedGame({
        gameId,
        expectedVersion,
        user,
        mutate: async (client, game) => {
            const expenseId = crypto.randomUUID();
            await client.query(`
                insert into admin_profit_tracker_expenses (
                    id,
                    game_id,
                    amount_cents,
                    description,
                    category,
                    created_by_user_id,
                    created_by_username,
                    updated_by_user_id,
                    updated_by_username
                )
                values ($1, $2, $3, $4, $5, $6, $7, $6, $7)
            `, [
                expenseId,
                game.id,
                amountCents.toString(),
                normalizedDescription,
                normalizedCategory,
                audit.id,
                audit.username
            ]);
            return { expenseId };
        }
    });
}

async function updateProfitTrackerExpense({
    gameId,
    expenseId,
    expectedVersion,
    amountUsd,
    description,
    category,
    user
}) {
    const normalizedExpenseId = normalizeUuid(expenseId, 'Expense ID');
    const amountCents = parseUsdAmountToCents(amountUsd);
    const normalizedDescription = cleanRequiredText(description, 'Description', 500);
    const normalizedCategory = normalizeCategory(category);
    const audit = normalizeUserAudit(user);

    return mutateLockedGame({
        gameId,
        expectedVersion,
        user,
        mutate: async (client, game) => {
            const result = await client.query(`
                update admin_profit_tracker_expenses
                set
                    amount_cents = $3,
                    description = $4,
                    category = $5,
                    updated_by_user_id = $6,
                    updated_by_username = $7,
                    updated_at = now()
                where id = $1 and game_id = $2
                returning id
            `, [
                normalizedExpenseId,
                game.id,
                amountCents.toString(),
                normalizedDescription,
                normalizedCategory,
                audit.id,
                audit.username
            ]);
            if (!result.rows[0]) {
                throw new ProfitTrackerStoreError('Expense not found', 404, 'EXPENSE_NOT_FOUND');
            }
            return { expenseId: normalizedExpenseId };
        }
    });
}

async function deleteProfitTrackerExpense({ gameId, expenseId, expectedVersion, user }) {
    const normalizedExpenseId = normalizeUuid(expenseId, 'Expense ID');

    return mutateLockedGame({
        gameId,
        expectedVersion,
        user,
        mutate: async (client, game) => {
            const result = await client.query(`
                delete from admin_profit_tracker_expenses
                where id = $1 and game_id = $2
                returning id
            `, [normalizedExpenseId, game.id]);
            if (!result.rows[0]) {
                throw new ProfitTrackerStoreError('Expense not found', 404, 'EXPENSE_NOT_FOUND');
            }
            return { expenseId: normalizedExpenseId, deleted: true };
        }
    });
}

module.exports = {
    DEFAULT_DEVEX_USD_PER_1000_ROBUX,
    EXPENSE_CATEGORIES,
    ProfitTrackerStoreError,
    createProfitTrackerExpense,
    createProfitTrackerGame,
    deleteProfitTrackerExpense,
    deleteProfitTrackerGame,
    ensureProfitTrackerSchema,
    listProfitTrackerGames,
    normalizeCreatorRewardsRobux,
    normalizeDevExUsdPer1000Robux,
    normalizeUniverseId,
    parseUsdAmountToCents,
    updateProfitTrackerExpense,
    updateProfitTrackerGame
};
