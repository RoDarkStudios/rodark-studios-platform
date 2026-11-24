const { ApplicationCommandType, Client, GatewayIntentBits, Partials, REST } = require('discord.js');
const { getDiscordBotControl, updateDiscordBotControl, setDiscordBotRuntimeStatus } = require('../api/_lib/discord-bot-control-store');
const { getPostgresPool } = require('../api/_lib/postgres');
const { runStartupSync } = require('./discord-startup-sync');
const { ensureTicketPanel, getTicketSystemControl, handleTicketInteraction } = require('./tickets');
const { ensureLevelSystem, getLevelSystemSyncKey, handleLevelMessage } = require('./levels');
const { createHoneypotSystem } = require('./honeypot');
const { createModerationSystem } = require('./moderation');
const { createStaffActions, staffActionsEnabled, staffCommands } = require('./staff-actions');
const { createInfrastructureWorker, controlWithLayout } = require('./server-infrastructure');
const infrastructureStore = require('../api/_lib/discord-infrastructure-store');
const { closeDiscordTicketRecord } = require('../api/_lib/discord-ticket-store');

const POLL_INTERVAL_MS = Number.parseInt(process.env.DISCORD_BOT_POLL_INTERVAL_MS || '5000', 10);
const DISCORD_BOT_TOKEN = String(process.env.DISCORD_BOT_TOKEN || '').trim();
const OBSOLETE_GUILD_COMMAND_NAMES = ['bug-payout', 'add-payout', 'forum-moderate', 'purge-channel'];
const COMMAND_SYNC_TTL_MS = 10 * 60 * 1000;

let client = null;
let connecting = false;
let currentControl = null;
let honeypotSystem = null;
let moderationSystem = null;
let staffActionSystem = null;
let infrastructureSystem = null;
let startupNeeded = true;
let syncingState = false;
let lastTicketPanelSyncKey = '';
let lastTicketPanelSyncAt = 0;
let lastLevelSystemSyncKey = '';
let lastLevelSystemSyncAt = 0;
let lastCommandSyncKey = '';
let nextCommandSyncAt = 0;

function getTargetGuilds(nextClient, control) {
    if (!nextClient || !nextClient.guilds || !nextClient.guilds.cache) {
        return [];
    }

    const guilds = Array.from(nextClient.guilds.cache.values());
    const configuredGuildId = control && control.guildId ? String(control.guildId) : '';
    return configuredGuildId
        ? guilds.filter((guild) => String(guild.id) === configuredGuildId)
        : guilds;
}

async function syncGuildCommands(nextClient, control) {
    if (!nextClient || !nextClient.isReady()) {
        return;
    }

    const guilds = getTargetGuilds(nextClient, control);
    const guildIds = guilds.map((guild) => String(guild.id)).sort().join(',');
    const enableStaffCommands = staffActionsEnabled(control);
    const syncKey = JSON.stringify([guildIds, enableStaffCommands]);
    const now = Date.now();
    if (syncKey === lastCommandSyncKey && now < nextCommandSyncAt) {
        return;
    }

    let failed = false;
    for (const guild of guilds) {
        const commands = await guild.commands.fetch().catch((error) => {
            console.error(`[discord-commands] Failed to fetch commands for ${guild.name}:`, error);
            failed = true;
            return null;
        });
        if (!commands) {
            continue;
        }

        const slashCommands = commands.filter((command) => command.type === ApplicationCommandType.ChatInput);
        for (const commandName of OBSOLETE_GUILD_COMMAND_NAMES) {
            const command = slashCommands.find((candidate) => candidate.name === commandName);
            if (!command) {
                continue;
            }

            await command.delete().catch((error) => {
                console.error(`[discord-commands] Failed to delete obsolete /${commandName}:`, error);
                failed = true;
            });
        }
        if (enableStaffCommands && guild.id === control.guildId) {
            for (const data of staffCommands) {
                const existing = slashCommands.find((command) => command.name === data.name);
                if (existing?.equals(data, true)) continue;
                await (existing ? existing.edit(data) : guild.commands.create(data)).catch((error) => {
                    console.error(`[discord-commands] Failed to register /${data.name}:`, error);
                    failed = true;
                });
            }
        }
    }

    lastCommandSyncKey = syncKey;
    nextCommandSyncAt = now + (failed ? 30_000 : COMMAND_SYNC_TTL_MS);
}

