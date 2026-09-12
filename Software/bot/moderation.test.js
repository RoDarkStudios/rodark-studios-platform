const test = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType, Collection, PermissionsBitField, PermissionFlagsBits: P } = require('discord.js');
const { createModerationSystem, buildCasePayload, LOG_TOPIC } = require('./moderation');
const { snapshotMessage, reviewConversation, validateCases, buildReviewInput } = require('./moderation-policy');

function fixture() {
    let time = Date.parse('2026-09-12T12:00:00Z');
    let sequence = 0;
    let timer;
    let reviewImpl = async () => ({ cases: [], usage: { input_tokens: 3000, output_tokens: 2000 } });
    const calls = { reviews: [], timeouts: [], logs: [], errors: [], usage: [], intervals: [], creates: [] };
    const queue = new Map(), cases = new Map(), locks = new Set(), intervals = new Map();
    const store = {
        async ensureSchema() {},
        async enqueue(message) {
            const previous = queue.get(message.id);
            if (!previous) queue.set(message.id, { payload: structuredClone(message), attempts: 0 });
            else if (!previous.deleted && previous.payload.version !== message.version) Object.assign(previous, { payload: structuredClone(message), attempts: 0 });
        },
        async markDeleted(ids) { ids.forEach((id) => { if (queue.has(id)) queue.get(id).deleted = true; }); },
        async pendingChannels(guildIds) {
            const result = new Map();
            for (const row of queue.values()) if (!row.deleted && row.attempts < 3 && row.reviewed !== row.payload.version && guildIds.includes(row.payload.guild_id)) {
                const item = result.get(row.payload.channel_id) || { channel_id: row.payload.channel_id, guild_id: row.payload.guild_id, pending_count: 0, oldest: row.payload.timestamp };
                item.pending_count++; result.set(item.channel_id, item);
            }
            return [...result.values()];
        },
        async loadPending(id) { return [...queue.values()].filter((row) => row.payload.channel_id === id && !row.deleted && row.attempts < 3 && row.reviewed !== row.payload.version).slice(0, 50).map((row) => structuredClone(row.payload)); },
        async getContext(id) { return [...queue.values()].filter((row) => row.payload.channel_id === id && !row.deleted && row.reviewed === row.payload.version).slice(-30).map((row) => structuredClone(row.payload)); },
        async recentCases(guildId, users) { return [...cases.values()].filter((entry) => entry.guild_id === guildId && users.includes(entry.user_id) && entry.outcome === 'timed_out' && !entry.dismissed_by); },
        async withLock(key, task) { if (locks.has(key)) return false; locks.add(key); try { await task(); return true; } finally { locks.delete(key); } },
        async claimInterval(id) { if ((intervals.get(id) || 0) > time) return false; intervals.set(id, time + 60_000); return true; },
        async commitReview(batch, entries) {
            for (const entry of entries) if (!entry.evidence.some((m) => queue.get(m.id)?.deleted || queue.get(m.id)?.payload.version !== m.version) && !cases.has(entry.id)) cases.set(entry.id, structuredClone(entry));
            for (const message of batch) if (queue.get(message.id)?.payload.version === message.version) queue.get(message.id).reviewed = message.version;
        },
        async failBatch(batch) { batch.forEach((m) => { if (queue.get(m.id)?.payload.version === m.version) queue.get(m.id).attempts++; }); },
        async unfinishedCases(guildId) { return [...cases.values()].filter((entry) => entry.guild_id === guildId && !entry.dismissed_by && (entry.outcome === 'pending' || !entry.log_message_id)).map((entry) => structuredClone(entry)); },
        async getCase(id) { return cases.has(id) ? structuredClone(cases.get(id)) : null; },
        async updateCase(id, patch) { Object.assign(cases.get(id), structuredClone(patch)); },
        async recordUsage(...args) { calls.usage.push(args); },
        async cleanup() {}
    };
    const everyone = { id: 'guild', name: '@everyone', permissions: new PermissionsBitField([P.ViewChannel, P.SendMessages]) };
    const staff = { id: 'staff', name: 'Staff', permissions: new PermissionsBitField([P.ModerateMembers]) };
    const ownerRole = { id: 'owner-role', name: 'Owner', permissions: new PermissionsBitField([]) };
    const client = { user: { id: 'bot' }, isReady: () => true, guilds: { cache: new Collection() } };
    const members = new Collection();
    const guild = {
        id: 'guild', ownerId: 'owner',
        roles: { everyone, cache: new Collection([['guild', everyone], ['staff', staff], ['owner-role', ownerRole]]), async fetch() { return this.cache; } },
        members: {
            async fetchMe() { return members.get('bot'); },
            async fetch({ user }) { if (!members.has(user)) throw Object.assign(new Error('Unknown Member'), { code: 10007 }); return members.get(user); }
        },
        channels: {
            cache: new Collection(),
            async fetch(id) { return id ? this.cache.get(id) || null : this.cache; },
            async create(options) { calls.creates.push(options); return makeChannel(options); }
        }
    };
    client.guilds.cache.set(guild.id, guild);
    function member(id, { roles = [], permissions = [], moderatable = true } = {}) {
        const item = { id, user: { id, bot: id === 'bot' }, roles: { cache: new Collection([['guild', everyone], ...roles.map((role) => [role.id, role])]) },
            permissions: new PermissionsBitField(permissions), moderatable, communicationDisabledUntilTimestamp: null,
            async disableCommunicationUntil(until, reason) { calls.timeouts.push({ id, until, reason }); this.communicationDisabledUntilTimestamp = until ? Number(until) : null; }
        };
        members.set(id, item); return item;
    }
    member('bot', { permissions: [P.Administrator] });
    member('alice'); member('bob'); member('owner'); member('mod', { roles: [staff], permissions: [P.ModerateMembers] });
    function makeChannel(options = {}) {
        const channel = {
            id: options.id || `channel-${++sequence}`, guild, type: options.type ?? ChannelType.GuildText,
            name: options.name || 'general', topic: options.topic, parentId: options.parent || null, parent: options.parentChannel || null,
            private: Boolean(options.private), isThread() { return [ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread].includes(this.type); },
            permissionsFor(role) {
                if (role.id === 'bot') return new PermissionsBitField(PermissionsBitField.All);
                return new PermissionsBitField(!this.private || ['staff', 'owner-role'].includes(role.id) ? [P.ViewChannel, P.SendMessages, P.ReadMessageHistory] : []);
            },
            permissionOverwrites: { cache: new Collection(), async set(values) { this.cache = new Collection(values.map((value) => [value.id, { ...value, allow: new PermissionsBitField(value.allow), deny: new PermissionsBitField(value.deny) }])); } },
            messages: {
                cache: new Collection(),
                async fetch(options) {
                    if (options?.limit) return new Collection([...this.cache].filter(([id]) => !options.before || id < options.before).slice(-options.limit));
                    const id = typeof options === 'string' ? options : options.message;
                    if (!this.cache.has(id)) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
                    return this.cache.get(id);
                }
            },
            async send(payload) {
                const message = { id: String(900000000000000000n + BigInt(++sequence)), payload,
                    async edit(next) { this.payload = next; return this; } };
                calls.logs.push({ channel: this, payload, message });
                return message;
            }
        };
        channel.permissionOverwrites.set(options.permissionOverwrites || []);
        guild.channels.cache.set(channel.id, channel);
        return channel;
    }
    const channel = makeChannel({ id: 'general' });
    function message(content = 'Hello', userId = 'alice', target = channel, overrides = {}) {
        const result = { id: String(100000000000000000n + BigInt(++sequence)), guild, channel: target, channelId: target.id,
            author: { id: userId, username: userId, bot: false }, content, createdTimestamp: time,
            attachments: new Collection(), stickers: new Collection(), ...overrides };
        target.messages.cache.set(result.id, result);
        return result;
    }
    const config = { enabled: true, apiKey: 'test-key', moderatorRoleIds: [], excludedChannelIds: [], logChannelId: '' };
    const control = { guildId: 'guild', desiredEnabled: true, ticketSystem: { categoryChannelId: 'tickets' } };
    const options = {
        store, config, now: () => time,
        review: async (input, options) => { calls.reviews.push({ input, options }); return reviewImpl(input, options); },
        setIntervalFn: (callback, delay) => { timer = callback; calls.intervals.push(delay); return { unref() {} }; },
        clearIntervalFn: () => { timer = null; }, logger: { error: (...args) => calls.errors.push(args), info() {} }
    };
    const system = createModerationSystem(client, options);
    const decision = (input, extra = {}) => ({ user_id: input.new_messages[0].user_id, message_ids: [input.new_messages[0].id], category: 'personal_attack', severity: 'clear', confidence: 'high', action: 'timeout', reason: 'Clear targeted personal abuse.', ...extra });
    function flag(extra = {}) { reviewImpl = async (input) => ({ cases: [decision(input, extra)], usage: {} }); }
    async function queueMessage(...args) { const m = message(...args); await system.handleMessage(m, control); return m; }
    async function next() { time += 60_000; await system.tick(control); }
    return { system, options, client, guild, channel, members, staff, ownerRole, config, control, calls, store, queue, cases,
        message, member, makeChannel, queueMessage, next, decision, flag,
        advance: (ms) => { time += ms; }, now: () => time,
        setReview: (fn) => { reviewImpl = fn; }, fireTimer: () => timer?.(),
        log: () => [...guild.channels.cache.values()].find((c) => c.topic === LOG_TOPIC) };
}

