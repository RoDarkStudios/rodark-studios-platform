const defaultStore = require('../api/_lib/discord-infrastructure-store');
const { compileBlueprint, buildPlan, snapshotHash, channelBody, roleBody, onboardingBody, clone } = require('./server-blueprint');

async function captureSnapshot(rest, guildId, botId, spec) {
    const root = `/guilds/${guildId}`;
    const [rawGuild, roles, channels, self, onboarding, autoMod] = await Promise.all([
        rest.get(root), rest.get(`${root}/roles`), rest.get(`${root}/channels`), rest.get(`${root}/members/${botId}`),
        rest.get(`${root}/onboarding`).catch((error) => { if (error.status === 404) return { enabled: false, prompts: [], default_channel_ids: [] }; throw error; }),
        rest.get(`${root}/auto-moderation/rules`)
    ]);
    const guild = Object.fromEntries(['id', 'name', 'owner_id', 'features', 'verification_level', 'explicit_content_filter',
        'default_message_notifications', 'rules_channel_id', 'public_updates_channel_id', 'safety_alerts_channel_id'].map((key) => [key, rawGuild[key] ?? null]));
    guild.features = [...(guild.features || [])].sort();
    const removableBots = {};
    for (const role of roles.filter((item) => item.tags?.bot_id && spec.bootstrap.removeBotRoleNames.some((name) => name.toLowerCase() === item.name.toLowerCase()))) {
        removableBots[role.tags.bot_id] = await rest.get(`${root}/members/${role.tags.bot_id}`).catch((error) => { if (error.status === 404) return null; throw error; });
    }
    return { guild, roles: roles.sort((a, b) => a.id.localeCompare(b.id)), channels, self: { roles: [...self.roles].sort(), user: { id: self.user.id } }, onboarding, autoMod, removableBots };
}

function controlWithLayout(control, active) {
    if (!active) return control;
    const c = active.bindings.channel, r = active.bindings.role;
    return { ...control, guildId: active.spec.guildId,
        infrastructure: active,
        startupContentSync: { rulesChannelId: c.rules, infoChannelId: c.info, rolesChannelId: c.roles, staffInfoChannelId: c['staff-info'], gameTestInfoChannelId: '' },
        ticketSystem: { ...control.ticketSystem, categoryChannelId: c['category:tickets'], panelChannelId: c.help, helperRoleIds: [r.staff] },
        levelSystem: { ...control.levelSystem, enabled: true, announcementChannelId: c['level-ups'] },
        gameUpdates: { ...control.gameUpdates, channelId: c['game-updates'], pingEveryoneEnabled: false }
    };
}

function operationPriority(op, blueprint) {
    if (op.kind === 'channel') {
        const type = blueprint.channels.find((channel) => channel.key === op.key).type;
        return type === 4 ? 20 : [0, 2].includes(type) ? 30 : 50;
    }
    return { remove_bot: 5, role: 10, everyone: 15, guild: 40, delete_automod: 55,
        delete_channel: 60, delete_role: 65, sort_roles: 70, sort_channels: 75, content: 80, onboarding: 90 }[op.kind] ?? 100;
}

