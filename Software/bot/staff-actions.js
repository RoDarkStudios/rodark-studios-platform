const {
    ChannelType, EmbedBuilder, PermissionFlagsBits: P, Routes, SlashCommandBuilder, escapeMarkdown
} = require('discord.js');
const defaultStore = require('../api/_lib/discord-staff-action-store');
const { assertPrivateLog } = require('./moderation');

const COMMAND_NAMES = ['ban', 'kick'];
const REASON_LIMIT = 300;
const NATIVE_REMOVAL_PERMISSIONS = [P.BanMembers, P.KickMembers];

const staffCommands = COMMAND_NAMES.map((name) => new SlashCommandBuilder()
    .setName(name)
    .setDescription(`${name === 'ban' ? 'Ban' : 'Kick'} a member from this server.`)
    .setNSFW(false)
    .setDefaultMemberPermissions(P.ModerateMembers)
    .addUserOption((option) => option.setName('member').setDescription('The member to remove').setRequired(true))
    .addStringOption((option) => option.setName('reason').setDescription('Why the member is being removed')
        .setMinLength(1).setMaxLength(REASON_LIMIT).setRequired(false))
    .toJSON());

function staffActionsEnabled(control) {
    return control?.infrastructure?.spec.staffRemovalCommands === true;
}

function fetchMember(guild, userId) {
    return guild.members.fetch({ user: userId, force: true }).catch((error) => {
        if (error.code === 10007) return null;
        throw error;
    });
}

function createStaffActions(actionRest, { store = defaultStore, logger = console, now = Date.now } = {}) {
    let nextLogCheck = 0;

    async function handleInteraction(interaction, control) {
        const action = interaction.commandName;
        if (!interaction.isChatInputCommand?.() || !COMMAND_NAMES.includes(action)) return false;

        await interaction.deferReply({ ephemeral: true });
        const reply = async (content) => {
            await interaction.editReply({ content, allowedMentions: { parse: [] } });
            return true;
        };
        const { guild } = interaction;
        if (!guild || guild.id !== control?.guildId || !staffActionsEnabled(control)) {
            return reply('This command is unavailable here until the server configuration is deployed.');
        }

        const { role: bindings } = control.infrastructure.bindings;
        const targetId = interaction.options.getUser('member', true).id;
        const reason = interaction.options.getString('reason')?.trim() || '';
        if (reason.length > REASON_LIMIT) {
            return reply(`Keep the reason to ${REASON_LIMIT} characters or fewer.`);
        }

        const [roles, actor, target] = await Promise.all([
            guild.roles.fetch(), fetchMember(guild, interaction.user.id), fetchMember(guild, targetId),
            guild.members.fetchMe({ force: true })
        ]);
        if (!actor) return reply('Only current Staff and administrators can use this command.');
        const administrator = actor.id === guild.ownerId || actor.permissions.has(P.Administrator);
        if (!administrator && !actor.roles.cache.has(bindings.staff)) {
            return reply('Only Staff and administrators can use this command.');
        }
        const staffRole = roles.get(bindings.staff);
        if (!administrator && (!staffRole || staffRole.permissions.any(NATIVE_REMOVAL_PERMISSIONS)
            || actor.permissions.any(NATIVE_REMOVAL_PERMISSIONS))) {
            return reply('Staff commands require native Ban Members and Kick Members permissions to be disabled. Ask an administrator to check your roles.');
        }
        if (!target) return reply('Choose a current server member.');
        if (actor.id === target.id || target.id === guild.ownerId || target.roles.cache.has(bindings.owner)
            || (!administrator && target.permissions.has(P.Administrator))
            || (actor.id !== guild.ownerId && actor.roles.highest.comparePositionTo(target.roles.highest) <= 0)) {
            return reply('Your role cannot take this action against that member.');
        }
        const ban = action === 'ban';
        if (!(ban ? target.bannable : target.kickable)) return reply(`The bot cannot ${action} that member.`);

        // Bound the request from before the reservation, including time spent waiting on Discord.
        const signal = AbortSignal.timeout(30_000);
        const reservation = await store.reserve({ id: interaction.id, guildId: guild.id, actorId: actor.id,
            targetId, action, reason, administrator });
        if (reservation.status === 'duplicate') return reply('This request was already recorded.');
        if (reservation.status === 'limited') {
            const retryTime = Math.ceil(new Date(reservation.retryAt).getTime() / 1000);
            return reply(`You reached the shared limit of ${defaultStore.LIMIT} bans and kicks in a rolling hour. Your next slot opens <t:${retryTime}:R>.`);
        }
        if (signal.aborted) {
            await store.finish(interaction.id, 'failed');
            return reply('This request expired before reaching Discord. Please try again.');
        }

        const options = { signal, reason: `/${action} by ${actor.id}, interaction ${interaction.id}` };
        let outcome = 'succeeded';
        try {
            if (ban) await actionRest.put(Routes.guildBan(guild.id, targetId), { ...options, body: { delete_message_seconds: 0 } });
            else await actionRest.delete(Routes.guildMember(guild.id, targetId), options);
        } catch (error) {
            // An ambiguous response still holds a slot. The action REST client does not retry writes.
            outcome = error.status >= 400 && error.status < 500 ? 'failed' : 'unconfirmed';
            logger.error(`[staff-actions] /${action} ${interaction.id} ${outcome}:`, error.message);
        }
        await store.finish(interaction.id, outcome).catch((error) => {
            logger.error(`[staff-actions] Could not record outcome for ${interaction.id}:`, error.message);
        });

        if (outcome === 'failed') return reply(`Discord rejected the ${action}.`);
        if (outcome === 'unconfirmed') return reply(`Discord did not confirm the ${action}. Check the server audit log before retrying.`);
        return reply(`<@${targetId}> was ${ban ? 'banned' : 'kicked'}.`);
    }

    // The worker runs this under the existing guild lock so only one replica publishes at a time.
    async function publishLogs(guild, control) {
        if (!guild || !staffActionsEnabled(control) || now() < nextLogCheck) return;
        nextLogCheck = now() + 15_000;
        const entries = await store.pendingLogs(guild.id);
        if (!entries.length) return;

        const bindings = control.infrastructure.bindings;
        const logChannel = await guild.channels.fetch(bindings.channel['moderation-log'], { force: true });
        if (logChannel?.type !== ChannelType.GuildText) throw new Error('The private moderation log channel is missing.');
        assertPrivateLog({ guild, logChannel, readerIds: [bindings.role.staff, bindings.role.owner] }, guild.client.user.id);

        for (const entry of entries) {
            const label = entry.action === 'ban' ? 'Ban' : 'Kick';
            const embed = new EmbedBuilder().setTitle(`${label} ${entry.outcome}`).setTimestamp(new Date(entry.created_at))
                .addFields(
                    { name: 'Moderator', value: `<@${entry.actor_id}> (${entry.actor_id})${entry.administrator ? ' · Administrator' : ''}` },
                    { name: 'Member', value: `<@${entry.target_id}> (${entry.target_id})` },
                    { name: 'Reason', value: entry.reason ? escapeMarkdown(entry.reason) : 'No reason provided' }
                ).setFooter({ text: `Interaction ${entry.interaction_id}` });
            const message = await logChannel.send({ embeds: [embed], allowedMentions: { parse: [] },
                nonce: entry.interaction_id, enforceNonce: true });
            await store.markLogged(entry.interaction_id, message.id);
        }
    }

    return { handleInteraction, publishLogs };
}

module.exports = { createStaffActions, staffActionsEnabled, staffCommands };
