const {
    ChannelType,
    EmbedBuilder,
    PermissionFlagsBits,
    SlashCommandBuilder
} = require('discord.js');

const ADD_PAYOUT_COMMAND_NAME = 'bug-payout';
const LEGACY_ADD_PAYOUT_COMMAND_NAME = 'add-payout';
const COMMAND_SYNC_TTL_MS = 5 * 60 * 1000;
const PAYOUT_EMBED_COLOR = 0xf97316;
const PAID_PAYOUT_EMBED_COLOR = 0x22c55e;
const PAYOUT_PAID_REACTION = '✅';
const BUG_REWARD_BY_SEVERITY = {
    minor: 50,
    moderate: 200,
    critical: 5000
};

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
        .addStringOption((option) => option
            .setName('severity')
            .setDescription('Bug severity used to calculate the Robux payout')
            .addChoices(
                { name: 'Minor - 50 Robux', value: 'minor' },
                { name: 'Moderate - 200 Robux', value: 'moderate' },
                { name: 'Critical - 5,000 Robux', value: 'critical' }
            )
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
        const legacyCommand = commands.find((command) => command.name === LEGACY_ADD_PAYOUT_COMMAND_NAME);
        if (legacyCommand) {
            await legacyCommand.delete().catch((error) => {
                console.error(`[bug-payouts] Failed to delete legacy /${LEGACY_ADD_PAYOUT_COMMAND_NAME}:`, error);
            });
        }

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

function formatSeverity(value) {
    const normalizedValue = String(value || '').trim().toLowerCase();
    return normalizedValue ? normalizedValue[0].toUpperCase() + normalizedValue.slice(1) : 'Unknown';
}

function getRobuxEmoji(guild) {
    const emoji = guild
        && guild.emojis
        && guild.emojis.cache
        && guild.emojis.cache.find((candidate) => candidate && candidate.name === 'Robux');

    return emoji ? emoji.toString() : 'Robux';
}

function buildBugPayoutEmbed(interaction, targetUser, severity, robux, bugDescription) {
    const robuxEmoji = getRobuxEmoji(interaction.guild);
    return new EmbedBuilder()
        .setTitle('Pending Bug Payout')
        .setColor(PAYOUT_EMBED_COLOR)
        .addFields(
            {
                name: 'Tester',
                value: targetUser.toString(),
                inline: true
            },
            {
                name: 'Robux',
                value: `${robuxEmoji} **${Number(robux).toLocaleString('en-US')}**`,
                inline: true
            },
            {
                name: 'Severity',
                value: formatSeverity(severity),
                inline: true
            },
            {
                name: 'Added By',
                value: interaction.user.toString(),
                inline: false
            },
            {
                name: 'Bug',
                value: String(bugDescription),
                inline: false
            }
        );
}

async function getReactionMember(reaction, user) {
    if (!reaction || !reaction.message || !reaction.message.guild || !user) {
        return null;
    }

    return reaction.message.guild.members.fetch(user.id).catch(() => null);
}

function isPendingBugPayoutEmbed(embed) {
    return embed && embed.title === 'Pending Bug Payout';
}

function buildPaidBugPayoutEmbed(existingEmbed, paidByUser) {
    const embed = EmbedBuilder.from(existingEmbed)
        .setTitle('Paid Bug Payout')
        .setColor(PAID_PAYOUT_EMBED_COLOR)
        .setDescription(null);

    const data = embed.toJSON();
    const fields = Array.isArray(data.fields)
        ? data.fields.filter((field) => field && field.name !== 'Paid By')
        : [];

    fields.push({
        name: 'Paid By',
        value: paidByUser.toString(),
        inline: false
    });

    return embed.setFields(fields);
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
    const severity = String(interaction.options.getString('severity', true) || '').trim().toLowerCase();
    const robux = BUG_REWARD_BY_SEVERITY[severity];
    const bugDescription = String(interaction.options.getString('bug', true) || '').trim();

    if (!robux) {
        await interaction.editReply('Choose a valid severity: minor, moderate, or critical.');
        return true;
    }

    const embed = buildBugPayoutEmbed(interaction, targetUser, severity, robux, bugDescription);
    const payoutMessage = await payoutChannel.send({
        content: `${targetUser.toString()} bug payout pending.`,
        embeds: [embed],
        allowedMentions: {
            parse: [],
            users: [targetUser.id]
        }
    });
    await payoutMessage.edit({
        content: '',
        embeds: [embed],
        allowedMentions: { parse: [] }
    }).catch((error) => {
        console.error('[bug-payouts] Failed to clear payout ping text:', error);
    });

    await interaction.editReply(`Added payout entry in ${payoutChannel.toString()}: ${payoutMessage.url}`);
    return true;
}

async function handleBugPayoutReaction(reaction, user, control) {
    if (!reaction || !user || user.bot) {
        return false;
    }

    if (!reaction.emoji || reaction.emoji.name !== PAYOUT_PAID_REACTION) {
        return false;
    }

    if (reaction.partial) {
        await reaction.fetch().catch(() => null);
    }

    const message = reaction.message && reaction.message.partial
        ? await reaction.message.fetch().catch(() => null)
        : reaction.message;
    if (!message || !message.guild) {
        return false;
    }

    const bugPayouts = getBugPayoutsControl(control);
    if (!bugPayouts.channelId || String(message.channelId) !== String(bugPayouts.channelId)) {
        return false;
    }

    if (!message.author || !message.client || String(message.author.id) !== String(message.client.user.id)) {
        return false;
    }

    const existingEmbed = message.embeds && message.embeds[0] ? message.embeds[0] : null;
    if (!isPendingBugPayoutEmbed(existingEmbed)) {
        return false;
    }

    const member = await getReactionMember(reaction, user);
    if (!memberCanAddBugPayout(member, bugPayouts.allowedRoleIds)) {
        await reaction.users.remove(user.id).catch(() => {});
        return true;
    }

    const embed = buildPaidBugPayoutEmbed(existingEmbed, user);
    await message.edit({ embeds: [embed] });
    await reaction.users.remove(user.id).catch(() => {});
    return true;
}

module.exports = {
    ensureBugPayoutCommand,
    getBugPayoutsControl,
    handleAddPayoutInteraction,
    handleBugPayoutReaction
};
