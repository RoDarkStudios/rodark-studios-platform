const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const postgres = require('./postgres');
const schema = readFileSync(join(__dirname, 'discord-infrastructure-schema.sql'), 'utf8');
let schemaPromise;
async function ensureSchema() {
    if (!schemaPromise) schemaPromise = postgres.postgresQuery(schema).catch((error) => { schemaPromise = null; throw error; });
    return schemaPromise;
}
function conflict(message) { return Object.assign(new Error(message), { statusCode: 409 }); }
async function getState(guildId) {
    await ensureSchema();
    await postgres.postgresQuery('insert into discord_infrastructure_state(guild_id) values ($1) on conflict do nothing', [guildId]);
    return (await postgres.postgresQuery('select * from discord_infrastructure_state where guild_id = $1', [guildId])).rows[0];
}
async function queuePreview(guildId, version, actor) {
    await getState(guildId);
    try {
        return (await postgres.postgresQuery(`insert into discord_infrastructure_jobs(id, guild_id, version, actor, status)
            values ($1,$2,$3,$4::jsonb,'preview_queued') returning *`, [randomUUID(), guildId, version, JSON.stringify(actor)])).rows[0];
    } catch (error) { if (error.code === '23505') throw conflict('A server operation is already queued or running.'); throw error; }
}
async function queueDeploy(guildId, id, version, actor) {
    await ensureSchema();
    try {
        const result = await postgres.postgresQuery(`update discord_infrastructure_jobs
            set status = 'deploy_queued', actor = $4::jsonb, updated_at = now()
            where id = $1 and guild_id = $2 and version = $3 and status = 'ready'
              and expires_at > now() and jsonb_array_length(plan->'errors') = 0
            returning *`, [id, guildId, version, JSON.stringify(actor)]);
        if (!result.rows.length) throw conflict('This preview expired, has blockers, or belongs to an older configuration. Generate a new preview.');
        return result.rows[0];
    } catch (error) { if (error.code === '23505') throw conflict('Another server operation is running.'); throw error; }
}
async function latestJobs(guildId) {
    await ensureSchema();
    return (await postgres.postgresQuery('select * from discord_infrastructure_jobs where guild_id = $1 order by created_at desc limit 8', [guildId])).rows;
}
async function withGuildLock(guildId, callback) {
    await ensureSchema();
    const connection = await postgres.getPostgresPool().connect();
    let acquired = false, lost = false;
    const onError = () => { lost = true; };
    connection.on?.('error', onError);
    try {
        acquired = (await connection.query("select pg_try_advisory_lock(hashtextextended('discord-infrastructure:' || $1, 0)) as acquired", [guildId])).rows[0].acquired;
        if (!acquired) return false;
        await callback({ assertHeld() { if (lost) throw new Error('The deployment lock connection was lost. Generate a fresh preview before retrying.'); } });
        return true;
    } finally {
        if (acquired && !lost) await connection.query("select pg_advisory_unlock(hashtextextended('discord-infrastructure:' || $1, 0))", [guildId]).catch(() => { lost = true; });
        connection.removeListener?.('error', onError);
        connection.release(lost);
    }
}
// Called only while holding the session lock: no other worker can still own these jobs.
async function recoverInterrupted(guildId) {
    await postgres.postgresQuery(`update discord_infrastructure_jobs set status = 'failed',
        error = 'The bot restarted during this operation. Generate a new preview to inspect and finish the remaining changes.', updated_at = now(), finished_at = now()
        where guild_id = $1 and status in ('previewing','applying')`, [guildId]);
}
async function claimJob(guildId) {
    return (await postgres.postgresQuery(`update discord_infrastructure_jobs set
        status = case when status = 'preview_queued' then 'previewing' else 'applying' end, updated_at = now()
        where id = (select id from discord_infrastructure_jobs where guild_id = $1
            and status in ('preview_queued','deploy_queued') order by created_at limit 1)
        returning *`, [guildId])).rows[0] || null;
}
async function ready(id, plan) {
    await postgres.postgresQuery(`update discord_infrastructure_jobs set status = 'ready', plan = $2::jsonb,
        expires_at = now() + interval '15 minutes', updated_at = now() where id = $1`, [id, JSON.stringify(plan)]);
}
async function finish(id, status, error = null) {
    if (!['succeeded', 'failed', 'stale'].includes(status)) throw new Error('Invalid deployment result.');
    await postgres.postgresQuery(`update discord_infrastructure_jobs set status = $2, error = $3,
        updated_at = now(), finished_at = now() where id = $1`, [id, status, error ? String(error).slice(0, 1800) : null]);
}
async function progress(id, entry) {
    await postgres.postgresQuery(`update discord_infrastructure_jobs set progress = progress || $2::jsonb, updated_at = now()
        where id = $1`, [id, JSON.stringify([{ ...entry, at: new Date().toISOString() }])]);
}
async function beginApply(guildId, resources) {
    await postgres.postgresQuery(`update discord_infrastructure_state set maintenance = true, resources = $2::jsonb,
        updated_at = now() where guild_id = $1`, [guildId, JSON.stringify(resources)]);
}
async function saveResources(guildId, resources) {
    await postgres.postgresQuery('update discord_infrastructure_state set resources = $2::jsonb, updated_at = now() where guild_id = $1', [guildId, JSON.stringify(resources)]);
}
async function activate(guildId, active, resources) {
    await postgres.postgresQuery(`update discord_infrastructure_state set initialized = true, maintenance = false,
        active = $2::jsonb, resources = $3::jsonb, drift = null, last_success_at = now(), updated_at = now()
        where guild_id = $1`, [guildId, JSON.stringify(active), JSON.stringify(resources)]);
}
async function setDrift(guildId, drift) {
    await postgres.postgresQuery('update discord_infrastructure_state set drift = $2::jsonb, last_checked_at = now() where guild_id = $1', [guildId, drift ? JSON.stringify(drift) : null]);
}
async function openTicketIds(guildId) {
    const { ensureDiscordBotControlSchema } = require('./discord-bot-control-store');
    await ensureDiscordBotControlSchema();
    return (await postgres.postgresQuery("select channel_id from discord_bot_tickets where guild_id = $1 and status = 'open'", [guildId])).rows.map((row) => row.channel_id);
}
module.exports = { ensureSchema, getState, queuePreview, queueDeploy, latestJobs, withGuildLock, recoverInterrupted,
    claimJob, ready, finish, progress, beginApply, saveResources, activate, setDrift, openTicketIds };
