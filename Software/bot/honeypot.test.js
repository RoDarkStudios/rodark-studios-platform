const test = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType, Collection, MessageType, PermissionsBitField, PermissionFlagsBits: P } = require('discord.js');
const { createHoneypotSystem } = require('./honeypot');

function fixture() {
    let sequence = 100;
    let saved = null;
    const banEvents = new Map();
    const calls = { bans: [], creates: [], sends: [], edits: [], deletes: [], fetchMembers: [] };
    const store = {
        async getState() { return saved ? { ...saved, banCount: banEvents.size } : null; },
        async saveState(guildId, channelId, warningMessageId) { saved = { channelId, warningMessageId }; },
        async recordBan(message) { banEvents.set(message.id, message.author.id); }
    };
    const client = { user: { id: 'bot' }, isReady: () => true, guilds: { cache: new Collection() } };
    const me = { permissions: new PermissionsBitField(PermissionsBitField.All) };
    const guild = {
        id: 'guild', name: 'Test server', ownerId: 'owner',
        members: {
            me,
            async fetchMe() { return me; },
            async fetch(options) { calls.fetchMembers.push(options); return { bannable: true }; },
            async ban(id, options) { calls.bans.push({ id, options }); }
        },
        channels: {
            cache: new Collection(),
            async fetch() { return this.cache; },
            async create(options) {
                calls.creates.push(options);
                return makeChannel(options);
            }
        }
    };
    client.guilds.cache.set(guild.id, guild);
    const control = { guildId: guild.id };

    function makeChannel(options) {
        const channel = {
            id: `channel-${++sequence}`, guild, name: options.name, type: options.type,
            parentId: options.parent || null, topic: options.topic || null,
            position: options.position || 0, rawPosition: options.position || 0,
            nsfw: options.nsfw || false, rateLimitPerUser: options.rateLimitPerUser || 0,
            isThread: () => false,
            permissionsFor: () => me.permissions,
            permissionOverwrites: {
                cache: new Collection(),
                async set(overwrites) { setOverwrites(overwrites); }
            },
            messages: {
                cache: new Collection(),
                async fetch(idOrOptions) {
                    if (typeof idOrOptions === 'object') return this.cache;
                    if (!this.cache.has(idOrOptions)) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
                    return this.cache.get(idOrOptions);
                }
            },
            async edit(changes) {
                calls.edits.push(changes);
                Object.assign(this, changes);
                if (changes.parent) this.parentId = changes.parent;
                if (changes.permissionOverwrites) {
                    this.permissionOverwrites = overwriteManager;
                    setOverwrites(changes.permissionOverwrites);
                }
                return this;
            },
            async setPosition(position) { this.position = this.rawPosition = position; return this; },
            async send(payload) {
                calls.sends.push({ payload, overwrites: this.permissionOverwrites.cache.clone() });
                const warning = {
                    id: `warning-${++sequence}`, author: client.user, embeds: payload.embeds,
                    components: payload.components, pinned: false,
                    async edit(nextPayload) {
                        this.embeds = nextPayload.embeds;
                        this.components = nextPayload.components;
                        return this;
                    },
                    async pin() { throw new Error('The honeypot warning must not be pinned'); },
                    async unpin() { this.pinned = false; return this; }
                };
                // Discord returns Embed instances, with .footer rather than Builder .data.
                Object.defineProperty(warning, 'embeds', {
                    get() { return this._embeds; },
                    set(embeds) { this._embeds = embeds.map((embed) => embed.toJSON ? embed.toJSON() : embed); }
                });
                warning.embeds = payload.embeds;
                this.messages.cache.set(warning.id, warning);
                return warning;
            }
        };
        const overwriteManager = channel.permissionOverwrites;
        function setOverwrites(overwrites) {
            channel.permissionOverwrites.cache = new Collection(overwrites.map((overwrite) => [overwrite.id, {
                id: overwrite.id, type: overwrite.type,
                allow: new PermissionsBitField(overwrite.allow), deny: new PermissionsBitField(overwrite.deny)
            }]));
        }
        setOverwrites(options.permissionOverwrites || []);
        guild.channels.cache.set(channel.id, channel);
        return channel;
    }

    const system = createHoneypotSystem(client, { store });
    const trap = () => guild.channels.cache.find((channel) => channel.type === ChannelType.GuildText);
    function message(overrides = {}) {
        const channel = overrides.channel || trap();
        return {
            id: `message-${++sequence}`, guild, channel, channelId: channel.id,
            author: { id: 'member', bot: false }, content: '', system: false,
            attachments: new Collection([['image', { name: 'screenshot.png' }]]),
            async delete() { calls.deletes.push(this.id); },
            ...overrides
        };
    }
    const countLabel = () => trap().messages.cache.get(saved.warningMessageId).components[0].toJSON().components[0].label;
    return { client, guild, me, control, store, system, calls, banEvents, trap, message, makeChannel, countLabel };
}