function getTicketPanelSyncKey(control) {
    const ticketSystem = getTicketSystemControl(control);
    return JSON.stringify({
        categoryChannelId: ticketSystem.categoryChannelId,
        panelChannelId: ticketSystem.panelChannelId,
        panelMessageId: ticketSystem.panelMessageId,
        helperRoleIds: ticketSystem.helperRoleIds
    });
}

async function syncTicketPanelIfNeeded(nextClient, control, options) {
    if (!nextClient || !nextClient.isReady()) {
        return;
    }

    const ticketSystem = getTicketSystemControl(control);
    if (!ticketSystem.enabled || !ticketSystem.categoryChannelId || !ticketSystem.panelChannelId) {
        lastTicketPanelSyncKey = '';
        lastTicketPanelSyncAt = 0;
        return;
    }

    const now = Date.now();
    const syncKey = getTicketPanelSyncKey(control);
    const force = Boolean(options && options.force);
    if (!force && syncKey === lastTicketPanelSyncKey && now - lastTicketPanelSyncAt < 5 * 60 * 1000) {
        return;
    }

    await ensureTicketPanel(nextClient, control);
    lastTicketPanelSyncKey = syncKey;
    lastTicketPanelSyncAt = now;
}

async function syncLevelSystemIfNeeded(nextClient, control, options) {
    if (!nextClient || !nextClient.isReady()) {
        return;
    }

    const syncKey = getLevelSystemSyncKey(control);
    const force = Boolean(options && options.force);
    const now = Date.now();
    if (!force && syncKey === lastLevelSystemSyncKey && now - lastLevelSystemSyncAt < 5 * 60 * 1000) {
        return;
    }

    await ensureLevelSystem(nextClient, control);
    lastLevelSystemSyncKey = syncKey;
    lastLevelSystemSyncAt = now;
}