test('quiet channels cost no requests; timer is one minute and message count never triggers an early call', async () => {
    const f = fixture(); await f.system.ensure(f.control); f.system.start(() => f.control);
    assert.deepEqual(f.calls.intervals, [60_000]);
    await f.next(); assert.equal(f.calls.reviews.length, 0);
    for (let i = 0; i < 12; i++) await f.queueMessage('Fuck this boss fight');
    assert.equal(f.calls.reviews.length, 0);
    f.advance(60_000); f.fireTimer(); await f.system.tick(f.control);
    assert.equal(f.calls.reviews.length, 1); assert.equal(f.calls.reviews[0].input.new_messages.length, 12);
    assert.equal(f.calls.timeouts.length, 0);
    await f.next(); assert.equal(f.calls.reviews.length, 1);
    await f.system.stop();
});

test('creates and repairs a private log with moderator role pings; setup is idempotent', async () => {
    const f = fixture(); await f.system.ensure(f.control);
    const log = f.log(); assert.equal(log.permissionOverwrites.cache.get('guild').deny.has(P.ViewChannel), true);
    assert.equal(log.permissionOverwrites.cache.get('staff').allow.has(P.ViewChannel), true);
    assert.equal(log.permissionOverwrites.cache.get('bot').allow.has(P.MentionEveryone), true);
    await log.permissionOverwrites.set([]);
    await f.system.ensure(f.control, { force: true });
    assert.equal(f.calls.creates.length, 1); assert.equal(log.permissionOverwrites.cache.get('guild').deny.has(P.ViewChannel), true);
});

