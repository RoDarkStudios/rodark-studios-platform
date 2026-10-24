(() => {
    const panel = document.getElementById('discord-bot-controls');
    if (!panel) return;
    const ownedContent = document.getElementById('admin-owned-content');
    const button = document.getElementById('infra-deploy');
    const status = document.getElementById('infra-status');
    const api = '/api/admin/discord-infrastructure';
    const pending = new Set(['preview_queued', 'previewing', 'deploy_queued', 'applying']);
    const labels = { preview_queued: 'Preparing deployment…', previewing: 'Checking the server…',
        deploy_queued: 'Deployment queued…', applying: 'Deploying…', succeeded: 'Deployed.',
        failed: 'Deployment needs attention.', stale: 'The server changed. Click Deploy to try again.' };
    let data, working = false, loading = false;

    function render() {
        const job = data.jobs[0];
        const olderFailure = job && ['failed', 'stale'].includes(job.status) && job.version !== data.version;
        button.disabled = working || data.jobs.some((item) => pending.has(item.status));
        button.textContent = button.disabled ? 'Deploying…' : 'Deploy';
        status.textContent = olderFailure
            ? 'The last attempt failed on an older version. Updated code is ready; click Deploy to retry.'
            : job?.error || (job?.status === 'applying' ? job.progress?.at(-1)?.label : '') || labels[job?.status] || '';
        status.classList.toggle('infra-error', Boolean(job?.error));
    }
    async function load() {
        if (loading || ownedContent.classList.contains('hidden')) return;
        loading = true;
        try {
            const response = await fetch(api, { credentials: 'same-origin', cache: 'no-store' });
            const payload = await response.json();
            if (!response.ok) throw new Error(payload.error || 'Unable to load deployment status.');
            data = payload; render();
        } catch (error) {
            status.textContent = error.message; status.classList.add('infra-error'); button.disabled = true;
        } finally { loading = false; }
    }
    button.addEventListener('click', async () => {
        if (working || !data) return;
        working = true; render(); status.textContent = 'Preparing deployment…';
        try {
            const response = await fetch(api, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'deploy', version: data.version }) });
            const payload = await response.json();
            if (!response.ok) throw new Error(payload.error || 'Deployment could not start.');
            data.jobs = [payload.job, ...data.jobs.filter((job) => job.id !== payload.job.id)];
            working = false; render();
        } catch (error) {
            working = false; render(); status.textContent = error.message; status.classList.add('infra-error');
        }
    });
    // Initialize as soon as access is confirmed, without requiring a tab click.
    const readyObserver = new MutationObserver(() => {
        if (!ownedContent.classList.contains('hidden')) {
            readyObserver.disconnect();
            void load();
        }
    });
    if (ownedContent.classList.contains('hidden')) {
        readyObserver.observe(ownedContent, { attributes: true, attributeFilter: ['class'] });
    } else {
        void load();
    }
    const timer = setInterval(() => { if (!panel.hidden && !document.hidden) void load(); }, 4000);
    window.addEventListener('pagehide', () => {
        clearInterval(timer);
        readyObserver.disconnect();
    }, { once: true });
})();