function createClient() {
    const nextClient = new Client({
        partials: [Partials.Message, Partials.Channel],
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.AutoModerationConfiguration,
            GatewayIntentBits.MessageContent
        ]
    });
    const nextHoneypot = createHoneypotSystem(nextClient);
    honeypotSystem = nextHoneypot;
    const nextModeration = createModerationSystem(nextClient);
    moderationSystem = nextModeration;
    const nextStaffActions = createStaffActions(new REST({ retries: 0 }).setToken(DISCORD_BOT_TOKEN));
    staffActionSystem = nextStaffActions;
    const nextInfrastructure = createInfrastructureWorker(nextClient, {
        beforeApply: () => nextModeration.pause(),
        onProgress: () => setDiscordBotRuntimeStatus('online', null),
        closeTicket: (channelId) => closeDiscordTicketRecord(channelId, nextClient.user.id),
        finishContent: async (active, actor) => {
            const channels = active.bindings.channel;
            const tickets = controlWithLayout({}, active).ticketSystem;
            const updated = await updateDiscordBotControl({ guildId: active.spec.guildId,
                contentRulesChannelId: channels.rules, contentInfoChannelId: channels.info, contentRolesChannelId: channels.roles,
                contentStaffInfoChannelId: channels['staff-info'], contentGameTestInfoChannelId: null,
                ticketsCategoryChannelId: tickets.categoryChannelId, ticketsPanelChannelId: tickets.panelChannelId,
                ticketsHelperRoleIds: tickets.helperRoleIds, levelAnnouncementChannelId: channels['level-ups']
            }, actor);
            const effective = controlWithLayout(updated, active);
            currentControl = effective;
            await nextClient.guilds.cache.get(active.spec.guildId).roles.fetch();
            await nextClient.guilds.cache.get(active.spec.guildId).channels.fetch();
            await runStartupSync(nextClient, effective);
            await syncTicketPanelIfNeeded(nextClient, effective, { force: true });
            await syncLevelSystemIfNeeded(nextClient, effective, { force: true });
            await nextHoneypot.ensure(effective, { force: true });
            await nextModeration.ensure(effective, { force: true });
        }
    });
    infrastructureSystem = nextInfrastructure;
    for (const event of ['channelCreate', 'channelUpdate', 'channelDelete', 'roleCreate', 'roleUpdate', 'roleDelete', 'guildUpdate', 'autoModerationRuleCreate', 'autoModerationRuleUpdate', 'autoModerationRuleDelete']) {
        nextClient.on(event, () => nextInfrastructure.markDirty());
    }

    nextClient.once('ready', async () => {
        const tag = nextClient.user && nextClient.user.tag ? nextClient.user.tag : 'Discord bot';
        console.log(`${tag} is online.`);
        await setDiscordBotRuntimeStatus('online', null);

        // All layout-mutating startup work runs under the infrastructure lock in syncBotState.
        startupNeeded = true;
        nextInfrastructure.markDirty();
    });

    nextClient.on('interactionCreate', async (interaction) => {
        try {
            const state = nextInfrastructure.getState();
            if (state?.maintenance) {
                if (interaction.isRepliable?.()) await interaction.reply({ content: 'The server layout is being updated. Please try again after deployment finishes.', ephemeral: true });
                return;
            }
            const control = nextInfrastructure.effectiveControl(currentControl || await getDiscordBotControl());
            currentControl = control;
            if (await nextStaffActions.handleInteraction(interaction, control)) return;
            if (await nextModeration.handleInteraction(interaction)) return;
            const locked = await infrastructureStore.withGuildLock(control.guildId || interaction.guildId, async () => {
                const liveState = await infrastructureStore.getState(control.guildId || interaction.guildId);
                if (liveState.maintenance) return;
                await handleTicketInteraction(interaction, control);
            });
            if (!locked && interaction.isRepliable?.() && !interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: 'The bot is synchronising the server. Please try again shortly.', ephemeral: true });
            }
        } catch (error) {
            console.error('Discord interaction failed:', error);
            await setDiscordBotRuntimeStatus('error', error.message).catch(() => {});

            if (interaction && interaction.isRepliable && interaction.isRepliable()) {
                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply({
                        content: 'Something went wrong while handling that bot action.'
                    }).catch(() => {});
                } else {
                    await interaction.reply({
                        content: 'Something went wrong while handling that bot action.',
                        ephemeral: true
                    }).catch(() => {});
                }
            }
        }
    });

    nextClient.on('messageCreate', async (message) => {
        try {
            if (nextInfrastructure.getState()?.maintenance) return;
            const control = nextInfrastructure.effectiveControl(currentControl || await getDiscordBotControl());
            currentControl = control;
            if (await nextHoneypot.handleMessage(message, control)) return;
            await nextModeration.handleMessage(message, control).catch((error) => {
                console.error('Discord moderation queue failed:', error.message);
            });
            const handled = await handleLevelMessage(message, control);
            if (handled) {
                await setDiscordBotRuntimeStatus('online', [nextHoneypot.getError(), nextModeration.getError()].filter(Boolean).join('; ') || null);
            }
        } catch (error) {
            console.error('Discord message handling failed:', error);
            await setDiscordBotRuntimeStatus('error', error.message).catch(() => {});
        }
    });

    nextClient.on('messageUpdate', (_previous, message) => {
        nextModeration.handleMessage(message, currentControl).catch((error) => {
            console.error('Discord moderation edit handling failed:', error.message);
        });
    });
    nextClient.on('messageDelete', (message) => {
        nextModeration.handleDelete([message]).catch((error) => console.error('Discord moderation deletion handling failed:', error.message));
    });
    nextClient.on('messageDeleteBulk', (messages) => {
        nextModeration.handleDelete([...messages.values()]).catch((error) => console.error('Discord moderation bulk deletion handling failed:', error.message));
    });

    nextClient.on('error', async (error) => {
        console.error('Discord client error:', error);
        await setDiscordBotRuntimeStatus('error', error.message);
    });

    nextClient.on('shardDisconnect', async () => {
        await setDiscordBotRuntimeStatus('offline', null);
    });

    return nextClient;
}

