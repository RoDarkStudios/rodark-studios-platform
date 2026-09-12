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
        insert into discord_bot_honeypot_bans (message_id, guild_id, channel_id, user_id)
        values ($1, $2, $3, $4)
        on conflict (message_id) do nothing
    `, [message.id, message.guild.id, message.channelId, message.author.id]);
}

module.exports = { getState, saveState, recordBan };
