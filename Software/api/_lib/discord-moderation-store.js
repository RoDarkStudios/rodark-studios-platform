const fs = require('node:fs');
const path = require('node:path');
const { getPostgresPool, postgresQuery } = require('./postgres');
const SCHEMA = fs.readFileSync(path.join(__dirname, 'discord-moderation-schema.sql'), 'utf8');
let schemaReady;

async function ensureSchema() {
    if (!schemaReady) schemaReady = postgresQuery(SCHEMA).catch((error) => { schemaReady = null; throw error; });
    await schemaReady;
}

async function enqueue(message) {
    await ensureSchema();
    await postgresQuery(`
        insert into discord_bot_moderation_messages (message_id, guild_id, channel_id, user_id, payload, version)
        values ($1, $2, $3, $4, $5::jsonb, $6)
        on conflict (message_id) do update set payload = excluded.payload, version = excluded.version,
            attempts = 0, updated_at = now()
        where discord_bot_moderation_messages.version <> excluded.version
            and not discord_bot_moderation_messages.deleted
    `, [message.id, message.guild_id, message.channel_id, message.user_id, JSON.stringify(message), message.version]);
}

async function markDeleted(ids) {
    await ensureSchema();
    if (ids.length) await postgresQuery(`update discord_bot_moderation_messages set deleted = true where message_id = any($1::text[])`, [ids]);
}

async function pendingChannels(guildIds) {
    await ensureSchema();
    const result = await postgresQuery(`
        select guild_id, channel_id, count(*)::integer as pending_count, min(received_at) as oldest
        from discord_bot_moderation_messages
        where guild_id = any($1::text[]) and not deleted and reviewed_version is distinct from version and attempts < 3
        group by guild_id, channel_id order by min(received_at)
    `, [guildIds]);
    return result.rows;
}

async function loadPending(channelId) {
    const result = await postgresQuery(`
        select payload from discord_bot_moderation_messages where channel_id = $1
        and not deleted and reviewed_version is distinct from version and attempts < 3
        order by received_at, message_id limit 50
    `, [channelId]);
    return result.rows.map((row) => row.payload);
}

async function getContext(channelId) {
    const result = await postgresQuery(`
        select payload from discord_bot_moderation_messages where channel_id = $1
        and not deleted and reviewed_version = version order by received_at desc limit 30
    `, [channelId]);
    return result.rows.map((row) => row.payload).reverse();
}

async function recentCases(guildId, userIds) {
    const result = await postgresQuery(`
        select data from discord_bot_moderation_cases where guild_id = $1 and user_id = any($2::text[])
        and created_at > now() - interval '24 hours' and data->>'outcome' = 'timed_out'
        and data->>'dismissed_by' is null order by created_at desc limit 15
    `, [guildId, userIds]);
    return result.rows.map(({ data }) => ({ user_id: data.user_id, category: data.category, reason: data.reason, case_id: data.id }));
}

// Session locks span external requests and are released even on failure or worker disconnect.
async function withLock(key, task) {
    await ensureSchema();
    const connection = await getPostgresPool().connect();
    let locked = false;
    let releaseError;
    try {
        const result = await connection.query('select pg_try_advisory_lock(hashtextextended($1, 0)) as locked', [`moderation:${key}`]);
        locked = result.rows[0].locked;
        if (!locked) return false;
        await task();
        return true;
    } finally {
        if (locked) {
            try { await connection.query('select pg_advisory_unlock(hashtextextended($1, 0))', [`moderation:${key}`]); }
            catch (error) { releaseError = error; }
        }
        connection.release(releaseError);
    }
}

async function claimInterval(channelId) {
    const result = await postgresQuery(`
        insert into discord_bot_moderation_channels (channel_id, next_review_at) values ($1, now() + interval '60 seconds')
        on conflict (channel_id) do update set next_review_at = excluded.next_review_at
        where discord_bot_moderation_channels.next_review_at <= now() returning channel_id
    `, [channelId]);
    return result.rowCount > 0;
}

