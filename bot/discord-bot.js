const { Client, GatewayIntentBits } = require('discord.js');
const { getDiscordBotControl, setDiscordBotRuntimeStatus } = require('../api/_lib/discord-bot-control-store');
const { getPostgresPool } = require('../api/_lib/postgres');
const { runStartupSync } = require('./discord-startup-sync');
const { ensureTicketPanel, getTicketSystemControl, handleTicketInteraction } = require('./tickets');
const { ensureBugPayoutCommand, handleAddPayoutInteraction } = require('./bug-payouts');
const { ensureLevelSystem, getLevelSystemSyncKey, handleLevelMessage } = require('./levels');
const { ensureChannelPurgeCommand, handleChannelPurgeInteraction } = require('./channel-purge');
const {
    getLeaderboardRoleSyncKey,
    resetLeaderboardRoleSyncState,
    syncLeaderboardRoleIfNeeded
} = require('./leaderboard-role');

const POLL_INTERVAL_MS = Number.parseInt(process.env.DISCORD_BOT_POLL_INTERVAL_MS || '5000', 10);
const DISCORD_BOT_TOKEN = String(process.env.DISCORD_BOT_TOKEN || '').trim();

let client = null;
let connecting = false;
let currentControl = null;
let lastTicketPanelSyncKey = '';
let lastTicketPanelSyncAt = 0;
let lastLevelSystemSyncKey = '';
let lastLevelSystemSyncAt = 0;
let lastLeaderboardRoleSyncKey = '';
let lastLeaderboardRoleSyncAt = 0;

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
    if (!ticketSystem.categoryChannelId || !ticketSystem.panelChannelId) {
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

async function syncLeaderboardRoleSettingsIfNeeded(nextClient, control, options) {
    if (!nextClient || !nextClient.isReady()) {
        return;
    }

    const syncKey = getLeaderboardRoleSyncKey(control);
    const force = Boolean(options && options.force);
    const now = Date.now();
    if (!force && syncKey === lastLeaderboardRoleSyncKey && now - lastLeaderboardRoleSyncAt < 60 * 1000) {
        await syncLeaderboardRoleIfNeeded(nextClient, control);
        return;
    }

    await syncLeaderboardRoleIfNeeded(nextClient, control, { force: true });
    lastLeaderboardRoleSyncKey = syncKey;
    lastLeaderboardRoleSyncAt = now;
}

function createClient() {
    const nextClient = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent
        ]
    });

    nextClient.once('ready', async () => {
        const tag = nextClient.user && nextClient.user.tag ? nextClient.user.tag : 'Discord bot';
        console.log(`${tag} is online.`);
        await setDiscordBotRuntimeStatus('online', null);

        try {
            const control = currentControl || await getDiscordBotControl();
            currentControl = control;
            await runStartupSync(nextClient, control);
            await syncTicketPanelIfNeeded(nextClient, control, { force: true });
            await syncLevelSystemIfNeeded(nextClient, control, { force: true });
            await ensureChannelPurgeCommand(nextClient, control, { force: true });
            await ensureBugPayoutCommand(nextClient, control, { force: true });
            await syncLeaderboardRoleSettingsIfNeeded(nextClient, control, { force: true });
            await setDiscordBotRuntimeStatus('online', null);
        } catch (error) {
            console.error('Discord startup sync failed:', error);
            await setDiscordBotRuntimeStatus('online', `Startup sync failed: ${String(error.message || 'unknown error')}`);
        }
    });

    nextClient.on('interactionCreate', async (interaction) => {
        try {
            const control = currentControl || await getDiscordBotControl();
            currentControl = control;
            const ticketHandled = await handleTicketInteraction(interaction, control);
            if (ticketHandled) {
                await setDiscordBotRuntimeStatus('online', null);
                return;
            }

            const purgeHandled = await handleChannelPurgeInteraction(interaction);
            if (purgeHandled) {
                await setDiscordBotRuntimeStatus('online', null);
                return;
            }

            const payoutHandled = await handleAddPayoutInteraction(interaction, control);
            if (payoutHandled) {
                await setDiscordBotRuntimeStatus('online', null);
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
            const control = currentControl || await getDiscordBotControl();
            currentControl = control;
            const handled = await handleLevelMessage(message, control);
            if (handled) {
                await setDiscordBotRuntimeStatus('online', null);
            }
        } catch (error) {
            console.error('Discord level system message handling failed:', error);
            await setDiscordBotRuntimeStatus('error', error.message).catch(() => {});
        }
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

    if (currentClient) {
        currentClient.removeAllListeners();
        await currentClient.destroy();
    }

    await setDiscordBotRuntimeStatus('offline', null);
    lastTicketPanelSyncKey = '';
    lastTicketPanelSyncAt = 0;
    lastLevelSystemSyncKey = '';
    lastLevelSystemSyncAt = 0;
    lastLeaderboardRoleSyncKey = '';
    lastLeaderboardRoleSyncAt = 0;
    resetLeaderboardRoleSyncState();
    currentControl = null;
    console.log('Discord bot is offline.');
}

async function syncBotState() {
    const control = await getDiscordBotControl();
    currentControl = control;
    if (control && control.desiredEnabled) {
        await connectBot();
        if (client && client.isReady()) {
            await syncTicketPanelIfNeeded(client, control);
            await syncLevelSystemIfNeeded(client, control);
            await ensureChannelPurgeCommand(client, control);
            await ensureBugPayoutCommand(client, control);
            await syncLeaderboardRoleSettingsIfNeeded(client, control);
        }
        return;
    }

    await disconnectBot();
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
    console.log('RoDark Discord bot worker starting.');
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
