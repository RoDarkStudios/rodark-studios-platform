const { postgresQuery } = require('./postgres');

const SETTINGS_ID = 1;
const DEFAULT_OPENAI_MODEL = 'gpt-5.4';

function normalizeOpenAiModel(value) {
    const trimmed = String(value || '').trim();
    if (!trimmed) {
        return DEFAULT_OPENAI_MODEL;
    }

    if (trimmed.length > 80) {
        throw new Error('OpenAI model must be 80 characters or fewer');
    }

    if (!/^[a-zA-Z0-9._:-]+$/.test(trimmed)) {
        throw new Error('OpenAI model contains unsupported characters');
    }

    return trimmed;
}

function toIsoString(value) {
    if (value instanceof Date) {
        return value.toISOString();
    }

    return typeof value === 'string' ? value : null;
}

function mapRowToSettings(row) {
    if (!row || typeof row !== 'object') {
        return null;
    }

    return {
        openaiModel: normalizeOpenAiModel(row.openai_model),
        updatedAt: toIsoString(row.updated_at),
        updatedByUserId: row.updated_by_user_id ? String(row.updated_by_user_id) : null,
        updatedByUsername: row.updated_by_username ? String(row.updated_by_username) : null
    };
}

async function ensureAdminPlatformSettingsSchema() {
    await postgresQuery(`
        create table if not exists admin_platform_settings (
            id smallint primary key check (id = 1),
            openai_model text not null default 'gpt-5.4',
            updated_by_user_id text,
            updated_by_username text,
            updated_at timestamptz not null default now()
        )
    `);

    await postgresQuery(`
        alter table admin_platform_settings
        add column if not exists openai_model text not null default 'gpt-5.4'
    `);

    await postgresQuery(`
        insert into admin_platform_settings (id, openai_model)
        values ($1, $2)
        on conflict (id) do nothing
    `, [
        SETTINGS_ID,
        normalizeOpenAiModel(process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL)
    ]);
}

async function getAdminPlatformSettings() {
    await ensureAdminPlatformSettingsSchema();

    const result = await postgresQuery(`
        select
            openai_model,
            updated_by_user_id,
            updated_by_username,
            updated_at
        from admin_platform_settings
        where id = $1
        limit 1
    `, [SETTINGS_ID]);

    return mapRowToSettings(result.rows[0]);
}

async function saveAdminPlatformSettings(settings, user) {
    await ensureAdminPlatformSettingsSchema();

    const result = await postgresQuery(`
        update admin_platform_settings
        set
            openai_model = $2,
            updated_by_user_id = $3,
            updated_by_username = $4,
            updated_at = now()
        where id = $1
        returning
            openai_model,
            updated_by_user_id,
            updated_by_username,
            updated_at
    `, [
        SETTINGS_ID,
        normalizeOpenAiModel(settings && settings.openaiModel),
        user && user.id ? String(user.id) : null,
        user && user.username ? String(user.username) : null
    ]);

    return mapRowToSettings(result.rows[0]);
}

module.exports = {
    DEFAULT_OPENAI_MODEL,
    ensureAdminPlatformSettingsSchema,
    getAdminPlatformSettings,
    saveAdminPlatformSettings
};
