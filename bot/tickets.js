const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    EmbedBuilder,
    ModalBuilder,
    PermissionFlagsBits,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');
const { setDiscordTicketPanelMessageId } = require('../api/_lib/discord-bot-control-store');
const {
    closeDiscordTicketRecord,
    createDiscordTicketRecord,
    getOpenDiscordTicketForUser,
    reserveDiscordTicketId,
    saveDiscordTicketTranscript
} = require('../api/_lib/discord-ticket-store');

const OPEN_TICKET_CUSTOM_ID = 'rodark_ticket_open';
const CLOSE_TICKET_CUSTOM_ID = 'rodark_ticket_close';
const TICKET_ISSUE_MODAL_CUSTOM_ID = 'rodark_ticket_issue_modal';
const TICKET_ISSUE_INPUT_CUSTOM_ID = 'rodark_ticket_issue';
const BUG_REPORT_CHANNEL_ID = '1208767046184345610';
const TICKET_OPEN_PING_DELETE_DELAY_MS = 1500;
const TICKET_CLOSE_DELETE_DELAY_MS = 1000;
const TICKET_TRANSCRIPT_FETCH_LIMIT = 100;
const pendingTicketOpenUserKeys = new Set();

function getTicketSystemControl(control) {
    const ticketSystem = control && control.ticketSystem && typeof control.ticketSystem === 'object'
        ? control.ticketSystem
        : {};

    return {
        categoryChannelId: ticketSystem.categoryChannelId ? String(ticketSystem.categoryChannelId) : '',
        panelChannelId: ticketSystem.panelChannelId ? String(ticketSystem.panelChannelId) : '',
        panelMessageId: ticketSystem.panelMessageId ? String(ticketSystem.panelMessageId) : '',
        helperRoleIds: Array.isArray(ticketSystem.helperRoleIds)
            ? ticketSystem.helperRoleIds.map((roleId) => String(roleId)).filter(Boolean)
            : []
    };
}

function buildTicketPanelPayload() {
    const embed = new EmbedBuilder()
        .setTitle('Open a Ticket')
        .setColor(0xf97316)
        .setDescription([
            'Need direct help from RoDark Studios staff? Open a private ticket and describe what you need.',
            'Tickets are for community and player support only.',
            '',
            '**Do not open tickets for:**',
            '- Acquisition, buyout, investment, partnership, or deal offers. RoDark Studios is not looking for or open to these.',
            '- Discord staff applications. We are not hiring Discord staff.',
            '- Game developer applications. We are not hiring developers.',
            '',
            `⚠️ For bug reports, use <#${BUG_REPORT_CHANNEL_ID}> instead. They will be read even if developers are currently busy.`
        ].join('\n'));

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(OPEN_TICKET_CUSTOM_ID)
            .setEmoji('📩')
            .setLabel('Open Ticket')
            .setStyle(ButtonStyle.Primary)
    );

    return {
        content: '',
        embeds: [embed],
        components: [row]
    };
}

function buildTicketIssueModal() {
    const issueInput = new TextInputBuilder()
        .setCustomId(TICKET_ISSUE_INPUT_CUSTOM_ID)
        .setLabel('What do you need help with?')
        .setPlaceholder('No acquisition/deal offers, hiring requests, or bug reports. Describe the support issue.')
        .setStyle(TextInputStyle.Paragraph)
        .setMinLength(20)
        .setMaxLength(1000)
        .setRequired(true);

    return new ModalBuilder()
        .setCustomId(TICKET_ISSUE_MODAL_CUSTOM_ID)
        .setTitle('Open a Ticket')
        .addComponents(new ActionRowBuilder().addComponents(issueInput));
}

function normalizeTicketIssue(value) {
    return String(value || '').trim().replace(/\r\n/g, '\n');
}

function getTicketOpenUserKey(guildId, userId) {
    return `${String(guildId)}:${String(userId)}`;
}

function buildTicketWelcomePayload(openerLabel, issueDescription) {
    const embed = new EmbedBuilder()
        .setTitle('Support Ticket')
        .setColor(0x22d3ee)
        .setDescription([
            `${openerLabel || 'A member'} opened this ticket.`,
            '',
            'Thank you for contacting support.',
            '',
            '**Issue**',
            issueDescription || 'No issue description provided.',
            '',
            'Please add any images or extra details here, then wait for a response.'
        ].join('\n'));

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(CLOSE_TICKET_CUSTOM_ID)
            .setEmoji('🔒')
            .setLabel('Close')
            .setStyle(ButtonStyle.Danger)
    );

    return {
        content: '',
        embeds: [embed],
        components: [row],
        allowedMentions: { parse: [] }
    };
}