test('no AI for tickets, staff-only channels, honeypot, bots, webhooks, DMs or private threads', async () => {
    const f = fixture(); await f.system.ensure(f.control);
    for (const options of [{ parent: 'tickets' }, { private: true }, { name: 'ignore | do-not-type' }, { type: ChannelType.PrivateThread }]) {
        await f.system.handleMessage(f.message('Abuse', 'alice', f.makeChannel(options)), f.control);
    }
    for (const overrides of [{ author: { id: 'bot', bot: true } }, { webhookId: 'hook' }, { system: true }, { guild: null }]) {
        await f.system.handleMessage(f.message('Abuse', 'alice', f.channel, overrides), f.control);
    }
    await f.system.handleMessage(f.message('Abuse', 'alice', f.log()), f.control);
    await f.next(); assert.equal(f.calls.reviews.length, 0);
});

test('public threads are reviewed independently with their own conversation context', async () => {
    const f = fixture(); const thread = f.makeChannel({ type: ChannelType.PublicThread, parent: f.channel.id, parentChannel: f.channel });
    await f.queueMessage('Hello general'); await f.queueMessage('Hello thread', 'bob', thread); await f.next();
    assert.equal(f.calls.reviews.length, 2);
    assert.ok(f.calls.reviews.every(({ input }) => new Set(input.new_messages.map((m) => m.channel_id)).size === 1));
});

