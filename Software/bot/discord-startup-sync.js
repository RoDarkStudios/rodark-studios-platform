const fs = require('fs');
const path = require('path');
const { AttachmentBuilder, ChannelType, EmbedBuilder } = require('discord.js');

const PLACEHOLDER_TEXT = 'Loading...';
const ASSETS_DIR = path.join(__dirname, 'assets', 'discord');
const EMOJIS_DIR = path.join(ASSETS_DIR, 'emojis');
const CHANNEL_IMAGES_DIR = path.join(ASSETS_DIR, 'channel-images');

const CUSTOM_EMOJI_SPECS = {
    Discord: {
        name: 'Discord',
        filename: 'Discord.png',
        fallback: '💬'
    },
    Instagram: {
        name: 'Instagram_icon',
        filename: 'Instagram_icon.png',
        fallback: '📸'
    },
    Roblox: {
        name: 'Roblox',
        filename: 'Roblox.png',
        fallback: '🎮'
    },
    RoDarkStudios: {
        name: 'RoDarkStudios',
        filename: 'RoDarkStudios.png',
        fallback: '🔥'
    },
    X: {
        name: 'X_',
        filename: 'X_.png',
        fallback: '✖️'
    },
    YouTube: {
        name: 'YouTube',
        filename: 'YouTube.png',
        fallback: '▶️'
    }
};

const CHANNEL_IMAGE_FILENAMES = {
    rules: 'Rules.png',
    info: 'Info.png',
    roles: 'Roles.png'
};
const BUG_REPORT_CHANNEL_ID = '1208767046184345610';
const TESTING_BUG_REPORT_CHANNEL_ID = '1207367656609423360';

const FALLBACK_CUSTOM_EMOJIS = Object.fromEntries(
    Object.entries(CUSTOM_EMOJI_SPECS).map(([label, spec]) => [label, spec.fallback])
);

function getConfiguredChannelIds(control) {
    const startupContentSync = control && control.startupContentSync && typeof control.startupContentSync === 'object'
        ? control.startupContentSync
        : {};

    return {
        rules: startupContentSync.rulesChannelId ? String(startupContentSync.rulesChannelId) : '',
        info: startupContentSync.infoChannelId ? String(startupContentSync.infoChannelId) : '',
        roles: startupContentSync.rolesChannelId ? String(startupContentSync.rolesChannelId) : '',
        staffInfo: startupContentSync.staffInfoChannelId ? String(startupContentSync.staffInfoChannelId) : '',
        gameTestInfo: startupContentSync.gameTestInfoChannelId ? String(startupContentSync.gameTestInfoChannelId) : ''
    };
}

function getAssetPath(folderPath, filename) {
    if (!filename) {
        return null;
    }

    const resolvedPath = path.join(folderPath, filename);
    return fs.existsSync(resolvedPath) ? resolvedPath : null;
}

function getRoleMention(guild, roleName) {
    if (!guild || !guild.roles || !guild.roles.cache) {
        return `@${roleName}`;
    }

    const role = guild.roles.cache.find((candidate) => (
        candidate &&
        typeof candidate.name === 'string' &&
        candidate.name.toLowerCase() === String(roleName).toLowerCase()
    ));
    return role ? role.toString() : `@${roleName}`;
}

function getLeaderboardRoleTopSize(control) {
    const rawTopSize = control && control.leaderboardRole && typeof control.leaderboardRole === 'object'
        ? control.leaderboardRole.topSize
        : 100;
    const parsedTopSize = Number.parseInt(rawTopSize || '100', 10);
    return Math.max(1, Math.min(100, Number.isFinite(parsedTopSize) ? parsedTopSize : 100));
}

async function fetchConfiguredChannel(client, channelId, label) {
    if (!channelId) {
        return null;
    }

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) {
        throw new Error(`Configured ${label} channel ${channelId} could not be found`);
    }

    if (channel.type !== ChannelType.GuildText) {
        throw new Error(`Configured ${label} channel ${channelId} is not a text channel`);
    }

    return channel;
}

async function resolveStartupSyncContext(client, control) {
    const configuredChannelIds = getConfiguredChannelIds(control);
    const entries = Object.entries(configuredChannelIds).filter(([, channelId]) => channelId);

    if (!entries.length) {
        return {
            guild: null,
            channels: {}
        };
    }

    const channels = {};
    let guild = null;

    for (const [label, channelId] of entries) {
        const channel = await fetchConfiguredChannel(client, channelId, label);
        channels[label] = channel;

        if (!guild) {
            guild = channel.guild;
            continue;
        }

        if (!channel.guild || channel.guild.id !== guild.id) {
            throw new Error('Configured startup sync channels must all belong to the same Discord server');
        }
    }

    return {
        guild,
        channels
    };
}

async function getOrCreateMainMessage(channel) {
    const existingMessages = await channel.messages.fetch({
        limit: 1,
        after: '0'
    }).catch(() => null);

    if (existingMessages && existingMessages.size) {
        const [message] = Array.from(existingMessages.values());
        if (message) {
            return message;
        }
    }

    return channel.send(PLACEHOLDER_TEXT);
}

