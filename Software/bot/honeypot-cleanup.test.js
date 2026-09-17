const test = require('node:test');
const assert = require('node:assert/strict');
const { createHoneypotCleanup } = require('./honeypot-cleanup');

const BAN_TIME = Date.UTC(2026, 8, 17, 12);
const snowflake = (at, sequence = 0) => String((BigInt(at - 1420070400000) << 22n) + BigInt(sequence));

function fixture() {
    let now = BAN_TIME;
    let sequence = 0;
    const messages = new Map();
    const calls = { searches: [], deletes: [], updates: [], bans: 0 };
    const job = {
        message_id: snowflake(BAN_TIME), guild_id: '100', user_id: '200',
        cleanup_from: new Date(BAN_TIME - 600_000), cleanup_until: new Date(BAN_TIME + 10_000),
        cleanup_due_at: new Date(BAN_TIME + 10_000), cleanup_passes: 0, cleanup_attempts: 0
    };
    const store = {
        async getDueCleanups(guildIds, at) {
            return guildIds.includes(job.guild_id) && job.cleanup_due_at && job.cleanup_due_at <= at ? [{ ...job }] : [];
        },
        async updateCleanup(id, update) {
            assert.equal(id, job.message_id);
            calls.updates.push(update);
            Object.assign(job, { cleanup_due_at: update.dueAt, cleanup_passes: update.passes,
                cleanup_attempts: update.attempts, cleanup_error: update.error });
        }
    };
    const client = {
        isReady: () => true, guilds: { cache: new Map([['100', {}]]) },
        rest: {
            async get(route, options) {
                if (route === '/guilds/100/bans/200') { calls.bans++; return {}; }
                assert.equal(route, '/guilds/100/messages/search');
                calls.searches.push(options.query);
                const query = options.query;
                const matches = [...messages.values()].filter((message) => BigInt(message.id) > BigInt(query.get('min_id'))
                    && BigInt(message.id) < BigInt(query.get('max_id')))
                    .sort((a, b) => BigInt(a.id) > BigInt(b.id) ? -1 : 1);
                // Deliberately return other authors/context, short pages and an
                // inaccurate count to test local safeguards and cursor pagination.
                return { messages: matches.slice(0, 2).map((message) => [message]), total_results: 0 };
            },
            async delete(route) {
                calls.deletes.push(route);
                messages.delete(route.split('/').at(-1));
            }
        }
    };
    function add(offset, overrides = {}) {
        const message = { id: snowflake(BAN_TIME + offset, sequence++), channel_id: '300',
            author: { id: '200' }, content: '', attachments: [{ filename: 'image.png' }], ...overrides };
        messages.set(message.id, message);
        return message;
    }
    const options = { store, now: () => now };
    const cleanup = createHoneypotCleanup(client, options);
    return { cleanup, client, store, job, calls, messages, add, options,
        advance(ms) { now += ms; }, now: () => now };
}

test('idle polls and other guilds make no Discord requests', async () => {
    const f = fixture();
    await f.cleanup.tick({});
    f.advance(10_000);
    await f.cleanup.tick({ guildId: '999' });
    assert.equal(f.calls.bans, 0);
    assert.equal(f.calls.searches.length, 0);
});

test('deletes image-only leftovers across channels/threads with a fixed ten-minute cutoff', async () => {
    const f = fixture();
    const old = f.add(-600_001);
    const boundary = f.add(-600_000);
    const media = f.add(-1_000);
    const thread = f.add(-500, { channel_id: '301' });
    const inFlight = f.add(5_000);
    const later = f.add(11_000);
    const other = f.add(-100, { author: { id: '999' } });
    const webhook = f.add(-200, { webhook_id: '400' });
    const otherGuild = f.add(-300, { guild_id: '999' });
    f.advance(10_000);
    await f.cleanup.tick({});
    assert.deepEqual(new Set(f.calls.deletes.map((route) => route.split('/').at(-1))),
        new Set([boundary.id, media.id, thread.id, inFlight.id]));
    for (const message of [old, later, other, webhook, otherGuild]) assert.ok(f.messages.has(message.id));
    assert.ok(f.calls.searches.length > 2, 'short pages must not stop pagination');
    for (const query of f.calls.searches) {
        assert.equal(query.get('author_id'), '200');
        assert.equal(query.get('include_nsfw'), 'true');
        assert.equal(query.get('min_id'), String(BigInt(snowflake(BAN_TIME - 600_000)) - 1n));
    }
    assert.equal(f.job.cleanup_passes, 1);
    assert.equal(f.job.cleanup_due_at.getTime(), BAN_TIME + 60_000);
});

