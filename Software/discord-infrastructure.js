(() => {
    const panel = document.getElementById('discord-tab-infrastructure');
    if (!panel) return;
    const $ = (id) => document.getElementById(id);
    const api = '/api/admin/discord-infrastructure';
    const pending = new Set(['preview_queued', 'previewing', 'deploy_queued', 'applying']);
    const labels = { preview_queued: 'Preview queued — waiting for the bot', previewing: 'Reading the live Discord server…', ready: 'Preview ready',
        deploy_queued: 'Deployment queued', applying: 'Applying changes to Discord…', succeeded: 'Deployment verified', failed: 'Operation needs attention', stale: 'A new preview is needed' };
    let data, working = false, loading = false, renderedVersion = '', timer;
    const textNode = (tag, text, className) => { const node = document.createElement(tag); node.textContent = text; if (className) node.className = className; return node; };
    function list(items) { const node = document.createElement('ul'); for (const item of items) node.append(textNode('li', item)); return node; }
    function renderBlueprint() {
        if (renderedVersion === data.version) return;
        renderedVersion = data.version;
        const layout = $('infra-layout'); layout.replaceChildren();
        for (const category of data.blueprint.channels.filter((channel) => channel.type === 4)) {
            const group = document.createElement('details'); group.open = true;
            group.append(textNode('summary', category.name));
            const children = document.createElement('ul');
            for (const channel of data.blueprint.channels.filter((item) => item.parentKey === category.key)) {
                const row = textNode('li', channel.name);
                const descriptions = [];
                if (channel.type === 15) descriptions.push('Forum');
                if (channel.profile === 'readonly' || channel.profile === 'staff-readonly') descriptions.push('Read only');
                if (channel.profile === 'chat') descriptions.push('Uploads disabled · link previews follow levels');
                if (channel.profile === 'creators') descriptions.push('Creators / staff / owners · 6-hour slowmode');
                if (channel.profile === 'owner-forum') descriptions.push('Owners create posts · everyone can reply');
                if (channel.type === 2) descriptions.push(channel.userLimit ? `${channel.userLimit} people` : 'No user limit');
                if (channel.tags?.length) descriptions.push(channel.tags.map((tag) => `${tag.name}${tag.moderated ? ' (owner)' : ''}`).join(' · '));
                if (descriptions.length) row.append(textNode('small', descriptions.join(' · ')));
                children.append(row);
            }
            if (category.key === 'category:tickets') children.append(textNode('li', 'Private tickets appear here as members open them.'));
            group.append(children); layout.append(group);
        }
        const roles = $('infra-roles'); roles.replaceChildren(textNode('p', 'Owner and the bot retain Administrator above these roles.', 'admin-tool-note'));
        for (const role of data.blueprint.roles) {
            const row = textNode('p', role.name, 'infra-role');
            const dot = document.createElement('span'); dot.className = 'infra-role-dot'; dot.style.backgroundColor = role.color ? `#${role.color.toString(16).padStart(6, '0')}` : '#94a3b8';
            row.prepend(dot);
            if (role.key === 'staff') row.append(textNode('small', 'Moderation permissions only; no server, channel or role management.'));
            if (role.key === 'creator') row.append(textNode('small', 'Manually awarded after an application through 🎫・help.'));
            if (role.managedBooster) row.append(textNode('small', 'Awarded automatically by Discord.'));
            roles.append(row);
        }
        $('infra-onboarding').replaceChildren(textNode('h4', data.blueprint.onboarding.gamesQuestion),
            list(data.blueprint.games.map((game) => game.name)), textNode('p', 'Choose one or more games. Other games remain available in Browse Channels.', 'admin-tool-note'),
            textNode('h4', data.blueprint.onboarding.notificationsQuestion), list(data.blueprint.notifications.map((notice) => notice.name)),
            textNode('p', 'Both questions support multiple choices; notification choices are optional.', 'admin-tool-note'));
    }
    function updateActions() {
        const job = data.jobs[0];
        const running = data.jobs.some((item) => pending.has(item.status));
        const usable = job?.status === 'ready' && job.version === data.version && new Date(job.expires_at).getTime() > Date.now() && !job.plan?.errors?.length;
        $('infra-preview').disabled = working || running;
        $('infra-deploy').disabled = working || running || !usable || !job.plan?.operations?.length;
        $('infra-deploy').textContent = data.initialized ? 'Deploy changes' : 'Rebuild Discord server';
    }
    function render() {
        const job = data.jobs[0];
        const running = data.jobs.some((item) => pending.has(item.status));
        $('infra-release').textContent = `Release ${data.version.slice(0, 10)}`;
        const notice = $('infra-notice');
        notice.className = 'infra-notice';
        if (data.maintenance) {
            notice.textContent = running ? 'The server is being rebuilt. Ticket creation and automatic layout changes are paused until verification finishes.' : 'A rebuild was interrupted. Generate a fresh preview to inspect and complete the remaining changes.';
            notice.classList.add('infra-warning');
        } else if (!data.initialized) {
            notice.textContent = 'FIRST DEPLOY: Existing channels and their message history will be permanently deleted and replaced with this layout. Unlisted editable roles and Bloxlink will be removed. Members, earned XP and retained role assignments stay.';
            notice.classList.add('infra-warning');
        } else if (data.drift) {
            notice.textContent = 'The live server differs from the deployed configuration. Preview changes to review and reconcile it.';
            notice.classList.add('infra-warning');
        } else notice.textContent = data.activeVersion === data.version ? 'The deployed server matches this release. Preview refreshes its live state.' : 'A new configuration is available. Preview its changes before deploying.';
        if (!data.online) notice.append(textNode('p', 'The bot is currently offline or reporting an error. Queued operations run when it is connected.'));
        updateActions();
        const result = $('infra-result'); result.replaceChildren();
        if (job) {
            result.append(textNode('h3', labels[job.status] || job.status));
            if (job.error) result.append(textNode('p', job.error, 'infra-error'));
            if (job.plan) {
                result.append(textNode('p', `${job.plan.counts.create} creations · ${job.plan.counts.update} updates · ${job.plan.counts.remove} removals`, 'infra-counts'));
                if (job.plan.errors.length) { result.append(textNode('h4', 'Resolve before deploying'), list(job.plan.errors)); }
                for (const note of job.plan.notes) result.append(textNode('p', note, 'admin-tool-note'));
                if (job.status === 'ready') {
                    if (!job.plan.operations.length) result.append(textNode('p', 'No changes needed.'));
                    else {
                        const changes = document.createElement('details'); changes.open = true; changes.append(textNode('summary', 'Changes in this preview'));
                        const items = document.createElement('ul');
                        for (const op of job.plan.operations) items.append(textNode('li', op.label, op.kind.startsWith('delete_') || op.kind === 'remove_bot' ? 'infra-removal' : ''));
                        changes.append(items); result.append(changes);
                    }
                    result.append(textNode('p', 'This preview expires after 15 minutes. Discord is checked again before deployment.', 'admin-tool-note'));
                }
            }
            if (job.progress?.length) result.append(textNode('p', job.progress.at(-1).label, 'infra-progress'));
        }
        $('infra-history').replaceChildren(...data.jobs.map((item) => textNode('p', `${new Date(item.created_at).toLocaleString()} — ${labels[item.status] || item.status} — ${item.actor.username || item.actor.id}`)));
        renderBlueprint();
    }
    async function load() {
        if (loading || $('admin-owned-content').classList.contains('hidden')) return;
        loading = true;
        try {
            const response = await fetch(api, { credentials: 'same-origin', cache: 'no-store' });
            const payload = await response.json();
            if (!response.ok) throw new Error(payload.error || 'Unable to load the server layout.');
            data = payload; render();
        } catch (error) { $('infra-notice').textContent = error.message; $('infra-deploy').disabled = true; }
        finally { loading = false; }
    }
    async function request(action) {
        if (working || !data) return;
        working = true; render();
        try {
            const response = await fetch(api, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action, version: data.version, ...(action === 'deploy' ? { previewId: data.jobs[0].id } : {}) }) });
            const payload = await response.json();
            if (!response.ok) throw new Error(payload.error || 'The request failed.');
            await load();
        } catch (error) { $('infra-result').replaceChildren(textNode('p', error.message, 'infra-error')); }
        finally { working = false; if (data) updateActions(); }
    }
    $('infra-preview').addEventListener('click', () => request('preview'));
    $('infra-deploy').addEventListener('click', () => request('deploy'));
    document.querySelector('[data-discord-tab-target="discord-tab-infrastructure"]').addEventListener('click', () => { void load(); });
    timer = setInterval(() => { if (!panel.hidden && !document.hidden) void load(); }, 4000);
    window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
})();
