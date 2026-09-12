const test = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType, Collection } = require('discord.js');
const ticketStore = require('../api/_lib/discord-ticket-store');
const { controlWithLayout } = require('./server-infrastructure');
const { manifest } = require('./server-blueprint');

test('ordinary tickets open privately and preserve their description without any AI request', async (t) => {
    const records = [], sent = [], created = [], replies = [];
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('Ticket handling must not call an AI or other HTTP endpoint'); });
    t.mock.method(globalThis, 'setTimeout', () => ({ unref() {} }));
    t.mock.method(ticketStore, 'getOpenDiscordTicketForUser', async () => null);
    t.mock.method(ticketStore, 'reserveDiscordTicketId', async () => 42);
    t.mock.method(ticketStore, 'createDiscordTicketRecord', async (record) => records.push(record));
    delete require.cache[require.resolve('./tickets')];
    const { handleTicketInteraction } = require('./tickets');
    const category = { id: 'category', type: ChannelType.GuildCategory };
    const guild = { id: 'guild', members: { me: { id: 'bot' } }, roles: { everyone: { id: 'guild' }, cache: new Collection([['staff', {}], ['owner', {}]]) },
        channels: { async fetch() { return category; }, async create(options) { created.push(options); return channel; } } };
    const channel = { id: 'ticket-channel', guild, toString: () => '<#ticket-channel>', async send(payload) { sent.push(payload); return { async delete() {} }; } };
    const interaction = { guild, channelId: 'panel', user: { id: 'user', username: 'User' }, customId: 'rodark_ticket_issue_modal',
        isButton: () => false, isModalSubmit: () => true, fields: { getTextInputValue: () => 'Please help with my missing game pass.' },
        async deferReply(options) { assert.equal(options.ephemeral, true); }, async editReply(payload) { replies.push(payload); } };
    const control = controlWithLayout({}, { spec: manifest, bindings: {
        channel: { 'category:tickets': 'category', help: 'panel' }, role: { staff: 'staff', owner: 'owner' }
    } });
    assert.equal(await handleTicketInteraction(interaction, control), true);
    assert.equal(created[0].name, 'ticket-42'); assert.equal(created[0].parent, 'category');
    assert.equal(records[0].openerUserId, 'user'); assert.equal(globalThis.fetch.mock.callCount(), 0);
    assert.match(sent[0].content, /<@&staff>/);
    assert.match(sent[0].content, /<@&owner>/);
    assert.deepEqual(sent[0].allowedMentions.roles, ['staff', 'owner']);
    assert.ok(created[0].permissionOverwrites.some(overwrite => overwrite.id === 'staff'));
    assert.ok(created[0].permissionOverwrites.some(overwrite => overwrite.id === 'owner'));
    assert.match(sent[1].embeds[0].toJSON().description, /missing game pass/);
    assert.equal(replies[0].embeds[0].toJSON().title, 'Ticket');
});

test('help panel refreshes in its deployed channel and points to the declared game forums', async () => {
    const { ensureTicketPanel } = require('./tickets');
    const edited = [];
    const guild = { id: manifest.guildId };
    const panel = { type: ChannelType.GuildText, guild, messages: { fetch: async () => ({ editable: true, edit: async payload => edited.push(payload) }) } };
    const category = { type: ChannelType.GuildCategory, guild };
    const channel = { help: 'help-channel', 'category:tickets': 'ticket-category' };
    manifest.games.forEach((game, index) => { channel[`${game.key}/bug-reports`] = String(300000000000000000n + BigInt(index)); });
    const control = controlWithLayout({ ticketSystem: { panelMessageId: 'existing-message' } }, {
        spec: manifest, bindings: { channel, role: { staff: 'staff', owner: 'owner' } }
    });
    const client = { channels: { fetch: async id => {
        assert.ok(['help-channel', 'ticket-category'].includes(id));
        return id === 'help-channel' ? panel : category;
    } } };
    await ensureTicketPanel(client, control);
    assert.equal(edited.length, 1);
    const description = edited[0].embeds[0].toJSON().description;
    manifest.games.forEach(game => assert.ok(description.includes(channel[`${game.key}/bug-reports`])));
    assert.ok(!description.includes('1208767046184345610'));
});
