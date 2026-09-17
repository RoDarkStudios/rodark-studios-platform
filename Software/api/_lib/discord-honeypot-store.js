const { postgresQuery } = require('./postgres');

let schemaReady;

async function ensureSchema() {
    if (!schemaReady) {
        schemaReady = (async () => {
            await postgresQuery(`
                create table if not exists discord_bot_honeypots (
                    guild_id text primary key,
                    channel_id text not null,
                    warning_message_id text
                )
            `);
            await postgresQuery(`
                create table if not exists discord_bot_honeypot_bans (
                    message_id text primary key,
                    guild_id text not null,
                    channel_id text not null,
                    user_id text not null,
                    banned_at timestamptz not null default now()
                )
            `);
            await postgresQuery(`
                create index if not exists discord_bot_honeypot_bans_guild_idx
                on discord_bot_honeypot_bans (guild_id)
            `);
            await postgresQuery(`
                alter table discord_bot_honeypot_bans
                    add column if not exists cleanup_from timestamptz,
                    add column if not exists cleanup_until timestamptz,
                    add column if not exists cleanup_due_at timestamptz,
                    add column if not exists cleanup_passes integer not null default 0,
                    add column if not exists cleanup_attempts integer not null default 0,
                    add column if not exists cleanup_error text
            `);
            await postgresQuery(`
                create index if not exists discord_bot_honeypot_cleanup_due_idx
                on discord_bot_honeypot_bans (cleanup_due_at) where cleanup_due_at is not null
            `);
        })().catch((error) => {
            schemaReady = null;
            throw error;
        });
    }
    await schemaReady;
}

async function getState(guildId) {
    await ensureSchema();
    const result = await postgresQuery(`
        select channel_id, warning_message_id,
            (select count(*) from discord_bot_honeypot_bans where guild_id = $1) as ban_count
        from discord_bot_honeypots where guild_id = $1
    `, [guildId]);
    const row = result.rows[0];
    return row ? {
        channelId: row.channel_id,
        warningMessageId: row.warning_message_id,
        banCount: Number(row.ban_count)
    } : null;
}

async function saveState(guildId, channelId, warningMessageId) {
    await ensureSchema();
    await postgresQuery(`
        insert into discord_bot_honeypots (guild_id, channel_id, warning_message_id)
        values ($1, $2, $3)
        on conflict (guild_id) do update set
            channel_id = excluded.channel_id,
            warning_message_id = excluded.warning_message_id
    `, [guildId, channelId, warningMessageId || null]);
}

async function recordBan(message) {
    await ensureSchema();
    await postgresQuery(`
        insert into discord_bot_honeypot_bans
            (message_id, guild_id, channel_id, user_id, banned_at, cleanup_from, cleanup_until, cleanup_due_at)
        values ($1, $2, $3, $4, $5, $6, $7, $7)
        on conflict (message_id) do nothing
    `, [message.id, message.guild.id, message.channelId, message.author.id,
        message.bannedAt || new Date(), message.cleanupFrom || null, message.cleanupUntil || null]);
}

async function getDueCleanups(guildIds, now = new Date()) {
    await ensureSchema();
    const result = await postgresQuery(`
        select * from discord_bot_honeypot_bans
        where guild_id = any($1::text[]) and cleanup_due_at <= $2
        order by cleanup_due_at limit 3
    `, [guildIds, now]);
    return result.rows;
}

async function updateCleanup(messageId, { dueAt, passes, attempts, error }) {
    await ensureSchema();
    await postgresQuery(`
        update discord_bot_honeypot_bans
        set cleanup_due_at = $2, cleanup_passes = $3, cleanup_attempts = $4, cleanup_error = $5
        where message_id = $1
    `, [messageId, dueAt, passes, attempts, error]);
}

module.exports = { getState, saveState, recordBan, getDueCleanups, updateCleanup };
