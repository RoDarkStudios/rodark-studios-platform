const { postgresQuery } = require('./postgres');

const GAME_CONFIG_ID = 1;

function toPositiveInteger(value, fieldName) {
    const parsed = Number.parseInt(String(value || '').trim(), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`${fieldName} is invalid in stored game config`);
    }
    return parsed;
}

function toOptionalPositiveInteger(value, fieldName) {
    if (value === null || value === undefined || String(value).trim() === '') {
        return null;
    }

    return toPositiveInteger(value, fieldName);
}

function mapRowToConfig(row) {
    if (!row || typeof row !== 'object') {
        return null;
    }

    return {
        productionUniverseId: toPositiveInteger(row.production_universe_id, 'production_universe_id'),
        testUniverseId: toOptionalPositiveInteger(row.test_universe_id, 'test_universe_id'),
        developmentUniverseId: toOptionalPositiveInteger(row.development_universe_id, 'development_universe_id'),
        updatedAt: row.updated_at instanceof Date
            ? row.updated_at.toISOString()
            : (typeof row.updated_at === 'string' ? row.updated_at : null),
        updatedByUserId: row.updated_by_user_id !== undefined && row.updated_by_user_id !== null
            ? String(row.updated_by_user_id)
            : null,
        updatedByUsername: row.updated_by_username !== undefined && row.updated_by_username !== null
            ? String(row.updated_by_username)
            : null
    };
}

async function ensureAdminGameConfigSchema() {
    await postgresQuery(`
        create table if not exists admin_game_config (
            id smallint primary key check (id = 1),
            production_universe_id bigint not null,
            test_universe_id bigint,
            development_universe_id bigint,
            updated_by_user_id text,
            updated_by_username text,
            updated_at timestamptz not null default now()
        )
    `);

    await postgresQuery(`
        alter table admin_game_config
            alter column test_universe_id drop not null,
            alter column development_universe_id drop not null
    `);
}

async function getStoredGameConfig() {
    await ensureAdminGameConfigSchema();

    const result = await postgresQuery(`
        select
            id,
            production_universe_id,
            test_universe_id,
            development_universe_id,
            updated_at,
            updated_by_user_id,
            updated_by_username
        from admin_game_config
        where id = 1
        limit 1
    `);

    if (!result.rows.length) {
        return null;
    }

    return mapRowToConfig(result.rows[0]);
}

async function saveStoredGameConfig(config) {
    await ensureAdminGameConfigSchema();

    const result = await postgresQuery(`
        insert into admin_game_config (
            id,
            production_universe_id,
            test_universe_id,
            development_universe_id,
            updated_by_user_id,
            updated_by_username,
            updated_at
        )
        values ($1, $2, $3, $4, $5, $6, now())
        on conflict (id) do update set
            production_universe_id = excluded.production_universe_id,
            test_universe_id = excluded.test_universe_id,
            development_universe_id = excluded.development_universe_id,
            updated_by_user_id = excluded.updated_by_user_id,
            updated_by_username = excluded.updated_by_username,
            updated_at = excluded.updated_at
        returning
            id,
            production_universe_id,
            test_universe_id,
            development_universe_id,
            updated_at,
            updated_by_user_id,
            updated_by_username
    `, [
        GAME_CONFIG_ID,
        Number(config && config.productionUniverseId),
        config && config.testUniverseId ? Number(config.testUniverseId) : null,
        config && config.developmentUniverseId ? Number(config.developmentUniverseId) : null,
        config && config.updatedByUserId ? String(config.updatedByUserId) : null,
        config && config.updatedByUsername ? String(config.updatedByUsername) : null
    ]);

    if (!result.rows.length) {
        throw new Error('Postgres upsert returned no game config row');
    }

    return mapRowToConfig(result.rows[0]);
}

module.exports = {
    ensureAdminGameConfigSchema,
    getStoredGameConfig,
    saveStoredGameConfig
};
