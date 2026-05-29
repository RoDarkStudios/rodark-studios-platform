const { postgresQuery } = require('./postgres');

function toPositiveInteger(value, fieldName) {
    const parsed = Number.parseInt(String(value || '').trim(), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`${fieldName} is invalid in stored game config`);
    }
    return parsed;
}

function mapRowToConfig(row) {
    if (!row || typeof row !== 'object') {
        return null;
    }

    return {
        productionUniverseId: toPositiveInteger(row.production_universe_id, 'production_universe_id'),
        testUniverseId: toPositiveInteger(row.test_universe_id, 'test_universe_id'),
        developmentUniverseId: toPositiveInteger(row.development_universe_id, 'development_universe_id'),
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

async function getStoredGameConfig() {
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
        1,
        Number(config && config.productionUniverseId),
        Number(config && config.testUniverseId),
        Number(config && config.developmentUniverseId),
        config && config.updatedByUserId ? String(config.updatedByUserId) : null,
        config && config.updatedByUsername ? String(config.updatedByUsername) : null
    ]);

    if (!result.rows.length) {
        throw new Error('Postgres upsert returned no game config row');
    }

    return mapRowToConfig(result.rows[0]);
}

module.exports = {
    getStoredGameConfig,
    saveStoredGameConfig
};