async function sendTemporaryTicketOpenPing(ticketChannel, openerUserId, helperRoleIds) {
    const roleMentions = (Array.isArray(helperRoleIds) ? helperRoleIds : [])
        .map((roleId) => String(roleId || '').trim())
        .filter((roleId) => roleId && ticketChannel.guild.roles.cache.has(roleId))
        .map((roleId) => `<@&${roleId}>`);
    const mentionParts = [`<@${openerUserId}>`, ...roleMentions];
    const pingMessage = await ticketChannel.send({
        content: mentionParts.join(' '),
        allowedMentions: {
            users: [String(openerUserId)],
            roles: (Array.isArray(helperRoleIds) ? helperRoleIds : []).map((roleId) => String(roleId)).filter(Boolean)
        }
    }).catch((error) => {
        console.error('Failed to send temporary ticket opener ping:', error);
        return null;
    });

    if (!pingMessage) {
        return;
    }

    setTimeout(() => {
        pingMessage.delete('Remove temporary ticket opener ping').catch((error) => {
            console.error('Failed to delete temporary ticket opener ping:', error);
        });
    }, TICKET_OPEN_PING_DELETE_DELAY_MS);
}

function buildTicketCreatedConfirmationPayload(ticketChannel) {
    const embed = new EmbedBuilder()
        .setTitle('Ticket')
        .setColor(0x22c55e)
        .setDescription(`Opened a new ticket: ${ticketChannel.toString()}`);

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setLabel('Go to Ticket')
            .setEmoji('🎫')
            .setStyle(ButtonStyle.Link)
            .setURL(`https://discord.com/channels/${ticketChannel.guild.id}/${ticketChannel.id}`)
    );

    return {
        content: '',
        embeds: [embed],
        components: [row]
    };
}

function buildExistingTicketPayload(ticketChannel) {
    const embed = new EmbedBuilder()
        .setTitle('Ticket Already Open')
        .setColor(0xf97316)
        .setDescription(`You already have an open ticket: ${ticketChannel.toString()}`);

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setLabel('Go to Ticket')
            .setEmoji('📩')
            .setStyle(ButtonStyle.Link)
            .setURL(`https://discord.com/channels/${ticketChannel.guild.id}/${ticketChannel.id}`)
    );

    return {
        content: '',
        embeds: [embed],
        components: [row]
    };
}

function buildTicketClosingComponents() {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(CLOSE_TICKET_CUSTOM_ID)
                .setEmoji('⏳')
                .setLabel('Closing')
                .setStyle(ButtonStyle.Danger)
                .setDisabled(true)
        )
    ];
}

function serializeMessageEmbed(embed) {
    return {
        title: embed.title || '',
        description: embed.description || '',
        url: embed.url || '',
        fields: Array.isArray(embed.fields)
            ? embed.fields.map((field) => ({
                name: field && field.name ? String(field.name) : '',
                value: field && field.value ? String(field.value) : ''
            }))
            : []
    };
}

function serializeTicketMessage(message) {
    return {
        id: String(message.id),
        createdAt: message.createdAt instanceof Date
            ? message.createdAt.toISOString()
            : new Date(Number(message.createdTimestamp) || Date.now()).toISOString(),
        authorId: message.author && message.author.id ? String(message.author.id) : '',
        authorTag: message.author && message.author.tag
            ? String(message.author.tag)
            : (message.author && message.author.username ? String(message.author.username) : 'Unknown'),
        bot: Boolean(message.author && message.author.bot),
        content: String(message.content || ''),
        attachments: Array.from(message.attachments ? message.attachments.values() : []).map((attachment) => ({
            id: String(attachment.id || ''),
            name: String(attachment.name || ''),
            url: String(attachment.url || ''),
            contentType: attachment.contentType ? String(attachment.contentType) : '',
            size: Number(attachment.size) || 0
        })),
        embeds: Array.isArray(message.embeds) ? message.embeds.map(serializeMessageEmbed) : []
    };
}

async function fetchTicketTranscriptMessages(channel) {
    const messages = [];
    let before;

    while (true) {
        const batch = await channel.messages.fetch({
            limit: TICKET_TRANSCRIPT_FETCH_LIMIT,
            before
        });

        if (!batch.size) {
            break;
        }

        messages.push(...Array.from(batch.values()).map(serializeTicketMessage));
        before = batch.last().id;

        if (batch.size < TICKET_TRANSCRIPT_FETCH_LIMIT) {
            break;
        }
    }

    return messages.sort((left, right) => {
        return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
    });
}

async function fetchGuildChannel(client, channelId, label) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) {
        throw new Error(`Configured ${label} ${channelId} could not be found`);
    }

    return channel;
}

