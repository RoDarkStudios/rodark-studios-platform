const {
    ChannelType,
    PermissionFlagsBits,
    SlashCommandBuilder
} = require('discord.js');

const PURGE_CHANNEL_COMMAND_NAME = 'purge-channel';
const OWNER_ROLE_NAME = 'Owner';
const CONFIRMATION_TEXT = 'PURGE';
const COMMAND_SYNC_TTL_MS = 5 * 60 * 1000;

let lastCommandSyncAt = 0;
let lastCommandSyncGuildIds = '';

function getTargetGuilds(client, control) {
    if (!client || !client.guilds || !client.guilds.cache) {
        return [];
    }

    const guilds = Array.from(client.guilds.cache.values());
    const configuredGuildId = control && control.guildId ? String(control.guildId) : '';
    return configuredGuildId
        ? guilds.filter((guild) => String(guild.id) === configuredGuildId)
        : guilds;
}

function buildPurgeChannelCommandData() {
    return new SlashCommandBuilder()
        .setName(PURGE_CHANNEL_COMMAND_NAME)
        .setDescription('Purge a channel by recreating it. Owner role only.')
        .setDMPermission(false)
        .addChannelOption((option) => option
            .setName('channel')
            .setDescription('The channel to purge')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true))
        .addStringOption((option) => option
            .setName('confirm')
            .setDescription(`Type ${CONFIRMATION_TEXT} to confirm`)
            .setRequired(true))
        .toJSON();
}

async function ensureChannelPurgeCommand(client, control, options) {
    if (!client || !client.isReady || !client.isReady()) {
        return;
    }

    const guilds = getTargetGuilds(client, control);
    const guildIds = guilds.map((guild) => String(guild.id)).sort().join(',');
    const now = Date.now();
    const force = Boolean(options && options.force);
    if (!force && guildIds === lastCommandSyncGuildIds && now - lastCommandSyncAt < COMMAND_SYNC_TTL_MS) {
        return;
    }

    const commandData = buildPurgeChannelCommandData();
    for (const guild of guilds) {
        const commands = await guild.commands.fetch().catch((error) => {
            console.error(`[channel-purge] Failed to fetch commands for ${guild.name}:`, error);
            return null;
        });
        if (!commands) {
            continue;
        }

        const existingCommand = commands.find((command) => command.name === PURGE_CHANNEL_COMMAND_NAME);
        if (existingCommand) {
            await existingCommand.edit(commandData).catch((error) => {
                console.error(`[channel-purge] Failed to update /${PURGE_CHANNEL_COMMAND_NAME}:`, error);
            });
            continue;
        }

        await guild.commands.create(commandData).catch((error) => {
            console.error(`[channel-purge] Failed to create /${PURGE_CHANNEL_COMMAND_NAME}:`, error);
        });
    }

    lastCommandSyncGuildIds = guildIds;
    lastCommandSyncAt = now;
}

function memberHasOwnerRole(member) {
    if (!member || !member.guild) {
        return false;
    }

    if (member.guild.ownerId && member.id && String(member.guild.ownerId) === String(member.id)) {
        return true;
    }

    return member.roles
        && member.roles.cache
        && member.roles.cache.some((role) => (
            role
            && typeof role.name === 'string'
            && role.name.toLowerCase() === OWNER_ROLE_NAME.toLowerCase()
        ));
}

async function getInteractionMember(interaction) {
    if (!interaction || !interaction.guild || !interaction.user) {
        return null;
    }

    if (interaction.member && interaction.member.roles && interaction.member.roles.cache) {
        return interaction.member;
    }

    return interaction.guild.members.fetch(interaction.user.id).catch(() => null);
}

async function getBotMember(guild) {
    if (!guild) {
        return null;
    }

    if (guild.members && guild.members.me) {
        return guild.members.me;
    }

    return guild.members.fetchMe().catch(() => null);
}

function isPurgeableChannel(channel) {
    return channel
        && (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement)
        && typeof channel.clone === 'function'
        && typeof channel.delete === 'function';
}

async function purgeChannel(interaction, targetChannel) {
    const reason = `Channel purged by ${interaction.user.tag || interaction.user.id}`;
    const originalPosition = Number(targetChannel.rawPosition);
    const newChannel = await targetChannel.clone({
        name: targetChannel.name,
        reason
    });

    if (Number.isFinite(originalPosition)) {
        await newChannel.setPosition(originalPosition, { reason }).catch((error) => {
            console.error('[channel-purge] Failed to restore channel position:', error);
        });
    }

    await targetChannel.delete(reason);
    return newChannel;
}

async function replyToPurgeInteraction(interaction, content) {
    if (!interaction || !interaction.isRepliable || !interaction.isRepliable()) {
        return;
    }

    if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content }).catch(() => {});
        return;
    }

    await interaction.reply({
        content,
        ephemeral: true
    }).catch(() => {});
}

async function handleChannelPurgeInteraction(interaction) {
    if (!interaction || !interaction.isChatInputCommand || !interaction.isChatInputCommand()) {
        return false;
    }

    if (interaction.commandName !== PURGE_CHANNEL_COMMAND_NAME) {
        return false;
    }

    if (!interaction.guild) {
        await replyToPurgeInteraction(interaction, 'This command can only be used inside the Discord server.');
        return true;
    }

    const member = await getInteractionMember(interaction);
    if (!memberHasOwnerRole(member)) {
        await replyToPurgeInteraction(interaction, 'Only the Owner role can purge channels.');
        return true;
    }

    const confirmValue = String(interaction.options.getString('confirm', true) || '').trim();
    if (confirmValue !== CONFIRMATION_TEXT) {
        await replyToPurgeInteraction(interaction, `Type ${CONFIRMATION_TEXT} in the confirm field to purge a channel.`);
        return true;
    }

    const targetChannel = interaction.options.getChannel('channel', true);
    if (!isPurgeableChannel(targetChannel) || targetChannel.guild.id !== interaction.guild.id) {
        await replyToPurgeInteraction(interaction, 'Choose a text or announcement channel from this server.');
        return true;
    }

    const botMember = await getBotMember(interaction.guild);
    if (!botMember || !botMember.permissions.has(PermissionFlagsBits.ManageChannels)) {
        await replyToPurgeInteraction(interaction, 'The bot needs Manage Channels permission to purge channels.');
        return true;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
        const newChannel = await purgeChannel(interaction, targetChannel);
        await replyToPurgeInteraction(interaction, `Purged ${newChannel.toString()}. The old channel was deleted and recreated.`);
    } catch (error) {
        console.error('[channel-purge] Failed to purge channel:', error);
        await replyToPurgeInteraction(interaction, `Failed to purge that channel: ${error.message || 'unknown error'}`);
    }

    return true;
}

module.exports = {
    ensureChannelPurgeCommand,
    handleChannelPurgeInteraction
};
