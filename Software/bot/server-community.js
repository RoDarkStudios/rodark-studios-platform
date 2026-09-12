const { SlashCommandBuilder, PermissionFlagsBits: P } = require('discord.js');
let commandSyncAt = 0;

async function ensureCommunityCommands(client, control, { force = false } = {}) {
    if (!control?.infrastructure || (!force && Date.now() - commandSyncAt < 5 * 60_000)) return;
    const guild = client.guilds.cache.get(control.guildId);
    if (!guild) return;
    const commands = await guild.commands.fetch();
    const data = new SlashCommandBuilder().setName('forum-moderate')
        .setDescription('Moderate this forum post without changing owner-only status tags.')
        .setDefaultMemberPermissions(P.ModerateMembers).setDMPermission(false)
        .addStringOption((option) => option.setName('action').setDescription('Action for this post').setRequired(true)
            .addChoices({ name: 'Lock post', value: 'lock' }, { name: 'Reopen post', value: 'reopen' }, { name: 'Delete abusive post', value: 'delete' }))
        .addStringOption((option) => option.setName('reason').setDescription('Reason for the moderation action').setRequired(true).setMaxLength(300)).toJSON();
    const existing = commands.find((command) => command.name === data.name);
    if (existing) await existing.edit(data); else await guild.commands.create(data);
    // Channel replacement must go through the infrastructure planner once IDs are managed.
    const purge = commands.find((command) => command.name === 'purge-channel');
    if (purge) await purge.delete();
    commandSyncAt = Date.now();
}

async function handleCommunityInteraction(interaction, control) {
    if (!interaction.isChatInputCommand?.() || interaction.commandName !== 'forum-moderate') return false;
    await interaction.deferReply({ ephemeral: true });
    const active = control?.infrastructure;
    if (!active || interaction.guildId !== active.spec.guildId) { await interaction.editReply('Forum moderation is unavailable here.'); return true; }
    const member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true });
    const owner = member.id === interaction.guild.ownerId || member.roles.cache.has(active.bindings.role.owner);
    if (!owner && !member.roles.cache.has(active.bindings.role.staff)) { await interaction.editReply('Only Staff and Owners can use this command.'); return true; }
    const thread = await interaction.guild.channels.fetch(interaction.channelId, { force: true });
    const parents = active.spec.games.flatMap((game) => active.spec.gameChannels.filter((channel) => channel.type === 'forum').map((channel) => active.bindings.channel[`${game.key}/${channel.key}`]));
    if (!thread?.isThread() || !parents.includes(thread.parentId)) { await interaction.editReply('Use this command inside a game forum post.'); return true; }
    const author = await interaction.guild.members.fetch({ user: thread.ownerId, force: true }).catch((error) => { if (error.code === 10007) return null; throw error; });
    if (!owner && (thread.ownerId === interaction.guild.ownerId || author?.roles.cache.has(active.bindings.role.owner) || author?.user.bot)) {
        await interaction.editReply('Ask an Owner to moderate posts created by Owners or bots.'); return true;
    }
    const action = interaction.options.getString('action', true);
    const reason = `Forum moderation by ${member.id}: ${interaction.options.getString('reason', true)}`;
    if (action === 'lock') await thread.edit({ locked: true, archived: true, reason });
    else if (action === 'reopen') await thread.edit({ locked: false, archived: false, reason });
    else if (action === 'delete') {
        await interaction.editReply('Removing this forum post.');
        await thread.delete(reason);
        return true;
    } else { await interaction.editReply('Unknown moderation action.'); return true; }
    await interaction.editReply(action === 'lock' ? 'Post locked. Status tags are unchanged.' : 'Post reopened. Status tags are unchanged.');
    return true;
}

async function ensureMemberRole(member, control) {
    const active = control?.infrastructure;
    const roleId = active?.bindings.role.member;
    if (!member || !roleId || member.user.bot || member.guild.id !== active.spec.guildId || member.roles.cache.has(roleId)) return;
    if (member.id === member.guild.ownerId || member.roles.cache.has(active.bindings.role.owner)) return;
    await member.roles.add(roleId, 'Community member; Roblox verification is not required');
}

module.exports = { ensureCommunityCommands, handleCommunityInteraction, ensureMemberRole };