async function ensureTicketPanel(client, control) {
    const ticketSystem = getTicketSystemControl(control);
    if (!ticketSystem.categoryChannelId || !ticketSystem.panelChannelId) {
        return;
    }

    const panelChannel = await fetchGuildChannel(client, ticketSystem.panelChannelId, 'ticket panel channel');
    if (panelChannel.type !== ChannelType.GuildText) {
        throw new Error(`Configured ticket panel channel ${ticketSystem.panelChannelId} is not a text channel`);
    }

    const categoryChannel = await fetchGuildChannel(client, ticketSystem.categoryChannelId, 'ticket category');
    if (categoryChannel.type !== ChannelType.GuildCategory) {
        throw new Error(`Configured ticket category ${ticketSystem.categoryChannelId} is not a category`);
    }

    if (!panelChannel.guild || !categoryChannel.guild || panelChannel.guild.id !== categoryChannel.guild.id) {
        throw new Error('Ticket panel channel and ticket category must belong to the same Discord server');
    }

    let panelMessage = null;
    if (ticketSystem.panelMessageId) {
        panelMessage = await panelChannel.messages.fetch(ticketSystem.panelMessageId).catch(() => null);
    }

    const payload = buildTicketPanelPayload();
    if (panelMessage && panelMessage.editable) {
        await panelMessage.edit(payload);
        return;
    }

    panelMessage = await panelChannel.send(payload);
    await setDiscordTicketPanelMessageId(panelMessage.id);
}

function permissionBits(flags) {
    return flags.reduce((bits, flag) => bits | BigInt(flag), 0n);
}

function buildTicketPermissionOverwrites(guild, categoryChannel, openerUserId, helperRoleIds) {
    const overwriteMap = new Map();

    function patchOverwrite(id, type, allowFlags, denyFlags) {
        const key = String(id);
        const current = overwriteMap.get(key) || {
            id: key,
            type,
            allow: 0n,
            deny: 0n
        };
        const allowBits = permissionBits(allowFlags || []);
        const denyBits = permissionBits(denyFlags || []);

        current.type = type;
        current.allow = (current.allow | allowBits) & ~denyBits;
        current.deny = (current.deny | denyBits) & ~allowBits;
        overwriteMap.set(key, current);
    }

    const viewAndReplyFlags = [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory
    ];

    patchOverwrite(guild.roles.everyone.id, 0, [], [PermissionFlagsBits.ViewChannel]);
    patchOverwrite(openerUserId, 1, [
        ...viewAndReplyFlags,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks
    ], []);
    const botUserId = guild.members.me && guild.members.me.id
        ? guild.members.me.id
        : categoryChannel.client.user.id;

    patchOverwrite(botUserId, 1, [
        ...viewAndReplyFlags,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageMessages
    ], []);

    helperRoleIds.forEach((roleId) => {
        if (guild.roles.cache.has(roleId)) {
            patchOverwrite(roleId, 0, viewAndReplyFlags, []);
        }
    });

    return Array.from(overwriteMap.values()).map((overwrite) => ({
        id: overwrite.id,
        type: overwrite.type,
        allow: overwrite.allow,
        deny: overwrite.deny
    }));
}

async function createTicketChannel(interaction, control, issueDescription) {
    const ticketSystem = getTicketSystemControl(control);
    if (!ticketSystem.categoryChannelId || !ticketSystem.panelChannelId) {
        await interaction.editReply('The ticket system is not configured yet.');
        return;
    }

    if (interaction.channelId !== ticketSystem.panelChannelId) {
        await interaction.editReply('Use the configured ticket panel channel to open a ticket.');
        return;
    }

    const categoryChannel = await interaction.guild.channels.fetch(ticketSystem.categoryChannelId).catch(() => null);
    if (!categoryChannel || categoryChannel.type !== ChannelType.GuildCategory) {
        await interaction.editReply('The configured ticket category could not be found.');
        return;
    }

    const ticketOpenUserKey = getTicketOpenUserKey(interaction.guild.id, interaction.user.id);
    if (pendingTicketOpenUserKeys.has(ticketOpenUserKey)) {
        await interaction.editReply('Your ticket request is already being processed.');
        return;
    }

    pendingTicketOpenUserKeys.add(ticketOpenUserKey);
    try {
        const existingTicket = await getOpenDiscordTicketForUser(interaction.guild.id, interaction.user.id);
        if (existingTicket) {
            const existingChannel = await interaction.guild.channels.fetch(existingTicket.channelId).catch(() => null);
            if (existingChannel && existingChannel.type === ChannelType.GuildText) {
                await interaction.editReply(buildExistingTicketPayload(existingChannel));
                return;
            }

            await closeDiscordTicketRecord(existingTicket.channelId, null);
        }

        const ticketId = await reserveDiscordTicketId();
        const channelName = `ticket-${ticketId}`;
        const permissionOverwrites = buildTicketPermissionOverwrites(
            interaction.guild,
            categoryChannel,
            interaction.user.id,
            ticketSystem.helperRoleIds
        );

        const ticketChannel = await interaction.guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: categoryChannel.id,
            permissionOverwrites,
            reason: `Ticket ${ticketId} opened by ${interaction.user.tag || interaction.user.id}`
        });

        try {
            await createDiscordTicketRecord({
                ticketId,
                guildId: interaction.guild.id,
                channelId: ticketChannel.id,
                openerUserId: interaction.user.id
            });
        } catch (error) {
            await ticketChannel.delete('Duplicate ticket prevented by one-open-ticket guard').catch(() => {});
            const duplicateTicket = await getOpenDiscordTicketForUser(interaction.guild.id, interaction.user.id);
            if (duplicateTicket) {
                const duplicateChannel = await interaction.guild.channels.fetch(duplicateTicket.channelId).catch(() => null);
                if (duplicateChannel && duplicateChannel.type === ChannelType.GuildText) {
                    await interaction.editReply(buildExistingTicketPayload(duplicateChannel));
                    return;
                }
            }

            throw error;
        }

        await sendTemporaryTicketOpenPing(ticketChannel, interaction.user.id, ticketSystem.helperRoleIds);
        await ticketChannel.send(buildTicketWelcomePayload(
            interaction.user.tag || interaction.user.username || 'A member',
            issueDescription
        ));
        await interaction.editReply(buildTicketCreatedConfirmationPayload(ticketChannel));
    } finally {
        pendingTicketOpenUserKeys.delete(ticketOpenUserKey);
    }
}

