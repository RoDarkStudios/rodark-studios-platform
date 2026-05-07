const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { postgresQuery } = require('../api/_lib/postgres');

const LEVEL_ROLE_MILESTONES = [5, 10, 15, 25, 50, 75, 100];
const DEFAULT_UNLOCK_LEVEL = 5;
const MESSAGES_PER_LEVEL = 10;
const LEVEL_MESSAGE_COOLDOWN_SECONDS = 10;
const LEVEL_ROLE_PREFIX = 'Level ';
const ATTACH_EMBED_PERMISSION_BITS = PermissionFlagsBits.AttachFiles | PermissionFlagsBits.EmbedLinks;

let ensuredGuildLevelRoles = new Map();

function getLevelSystemControl(control) {
    const levelSystem = control && control.levelSystem && typeof control.levelSystem === 'object'
        ? control.levelSystem
        : {};
    const configuredUnlockLevel = Number.parseInt(levelSystem.attachmentUnlockLevel || DEFAULT_UNLOCK_LEVEL, 10);
    const attachmentUnlockLevel = LEVEL_ROLE_MILESTONES.includes(configuredUnlockLevel)
        ? configuredUnlockLevel
        : DEFAULT_UNLOCK_LEVEL;

    return {
        enabled: Boolean(levelSystem.enabled),
        announcementChannelId: levelSystem.announcementChannelId ? String(levelSystem.announcementChannelId) : '',
        attachmentUnlockLevel
    };
}

function calculateLevel(messageCount) {
    return Math.floor((Number(messageCount) || 0) / MESSAGES_PER_LEVEL);
}

function getLevelRoleName(level) {
    return `${LEVEL_ROLE_PREFIX}${level}`;
}

function getLevelSystemSyncKey(control) {
    const levelSystem = getLevelSystemControl(control);
    return JSON.stringify({
        enabled: levelSystem.enabled,
        announcementChannelId: levelSystem.announcementChannelId,
        attachmentUnlockLevel: levelSystem.attachmentUnlockLevel
    });
}

function buildLevelRolePermissions(levelSystem, milestoneLevel) {
    return milestoneLevel >= levelSystem.attachmentUnlockLevel ? ATTACH_EMBED_PERMISSION_BITS : 0n;
}

async function ensureMemberLevelTable() {
    await postgresQuery(`
        create table if not exists discord_bot_member_levels (
            guild_id text not null,
            user_id text not null,
            message_count integer not null default 0,
            level integer not null default 0,
            last_message_at timestamptz,
            updated_at timestamptz not null default now(),
            primary key (guild_id, user_id)
        )
    `);
}

async function ensureEveryoneAttachmentGate(guild, levelSystem) {
    const everyoneRole = guild && guild.roles && guild.roles.everyone ? guild.roles.everyone : null;
    if (!everyoneRole || !everyoneRole.permissions) {
        return;
    }

    const currentPermissions = BigInt(everyoneRole.permissions.bitfield);
    if ((currentPermissions & ATTACH_EMBED_PERMISSION_BITS) === 0n) {
        return;
    }

    const nextPermissions = currentPermissions & ~ATTACH_EMBED_PERMISSION_BITS;
    await everyoneRole.edit({
        permissions: nextPermissions,
        reason: `Require ${getLevelRoleName(levelSystem.attachmentUnlockLevel)} for attachments and embeds`
    });
}

async function ensureLevelRoles(guild, control) {
    const levelSystem = getLevelSystemControl(control);
    if (!guild || !levelSystem.enabled) {
        return new Map();
    }

    await guild.roles.fetch().catch(() => null);

    const roleMap = new Map();
    for (const milestoneLevel of LEVEL_ROLE_MILESTONES) {
        const roleName = getLevelRoleName(milestoneLevel);
        let role = guild.roles.cache.find((candidate) => (
            candidate &&
            typeof candidate.name === 'string' &&
            candidate.name.toLowerCase() === roleName.toLowerCase()
        ));
        const desiredPermissions = buildLevelRolePermissions(levelSystem, milestoneLevel);

        if (!role) {
            role = await guild.roles.create({
                name: roleName,
                color: milestoneLevel >= 50 ? 0x22d3ee : 0xf97316,
                mentionable: false,
                permissions: desiredPermissions,
                reason: 'Ensure RoDark Studios level role exists'
            });
        } else {
            const currentPermissions = BigInt(role.permissions.bitfield);
            if ((currentPermissions & ATTACH_EMBED_PERMISSION_BITS) !== desiredPermissions) {
                const nextPermissions = (currentPermissions & ~ATTACH_EMBED_PERMISSION_BITS) | desiredPermissions;
                await role.edit({
                    permissions: nextPermissions,
                    reason: 'Sync RoDark Studios level role permissions'
                }).catch((error) => {
                    console.error(`[levels] Failed to sync ${roleName} permissions:`, error);
                });
            }
        }

        roleMap.set(milestoneLevel, role);
    }

    await ensureEveryoneAttachmentGate(guild, levelSystem).catch((error) => {
        console.error('[levels] Failed to remove attachment/embed permissions from @everyone:', error);
    });

    ensuredGuildLevelRoles.set(guild.id, {
        key: getLevelSystemSyncKey(control),
        roles: roleMap
    });
    return roleMap;
}