async function applyPlan({ blueprint, plan, snapshot, rest, saveResources, finishContent, closeTicket, progress, guard }) {
    const bindings = clone(plan.bindings);
    const root = `/guilds/${blueprint.guildId}`;
    const reason = 'Apply reviewed RoDark Studios server configuration';
    const write = async (method, path, body) => {
        guard();
        try { return await rest[method](path, { ...(body !== undefined ? { body } : {}), reason }); }
        catch (error) { if (method === 'delete' && error.status === 404) return null; throw error; }
    };
    const operations = [...plan.operations].sort((a, b) => operationPriority(a, blueprint) - operationPriority(b, blueprint));
    if (snapshot.onboarding.enabled && operations.some((op) => ['delete_channel', 'onboarding'].includes(op.kind))) {
        await write('put', `${root}/onboarding`, { enabled: false });
        await progress({ label: 'Temporarily pause onboarding while its channels are replaced' });
    }
    for (const [index, op] of operations.entries()) {
        guard();
        if (op.kind === 'role') {
            const role = blueprint.roles.find((item) => item.key === op.key);
            const currentId = bindings.role[op.key];
            const result = await write(currentId ? 'patch' : 'post', currentId ? `${root}/roles/${currentId}` : `${root}/roles`, roleBody(role));
            bindings.role[op.key] = result.id;
            await saveResources(bindings);
        } else if (op.kind === 'everyone') {
            await write('patch', `${root}/roles/${blueprint.guildId}`, { permissions: blueprint.everyonePermissions });
        } else if (op.kind === 'channel') {
            const channel = blueprint.channels.find((item) => item.key === op.key);
            const currentId = bindings.channel[op.key];
            const existing = currentId ? await rest.get(`/channels/${currentId}`) : null;
            const payload = channelBody(channel, bindings, existing);
            // Avoid disarming an already armed trap for an unrelated channel edit.
            if (existing && channel.profile === 'honeypot') delete payload.permission_overwrites;
            const result = await write(currentId ? 'patch' : 'post', currentId ? `/channels/${currentId}` : `${root}/channels`, payload);
            bindings.channel[op.key] = result.id;
            bindings.tag ||= {};
            for (const tag of channel.tags || []) {
                const actual = result.available_tags?.find((item) => item.name === tag.name);
                if (actual) bindings.tag[`${channel.key}/${tag.key}`] = actual.id;
            }
            await saveResources(bindings);
            // REQUIRE_TAG is an edit setting on Discord versions that omit it at creation.
            if (!currentId && channel.type === 15 && payload.flags) await write('patch', `/channels/${result.id}`, { flags: payload.flags });
        } else if (op.kind === 'guild') {
            await write('patch', root, { ...blueprint.spec.settings, name: blueprint.spec.name,
                rules_channel_id: bindings.channel.rules, public_updates_channel_id: bindings.channel['staff-info'], safety_alerts_channel_id: bindings.channel['moderation-log'],
                ...(!snapshot.guild.features.includes('COMMUNITY') ? { features: ['COMMUNITY'] } : {}) });
        } else if (op.kind === 'delete_channel') {
            await write('delete', `/channels/${op.id}`);
            await closeTicket(op.id);
        } else if (op.kind === 'delete_role') {
            await write('delete', `${root}/roles/${op.id}`);
        } else if (op.kind === 'remove_bot') {
            await write('delete', `${root}/members/${op.id}`);
        } else if (op.kind === 'delete_automod') {
            await write('delete', `${root}/auto-moderation/rules/${op.id}`);
        } else if (op.kind === 'sort_roles') {
            const rows = [...blueprint.roles].reverse().filter((role) => bindings.role[role.key]).map((role, i) => ({ id: bindings.role[role.key], position: i + 1 }));
            await write('patch', `${root}/roles`, rows);
        } else if (op.kind === 'sort_channels') {
            await write('patch', `${root}/channels`, blueprint.channels.map((channel) => ({ id: bindings.channel[channel.key], position: channel.position,
                ...(channel.parentKey ? { parent_id: bindings.channel[channel.parentKey], lock_permissions: false } : {}) })));
        } else if (op.kind === 'content') {
            await finishContent({ version: blueprint.version, spec: blueprint.spec, bindings });
        } else if (op.kind === 'onboarding') {
            const current = await rest.get(`${root}/onboarding`);
            const updated = await write('put', `${root}/onboarding`, onboardingBody(blueprint, bindings, current));
            bindings.prompt ||= {}; bindings.option ||= {};
            for (const [index, key] of ['games', 'notifications'].entries()) {
                const prompt = updated.prompts[index]; bindings.prompt[key] = prompt.id;
                const choices = index === 0 ? blueprint.spec.games : blueprint.spec.notifications;
                choices.forEach((choice, choiceIndex) => { bindings.option[`${key}/${choice.key}`] = prompt.options[choiceIndex].id; });
            }
            await saveResources(bindings);
        } else throw new Error(`Unsupported deployment operation: ${op.kind}`);
        await progress({ label: op.label, completed: index + 1, total: operations.length });
    }
    // A channel removal may pause onboarding even when the questions themselves are unchanged.
    if (snapshot.onboarding.enabled && operations.some((op) => op.kind === 'delete_channel') && !operations.some((op) => op.kind === 'onboarding')) {
        await write('put', `${root}/onboarding`, { enabled: true });
    }
    return bindings;
}