test('creates a clearly marked trap near the top, warns before opening, and allows files and previews', async () => {
    const f = fixture();
    await f.system.ensure(f.control);
    assert.deepEqual(f.calls.creates.map((entry) => entry.type), [ChannelType.GuildCategory, ChannelType.GuildText]);
    assert.equal(f.calls.creates[0].name, 'IGNORE');
    assert.equal(f.calls.creates[0].position, 1);
    assert.equal(f.trap().name, 'ignore│do-not-type');
    assert.equal(f.calls.sends[0].overwrites.get(f.guild.id).deny.has(P.SendMessages), true);
    const permissions = f.trap().permissionOverwrites.cache.get(f.guild.id);
    assert.equal(permissions.allow.has([P.ViewChannel, P.ReadMessageHistory, P.SendMessages, P.AttachFiles, P.EmbedLinks]), true);
    assert.equal(permissions.deny.has([P.MentionEveryone, P.CreatePublicThreads, P.CreatePrivateThreads, P.SendMessagesInThreads]), true);
    assert.equal(f.countLabel(), 'Bans: 0');
    assert.match(f.calls.sends[0].payload.embeds[0].toJSON().description, /accidental message/);
    assert.deepEqual(f.calls.sends[0].payload.allowedMentions, { parse: [] });
});

test('adopts separator variants and removes category/member/level permission conflicts only in the trap', async () => {
    const f = fixture();
    const existing = f.makeChannel({
        name: 'ignore | do-not-type', type: ChannelType.GuildText, nsfw: true, rateLimitPerUser: 60,
        permissionOverwrites: [
            { id: 'level-role', type: 0, allow: [], deny: [P.EmbedLinks, P.AttachFiles] },
            { id: 'member', type: 1, allow: [], deny: [P.ViewChannel, P.SendMessages] }
        ]
    });
    const other = f.makeChannel({ name: 'media', type: ChannelType.GuildText, permissionOverwrites: [
        { id: f.guild.id, type: 0, allow: [], deny: [P.EmbedLinks] }
    ] });
    await f.system.ensure(f.control);
    assert.equal(f.calls.creates.length, 1); // Category only; reuses the channel.
    assert.equal(existing.permissionOverwrites.cache.size, 2);
    assert.equal(existing.nsfw, false);
    assert.equal(existing.rateLimitPerUser, 0);
    assert.equal(other.permissionOverwrites.cache.get(f.guild.id).deny.has(P.EmbedLinks), true);
});

test('repeated and concurrent syncs do not create duplicate channels or warnings', async () => {
    const f = fixture();
    await Promise.all([f.system.ensure(f.control), f.system.ensure(f.control)]);
    await f.system.ensure(f.control, { force: true });
    assert.equal(f.calls.creates.length, 2);
    assert.equal(f.calls.sends.length, 1);
});

test('legacy warning pins and their bot notices are removed while the warning and other messages are retained', async () => {
    const f = fixture();
    await f.system.ensure(f.control);
    const warning = f.trap().messages.cache.first();
    assert.equal(warning.pinned, false);
    warning.pinned = true;
    const notice = f.message({ type: MessageType.ChannelPinnedMessage, author: f.client.user, reference: { messageId: warning.id } });
    const unrelated = f.message({ type: MessageType.ChannelPinnedMessage, author: f.client.user, reference: { messageId: 'another-message' } });
    const ownerNotice = f.message({ type: MessageType.ChannelPinnedMessage, author: { id: 'owner' }, reference: { messageId: warning.id } });
    for (const message of [notice, unrelated, ownerNotice]) f.trap().messages.cache.set(message.id, message);
    const restarted = createHoneypotSystem(f.client, { store: f.store });
    await restarted.ensure(f.control);
    assert.equal(warning.pinned, false);
    assert.deepEqual(f.calls.deletes, [notice.id]);
    assert.equal(f.calls.sends.length, 1);
    assert.equal(f.trap().messages.cache.get(warning.id), warning);
    assert.equal(f.countLabel(), 'Bans: 0');
});