async function ensureLevelSystem(client, control) {
    const levelSystem = getLevelSystemControl(control);
    if (!client || !client.isReady || !client.isReady() || !levelSystem.enabled) {
        return;
    }

    await ensureMemberLevelTable();

    const guilds = Array.from(client.guilds.cache.values());
    const guildId = control && control.guildId ? String(control.guildId) : '';
    const targetGuilds = guildId
        ? guilds.filter((guild) => String(guild.id) === guildId)
        : guilds;

    for (const guild of targetGuilds) {
        await ensureLevelRoles(guild, control);
    }
}

async function incrementMemberMessageCount(guildId, userId) {
    await ensureMemberLevelTable();

    const result = await postgresQuery(`
        insert into discord_bot_member_levels (
            guild_id,
            user_id,
            message_count,
            level,
            last_message_at,
            updated_at
        )
        values ($1, $2, 1, 0, now(), now())
        on conflict (guild_id, user_id) do update
        set
            message_count = discord_bot_member_levels.message_count + 1,
            level = floor((discord_bot_member_levels.message_count + 1) / $3)::integer,
            last_message_at = now(),
            updated_at = now()
        where
            discord_bot_member_levels.last_message_at is null
            or discord_bot_member_levels.last_message_at <= now() - ($4::text)::interval
        returning message_count, level
    `, [
        String(guildId),
        String(userId),
        MESSAGES_PER_LEVEL,
        `${LEVEL_MESSAGE_COOLDOWN_SECONDS} seconds`
    ]);

    if (!result.rows.length) {
        return {
            counted: false,
            messageCount: 0,
            previousLevel: 0,
            level: 0
        };
    }

    const row = result.rows[0] || {};
    const messageCount = Number(row.message_count) || 0;
    return {
        counted: true,
        messageCount,
        previousLevel: calculateLevel(Math.max(0, messageCount - 1)),
        level: Number(row.level) || 0
    };
}

async function assignEarnedLevelRoles(member, control, memberLevel) {
    if (!member || !member.guild) {
        return [];
    }

    const cached = ensuredGuildLevelRoles.get(member.guild.id);
    const roleMap = cached && cached.key === getLevelSystemSyncKey(control)
        ? cached.roles
        : await ensureLevelRoles(member.guild, control);
    const earnedMilestones = LEVEL_ROLE_MILESTONES.filter((milestoneLevel) => milestoneLevel <= memberLevel);
    const addedRoles = [];

    for (const milestoneLevel of earnedMilestones) {
        const role = roleMap.get(milestoneLevel);
        if (!role || member.roles.cache.has(role.id)) {
            continue;
        }

        try {
            await member.roles.add(role, `Reached ${getLevelRoleName(milestoneLevel)}`);
            addedRoles.push(role);
        } catch (error) {
            console.error(`[levels] Failed to add ${role.name} to ${member.user.tag || member.id}:`, error);
        }
    }

    return addedRoles;
}

async function sendLevelUpAnnouncement(message, control, nextLevel, addedRoles) {
    const levelSystem = getLevelSystemControl(control);
    if (!levelSystem.announcementChannelId) {
        return;
    }

    const channel = await message.client.channels.fetch(levelSystem.announcementChannelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText || channel.guild.id !== message.guild.id) {
        return;
    }

    const highestAddedRole = Array.isArray(addedRoles) && addedRoles.length
        ? addedRoles[addedRoles.length - 1]
        : null;
    const unlockNote = nextLevel === levelSystem.attachmentUnlockLevel
        ? ' You can now attach files and embed links.'
        : '';
    const roleNote = highestAddedRole
        ? ` You earned **${highestAddedRole.name}**.`
        : '';

    await channel.send({
        content: `<@${message.author.id}> leveled up to **Level ${nextLevel}**.${roleNote}${unlockNote}`,
        allowedMentions: {
            users: [String(message.author.id)],
            roles: []
        }
    }).catch((error) => {
        console.error('[levels] Failed to send level-up announcement:', error);
    });
}

async function handleLevelMessage(message, control) {
    const levelSystem = getLevelSystemControl(control);
    if (!levelSystem.enabled || !message || !message.guild || !message.author || message.author.bot) {
        return false;
    }

    if (control && control.guildId && String(control.guildId) !== String(message.guild.id)) {
        return false;
    }

    const levelResult = await incrementMemberMessageCount(message.guild.id, message.author.id);
    if (!levelResult.counted) {
        return true;
    }

    const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
    const addedRoles = member && levelResult.level > 0
        ? await assignEarnedLevelRoles(member, control, levelResult.level)
        : [];
    if (levelResult.level <= levelResult.previousLevel) {
        return true;
    }

    await sendLevelUpAnnouncement(message, control, levelResult.level, addedRoles);
    return true;
}

module.exports = {
    DEFAULT_UNLOCK_LEVEL,
    LEVEL_ROLE_MILESTONES,
    ensureLevelSystem,
    getLevelSystemControl,
    getLevelSystemSyncKey,
    handleLevelMessage
};