function createInfrastructureWorker(client, { store = defaultStore, finishContent, closeTicket, beforeApply, onProgress, logger = console, now = Date.now } = {}) {
    let busy = false, lastDriftCheck = 0, dirty = true, currentState = null;
    async function tick(control, ordinarySync) {
        if (busy || !client.isReady()) return;
        busy = true;
        try {
            const blueprint = compileBlueprint(control);
            if (control.guildId && control.guildId !== blueprint.guildId) throw new Error('Configured bot guild differs from discord/server.json.');
            if (!client.guilds.cache.has(blueprint.guildId)) throw new Error('The bot is not in the server defined in discord/server.json.');
            currentState = await store.getState(blueprint.guildId);
            if (currentState.maintenance) await beforeApply?.();
            await store.withGuildLock(blueprint.guildId, async (lease) => {
                await store.recoverInterrupted(blueprint.guildId);
                currentState = await store.getState(blueprint.guildId);
                const job = await store.claimJob(blueprint.guildId);
                if (job) {
                    try {
                        if (job.version !== blueprint.version) {
                            await store.finish(job.id, 'stale', 'The website and bot configuration changed or have not finished deploying. Refresh and generate a new preview.');
                            return;
                        }
                        const tickets = await store.openTicketIds(blueprint.guildId);
                        const snapshot = await captureSnapshot(client.rest, blueprint.guildId, client.user.id, blueprint.spec);
                        if (job.status === 'previewing') {
                            const plan = buildPlan(blueprint, snapshot, currentState, tickets);
                            await store.ready(job.id, plan);
                        } else {
                            if (!job.plan || job.plan.errors.length || new Date(job.expires_at).getTime() <= now() ||
                                job.plan.fingerprint !== snapshotHash(snapshot, tickets, job.plan.initial)) {
                                await store.finish(job.id, 'stale', 'Discord changed since this preview, or the preview expired. Generate a fresh preview before deploying.');
                                return;
                            }
                            // Recompute trusted operations; never execute plan data supplied by a browser.
                            const plan = buildPlan(blueprint, snapshot, currentState, tickets);
                            if (plan.errors.length) throw new Error(plan.errors.join(' '));
                            lease.assertHeld();
                            await store.beginApply(blueprint.guildId, plan.bindings);
                            currentState = { ...currentState, maintenance: true };
                            await beforeApply?.();
                            const bindings = await applyPlan({ blueprint, plan, snapshot, rest: client.rest,
                                guard: lease.assertHeld,
                                saveResources: (resources) => store.saveResources(blueprint.guildId, resources),
                                progress: async (entry) => { await store.progress(job.id, entry); await onProgress?.(); },
                                finishContent: (active) => finishContent(active, job.actor), closeTicket });
                            const live = await captureSnapshot(client.rest, blueprint.guildId, client.user.id, blueprint.spec);
                            const verified = buildPlan(blueprint, live, { initialized: true, resources: bindings, active: { version: blueprint.version } }, await store.openTicketIds(blueprint.guildId));
                            if (verified.errors.length || verified.operations.length) throw new Error(`Verification found remaining changes: ${[...verified.errors, ...verified.operations.map((op) => op.label)].slice(0, 8).join('; ')}. Generate a new preview to finish.`);
                            await store.activate(blueprint.guildId, { version: blueprint.version, spec: blueprint.spec, bindings }, bindings);
                            await store.finish(job.id, 'succeeded');
                            dirty = false; lastDriftCheck = now();
                        }
                    } catch (error) {
                        logger.error('[server-infrastructure]', error);
                        await store.finish(job.id, 'failed', error.message);
                    }
                    currentState = await store.getState(blueprint.guildId);
                }
                if (currentState.maintenance) return;
                const effective = controlWithLayout(control, currentState.active);
                await ordinarySync?.(effective);
                // Event-driven invalidation plus a periodic refresh also catches events lost on reconnect.
                if (currentState.initialized && now() - lastDriftCheck > (dirty ? 30_000 : 5 * 60_000)) {
                    const deployed = compileBlueprint(control, currentState.active.spec);
                    const live = await captureSnapshot(client.rest, blueprint.guildId, client.user.id, deployed.spec);
                    const plan = buildPlan(deployed, live, currentState, await store.openTicketIds(blueprint.guildId));
                    await store.setDrift(blueprint.guildId, plan.operations.length || plan.errors.length ? {
                        changes: plan.operations.map((op) => op.label), errors: plan.errors, detectedAt: new Date(now()).toISOString()
                    } : null);
                    dirty = false; lastDriftCheck = now();
                }
            });
        } finally { busy = false; }
    }
    return { tick, markDirty: () => { dirty = true; }, getState: () => currentState, isBusy: () => busy,
        effectiveControl: (control) => controlWithLayout(control, currentState?.active) };
}

module.exports = { captureSnapshot, applyPlan, createInfrastructureWorker, controlWithLayout, operationPriority };