test('clear violations get a ten-minute timeout and an evidence log without pinging everyone', async () => {
    const f = fixture(); f.flag(); const m = await f.queueMessage('Targeted abuse'); await f.next();
    assert.equal(f.calls.timeouts.length, 1); assert.equal(Number(f.calls.timeouts[0].until), f.now() + 600_000);
    const entry = [...f.cases.values()][0]; assert.equal(entry.outcome, 'timed_out');
    const payload = f.calls.logs.at(-1).payload; assert.deepEqual(payload.allowedMentions, { parse: [], users: [], roles: [] });
    assert.match(payload.embeds[0].toJSON().fields.find((field) => field.name === 'Evidence 1').value, new RegExp(m.id));
    await f.next(); assert.equal(f.calls.timeouts.length, 1); assert.equal(f.calls.reviews.length, 1);
});

test('severe hate gets a bounded timeout and moderator ban review; no ban API exists in this module', async () => {
    const f = fixture(); f.flag({ category: 'hate_speech', severity: 'severe', action: 'timeout_and_review' });
    await f.queueMessage('Racial abuse'); await f.next();
    assert.equal(Number(f.calls.timeouts[0].until), f.now() + 3_600_000);
    assert.deepEqual(f.calls.logs.at(-1).payload.allowedMentions.roles, ['staff']);
    assert.equal(f.calls.logs.at(-1).payload.content, '<@&staff>');
});

test('uncertainty overrides a model request to punish and only requests human review', async () => {
    const f = fixture(); f.flag({ confidence: 'uncertain', action: 'timeout_and_review' });
    await f.queueMessage('Ambiguous exchange'); await f.next();
    assert.equal(f.calls.timeouts.length, 0); assert.equal([...f.cases.values()][0].outcome, 'review_only');
    assert.deepEqual(f.calls.logs.at(-1).payload.allowedMentions.roles, ['staff']);
});

test('owner, Owner role, staff, administrators and hierarchy-protected members are review-only', async () => {
    for (const setup of [
        (f) => f.members.get('owner'),
        (f) => f.member('alice', { roles: [f.ownerRole] }),
        (f) => f.members.get('mod'),
        (f) => f.member('alice', { permissions: [P.Administrator] }),
        (f) => f.member('alice', { moderatable: false })
    ]) {
        const f = fixture(); f.flag(); const member = setup(f); await f.queueMessage('Abuse', member.id); await f.next();
        assert.equal(f.calls.timeouts.length, 0); assert.equal([...f.cases.values()][0].outcome, 'review_only');
    }
});

test('keeps a longer existing timeout and does not stack timeouts across channels', async () => {
    const f = fixture(); f.flag();
    f.members.get('alice').communicationDisabledUntilTimestamp = f.now() + 86_400_000;
    await f.queueMessage('Abuse'); await f.next(); assert.equal(f.calls.timeouts.length, 0);
    const g = fixture(); g.flag(); await g.queueMessage('Abuse'); await g.queueMessage('More abuse', 'alice', g.makeChannel()); await g.next();
    assert.equal(g.calls.timeouts.length, 1);
});

test('duplicate gateway events and embed-only updates do not cause repeat reviews', async () => {
    const f = fixture(); const m = await f.queueMessage('Hello'); await f.system.handleMessage(m, f.control); await f.next();
    m.embeds = [{ title: 'Preview' }]; await f.system.handleMessage(m, f.control); await f.next();
    assert.equal(f.calls.reviews.length, 1);
    m.content = 'Actually edited'; m.editedTimestamp = f.now(); await f.system.handleMessage(m, f.control); await f.next();
    assert.equal(f.calls.reviews.length, 2);
});

test('an edit arriving during AI review remains queued and cannot be punished using the old text', async () => {
    const f = fixture(); const m = await f.queueMessage('Old content');
    f.setReview(async (input) => {
        m.content = 'Changed content'; m.editedTimestamp = f.now(); await f.system.handleMessage(m, f.control);
        return { cases: [f.decision(input)], usage: {} };
    });
    await f.next(); assert.equal(f.calls.timeouts.length, 0); assert.equal(f.cases.size, 0);
    assert.equal((await f.store.loadPending(f.channel.id))[0].content, 'Changed content');
});

test('deleted messages are invalidated, including deletion during review', async () => {
    const f = fixture(); const m = await f.queueMessage('Old content');
    f.setReview(async (input) => { await f.system.handleDelete([m]); return { cases: [f.decision(input)], usage: {} }; });
    await f.next(); assert.equal(f.cases.size, 0); assert.equal(f.calls.timeouts.length, 0);
    await f.next(); assert.equal(f.calls.reviews.length, 1);
});