test('an attachment-only message is banned without reading message content and increments the counter', async () => {
    const f = fixture();
    await f.system.ensure(f.control);
    const message = f.message();
    assert.equal(await f.system.handleMessage(message, f.control), true);
    assert.equal(f.calls.bans.length, 1);
    assert.equal(f.calls.bans[0].id, 'member');
    assert.equal(f.calls.bans[0].options.deleteMessageSeconds, 3600);
    assert.match(f.calls.bans[0].options.reason, new RegExp(message.id));
    assert.deepEqual(f.calls.fetchMembers, [{ user: 'member', force: true }]);
    assert.equal(f.countLabel(), 'Bans: 1');
    assert.deepEqual(f.calls.deletes, [message.id]);
});

test('own messages, system notices, DMs and other channels/guilds do not ban; bot accounts do', async () => {
    const f = fixture();
    await f.system.ensure(f.control);
    await f.system.handleMessage(f.message({ author: f.client.user }), f.control);
    await f.system.handleMessage(f.message({ system: true }), f.control);
    assert.equal(await f.system.handleMessage(f.message({ guild: null }), f.control), false);
    assert.equal(await f.system.handleMessage(f.message({ channelId: 'general' }), f.control), false);
    assert.equal(await f.system.handleMessage(f.message(), { guildId: 'other' }), false);
    assert.equal(f.calls.bans.length, 0);
    await f.system.handleMessage(f.message({ author: { id: 'other-bot', bot: true } }), f.control);
    assert.equal(f.calls.bans[0].id, 'other-bot');
});

test('webhook messages are deleted and reported without banning the webhook ID', async () => {
    const f = fixture();
    await f.system.ensure(f.control);
    const message = f.message({ webhookId: 'hook', author: { id: 'hook', bot: true } });
    await assert.rejects(f.system.handleMessage(message, f.control), /webhook hook/);
    assert.equal(f.calls.bans.length, 0);
    assert.deepEqual(f.calls.deletes, [message.id]);
    assert.equal(f.countLabel(), 'Bans: 0');
});

test('concurrent spam from one account produces one ban and count; later duplicates are removed', async () => {
    const f = fixture();
    await f.system.ensure(f.control);
    await Promise.all(Array.from({ length: 5 }, () => f.system.handleMessage(f.message(), f.control)));
    await f.system.handleMessage(f.message(), f.control);
    assert.equal(f.calls.bans.length, 1);
    assert.equal(f.banEvents.size, 1);
    assert.equal(f.countLabel(), 'Bans: 1');
});

test('concurrent bans of different accounts preserve the displayed count', async () => {
    const f = fixture();
    await f.system.ensure(f.control);
    await Promise.all(['one', 'two', 'three'].map((id) => f.system.handleMessage(f.message({ author: { id } }), f.control)));
    assert.equal(f.calls.bans.length, 3);
    assert.equal(f.countLabel(), 'Bans: 3');
});

test('hierarchy/ban failures are surfaced, remove the trigger, do not count, and allow a retry', async () => {
    const f = fixture();
    await f.system.ensure(f.control);
    f.guild.members.fetch = async () => ({ bannable: false });
    await assert.rejects(f.system.handleMessage(f.message(), f.control), /role hierarchy/);
    assert.equal(f.calls.bans.length, 0);
    f.guild.members.fetch = async () => ({ bannable: true });
    f.guild.members.ban = async () => { throw new Error('Missing Permissions'); };
    await assert.rejects(f.system.handleMessage(f.message(), f.control), /Missing Permissions/);
    assert.equal(f.calls.deletes.length, 2);
    assert.equal(f.banEvents.size, 0);
    f.guild.members.ban = async () => {};
    await f.system.handleMessage(f.message(), f.control);
    assert.equal(f.countLabel(), 'Bans: 1');
});

test('an account that leaves immediately after posting is still banned by ID', async () => {
    const f = fixture();
    await f.system.ensure(f.control);
    f.guild.members.fetch = async () => { throw Object.assign(new Error('Unknown Member'), { code: 10007 }); };
    await f.system.handleMessage(f.message(), f.control);
    assert.equal(f.calls.bans.length, 1);
});