async function editMessageWithEmbed(message, embed, imageFilename) {
    const imagePath = getAssetPath(CHANNEL_IMAGES_DIR, imageFilename);
    const payload = {
        content: '',
        embeds: [embed],
        attachments: []
    };

    if (imagePath) {
        embed.setImage(`attachment://${imageFilename}`);
        payload.files = [
            new AttachmentBuilder(imagePath, { name: imageFilename })
        ];
    }

    await message.edit(payload);
}

async function editMessageWithContent(message, content, extraOptions) {
    await message.edit({
        content,
        embeds: [],
        attachments: [],
        ...(extraOptions && typeof extraOptions === 'object' ? extraOptions : {})
    });
}

async function ensureCustomEmojis(guild) {
    if (!guild) {
        return FALLBACK_CUSTOM_EMOJIS;
    }

    const customEmojis = { ...FALLBACK_CUSTOM_EMOJIS };
    const existingByName = new Map(guild.emojis.cache.map((emoji) => [emoji.name, emoji]));

    for (const [label, spec] of Object.entries(CUSTOM_EMOJI_SPECS)) {
        let emoji = existingByName.get(spec.name) || null;

        if (!emoji) {
            const emojiPath = getAssetPath(EMOJIS_DIR, spec.filename);
            if (!emojiPath) {
                console.warn(`[discord-startup-sync] Missing emoji image ${spec.filename}; using fallback for ${label}.`);
            } else {
                const imageBuffer = fs.readFileSync(emojiPath);
                emoji = await guild.emojis.create({
                    attachment: imageBuffer,
                    name: spec.name,
                    reason: 'Ensure required RoDark Studios startup-sync emoji exists'
                });
                existingByName.set(spec.name, emoji);
                console.log(`[discord-startup-sync] Created emoji :${spec.name}:`);
            }
        }

        if (emoji) {
            customEmojis[label] = emoji.toString();
        }
    }

    return customEmojis;
}

async function syncRulesChannel(channel) {
    const message = await getOrCreateMainMessage(channel);
    const embed = new EmbedBuilder()
        .setTitle('Please Follow The Rules')
        .setColor(0xff4d4f)
        .setDescription([
            '1. Follow Discord and Roblox terms at all times.',
            '2. Treat everyone respectfully. Harassment, hate speech, or targeted abuse is not allowed.',
            '3. Do not spam, flood channels, or deliberately disrupt conversations.',
            '4. Keep content appropriate for the server and the channel you are using.',
            '5. Do not share private or personal information without permission.',
            '6. Do not post scams, malware, phishing, exploits, or other harmful material.',
            '7. Use channels for their intended purpose and stay reasonably on topic.',
            '8. Do not repeatedly ping staff or members without a valid reason.',
            '9. Behave respectfully in voice chat and do not troll, mic spam, or harass others.',
            '10. Respect staff decisions and raise concerns calmly instead of arguing publicly.'
        ].join('\n'));

    await editMessageWithEmbed(message, embed, CHANNEL_IMAGE_FILENAMES.rules);
}

async function syncInfoChannel(channel, customEmojis) {
    const message = await getOrCreateMainMessage(channel);
    const embed = new EmbedBuilder()
        .setTitle('RoDark Studios')
        .setColor(0x3b82f6)
        .setDescription('RoDark Studios is a Roblox game studio and community server.')
        .addFields(
            {
                name: `${customEmojis.RoDarkStudios} Website`,
                value: '[rodarkstudios.com](https://rodarkstudios.com)',
                inline: false
            },
            {
                name: `${customEmojis.Roblox} Roblox Group`,
                value: '[Join RoDark Studios](https://www.roblox.com/communities/5545660/RoDark-Studios#!/about)',
                inline: false
            },
            {
                name: `${customEmojis.Roblox} Main Game`,
                value: '[Play Coding Simulator 2](https://www.roblox.com/games/109141895577255/Coding-Simulator-2)',
                inline: false
            },
            {
                name: `${customEmojis.YouTube} YouTube`,
                value: '[@rodarkstudios](https://www.youtube.com/@rodarkstudios)',
                inline: true
            },
            {
                name: `${customEmojis.Instagram} Instagram`,
                value: '[@rodarkstudios](https://www.instagram.com/rodarkstudios)',
                inline: true
            },
            {
                name: `${customEmojis.X} X`,
                value: '[@rodarkstudios](https://x.com/rodarkstudios)',
                inline: true
            }
        );

    await editMessageWithEmbed(message, embed, CHANNEL_IMAGE_FILENAMES.info);
}