test('a second delayed pass catches a message indexed after the first empty pass', async () => {
    const f = fixture();
    f.advance(10_000);
    await f.cleanup.tick({});
    f.add(2_000);
    f.advance(49_000);
    await f.cleanup.tick({});
    assert.equal(f.calls.deletes.length, 0);
    f.advance(1_000);
    await f.cleanup.tick({});
    assert.equal(f.calls.deletes.length, 1);
    assert.equal(f.job.cleanup_passes, 2);
    assert.equal(f.job.cleanup_due_at, null);
    const reads = f.calls.searches.length;
    await f.cleanup.tick({});
    assert.equal(f.calls.searches.length, reads);
});

test('permission failures leave retries queued, allow other channels to clean, and surface an error', async () => {
    const f = fixture();
    const blocked = f.add(-100);
    const allowed = f.add(-200, { channel_id: '301' });
    const remove = f.client.rest.delete;
    f.client.rest.delete = async (route) => {
        if (route.includes('/300/')) throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
        return remove(route);
    };
    f.advance(10_000);
    await f.cleanup.tick({});
    assert.ok(f.messages.has(blocked.id));
    assert.ok(!f.messages.has(allowed.id));
    assert.equal(f.job.cleanup_passes, 0);
    assert.match(f.cleanup.getError(), /300.*Missing Permissions/);
    assert.equal(f.job.cleanup_due_at.getTime(), BAN_TIME + 40_000);
    f.client.rest.delete = remove;
    // A long delay must not move the original ten-minute cutoff forward.
    f.advance(3_600_000);
    await f.cleanup.tick({});
    assert.ok(!f.messages.has(blocked.id));
    assert.equal(f.cleanup.getError(), null);
});

test('search indexing and transient API failures retry instead of reporting an empty cleanup', async () => {
    for (const response of [{ code: 110000, retry_after: 120 }, { messages: [], doing_deep_historical_index: true }, {}]) {
        const f = fixture();
        const get = f.client.rest.get;
        f.client.rest.get = async (route, options) => route.endsWith('/search') ? response : get(route, options);
        f.advance(10_000);
        await f.cleanup.tick({});
        assert.equal(f.job.cleanup_passes, 0);
        assert.equal(f.job.cleanup_attempts, 1);
        assert.ok(f.cleanup.getError());
        if (response.retry_after) assert.equal(f.job.cleanup_due_at.getTime(), f.now() + response.retry_after * 1000);
    }
    const f = fixture();
    f.client.rest.get = async () => { throw new Error('Network unavailable'); };
    f.advance(10_000);
    await f.cleanup.tick({});
    assert.equal(f.job.cleanup_attempts, 1);
    assert.match(f.cleanup.getError(), /Network unavailable/);
});

test('already deleted messages/channels are harmless and an explicit unban cancels cleanup', async () => {
    const f = fixture();
    f.add(-1);
    f.client.rest.delete = async () => { throw Object.assign(new Error('Unknown Message'), { code: 10008 }); };
    f.advance(10_000);
    await f.cleanup.tick({});
    assert.equal(f.job.cleanup_passes, 1);
    assert.equal(f.cleanup.getError(), null);
    f.client.rest.get = async () => { throw Object.assign(new Error('Unknown Ban'), { code: 10026 }); };
    f.advance(50_000);
    await f.cleanup.tick({});
    assert.equal(f.job.cleanup_due_at, null);
});

test('restarting resumes persisted cleanup and overlapping ticks do not run duplicate sweeps', async () => {
    const f = fixture();
    f.add(-100);
    f.advance(10_000);
    await Promise.all([f.cleanup.tick({}), f.cleanup.tick({}), f.cleanup.tick({})]);
    assert.equal(f.calls.bans, 1);
    await f.cleanup.stop();
    f.add(1_000);
    f.advance(50_000);
    const restarted = createHoneypotCleanup(f.client, f.options);
    await restarted.tick({});
    assert.equal(f.job.cleanup_due_at, null);
    assert.equal(f.calls.deletes.length, 2);
});

test('stopping during a search preserves the job without deleting or marking it complete', async () => {
    const f = fixture();
    f.add(-100);
    const get = f.client.rest.get;
    let release;
    let searching;
    const started = new Promise((resolve) => { searching = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    f.client.rest.get = async (route, options) => {
        if (route.endsWith('/search')) { searching(); await gate; }
        return get(route, options);
    };
    f.advance(10_000);
    const tick = f.cleanup.tick({});
    await started;
    const stop = f.cleanup.stop();
    release();
    await Promise.all([tick, stop]);
    assert.equal(f.calls.deletes.length, 0);
    assert.equal(f.calls.updates.length, 0);
});

test('database failures are visible and do not become unhandled background rejections', async () => {
    const f = fixture();
    f.store.getDueCleanups = async () => { throw new Error('Database unavailable'); };
    await f.cleanup.tick({});
    assert.match(f.cleanup.getError(), /queue.*Database unavailable/);
});