async function closeTicketChannel(interaction) {
    const channel = interaction.channel;
    if (!channel || channel.type !== ChannelType.GuildText) {
        await interaction.editReply('This ticket channel could not be closed.');
        return;
    }

    if (interaction.message && interaction.message.editable) {
        await interaction.message.edit({ components: buildTicketClosingComponents() }).catch((error) => {
            console.error('Failed to update closing ticket button:', error);
        });
    }

    await interaction.editReply('Closing ticket...');

    const closedTicket = await closeDiscordTicketRecord(channel.id, interaction.user.id);
    if (closedTicket) {
        try {
            const transcriptMessages = await fetchTicketTranscriptMessages(channel);
            await saveDiscordTicketTranscript({
                ticketId: closedTicket.ticketId,
                guildId: closedTicket.guildId,
                channelId: closedTicket.channelId,
                channelName: channel.name,
                openerUserId: closedTicket.openerUserId,
                closedByUserId: closedTicket.closedByUserId,
                createdAt: closedTicket.createdAt,
                closedAt: closedTicket.closedAt,
                messageCount: transcriptMessages.length,
                messages: transcriptMessages
            });
        } catch (error) {
            console.error('Failed to save ticket transcript:', error);
        }
    }

    setTimeout(() => {
        channel.delete(`Ticket closed by ${interaction.user.tag || interaction.user.id}`).catch((error) => {
            console.error('Failed to delete closed ticket channel:', error);
        });
    }, TICKET_CLOSE_DELETE_DELAY_MS);
}

async function handleTicketInteraction(interaction, control) {
    if (!interaction || (!interaction.isButton() && !interaction.isModalSubmit())) {
        return false;
    }

    if (
        interaction.customId !== OPEN_TICKET_CUSTOM_ID
        && interaction.customId !== CLOSE_TICKET_CUSTOM_ID
        && interaction.customId !== TICKET_ISSUE_MODAL_CUSTOM_ID
    ) {
        return false;
    }

    if (interaction.isModalSubmit()) {
        await interaction.deferReply({ ephemeral: true });
        const issueDescription = normalizeTicketIssue(
            interaction.fields.getTextInputValue(TICKET_ISSUE_INPUT_CUSTOM_ID)
        );
        await createTicketChannel(interaction, control, issueDescription);
        return true;
    }

    if (interaction.customId === OPEN_TICKET_CUSTOM_ID) {
        const ticketSystem = getTicketSystemControl(control);
        if (!ticketSystem.categoryChannelId || !ticketSystem.panelChannelId) {
            await interaction.reply({
                content: 'The ticket system is not configured yet.',
                ephemeral: true
            });
            return true;
        }

        if (interaction.channelId !== ticketSystem.panelChannelId) {
            await interaction.reply({
                content: 'Use the configured ticket panel channel to open a ticket.',
                ephemeral: true
            });
            return true;
        }

        await interaction.showModal(buildTicketIssueModal());
        return true;
    }

    await interaction.deferReply({ ephemeral: true });
    await closeTicketChannel(interaction);
    return true;
}

module.exports = {
    ensureTicketPanel,
    handleTicketInteraction,
    getTicketSystemControl
};