test('Discord evidence is freshly checked before punishment even when an edit event was missed', async () => {
    const f = fixture(); const m = await f.queueMessage('Old content');
    f.setReview(async (input) => { m.content = 'Corrected'; return { cases: [f.decision(input)], usage: {} }; });
    await f.next(); assert.equal(f.calls.timeouts.length, 0); assert.equal([...f.cases.values()][0].outcome, 'stale');
});

test('message overflow is kept for the next minute, not dropped or reviewed immediately', async () => {
    const f = fixture(); for (let i = 0; i < 65; i++) await f.queueMessage('a'.repeat(100));
    await f.next(); const firstCount = f.calls.reviews[0].input.new_messages.length;
    assert.ok(firstCount < 65); await f.system.tick(f.control); assert.equal(f.calls.reviews.length, 1);
    await f.next(); assert.equal(f.calls.reviews.length, 2);
    assert.ok((await f.store.loadPending('general')).length > 0);
    await f.next();
    assert.equal(f.calls.reviews.flatMap(({ input }) => input.new_messages).length, 65);
});

test('context includes earlier chat and replies without turning history into actionable messages', async () => {
    const f = fixture(); const old = f.message('Can you stop targeting me?', 'bob');
    const m = await f.queueMessage('A reply', 'alice', f.channel, { reference: { messageId: old.id } });
    await f.next(); const input = f.calls.reviews[0].input;
    assert.deepEqual(input.new_messages.map((m) => m.id), [m.id]); assert.equal(input.context_messages[0].id, old.id);
    assert.throws(() => validateCases({ cases: [f.decision(input, { user_id: 'bob', message_ids: [old.id] })] }, input.new_messages), /misattributed/);
});

test('failed model calls cause no punishment, keep the queue, back off and record usage', async () => {
    const f = fixture(); await f.queueMessage('Hello');
    f.setReview(async () => { throw Object.assign(new Error('Incomplete'), { usage: { output_tokens: 8192 } }); });
    await f.next(); assert.equal(f.calls.timeouts.length, 0); assert.equal(f.calls.usage[0][2].output_tokens, 8192);
    assert.equal((await f.store.loadPending('general')).length, 1);
    await f.next(); assert.equal(f.calls.reviews.length, 2);
    await f.next(); assert.equal(f.calls.reviews.length, 2);
    await f.next(); assert.equal(f.calls.reviews.length, 3);
    f.advance(20 * 60_000); await f.system.tick(f.control); assert.equal(f.calls.reviews.length, 3);
});

test('misattributed model evidence rejects the entire response before any action', async () => {
    const f = fixture(); f.flag({ user_id: 'bob' }); await f.queueMessage('Hello', 'alice'); await f.next();
    assert.equal(f.cases.size, 0); assert.equal(f.calls.timeouts.length, 0);
});

test('overlapping cycles share one request and stop aborts in-flight work without punishment', async () => {
    const f = fixture(); await f.queueMessage('Hello'); let started;
    const ready = new Promise((resolve) => { started = resolve; });
    f.setReview((_input, { signal }) => new Promise((_resolve, reject) => {
        started(); signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
    }));
    const tick = f.system.tick(f.control); await ready; const duplicate = f.system.tick(f.control);
    assert.equal(f.calls.reviews.length, 1); await f.system.stop(); await Promise.all([tick, duplicate]);
    assert.equal(f.calls.timeouts.length, 0); assert.equal((await f.store.loadPending('general')).length, 1);
});

test('deployment pause aborts reviews without consuming retries, and resume keeps queued evidence', async () => {
    const f = fixture();
    await f.queueMessage('Hello');
    let started;
    const ready = new Promise((resolve) => { started = resolve; });
    f.setReview((_input, { signal }) => new Promise((_resolve, reject) => {
        started(); signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
    }));
    const tick = f.system.tick(f.control); await ready;
    await f.system.pause(); await tick;
    assert.equal(f.calls.timeouts.length, 0);
    assert.equal(f.calls.logs.length, 0);
    assert.equal([...f.queue.values()][0].attempts, 0);
    await f.system.tick(f.control); assert.equal(f.calls.reviews.length, 1);
    f.setReview(async () => ({ cases: [], usage: {} }));
    f.system.resume(); await f.next();
    assert.equal(f.calls.reviews.length, 2);
    assert.equal((await f.store.loadPending('general')).length, 0);
});