async function connectBot() {
    if (client || connecting) {
        return;
    }

    if (!DISCORD_BOT_TOKEN) {
        await setDiscordBotRuntimeStatus('error', 'DISCORD_BOT_TOKEN must be set');
        return;
    }

    connecting = true;
    await setDiscordBotRuntimeStatus('connecting', null);

    try {
        client = createClient();
        await client.login(DISCORD_BOT_TOKEN);
    } catch (error) {
        console.error('Failed to connect Discord bot:', error);
        await honeypotSystem?.stop();
        await moderationSystem?.stop();
        moderationSystem = null;
        staffActionSystem = null;
        if (client) await client.destroy();
        client = null;
        await setDiscordBotRuntimeStatus('error', error.message);
    } finally {
        connecting = false;
    }
}

async function disconnectBot() {
    if (!client && !connecting) {
        await setDiscordBotRuntimeStatus('offline', null);
        return;
    }

    const currentClient = client;
    client = null;
    const currentHoneypot = honeypotSystem;
    honeypotSystem = null;
    const currentModeration = moderationSystem;
    moderationSystem = null;
    staffActionSystem = null;
    infrastructureSystem = null;
    startupNeeded = true;
    await currentHoneypot?.stop();
    await currentModeration?.stop();

    if (currentClient) {
        currentClient.removeAllListeners();
        await currentClient.destroy();
    }

    await setDiscordBotRuntimeStatus('offline', null);
    lastTicketPanelSyncKey = '';
    lastTicketPanelSyncAt = 0;
    lastLevelSystemSyncKey = '';
    lastLevelSystemSyncAt = 0;
    lastCommandSyncKey = '';
    nextCommandSyncAt = 0;
    currentControl = null;
    console.log('Discord bot is offline.');
}

async function syncBotState() {
    if (syncingState) return;
    syncingState = true;
    try {
    const control = await getDiscordBotControl();
    currentControl = infrastructureSystem ? infrastructureSystem.effectiveControl(control) : control;
    if (control && control.desiredEnabled) {
        await connectBot();
        if (client && client.isReady()) {
            // Cleanup runs independently of layout sync and never delays new bans.
            // The existing poll drives its durable queue; no per-message scans/timers.
            void honeypotSystem.tickCleanup(currentControl);
            await syncGuildCommands(client, currentControl);
            await infrastructureSystem.tick(control, async (effective) => {
                currentControl = effective;
                await staffActionSystem.publishLogs(client.guilds.cache.get(effective.guildId), effective).catch((error) => {
                    console.error('[staff-actions] Could not publish action logs:', error.message);
                });
                moderationSystem.resume();
                moderationSystem.start(() => currentControl);
                await moderationSystem.ensure(effective, { force: startupNeeded });
                await honeypotSystem.ensure(effective, { force: startupNeeded });
                if (startupNeeded) await runStartupSync(client, effective);
                await syncTicketPanelIfNeeded(client, effective, { force: startupNeeded });
                await syncLevelSystemIfNeeded(client, effective, { force: startupNeeded });
                startupNeeded = false;
                await setDiscordBotRuntimeStatus('online', [honeypotSystem.getError(), moderationSystem.getError()].filter(Boolean).join('; ') || null);
            });
        }
        return;
    }

    await disconnectBot();
    } finally { syncingState = false; }
}

async function shutdown() {
    try {
        await disconnectBot();
    } finally {
        await getPostgresPool().end();
        process.exit(0);
    }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function main() {
    console.log('RoDark Studios Discord bot worker starting.');
    await syncBotState();
    setInterval(() => {
        syncBotState().catch(async (error) => {
            console.error('Discord bot state sync failed:', error);
            await setDiscordBotRuntimeStatus('error', error.message).catch(() => {});
        });
    }, Number.isFinite(POLL_INTERVAL_MS) && POLL_INTERVAL_MS >= 1000 ? POLL_INTERVAL_MS : 5000);
}

main().catch(async (error) => {
    console.error(error);
    await setDiscordBotRuntimeStatus('error', error.message).catch(() => {});
    process.exitCode = 1;
});
