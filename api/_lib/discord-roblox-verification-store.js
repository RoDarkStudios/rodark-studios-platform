const { postgresQuery } = require('./postgres');

let schemaReadyPromise = null;

async function ensureDiscordRobloxVerificationSchema() {
    if (!schemaReadyPromise) {
        schemaReadyPromise = postgresQuery(`
            create table if not exists discord_roblox_verifications (
                roblox_user_id text primary key,
                discord_user_id text not null unique,
                roblox_username text not null default '',
                roblox_display_name text not null default '',
                discord_username text not null default '',
                discord_global_name text not null default '',
                verified_at timestamptz not null default now(),
                updated_at timestamptz not null default now()
            );

            create index if not exists discord_roblox_verifications_discord_user_id_idx
            on discord_roblox_verifications (discord_user_id);
        `);
    }

    await schemaReadyPromise;
}

function serializeVerification(row) {
    if (!row) {
        return null;
    }

    return {
        robloxUserId: String(row.roblox_user_id),
        discordUserId: String(row.discord_user_id),
        robloxUsername: String(row.roblox_username || ''),
        robloxDisplayName: String(row.roblox_display_name || ''),
        discordUsername: String(row.discord_username || ''),
        discordGlobalName: String(row.discord_global_name || ''),
        verifiedAt: row.verified_at ? new Date(row.verified_at).toISOString() : null,
        updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
    };
}

async function upsertDiscordRobloxVerification({ robloxUser, discordUser }) {
    await ensureDiscordRobloxVerificationSchema();

    const result = await postgresQuery(`
        with cleared as (
            delete from discord_roblox_verifications
            where roblox_user_id = $1 or discord_user_id = $2
        )
        insert into discord_roblox_verifications (
            roblox_user_id,
            discord_user_id,
            roblox_username,
            roblox_display_name,
            discord_username,
            discord_global_name,
            verified_at,
            updated_at
        )
        values ($1, $2, $3, $4, $5, $6, now(), now())
        returning *
    `, [
        String(robloxUser.id),
        String(discordUser.id),
        String(robloxUser.username || ''),
        String(robloxUser.display_name || robloxUser.displayName || robloxUser.username || ''),
        String(discordUser.username || ''),
        String(discordUser.globalName || discordUser.username || '')
    ]);

    return serializeVerification(result.rows[0]);
}

async function getVerificationByRobloxUserId(robloxUserId) {
    await ensureDiscordRobloxVerificationSchema();
    const result = await postgresQuery(`
        select *
        from discord_roblox_verifications
        where roblox_user_id = $1
        limit 1
    `, [String(robloxUserId)]);

    return serializeVerification(result.rows[0]);
}

async function getVerificationByDiscordUserId(discordUserId) {
    await ensureDiscordRobloxVerificationSchema();
    const result = await postgresQuery(`
        select *
        from discord_roblox_verifications
        where discord_user_id = $1
        limit 1
    `, [String(discordUserId)]);

    return serializeVerification(result.rows[0]);
}

async function getDiscordIdsByRobloxUserIds(robloxUserIds) {
    const ids = Array.from(new Set((robloxUserIds || [])
        .map((value) => String(value || '').trim())
        .filter(Boolean)));
    const mapped = new Map();
    if (ids.length === 0) {
        return mapped;
    }

    await ensureDiscordRobloxVerificationSchema();
    const result = await postgresQuery(`
        select roblox_user_id, discord_user_id
        from discord_roblox_verifications
        where roblox_user_id = any($1::text[])
    `, [ids]);

    for (const row of result.rows) {
        const robloxUserId = String(row.roblox_user_id);
        const discordUserId = String(row.discord_user_id);
        if (!mapped.has(robloxUserId)) {
            mapped.set(robloxUserId, []);
        }
        mapped.get(robloxUserId).push(discordUserId);
    }

    return mapped;
}

async function deleteDiscordRobloxVerification({ robloxUserId, discordUserId }) {
    const conditions = [];
    const params = [];

    if (robloxUserId) {
        params.push(String(robloxUserId));
        conditions.push(`roblox_user_id = $${params.length}`);
    }
    if (discordUserId) {
        params.push(String(discordUserId));
        conditions.push(`discord_user_id = $${params.length}`);
    }

    if (!conditions.length) {
        return 0;
    }

    await ensureDiscordRobloxVerificationSchema();
    const result = await postgresQuery(`
        delete from discord_roblox_verifications
        where ${conditions.join(' or ')}
    `, params);

    return Number(result.rowCount) || 0;
}

module.exports = {
    deleteDiscordRobloxVerification,
    ensureDiscordRobloxVerificationSchema,
    getDiscordIdsByRobloxUserIds,
    getVerificationByDiscordUserId,
    getVerificationByRobloxUserId,
    upsertDiscordRobloxVerification
};