test('a restarted worker recovers queued messages without reviewing idle channels', async () => {
    const f = fixture(); await f.queueMessage('Hello'); await f.system.stop();
    const replacement = createModerationSystem(f.client, f.options); await replacement.tick(f.control);
    assert.equal(f.calls.reviews.length, 1); await replacement.tick(f.control); assert.equal(f.calls.reviews.length, 1);
});

test('a database failure after timeout recovers the same absolute timeout without extending it', async () => {
    const f = fixture(); f.flag(); await f.queueMessage('Abuse'); const original = f.store.updateCase;
    let fail = true; f.store.updateCase = async (id, patch) => { if (patch.outcome === 'timed_out' && fail) { fail = false; throw new Error('Database unavailable'); } return original(id, patch); };
    await f.next(); assert.equal(f.calls.timeouts.length, 1); assert.equal([...f.cases.values()][0].outcome, 'pending');
    await f.next(); assert.equal(f.calls.timeouts.length, 1); assert.equal([...f.cases.values()][0].outcome, 'timed_out');
});

test('notification failures are retried without applying the timeout again', async () => {
    const f = fixture(); f.flag(); await f.system.ensure(f.control); const send = f.log().send;
    let fail = true; f.log().send = async function(payload) { if (payload.nonce && fail) { fail = false; throw new Error('Discord unavailable'); } return send.call(this, payload); };
    await f.queueMessage('Abuse'); await f.next(); await f.next();
    assert.equal(f.calls.timeouts.length, 1); assert.ok([...f.cases.values()][0].log_message_id);
    assert.equal(f.calls.logs.filter(({ payload }) => payload.nonce).length, 1);
});

function interactionFor(f, user = 'mod', action = 'dismiss') {
    const entry = [...f.cases.values()][0]; const log = f.calls.logs.find(({ message }) => message.id === entry.log_message_id);
    const replies = [];
    return { isButton: () => true, customId: `ai_mod:${action}:${entry.id}`, user: { id: user }, guildId: f.guild.id,
        channelId: f.log().id, message: log.message, async deferReply() {}, async editReply(text) { replies.push(text); }, replies };
}

test('moderators can dismiss and undo the exact bot timeout; ordinary members cannot', async () => {
    const f = fixture(); f.flag(); await f.queueMessage('Abuse'); await f.next();
    const denied = interactionFor(f, 'bob'); await f.system.handleInteraction(denied);
    assert.match(denied.replies[0], /Only moderators/); assert.equal(f.calls.timeouts.length, 1);
    const approved = interactionFor(f); await f.system.handleInteraction(approved);
    assert.equal(f.calls.timeouts.length, 2); assert.equal(f.calls.timeouts[1].until, null);
    assert.equal([...f.cases.values()][0].dismissed_by, 'mod');
    assert.equal((await f.store.recentCases('guild', ['alice'])).length, 0);
});

test('dismissing an AI case never removes a different timeout imposed afterwards', async () => {
    const f = fixture(); f.flag(); await f.queueMessage('Abuse'); await f.next();
    f.members.get('alice').communicationDisabledUntilTimestamp = f.now() + 86_400_000;
    const interaction = interactionFor(f); await f.system.handleInteraction(interaction);
    assert.equal(f.calls.timeouts.length, 1); assert.match(interaction.replies[0], /left in place/);
});

test('review buttons are bound to the logged case, channel and guild', async () => {
    const f = fixture(); f.flag(); await f.queueMessage('Abuse'); await f.next();
    const interaction = interactionFor(f); interaction.channelId = 'another-channel'; await f.system.handleInteraction(interaction);
    assert.equal(f.calls.timeouts.length, 1); assert.match(interaction.replies[0], /could not be verified/);
});

test('disabled configuration and missing API keys never send requests', async () => {
    for (const patch of [{ enabled: false }, { apiKey: '' }]) {
        const f = fixture(); Object.assign(f.config, patch); await f.queueMessage('Hello'); await f.next();
        assert.equal(f.calls.reviews.length, 0); assert.equal(f.queue.size, 0);
    }
});

