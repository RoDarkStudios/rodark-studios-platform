const { Routes } = require('discord.js');

const CLEANUP_WINDOW_MS = 10 * 60 * 1000;
const SETTLE_MS = 10_000;
const DISCORD_EPOCH = 1420070400000;
const snowflakeAt = (timestamp) => BigInt(timestamp - DISCORD_EPOCH) << 22n;

// Search only this author and this fixed time range, including attachment-only
// posts and threads. Cursor pagination stays stable while results are deleted.
async function sweepMessages(client, job, active) {
    try {
        await client.rest.get(Routes.guildBan(job.guild_id, job.user_id));
    } catch (error) {
        if (error.code === 10026) return 'cancelled'; // An explicit unban cancels cleanup.
        throw error;
    }
    const from = snowflakeAt(new Date(job.cleanup_from).getTime());
    const until = snowflakeAt(new Date(job.cleanup_until).getTime() + 1);
    let before = until;
    const errors = new Map();
    for (let page = 0; page < 100; page++) {
        if (!active()) return false;
        const query = new URLSearchParams({
            author_id: job.user_id, min_id: String(from - 1n), max_id: String(before),
            sort_by: 'timestamp', sort_order: 'desc', limit: '25', include_nsfw: 'true'
        });
        // Use the documented route directly to support older discord.js 14 releases.
        const result = await client.rest.get(`/guilds/${job.guild_id}/messages/search`, { query });
        if (result.code === 110000 || result.doing_deep_historical_index) {
            const error = new Error('Discord message search is still indexing; cleanup will retry');
            error.retryAfterMs = Math.max(0, Number(result.retry_after) || 0) * 1000;
            throw error;
        }
        if (!Array.isArray(result.messages)) throw new Error('Invalid Discord message search response');
        const messages = result.messages.flat();
        if (!messages.length) {
            if (errors.size) throw new Error([...errors.values()].join('; '));
            return true;
        }
        let oldest = before;
        for (const message of messages) {
            if (!/^\d+$/.test(message.id)) throw new Error('Invalid message ID in cleanup results');
            const id = BigInt(message.id);
            if (id < oldest) oldest = id;
            // Never trust search filters alone when choosing what to delete.
            if (message.author?.id !== job.user_id || message.webhook_id
                || (message.guild_id && message.guild_id !== job.guild_id)
                || id < from || id >= until || !/^\d+$/.test(message.channel_id)) continue;
            if (!active()) return false;
            if (errors.has(message.channel_id)) continue;
            try {
                await client.rest.delete(Routes.channelMessage(message.channel_id, message.id), {
                    reason: `Honeypot cleanup for ban triggered by ${job.message_id}`
                });
            } catch (error) {
                if (error.code !== 10008 && error.code !== 10003) {
                    errors.set(message.channel_id, `Channel ${message.channel_id}: ${error.message}`);
                }
            }
        }
        if (oldest >= before) throw new Error('Discord cleanup search cursor did not advance');
        before = oldest;
    }
    throw new Error('Cleanup page budget reached; remaining messages will be retried');
}

function createHoneypotCleanup(client, { store, now = Date.now }) {
    const errors = new Map();
    let running;
    let stopped = false;
    const active = () => !stopped && client.isReady();

    async function run(control) {
        try {
            const guildIds = [...client.guilds.cache.keys()].filter((id) => !control?.guildId || id === String(control.guildId));
            if (!guildIds.length) return;
            const jobs = await store.getDueCleanups(guildIds, new Date(now()));
            errors.delete('queue');
            for (const job of jobs) {
                if (!active()) return;
                try {
                    const result = await sweepMessages(client, job, active);
                    if (!result || !active()) return;
                    const passes = job.cleanup_passes + 1;
                    // Always check again after indexing/late message delivery settles.
                    const dueAt = result !== 'cancelled' && passes < 2
                        ? new Date(Math.max(now() + 30_000, new Date(job.cleanup_until).getTime() + 50_000)) : null;
                    await store.updateCleanup(job.message_id, { dueAt, passes, attempts: 0, error: null });
                    errors.delete(job.message_id);
                    console.log(`[honeypot] Cleanup pass ${passes} finished for ${job.user_id} in ${job.guild_id}.`);
                } catch (error) {
                    const description = `Honeypot cleanup for ${job.user_id} in ${job.guild_id}: ${error.message}`;
                    errors.set(job.message_id, description);
                    console.error(description);
                    const attempts = job.cleanup_attempts + 1;
                    const delay = Math.max(error.retryAfterMs || 0, Math.min(300_000, 30_000 * 2 ** Math.min(attempts - 1, 4)));
                    const dueAt = new Date(now() + delay);
                    await store.updateCleanup(job.message_id, {
                        dueAt, passes: job.cleanup_passes, attempts, error: description.slice(0, 2000)
                    });
                }
            }
        } catch (error) {
            errors.set('queue', `Honeypot cleanup queue: ${error.message}`);
            console.error(`[honeypot] Cleanup queue failed: ${error.message}`);
        }
    }

    function tick(control) {
        if (!active()) return Promise.resolve();
        if (!running) running = run(control).finally(() => { running = null; });
        return running;
    }

    return {
        tick,
        getError: () => [...errors.values()].join('; ').slice(0, 2000) || null,
        async stop() { stopped = true; await running; }
    };
}

module.exports = { createHoneypotCleanup, CLEANUP_WINDOW_MS, SETTLE_MS };