// Record every case and acknowledge exactly the reviewed versions in a single transaction.
async function commitReview(batch, cases) {
    const connection = await getPostgresPool().connect();
    try {
        await connection.query('begin');
        const current = await connection.query(`select message_id, version, deleted from discord_bot_moderation_messages
            where message_id = any($1::text[]) for update`, [batch.map((item) => item.id)]);
        const rows = new Map(current.rows.map((row) => [row.message_id, row]));
        for (const entry of cases) {
            if (entry.evidence.some((item) => rows.get(item.id)?.deleted || rows.get(item.id)?.version !== item.version)) continue;
            await connection.query(`insert into discord_bot_moderation_cases (case_id, guild_id, user_id, data)
                values ($1, $2, $3, $4::jsonb) on conflict (case_id) do nothing`,
            [entry.id, entry.guild_id, entry.user_id, JSON.stringify(entry)]);
        }
        await connection.query(`
            update discord_bot_moderation_messages m set reviewed_version = r.version
            from jsonb_to_recordset($1::jsonb) as r(id text, version text)
            where m.message_id = r.id and m.version = r.version
        `, [JSON.stringify(batch.map(({ id, version }) => ({ id, version })))]);
        await connection.query('commit');
    } catch (error) {
        await connection.query('rollback').catch(() => {});
        throw error;
    } finally { connection.release(); }
}

async function failBatch(batch) {
    await postgresQuery(`
        update discord_bot_moderation_messages m set attempts = attempts + 1
        from jsonb_to_recordset($1::jsonb) as r(id text, version text)
        where m.message_id = r.id and m.version = r.version
    `, [JSON.stringify(batch.map(({ id, version }) => ({ id, version })))]);
}

async function unfinishedCases(guildId) {
    const result = await postgresQuery(`select data from discord_bot_moderation_cases where guild_id = $1
        and (data->>'outcome' = 'pending' or data->>'log_message_id' is null)
        and data->>'dismissed_by' is null order by created_at limit 50`, [guildId]);
    return result.rows.map((row) => row.data);
}

async function getCase(id) {
    await ensureSchema();
    const result = await postgresQuery('select data from discord_bot_moderation_cases where case_id = $1', [id]);
    return result.rows[0]?.data || null;
}

async function updateCase(id, patch) {
    await postgresQuery('update discord_bot_moderation_cases set data = data || $2::jsonb where case_id = $1', [id, JSON.stringify(patch)]);
}

async function recordUsage(guildId, model, usage = {}, failed = false) {
    const integer = (value) => Math.max(0, Math.floor(Number(value) || 0));
    await postgresQuery(`
        insert into discord_bot_moderation_usage
            (guild_id, usage_date, model, requests, failures, input_tokens, cached_input_tokens, output_tokens, reasoning_tokens)
        values ($1, (now() at time zone 'UTC')::date, $2, 1, $3, $4, $5, $6, $7)
        on conflict (guild_id, usage_date, model) do update set
            requests = discord_bot_moderation_usage.requests + 1,
            failures = discord_bot_moderation_usage.failures + excluded.failures,
            input_tokens = discord_bot_moderation_usage.input_tokens + excluded.input_tokens,
            cached_input_tokens = discord_bot_moderation_usage.cached_input_tokens + excluded.cached_input_tokens,
            output_tokens = discord_bot_moderation_usage.output_tokens + excluded.output_tokens,
            reasoning_tokens = discord_bot_moderation_usage.reasoning_tokens + excluded.reasoning_tokens
    `, [guildId, model, failed ? 1 : 0, integer(usage.input_tokens), integer(usage.input_tokens_details?.cached_tokens),
        integer(usage.output_tokens), integer(usage.output_tokens_details?.reasoning_tokens)]);
}

async function cleanup() {
    await ensureSchema();
    await postgresQuery(`delete from discord_bot_moderation_messages where updated_at < now() - interval '24 hours'`);
    await postgresQuery(`delete from discord_bot_moderation_channels where next_review_at < now() - interval '24 hours'`);
    await postgresQuery(`delete from discord_bot_moderation_cases where created_at < now() - interval '30 days'`);
    await postgresQuery(`delete from discord_bot_moderation_usage where usage_date < current_date - 90`);
}

module.exports = {
    ensureSchema, enqueue, markDeleted, pendingChannels, loadPending, getContext, recentCases,
    withLock, claimInterval, commitReview, failBatch, unfinishedCases, getCase, updateCase, recordUsage, cleanup
};