test('missing moderator role prevents setup and automatic moderation', async () => {
    const f = fixture(); f.guild.roles.cache.delete('staff');
    await f.system.ensure(f.control); assert.match(f.system.getError(), /moderator\/Staff/);
    await f.queueMessage('Hello'); await f.next(); assert.equal(f.calls.reviews.length, 0);
});

test('no evidence is published or timeout applied if the log becomes public', async () => {
    const f = fixture(); await f.system.ensure(f.control); f.flag(); await f.queueMessage('Abuse');
    await f.log().permissionOverwrites.set([]); await f.next();
    assert.equal(f.calls.timeouts.length, 0); assert.equal(f.calls.logs.length, 0);
    await f.system.ensure(f.control, { force: true }); await f.next(); assert.equal(f.calls.timeouts.length, 1);
});

test('old queued evidence is sent for human review instead of a delayed automatic timeout', async () => {
    const f = fixture(); f.flag(); await f.queueMessage('Abuse'); f.advance(11 * 60_000); await f.system.tick(f.control);
    assert.equal(f.calls.timeouts.length, 0); assert.equal([...f.cases.values()][0].outcome, 'review_only');
});

test('repeat offences escalate but dismissed cases do not contribute', async () => {
    const f = fixture(); f.flag(); await f.queueMessage('Abuse'); await f.next();
    f.members.get('alice').communicationDisabledUntilTimestamp = null;
    await f.queueMessage('More abuse'); await f.next();
    assert.equal(Number(f.calls.timeouts[1].until), f.now() + 30 * 60_000);
    for (const entry of f.cases.values()) entry.dismissed_by = 'mod';
    f.members.get('alice').communicationDisabledUntilTimestamp = null;
    await f.queueMessage('Another offence'); await f.next();
    assert.equal(Number(f.calls.timeouts[2].until), f.now() + 10 * 60_000);
});

test('worst-case escaped evidence stays within Discord embed limits', () => {
    const evidence = Array.from({ length: 50 }, (_, i) => ({ id: String(100000000000000000n + BigInt(i)), timestamp: '2026-09-12T12:00:00.000Z', content: '*'.repeat(4000) }));
    const entry = { id: 'f'.repeat(24), guild_id: '1'.repeat(19), channel_id: '2'.repeat(19), user_id: '3'.repeat(19),
        evidence, reason: '*'.repeat(700), category: 'personal_attack', confidence: 'high', result: 'X'.repeat(1000),
        outcome: 'timed_out', timeout_until: evidence[0].timestamp, needs_review: true };
    const embed = buildCasePayload(entry, ['staff']).embeds[0].toJSON();
    assert.ok(embed.fields.every((field) => field.value.length <= 1024));
    const size = embed.title.length + embed.description.length + embed.footer.text.length + embed.fields.reduce((total, field) => total + field.name.length + field.value.length, 0);
    assert.ok(size <= 6000);
});

test('API uses only Luna/high, bounded reasoning, strict structured output and no stored conversations', async () => {
    const f = fixture(); const input = buildReviewInput([snapshotMessage(f.message('Hello'))]); let body;
    const result = await reviewConversation(input, { apiKey: 'test', fetchImpl: async (_url, options) => {
        body = JSON.parse(options.body);
        return { ok: true, status: 200, async json() { return { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"cases":[]}' }] }], usage: { output_tokens: 300 } }; } };
    } });
    assert.equal(body.model, 'gpt-5.6-luna'); assert.equal(body.reasoning.effort, 'high'); assert.equal(body.store, false);
    assert.equal(body.text.format.strict, true); assert.equal(body.max_output_tokens, 8192); assert.equal(body.tools, undefined);
    assert.deepEqual(result.cases, []); assert.equal(result.usage.output_tokens, 300);
});

test('incomplete, refused, malformed and HTTP error responses cannot produce a decision', async () => {
    const f = fixture(); const input = buildReviewInput([snapshotMessage(f.message('Hello'))]);
    for (const payload of [
        { status: 'incomplete', output: [], usage: { output_tokens: 8192 } },
        { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No' }] }] },
        { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'not JSON' }] }] }
    ]) {
        await assert.rejects(reviewConversation(input, { apiKey: 'test', fetchImpl: async () => ({ ok: true, status: 200, json: async () => payload }) }));
    }
    await assert.rejects(reviewConversation(input, { apiKey: 'test', fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }) }), /HTTP 429/);
});