async function syncRolesChannel(channel, control) {
    const message = await getOrCreateMainMessage(channel);
    const guild = channel.guild;
    const leaderboardTopSize = getLeaderboardRoleTopSize(control);
    const embed = new EmbedBuilder()
        .setTitle('Server Roles')
        .setColor(0x22c55e)
        .setDescription([
            `${getRoleMention(guild, 'Owner')}\n> Owns and runs RoDark Studios.`,
            `${getRoleMention(guild, 'RoDark Studios Bot')}\n> Our custom bot for support, automation, and moderation.`,
            `${getRoleMention(guild, 'Developer')}\n> Helps create and improve RoDark Studios games.`,
            `${getRoleMention(guild, 'Staff')}\n> Helps members, handles tickets, and enforces the rules.`,
            `${getRoleMention(guild, 'Associate')}\n> Trusted friend, collaborator, or long-term supporter of RoDark Studios.`,
            `${getRoleMention(guild, 'Content Creator')}\n> Recognized content creator. Create a ticket to apply.`,
            `${getRoleMention(guild, 'Server Booster')}\n> Supports the server with Nitro boosts.`,
            `${getRoleMention(guild, 'Leaderboard Player')}\n> Top ${leaderboardTopSize} Coding Simulator 2 players by level.`,
            `${getRoleMention(guild, 'Member')}\n> Verified member of the RoDark Studios community.`
        ].join('\n\n'));

    await editMessageWithEmbed(message, embed, CHANNEL_IMAGE_FILENAMES.roles);
}

async function syncStaffInfoChannel(channel) {
    const message = await getOrCreateMainMessage(channel);
    const guild = channel.guild;
    const embed = new EmbedBuilder()
        .setTitle('Staff Info')
        .setColor(0x2ecc71)
        .setDescription(`${getRoleMention(guild, 'Staff')} responsibilities and expectations.`)
        .addFields(
            {
                name: 'Staff Jobs',
                value: [
                    `1. **Bug report follow-up** - Watch <#${BUG_REPORT_CHANNEL_ID}> and <#${TESTING_BUG_REPORT_CHANNEL_ID}>. If a report is vague, promptly ask for what happened, how to reproduce it, screenshots or video, and an F9 developer console screenshot if errors may be involved.`,
                    `2. **Tickets and escalation** - Respond to tickets, answer what you can, and ask for clearer details when needed. If a ticket needs owner or developer help, mention an ${getRoleMention(guild, 'Owner')} with a clear summary, then leave it for them.`,
                    '3. **Community help** - Stay up to date on how the game works, answer general questions, help people out, and keep an active, helpful community presence.',
                    '4. **Rule enforcement** - Enforce the rules and timeout rule-breakers when needed.'
                ].join('\n'),
                inline: false
            },
            {
                name: 'Ticket Languages',
                value: 'If a ticket opener does not speak English or asks to use another language, use translation software and let them use their preferred language.',
                inline: false
            },
            {
                name: 'Permissions',
                value: 'Do not use staff permissions for personal reasons or jokes. Permission abuse will result in the role being revoked.',
                inline: false
            }
        );

    await editMessageWithEmbed(message, embed);
}

async function syncGameTestInfoChannel(channel, customEmojis) {
    const message = await getOrCreateMainMessage(channel);
    const guild = channel.guild;
    const embed = new EmbedBuilder()
        .setTitle('Game Testing')
        .setColor(0x06b6d4)
        .setDescription([
            'Anyone is welcome to help test Coding Simulator 2.',
            '',
            'Test game: <https://www.roblox.com/games/94676081033757/Coding-Simulator-2>'
        ].join('\n'))
        .addFields(
            {
                name: 'Game Versions',
                value: [
                    'The **live game** is the main public version.',
                    'The **test game** is where upcoming changes can be tried before they are released.'
                ].join('\n'),
                inline: false
            },
            {
                name: 'Bug Reports',
                value: [
                    `If you find a bug in the **test game**, report it in <#${TESTING_BUG_REPORT_CHANNEL_ID}>.`,
                    `If you find a bug in the **live game**, report it in <#${BUG_REPORT_CHANNEL_ID}>.`,
                    'Include what happened, how to reproduce it, a screenshot of the in-game console, and preferably a video.'
                ].join('\n'),
                inline: false
            },
            {
                name: 'Console',
                value: 'To open the console, press `F9` or type `/console` in the in-game chat.',
                inline: false
            },
            {
                name: 'Important',
                value: [
                    'Use the test game for upcoming changes before they are released.',
                    'Only report issues you can clearly describe or reproduce.',
                    `If a report needs owner review, notify an ${getRoleMention(guild, 'Owner')}.`
                ].join('\n'),
                inline: false
            },
        );

    await editMessageWithEmbed(message, embed);
}

async function runStartupSync(client, control) {
    const { guild, channels } = await resolveStartupSyncContext(client, control);
    if (!guild) {
        console.log('[discord-startup-sync] No fixed channels configured; skipping startup sync.');
        return;
    }

    const customEmojis = await ensureCustomEmojis(guild);

    if (channels.rules) {
        await syncRulesChannel(channels.rules);
    }

    if (channels.info) {
        await syncInfoChannel(channels.info, customEmojis);
    }

    if (channels.roles) {
        await syncRolesChannel(channels.roles, control);
    }

    if (channels.staffInfo) {
        await syncStaffInfoChannel(channels.staffInfo);
    }

    if (channels.gameTestInfo) {
        await syncGameTestInfoChannel(channels.gameTestInfo, customEmojis);
    }

    console.log('[discord-startup-sync] Startup channel sync completed.');
}

module.exports = {
    runStartupSync
};
