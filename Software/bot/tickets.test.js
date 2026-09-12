const test = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType, Collection } = require('discord.js');
const ticketStore = require('../api/_lib/discord-ticket-store');

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
    const guild = { id: 'guild', members: { me: { id: 'bot' } }, roles: { everyone: { id: 'guild' }, cache: new Collection([['staff', {}]]) },
        channels: { async fetch() { return category; }, async create(options) { created.push(options); return channel; } } };
    const channel = { id: 'ticket-channel', guild, toString: () => '<#ticket-channel>', async send(payload) { sent.push(payload); return { async delete() {} }; } };
    const interaction = { guild, channelId: 'panel', user: { id: 'user', username: 'User' }, customId: 'rodark_ticket_issue_modal',
        isButton: () => false, isModalSubmit: () => true, fields: { getTextInputValue: () => 'Please help with my missing game pass.' },
        async deferReply(options) { assert.equal(options.ephemeral, true); }, async editReply(payload) { replies.push(payload); } };
    assert.equal(await handleTicketInteraction(interaction, { ticketSystem: { categoryChannelId: 'category', panelChannelId: 'panel', helperRoleIds: ['staff'] } }), true);
    assert.equal(created[0].name, 'ticket-42'); assert.equal(created[0].parent, 'category');
    assert.equal(records[0].openerUserId, 'user'); assert.equal(globalThis.fetch.mock.callCount(), 0);
    assert.match(sent[1].embeds[0].toJSON().description, /missing game pass/);
    assert.equal(replies[0].embeds[0].toJSON().title, 'Ticket');
});