test('database failure does not stop the ban and duplicate messages do not repeat the ban', async () => {
    const f = fixture();
    await f.system.ensure(f.control);
    const recordBan = f.store.recordBan;
    f.store.recordBan = async () => { throw new Error('Database unavailable'); };
    await assert.rejects(f.system.handleMessage(f.message(), f.control), /Database unavailable/);
    await f.system.handleMessage(f.message(), f.control);
    assert.equal(f.calls.bans.length, 1);
    f.store.recordBan = recordBan;
    await f.system.ensure(f.control);
    assert.equal(f.calls.bans.length, 1);
    assert.equal(f.countLabel(), 'Bans: 1');
});

test('all concurrent triggers are cleaned up when the ban is blocked', async () => {
    const f = fixture();
    await f.system.ensure(f.control);
    f.guild.members.ban = async () => { throw new Error('Forbidden'); };
    const results = await Promise.allSettled(Array.from({ length: 3 }, () => f.system.handleMessage(f.message(), f.control)));
    assert.equal(results.every((result) => result.status === 'rejected'), true);
    assert.equal(f.calls.deletes.length, 3);
    assert.equal(f.countLabel(), 'Bans: 0');
});

test('missing permissions or warning failure prevents initial activation', async () => {
    const f = fixture();
    f.me.permissions.remove(P.Administrator, P.BanMembers);
    await assert.rejects(f.system.ensure(f.control), /BanMembers/);
    assert.equal(f.calls.creates.length, 0);
    f.me.permissions.add(P.BanMembers);
    const trap = f.makeChannel({ name: 'ignore-do-not-type', type: ChannelType.GuildText });
    trap.send = async () => { throw new Error('Cannot send warning'); };
    await assert.rejects(f.system.ensure(f.control), /Cannot send warning/);
    await f.system.handleMessage(f.message(), f.control);
    assert.equal(f.calls.bans.length, 0);
});

test('restart and deleted channel/warning recovery retain the successful-ban count', async () => {
    const f = fixture();
    await f.system.ensure(f.control);
    await f.system.handleMessage(f.message(), f.control);
    const restarted = createHoneypotSystem(f.client, { store: f.store });
    await restarted.ensure(f.control);
    assert.equal(f.calls.sends.length, 1);
    assert.equal(f.countLabel(), 'Bans: 1');
    f.trap().messages.cache.clear();
    await restarted.ensure(f.control, { force: true });
    assert.equal(f.calls.sends.length, 2);
    assert.equal(f.countLabel(), 'Bans: 1');
    f.guild.channels.cache.delete(f.trap().id);
    await restarted.ensure(f.control, { force: true });
    assert.equal(f.calls.creates.length, 3);
    assert.equal(f.countLabel(), 'Bans: 1');
});

test('thread messages trigger the parent trap but name lookalikes outside its saved ID do not', async () => {
    const f = fixture();
    await f.system.ensure(f.control);
    const lookalike = f.makeChannel({ name: 'ignore│do-not-type', type: ChannelType.GuildText });
    assert.equal(await f.system.handleMessage(f.message({ channel: lookalike }), f.control), false);
    const thread = { id: 'thread', parentId: f.trap().id, isThread: () => true };
    await f.system.handleMessage(f.message({ channel: thread }), f.control);
    assert.equal(f.calls.bans.length, 1);
});

test('ambiguous existing trap names fail before changing channels', async () => {
    const f = fixture();
    f.makeChannel({ name: 'ignore│do-not-type', type: ChannelType.GuildText });
    f.makeChannel({ name: 'ignore-do-not-type', type: ChannelType.GuildText });
    await assert.rejects(f.system.ensure(f.control), /multiple/);
    assert.equal(f.calls.creates.length, 0);
    assert.equal(f.calls.sends.length, 0);
});

test('warning retrieval errors do not create duplicates and spoofed warning authors are not edited', async () => {
    const f = fixture();
    await f.system.ensure(f.control);
    const messages = f.trap().messages;
    const fetch = messages.fetch;
    messages.fetch = async () => { throw Object.assign(new Error('Forbidden'), { code: 50013 }); };
    await assert.rejects(f.system.ensure(f.control, { force: true }), /Forbidden/);
    assert.equal(f.calls.sends.length, 1);
    messages.fetch = fetch;
    messages.cache.first().author = { id: 'someone-else' };
    await f.system.ensure(f.control, { force: true });
    assert.equal(f.calls.sends.length, 2);
});
