const {
    ChannelType,
    EmbedBuilder,
    PermissionFlagsBits,
    SlashCommandBuilder
} = require('discord.js');

const ADD_PAYOUT_COMMAND_NAME = 'add-payout';
const COMMAND_SYNC_TTL_MS = 5 * 60 * 1000;
const PAYOUT_EMBED_COLOR = 0xf97316;

let lastCommandSyncAt = 0;
let lastCommandSyncGuildIds = '';

function getBugPayoutsControl(control) {
    const bugPayouts = control && control.bugPayouts && typeof control.bugPayouts === 'object'
        ? control.bugPayouts
        : {};

    return {
        channelId: bugPayouts.channelId ? String(bugPayouts.channelId) : '',
        allowedRoleIds: Array.isArray(bugPayouts.allowedRoleIds)
            ? bugPayouts.allowedRoleIds.map((roleId) => String(roleId)).filter(Boolean)
            : []
    };
}

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

function buildAddPayoutCommandData() {
    return new SlashCommandBuilder()
        .setName(ADD_PAYOUT_COMMAND_NAME)
        .setDescription('Add one pending bug payout entry.')
        .setDMPermission(false)
        .addUserOption((option) => option
            .setName('user')
            .setDescription('Discord user who should receive the payout')
            .setRequired(true))
        .addIntegerOption((option) => option
            .setName('robux')
            .setDescription('Robux amount for this single bug')
            .setMinValue(1)
            .setMaxValue(1000000)
            .setRequired(true))
        .addStringOption((option) => option
            .setName('bug')
            .setDescription('Short description of the bug this payout is for')
            .setMinLength(3)
            .setMaxLength(300)
            .setRequired(true))
        .toJSON();
}

async function ensureBugPayoutCommand(client, control, options) {
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

    const commandData = buildAddPayoutCommandData();
    for (const guild of guilds) {
        const commands = await guild.commands.fetch().catch((error) => {
            console.error(`[bug-payouts] Failed to fetch commands for ${guild.name}:`, error);
            return null;
        });
        if (!commands) {
            continue;
        }

        const existingCommand = commands.find((command) => command.name === ADD_PAYOUT_COMMAND_NAME);
        if (existingCommand) {
            await existingCommand.edit(commandData).catch((error) => {
                console.error(`[bug-payouts] Failed to update /${ADD_PAYOUT_COMMAND_NAME}:`, error);
            });
            continue;
        }

        await guild.commands.create(commandData).catch((error) => {
            console.error(`[bug-payouts] Failed to create /${ADD_PAYOUT_COMMAND_NAME}:`, error);
        });
    }

    lastCommandSyncGuildIds = guildIds;
    lastCommandSyncAt = now;
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

function memberCanAddBugPayout(member, allowedRoleIds) {
    if (!member) {
        return false;
    }

    if (member.permissions && member.permissions.has(PermissionFlagsBits.Administrator)) {
        return true;
    }

    const allowedRoleIdSet = new Set((Array.isArray(allowedRoleIds) ? allowedRoleIds : [])
        .map((roleId) => String(roleId))
        .filter(Boolean));
    if (!allowedRoleIdSet.size) {
        return false;
    }

    return member.roles
        && member.roles.cache
        && member.roles.cache.some((role) => role && allowedRoleIdSet.has(String(role.id)));
}

function formatDiscordTimestamp(date) {
    const seconds = Math.floor(date.getTime() / 1000);
    return `<t:${seconds}:f>`;
}

function buildBugPayoutEmbed(interaction, targetUser, robux, bugDescription) {
    const createdAt = new Date();
    return new EmbedBuilder()
        .setTitle('Pending Bug Payout')
        .setColor(PAYOUT_EMBED_COLOR)
        .setDescription('One bug payout entry is pending.')
        .addFields(
            {
                name: 'Tester',
                value: `${targetUser.toString()}\n\`${targetUser.tag || targetUser.id}\``,
                inline: true
            },
            {
                name: 'Robux',
                value: `**${Number(robux).toLocaleString('en-US')}**`,
                inline: true
            },
            {
                name: 'Added By',
                value: `${interaction.user.toString()}\n\`${interaction.user.tag || interaction.user.id}\``,
                inline: true
            },
            {
                name: 'Bug',
                value: String(bugDescription),
                inline: false
            },
            {
                name: 'Created',
                value: formatDiscordTimestamp(createdAt),
                inline: false
            }
        )
        .setTimestamp(createdAt);
}

async function replyToPayoutInteraction(interaction, content) {
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

async function handleAddPayoutInteraction(interaction, control) {
    if (!interaction || !interaction.isChatInputCommand || !interaction.isChatInputCommand()) {
        return false;
    }

    if (interaction.commandName !== ADD_PAYOUT_COMMAND_NAME) {
        return false;
    }

    if (!interaction.guild) {
        await replyToPayoutInteraction(interaction, 'This command can only be used inside the Discord server.');
        return true;
    }

    const bugPayouts = getBugPayoutsControl(control);
    if (!bugPayouts.channelId) {
        await replyToPayoutInteraction(interaction, 'The bug payouts channel is not configured yet.');
        return true;
    }

    const member = await getInteractionMember(interaction);
    if (!memberCanAddBugPayout(member, bugPayouts.allowedRoleIds)) {
        await replyToPayoutInteraction(interaction, 'You do not have permission to use this command.');
        return true;
    }

    const payoutChannel = await interaction.guild.channels.fetch(bugPayouts.channelId).catch(() => null);
    if (!payoutChannel || payoutChannel.type !== ChannelType.GuildText) {
        await replyToPayoutInteraction(interaction, 'The configured bug payouts channel could not be found.');
        return true;
    }

    await interaction.deferReply({ ephemeral: true });

    const targetUser = interaction.options.getUser('user', true);
    const robux = interaction.options.getInteger('robux', true);
    const bugDescription = String(interaction.options.getString('bug', true) || '').trim();

    const embed = buildBugPayoutEmbed(interaction, targetUser, robux, bugDescription);
    const payoutMessage = await payoutChannel.send({
        embeds: [embed],
        allowedMentions: { parse: [] }
    });

    await interaction.editReply(`Added payout entry in ${payoutChannel.toString()}: ${payoutMessage.url}`);
    return true;
}

module.exports = {
    ensureBugPayoutCommand,
    getBugPayoutsControl,
    handleAddPayoutInteraction
};
