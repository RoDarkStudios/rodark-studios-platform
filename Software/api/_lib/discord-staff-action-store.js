const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const postgres = require('./postgres');

const LIMIT = 5;
const schema = readFileSync(join(__dirname, 'discord-staff-action-schema.sql'), 'utf8');
let schemaReady;

function ensureSchema() {
    if (!schemaReady) schemaReady = postgres.postgresQuery(schema).catch((error) => { schemaReady = null; throw error; });
    return schemaReady;
}

async function reserve({ id, guildId, actorId, targetId, action, reason, administrator }) {
    await ensureSchema();
    const connection = await postgres.getPostgresPool().connect();
    let releaseError;
    try {
        await connection.query('begin isolation level read committed');
        // Take the same lock for both commands and on every worker before reading the quota.
        await connection.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`staff-action:${guildId}:${actorId}`]);
        const existing = await connection.query('select 1 from discord_bot_staff_actions where interaction_id = $1', [id]);
        let result = { status: 'duplicate' };
        if (!existing.rows.length) {
            const quota = administrator ? null : (await connection.query(`
                select count(*)::integer as used, min(quota_until) as retry_at from (
                    select quota_until from discord_bot_staff_actions where guild_id = $1 and actor_id = $2
                        and outcome <> 'failed' and quota_until > statement_timestamp()
                    order by quota_until desc limit $3
                ) as active_actions
            `, [guildId, actorId, LIMIT])).rows[0];
            if (quota && quota.used >= LIMIT) {
                result = { status: 'limited', retryAt: quota.retry_at };
            } else {
                await connection.query(`
                    insert into discord_bot_staff_actions (interaction_id, guild_id, actor_id, target_id, action, reason, administrator)
                    values ($1, $2, $3, $4, $5, $6, $7)
                `, [id, guildId, actorId, targetId, action, reason, administrator]);
                result = { status: 'reserved' };
            }
        }
        await connection.query('commit');
        return result;
    } catch (error) {
        try { await connection.query('rollback'); } catch (rollbackError) { releaseError = rollbackError; }
        throw error;
    } finally {
        connection.release(releaseError);
    }
}

async function finish(id, outcome) {
    await postgres.postgresQuery(`
        update discord_bot_staff_actions set outcome = $2, quota_until = clock_timestamp() + interval '1 hour'
        where interaction_id = $1 and outcome = 'pending'
    `, [id, outcome]);
}

async function pendingLogs(guildId) {
    await ensureSchema();
    return (await postgres.postgresQuery(`
        select interaction_id, actor_id, target_id, action, reason, administrator, created_at,
            case when outcome = 'pending' then 'unconfirmed' else outcome end as outcome
        from discord_bot_staff_actions where guild_id = $1 and log_message_id is null
            and (outcome <> 'pending' or created_at <= statement_timestamp() - interval '1 minute')
        order by created_at, interaction_id limit 20
    `, [guildId])).rows;
}

async function markLogged(id, messageId) {
    await postgres.postgresQuery(`update discord_bot_staff_actions set log_message_id = $2 where interaction_id = $1`, [id, messageId]);
}

module.exports = { LIMIT, reserve, finish, pendingLogs, markLogged };
