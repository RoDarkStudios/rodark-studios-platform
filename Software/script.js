async function postJson(url, payload) {
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify(payload || {})
    });

    let data = {};
    try {
        data = await response.json();
    } catch (error) {
        data = {};
    }

    if (!response.ok) {
        const errorMessage = data.error || `Request failed (${response.status})`;
        const error = new Error(errorMessage);
        error.status = response.status;
        error.data = data;
        throw error;
    }

    return data;
}

function getUserUsername(user) {
    if (user && typeof user.username === 'string' && user.username.trim()) {
        return user.username.trim();
    }

    if (!user || !user.user_metadata || typeof user.user_metadata.username !== 'string') {
        return '';
    }

    return user.user_metadata.username.trim();
}

function setAdminTabVisibility(isVisible) {
    const navAdminItem = document.getElementById('nav-admin-item');
    if (!navAdminItem) {
        return;
    }

    if (isVisible) {
        navAdminItem.classList.remove('hidden');
        return;
    }

    navAdminItem.classList.add('hidden');
}

function readAuthStatusFromQuery() {
    const params = new URLSearchParams(window.location.search);
    const hasAuthParams = params.has('auth') || params.has('reason');
    if (!hasAuthParams) {
        return;
    }

    params.delete('auth');
    params.delete('reason');
    const cleanedSearch = params.toString();
    const nextUrl = `${window.location.pathname}${cleanedSearch ? `?${cleanedSearch}` : ''}${window.location.hash}`;
    window.history.replaceState({}, '', nextUrl);
}

function setNavbarUsername(user) {
    const navUsername = document.getElementById('nav-username');
    const navSignoutBtn = document.getElementById('nav-signout-btn');
    if (!navUsername) {
        return;
    }

    const username = getUserUsername(user);
    if (username) {
        navUsername.textContent = `@${username}`;
        navUsername.classList.remove('guest');
        navUsername.removeAttribute('aria-label');
        if (navSignoutBtn) {
            navSignoutBtn.classList.remove('hidden');
        }
        return;
    }

    navUsername.textContent = 'Sign in with Roblox';
    navUsername.classList.add('guest');
    navUsername.setAttribute('aria-label', 'Sign in with Roblox');
    if (navSignoutBtn) {
        navSignoutBtn.classList.add('hidden');
    }
}

function setAuthUi(user) {
    setNavbarUsername(user);
    setAdminTabVisibility(false);
}

async function fetchAdminStatus() {
    try {
        const response = await fetchWithTimeout('/api/auth/admin', {
            method: 'GET',
            credentials: 'include'
        }, 8000);

        if (!response.ok) {
            return { isAdmin: false };
        }

        const data = await response.json();
        return {
            isAdmin: Boolean(data && data.isAdmin)
        };
    } catch (error) {
        return { isAdmin: false };
    }
}

async function refreshAuthUi() {
    try {
        const response = await fetch('/api/auth/me', {
            method: 'GET',
            credentials: 'include'
        });

        if (!response.ok) {
            setAuthUi(null);
            return;
        }

        const data = await response.json();
        const user = data.user || null;
        setAuthUi(user);

        if (!user) {
            return;
        }

        const adminStatus = await fetchAdminStatus();
        setAdminTabVisibility(adminStatus.isAdmin);
    } catch (error) {
        setAuthUi(null);
    }
}

function handleRobloxLogin() {
    const returnTo = `${window.location.pathname}${window.location.search}`;
    const loginUrl = `/api/auth/login?returnTo=${encodeURIComponent(returnTo || '/')}`;
    window.location.href = loginUrl;
}

async function handleSignOut() {
    const navSignoutBtn = document.getElementById('nav-signout-btn');
    if (!navSignoutBtn) {
        return;
    }

    navSignoutBtn.disabled = true;

    try {
        await postJson('/api/auth/logout', {});
    } catch (error) {
        // Keep UI consistent even if backend signout fails unexpectedly.
    } finally {
        await refreshAuthUi();
        navSignoutBtn.disabled = false;
    }
}

function setDiscordBotStatusCard(title, detail, dotClass) {
    const statusDot = document.getElementById('discord-bot-status-dot');
    const statusTitle = document.getElementById('discord-bot-status-title');
    const statusDetail = document.getElementById('discord-bot-status-detail');

    if (statusDot) {
        statusDot.className = `admin-discord-status-dot ${dotClass || ''}`.trim();
    }
    if (statusTitle) {
        statusTitle.textContent = title || 'Discord bot status';
    }
    if (statusDetail) {
        statusDetail.textContent = detail || '';
    }
}

function initAuth() {
    const navUsername = document.getElementById('nav-username');
    const navSignoutBtn = document.getElementById('nav-signout-btn');

    readAuthStatusFromQuery();
    refreshAuthUi();

    if (navUsername) {
        navUsername.addEventListener('click', () => {
            if (navUsername.classList.contains('guest')) {
                handleRobloxLogin();
            }
        });
    }

    if (navSignoutBtn) {
        navSignoutBtn.addEventListener('click', handleSignOut);
    }
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

async function initAdminHome() {
    const ownedContent = document.getElementById('admin-home-content');
    if (!ownedContent) {
        return;
    }

    const deniedElement = document.getElementById('admin-access-denied');
    const adminStatus = await fetchAdminStatus();
    if (!adminStatus || !adminStatus.isAdmin) {
        ownedContent.classList.add('hidden');
        if (deniedElement) {
            deniedElement.classList.remove('hidden');
        }
        return;
    }

    ownedContent.classList.remove('hidden');
    if (deniedElement) {
        deniedElement.classList.add('hidden');
    }
}

function formatDiscordBotStatus(control) {
    if (!control || typeof control !== 'object') {
        return {
            title: 'Discord bot status',
            detail: 'Bot control state is unavailable.',
            dotClass: 'error',
            buttonText: 'Connect bot',
            desiredEnabled: false
        };
    }

    const desiredEnabled = Boolean(control.desiredEnabled);
    const runtimeStatus = String(control.runtimeStatus || 'offline').toLowerCase();
    const statusLabel = runtimeStatus.charAt(0).toUpperCase() + runtimeStatus.slice(1);
    const desiredLabel = desiredEnabled ? 'Connect requested' : 'Disconnect requested';
    const lastSeen = control.lastSeenAt ? ` Last seen: ${new Date(control.lastSeenAt).toLocaleString()}.` : '';
    const lastError = control.lastError ? ` Error: ${control.lastError}` : '';

    return {
        title: `Discord bot: ${statusLabel}`,
        detail: `${desiredLabel}.${lastSeen}${lastError}`,
        dotClass: runtimeStatus === 'online' ? 'online' : (runtimeStatus === 'connecting' ? 'connecting' : (runtimeStatus === 'error' ? 'error' : '')),
        buttonText: desiredEnabled ? 'Disconnect bot' : 'Connect bot',
        desiredEnabled
    };
}

function renderDiscordBotControl(control) {
    const formatted = formatDiscordBotStatus(control);
    setDiscordBotStatusCard(formatted.title, formatted.detail, formatted.dotClass);
    const toggleButton = document.getElementById('discord-bot-toggle-btn');
    if (toggleButton) {
        toggleButton.textContent = formatted.buttonText;
        toggleButton.dataset.desiredEnabled = formatted.desiredEnabled ? 'true' : 'false';
        toggleButton.disabled = Boolean(control?.serverLayoutMaintenance);
    }
}

function setDiscordBotStatusMessage(message, type) {
    const statusElement = document.getElementById('discord-bot-status-message');
    if (!statusElement) {
        return;
    }

    if (!message) {
        statusElement.textContent = '';
        statusElement.className = 'admin-status info hidden';
        return;
    }

    statusElement.textContent = message;
    statusElement.className = `admin-status ${type || 'info'}`;
}

function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
        controller.abort();
    }, Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : 12000);
    const settings = {
        ...(options || {}),
        signal: controller.signal
    };

    return fetch(url, settings).finally(() => {
        window.clearTimeout(timeoutId);
    });
}

async function fetchDiscordBotControl() {
    const response = await fetchWithTimeout('/api/admin/discord-bot-control', {
        method: 'GET', credentials: 'include'
    }, 12000);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Discord bot status failed (${response.status})`);
    return payload;
}

async function setDiscordBotDesiredState(desiredEnabled) {
    return postJson('/api/admin/discord-bot-control', { desiredEnabled });
}

const DISCORD_TICKET_TRANSCRIPT_PAGE_SIZE = 50;

async function fetchDiscordTicketTranscripts(offset) {
    const requestUrl = `/api/admin/discord-bot-control?ticketTranscripts=1&limit=${DISCORD_TICKET_TRANSCRIPT_PAGE_SIZE}&offset=${encodeURIComponent(String(offset || 0))}`;
    const response = await fetch(requestUrl, {
        method: 'GET',
        credentials: 'include'
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(payload.error || `Ticket transcripts failed (${response.status})`);
    }

    return Array.isArray(payload.transcripts) ? payload.transcripts : [];
}

async function fetchDiscordTicketTranscript(ticketId) {
    const response = await fetch(`/api/admin/discord-bot-control?ticketTranscriptId=${encodeURIComponent(String(ticketId))}`, {
        method: 'GET',
        credentials: 'include'
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(payload.error || `Ticket transcript failed (${response.status})`);
    }

    return payload.transcript || null;
}

function formatTicketTranscriptDate(value) {
    if (!value) {
        return 'Unknown time';
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return 'Unknown time';
    }

    return date.toLocaleString();
}

function renderDiscordTicketTranscriptList(transcripts, selectedTicketId) {
    const listElement = document.getElementById('discord-ticket-transcripts-list');
    if (!listElement) {
        return;
    }

    listElement.innerHTML = '';

    if (!Array.isArray(transcripts) || !transcripts.length) {
        const empty = document.createElement('p');
        empty.className = 'admin-ticket-transcript-empty';
        empty.textContent = 'No closed ticket transcripts yet.';
        listElement.appendChild(empty);
        return;
    }

    transcripts.forEach((transcript) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'admin-ticket-transcript-item';
        if (String(transcript.ticketId) === String(selectedTicketId || '')) {
            button.classList.add('is-active');
        }
        button.dataset.ticketId = String(transcript.ticketId);

        const title = document.createElement('span');
        title.className = 'admin-ticket-transcript-title';
        title.textContent = transcript.channelName
            ? `#${transcript.channelName}`
            : `Ticket ${transcript.ticketId}`;

        const meta = document.createElement('span');
        meta.className = 'admin-ticket-transcript-meta';
        meta.textContent = `${formatTicketTranscriptDate(transcript.closedAt)} · ${Number(transcript.messageCount) || 0} messages`;

        button.appendChild(title);
        button.appendChild(meta);
        listElement.appendChild(button);
    });
}

function renderDiscordTicketTranscriptDetail(transcript) {
    const viewer = document.getElementById('discord-ticket-transcript-viewer');
    if (!viewer) {
        return;
    }

    viewer.innerHTML = '';

    if (!transcript) {
        viewer.textContent = 'Select a transcript to view it.';
        return;
    }

    const heading = document.createElement('h3');
    heading.className = 'admin-tool-title';
    heading.textContent = transcript.channelName ? `#${transcript.channelName}` : `Ticket ${transcript.ticketId}`;
    viewer.appendChild(heading);

    const meta = document.createElement('p');
    meta.className = 'admin-ticket-transcript-meta';
    meta.textContent = `Closed ${formatTicketTranscriptDate(transcript.closedAt)} · ${Number(transcript.messageCount) || 0} messages`;
    viewer.appendChild(meta);

    const messages = Array.isArray(transcript.messages) ? transcript.messages : [];
    if (!messages.length) {
        const empty = document.createElement('p');
        empty.className = 'admin-ticket-transcript-empty';
        empty.textContent = 'This transcript has no saved messages.';
        viewer.appendChild(empty);
        return;
    }

    messages.forEach((message) => {
        const item = document.createElement('article');
        item.className = 'admin-ticket-transcript-message';

        const author = document.createElement('div');
        author.className = 'admin-ticket-transcript-author';
        author.textContent = `${message.authorTag || 'Unknown'} · ${formatTicketTranscriptDate(message.createdAt)}`;
        item.appendChild(author);

        const content = document.createElement('div');
        content.className = 'admin-ticket-transcript-content';
        content.textContent = message.content || '';
        item.appendChild(content);

        (Array.isArray(message.embeds) ? message.embeds : []).forEach((embed) => {
            const embedText = [embed.title, embed.description]
                .filter(Boolean)
                .join('\n');
            if (!embedText) {
                return;
            }

            const embedBlock = document.createElement('div');
            embedBlock.className = 'admin-ticket-transcript-content';
            embedBlock.textContent = embedText;
            item.appendChild(embedBlock);
        });

        (Array.isArray(message.attachments) ? message.attachments : []).forEach((attachment) => {
            const link = document.createElement('a');
            link.className = 'admin-ticket-transcript-attachment';
            link.href = attachment.url || '#';
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = attachment.name ? `Attachment: ${attachment.name}` : 'Attachment';
            item.appendChild(link);
        });

        viewer.appendChild(item);
    });
}

async function initDiscordBotDashboard() {
    const dashboard = document.getElementById('discord-bot-dashboard');
    const ownedContent = document.getElementById('admin-owned-content');
    if (!dashboard || !ownedContent) {
        return;
    }

    const deniedElement = document.getElementById('admin-access-denied');
    const toggleButton = document.getElementById('discord-bot-toggle-btn');
    const ticketTranscriptsRefreshButton = document.getElementById('discord-ticket-transcripts-refresh-btn');
    const ticketTranscriptsLoadMoreButton = document.getElementById('discord-ticket-transcripts-load-more-btn');
    const ticketTranscriptsList = document.getElementById('discord-ticket-transcripts-list');
    const ticketTranscriptViewer = document.getElementById('discord-ticket-transcript-viewer');
    const adminStatus = await fetchAdminStatus();
    const isAdmin = Boolean(adminStatus && adminStatus.isAdmin);

    if (!isAdmin) {
        ownedContent.classList.add('hidden');
        if (deniedElement) {
            deniedElement.classList.remove('hidden');
        }
        return;
    }

    if (deniedElement) {
        deniedElement.classList.add('hidden');
    }
    ownedContent.classList.remove('hidden');
    let currentTicketTranscriptId = '';
    let currentTicketTranscripts = [];
    let ticketTranscriptOffset = 0;
    let hasMoreTicketTranscripts = false;

    function activateDiscordDashboardTab(targetId) {
        const tabButtons = Array.from(dashboard.querySelectorAll('[data-discord-tab-target]'));
        const tabPanels = Array.from(dashboard.querySelectorAll('.admin-discord-tab-panel'));

        tabButtons.forEach((button) => {
            const isActive = String(button.dataset.discordTabTarget || '') === String(targetId);
            button.classList.toggle('is-active', isActive);
            button.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });

        tabPanels.forEach((panel) => {
            const isActive = panel.id === targetId;
            panel.classList.toggle('is-active', isActive);
            panel.hidden = !isActive;
        });
    }

    async function refreshControl() {
        try {
            const control = await fetchDiscordBotControl();
            renderDiscordBotControl(control.control);
            setDiscordBotStatusMessage('', 'info');
        } catch (error) {
            setDiscordBotStatusCard(
                'Discord bot: unavailable',
                error.message || 'Failed to load Discord bot status.',
                'error'
            );
            if (toggleButton) {
                toggleButton.disabled = true;
            }
            setDiscordBotStatusMessage(error.message || 'Failed to load Discord bot status.', 'error');
        }
    }

    async function refreshTicketTranscripts(options) {
        if (!ticketTranscriptsList) {
            return;
        }

        const append = Boolean(options && options.append);
        if (ticketTranscriptsRefreshButton) {
            ticketTranscriptsRefreshButton.disabled = true;
        }
        if (ticketTranscriptsLoadMoreButton) {
            ticketTranscriptsLoadMoreButton.disabled = true;
        }

        try {
            const nextOffset = append ? ticketTranscriptOffset : 0;
            const transcripts = await fetchDiscordTicketTranscripts(nextOffset);
            currentTicketTranscripts = append
                ? currentTicketTranscripts.concat(transcripts)
                : transcripts;
            ticketTranscriptOffset = currentTicketTranscripts.length;
            hasMoreTicketTranscripts = transcripts.length === DISCORD_TICKET_TRANSCRIPT_PAGE_SIZE;
            renderDiscordTicketTranscriptList(currentTicketTranscripts, currentTicketTranscriptId);
            if (!currentTicketTranscriptId && ticketTranscriptViewer) {
                renderDiscordTicketTranscriptDetail(null);
            }
            if (ticketTranscriptsLoadMoreButton) {
                ticketTranscriptsLoadMoreButton.classList.toggle('hidden', !hasMoreTicketTranscripts);
            }
        } catch (error) {
            ticketTranscriptsList.textContent = error.message || 'Failed to load ticket transcripts.';
        } finally {
            if (ticketTranscriptsRefreshButton) {
                ticketTranscriptsRefreshButton.disabled = false;
            }
            if (ticketTranscriptsLoadMoreButton) {
                ticketTranscriptsLoadMoreButton.disabled = false;
            }
        }
    }

    if (toggleButton) {
        toggleButton.addEventListener('click', async () => {
            const currentlyDesiredEnabled = toggleButton.dataset.desiredEnabled === 'true';
            const nextDesiredEnabled = !currentlyDesiredEnabled;
            toggleButton.disabled = true;
            setDiscordBotStatusMessage(nextDesiredEnabled ? 'Connecting bot...' : 'Disconnecting bot...', 'info');

            try {
                const control = await setDiscordBotDesiredState(nextDesiredEnabled);
                renderDiscordBotControl(control.control);
                setDiscordBotStatusMessage(nextDesiredEnabled
                    ? 'Connect requested. The bot service will come online shortly.'
                    : 'Disconnect requested. The bot service will go offline shortly.', 'success');
            } catch (error) {
                setDiscordBotStatusMessage(error.message || 'Failed to update Discord bot.', 'error');
            } finally {
                toggleButton.disabled = false;
            }
        });
    }

    dashboard.querySelectorAll('[data-discord-tab-target]').forEach((button) => {
        button.addEventListener('click', () => {
            const targetId = String(button.dataset.discordTabTarget || '');
            if (targetId) {
                activateDiscordDashboardTab(targetId);
            }
        });
    });

    if (ticketTranscriptsRefreshButton) {
        ticketTranscriptsRefreshButton.addEventListener('click', () => {
            currentTicketTranscriptId = '';
            refreshTicketTranscripts();
        });
    }

    if (ticketTranscriptsLoadMoreButton) {
        ticketTranscriptsLoadMoreButton.addEventListener('click', () => {
            refreshTicketTranscripts({ append: true });
        });
    }

    if (ticketTranscriptsList) {
        ticketTranscriptsList.addEventListener('click', async (event) => {
            const item = event.target && event.target.closest
                ? event.target.closest('.admin-ticket-transcript-item')
                : null;
            if (!item) {
                return;
            }

            currentTicketTranscriptId = String(item.dataset.ticketId || '');
            renderDiscordTicketTranscriptList(currentTicketTranscripts, currentTicketTranscriptId);

            if (ticketTranscriptViewer) {
                ticketTranscriptViewer.textContent = 'Loading transcript...';
            }

            try {
                const transcript = await fetchDiscordTicketTranscript(currentTicketTranscriptId);
                renderDiscordTicketTranscriptDetail(transcript);
            } catch (error) {
                if (ticketTranscriptViewer) {
                    ticketTranscriptViewer.textContent = error.message || 'Failed to load ticket transcript.';
                }
            }
        });
    }

    await refreshControl();
    await refreshTicketTranscripts();
    window.setInterval(refreshControl, 5000);
}

// Age calculation function
function calculateAge(birthDate) {
    const today = new Date();
    const birth = new Date(birthDate);
    let age = today.getFullYear() - birth.getFullYear();
    const monthDiff = today.getMonth() - birth.getMonth();

    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
        age--;
    }

    return age;
}

async function fetchAllGameStats() {
    const showcase = document.getElementById('games-showcase');
    if (!showcase) {
        return;
    }

    function formatNumber(num) {
        return num.toLocaleString();
    }

    function setCarouselNavDisabled(isDisabled) {
        const prevButton = document.getElementById('games-prev');
        const nextButton = document.getElementById('games-next');
        if (prevButton) {
            prevButton.disabled = isDisabled;
        }
        if (nextButton) {
            nextButton.disabled = isDisabled;
        }
    }

    async function fetchRobloxGroupGames() {
        const response = await fetch('/api/roblox/group-games', {
            method: 'GET'
        });
        if (!response.ok) {
            let payload = null;
            try {
                payload = await response.json();
            } catch (error) {
                payload = null;
            }

            const detail = payload && typeof payload.details === 'string' && payload.details.trim()
                ? payload.details.trim()
                : `Group games API failed (${response.status})`;
            throw new Error(detail);
        }

        const payload = await response.json();
        return Array.isArray(payload && payload.games) ? payload.games : [];
    }

    function createStat(iconClass, value, label) {
        const stat = document.createElement('div');
        stat.className = 'stat';

        const icon = document.createElement('i');
        icon.className = iconClass;
        icon.setAttribute('aria-hidden', 'true');

        const valueElement = document.createElement('span');
        valueElement.textContent = value;

        const labelElement = document.createElement('small');
        labelElement.textContent = label;

        stat.append(icon, valueElement, labelElement);
        return stat;
    }

    function createRobloxLink(href, className, label, iconClass) {
        const link = document.createElement('a');
        link.href = href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.className = className;

        const icon = document.createElement('i');
        icon.className = iconClass;
        icon.setAttribute('aria-hidden', 'true');

        link.append(icon, document.createTextNode(label));
        return link;
    }

    function createGameCard(game, index) {
        const universeId = Number(game && game.universeId);
        const name = typeof (game && game.name) === 'string' && game.name.trim()
            ? game.name.trim()
            : 'Roblox Game';
        const description = typeof (game && game.description) === 'string' && game.description.trim()
            ? game.description.trim()
            : 'Description unavailable.';
        const visits = Number(game && game.visits);
        const playing = Number(game && game.playing);
        const isDiscontinued = Boolean(game && game.isDiscontinued);
        const iconUrl = typeof (game && game.iconUrl) === 'string' && game.iconUrl.trim()
            ? game.iconUrl.trim()
            : `/api/roblox/game-icon?universeId=${encodeURIComponent(String(universeId))}&size=512x512`;
        const robloxUrl = typeof (game && game.robloxUrl) === 'string' && game.robloxUrl.trim()
            ? game.robloxUrl.trim()
            : `https://www.roblox.com/games/${encodeURIComponent(String(game && game.rootPlaceId || ''))}`;

        const card = document.createElement('div');
        card.className = `game-card featured${index === 0 ? ' is-active' : ''}`;
        card.dataset.gameIndex = String(index);
        if (Number.isFinite(universeId) && universeId > 0) {
            card.dataset.universeId = String(universeId);
        }
        card.setAttribute('aria-hidden', index === 0 ? 'false' : 'true');

        const thumbnail = document.createElement('div');
        thumbnail.className = 'game-thumbnail';

        const image = document.createElement('img');
        image.src = iconUrl;
        image.alt = name;
        image.className = 'game-image';
        image.loading = index === 0 ? 'eager' : 'lazy';
        image.decoding = 'async';

        const overlay = document.createElement('div');
        overlay.className = 'play-overlay';
        overlay.append(createRobloxLink(robloxUrl, 'play-btn', 'Play Now', 'fas fa-play'));

        if (isDiscontinued) {
            const badge = document.createElement('span');
            badge.className = 'game-status-badge discontinued';
            badge.textContent = 'Discontinued';
            badge.title = 'This game is marked discontinued in its Roblox description.';
            thumbnail.append(badge);
        }

        thumbnail.append(image, overlay);

        const info = document.createElement('div');
        info.className = 'game-info';

        const title = document.createElement('h3');
        title.className = 'game-title';
        title.textContent = name;

        const descriptionElement = document.createElement('p');
        descriptionElement.className = 'game-description';
        descriptionElement.textContent = description;

        const stats = document.createElement('div');
        stats.className = 'game-stats';
        stats.append(
            createStat(
                'fas fa-eye',
                Number.isFinite(visits) && visits >= 0 ? formatNumber(Math.trunc(visits)) : 'Unavailable',
                'Total Visits'
            )
        );
        if (Number.isFinite(playing) && playing > 1000) {
            stats.append(createStat(
                'fas fa-users',
                formatNumber(Math.trunc(playing)),
                'Playing Now'
            ));
        }

        info.append(
            title,
            descriptionElement,
            stats,
            createRobloxLink(robloxUrl, 'btn btn-primary', 'Play on Roblox', 'fab fa-roblox')
        );

        card.append(thumbnail, info);
        return card;
    }

    function renderGameMessage(message, isError) {
        showcase.replaceChildren();
        const messageElement = document.createElement('div');
        messageElement.className = `games-loading${isError ? ' games-error' : ''}`;
        const icon = document.createElement('i');
        icon.className = isError ? 'fas fa-triangle-exclamation' : 'fas fa-circle-info';
        icon.setAttribute('aria-hidden', 'true');
        const text = document.createElement('span');
        text.textContent = message;
        messageElement.append(icon, text);
        showcase.append(messageElement);
        setCarouselNavDisabled(true);
    }

    try {
        setCarouselNavDisabled(true);
        const games = await fetchRobloxGroupGames();
        if (!games.length) {
            renderGameMessage('No group games with over 100,000 visits are available right now.', false);
            return;
        }

        const cards = games.map(createGameCard);
        showcase.replaceChildren(...cards);
        initGamesCarousel();
    } catch (error) {
        console.error('Failed to fetch featured game metadata:', error);
        renderGameMessage('Games are unavailable right now.', true);
    }
}

// Function to fetch group member count from Roblox
async function fetchGroupStats() {
    const groupMemberCountElement = document.getElementById('group-member-count');
    if (!groupMemberCountElement) {
        return;
    }

    try {
        function formatNumber(num) {
            return num.toLocaleString();
        }

        const groupStatsResponse = await fetch('/api/roblox/group-stats', {
            method: 'GET'
        });
        if (!groupStatsResponse.ok) {
            throw new Error(`Group stats API failed (${groupStatsResponse.status})`);
        }

        const groupStats = await groupStatsResponse.json();
        const memberCount = Number(groupStats && groupStats.memberCount);
        if (!Number.isFinite(memberCount) || memberCount < 0) {
            throw new Error('Group stats API returned invalid memberCount');
        }

        groupMemberCountElement.textContent = formatNumber(Math.trunc(memberCount));
    } catch (error) {
        console.error('Failed to fetch group statistics:', error);
        groupMemberCountElement.textContent = 'Unavailable';
    }
}

// Bind fallback behavior for team avatar images rendered in HTML
function fetchUserAvatars() {
    const avatarElements = document.querySelectorAll('.member-avatar .avatar-image');
    if (!avatarElements.length) {
        return;
    }

    avatarElements.forEach((img) => {
        if (img.dataset.fallbackBound === '1') {
            return;
        }

        img.dataset.fallbackBound = '1';
        img.addEventListener('error', () => {
            const avatarElement = img.closest('.member-avatar');
            if (!avatarElement) {
                return;
            }

            avatarElement.innerHTML = '<i class="fas fa-user"></i>';
        }, { once: true });
    });
}

function initGamesCarousel() {
    const carousel = document.getElementById('games-carousel');
    const prevButton = document.getElementById('games-prev');
    const nextButton = document.getElementById('games-next');
    if (!carousel || !prevButton || !nextButton) {
        return;
    }

    const gameCards = Array.from(carousel.querySelectorAll('.game-card'));
    if (gameCards.length === 0) {
        return;
    }

    let activeIndex = gameCards.findIndex((card) => card.classList.contains('is-active'));
    if (activeIndex < 0) {
        activeIndex = 0;
    }

    function setActiveCard(nextIndex) {
        activeIndex = (nextIndex + gameCards.length) % gameCards.length;

        gameCards.forEach((card, index) => {
            const isActive = index === activeIndex;
            card.classList.toggle('is-active', isActive);
            card.setAttribute('aria-hidden', isActive ? 'false' : 'true');
        });
    }

    function cycle(direction) {
        setActiveCard(activeIndex + direction);
    }

    const disableNav = gameCards.length <= 1;
    prevButton.disabled = disableNav;
    nextButton.disabled = disableNav;

    prevButton.addEventListener('click', () => cycle(-1));
    nextButton.addEventListener('click', () => cycle(1));

    carousel.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowLeft') {
            event.preventDefault();
            cycle(-1);
            return;
        }

        if (event.key === 'ArrowRight') {
            event.preventDefault();
            cycle(1);
        }
    });

    setActiveCard(activeIndex);
}

// Update ages when page loads
document.addEventListener('DOMContentLoaded', function() {
    initAuth();
    initAdminHome();
    initDiscordBotDashboard().catch((error) => {
        setDiscordBotStatusCard(
            'Discord bot: unavailable',
            error && error.message ? error.message : 'Failed to initialize Discord bot dashboard.',
            'error'
        );
        setDiscordBotStatusMessage(
            error && error.message ? error.message : 'Failed to initialize Discord bot dashboard.',
            'error'
        );
    });

    // Calculate and display ages
    const myronAge = calculateAge('2008-05-31');
    const tristanAge = calculateAge('2004-12-25');
    const kasperAge = calculateAge('2004-12-25');

    const myronAgeElement = document.getElementById('myron-age');
    const tristanAgeElement = document.getElementById('tristan-age');
    const kasperAgeElement = document.getElementById('kasper-age');
    if (myronAgeElement) {
        myronAgeElement.textContent = myronAge;
    }
    if (tristanAgeElement) {
        tristanAgeElement.textContent = tristanAge;
    }
    if (kasperAgeElement) {
        kasperAgeElement.textContent = kasperAge;
    }

    // Update current year in footer
    const currentYearElement = document.getElementById('current-year');
    if (currentYearElement) {
        currentYearElement.textContent = new Date().getFullYear();
    }

    // Fetch and display game statistics
    fetchAllGameStats();

    // Fetch and display group statistics
    fetchGroupStats();
    // Bind fallback handlers for user avatars
    fetchUserAvatars();
});

// Mobile navigation toggle
const hamburger = document.querySelector('.hamburger');
const navMenu = document.querySelector('.nav-menu');

if (hamburger && navMenu) {
    hamburger.addEventListener('click', function() {
        hamburger.classList.toggle('active');
        navMenu.classList.toggle('active');
    });

    // Close mobile menu when clicking on a link
    document.querySelectorAll('.nav-link').forEach(link => {
        link.addEventListener('click', () => {
            hamburger.classList.remove('active');
            navMenu.classList.remove('active');
        });
    });
}

// Smooth scrolling for navigation links
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function(e) {
        e.preventDefault();
        const target = document.querySelector(this.getAttribute('href'));
        if (target) {
            const offsetTop = target.offsetTop - 80; // Account for fixed navbar
            window.scrollTo({
                top: offsetTop,
                behavior: 'smooth'
            });
        }
    });
});

// Navbar background on scroll
window.addEventListener('scroll', function() {
    const navbar = document.querySelector('.navbar');
    if (!navbar) {
        return;
    }

    if (window.scrollY > 50) {
        navbar.style.background = 'rgba(23, 23, 23, 0.98)';
    } else {
        navbar.style.background = 'rgba(23, 23, 23, 0.95)';
    }
});

// Intersection Observer for fade-in animations
const observerOptions = {
    threshold: 0.1,
    rootMargin: '0px 0px -50px 0px'
};

const observer = new IntersectionObserver(function(entries) {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.style.opacity = '1';
            entry.target.style.transform = 'translateY(0)';
        }
    });
}, observerOptions);

// Add animation styles and observe elements
window.addEventListener('load', function() {
    const animatedElements = document.querySelectorAll('.team-member, .feature, .game-card, .social-link');

    animatedElements.forEach((el, index) => {
        el.style.opacity = '0';
        el.style.transform = 'translateY(30px)';
        el.style.transition = `opacity 0.6s ease ${index * 0.1}s, transform 0.6s ease ${index * 0.1}s`;
        observer.observe(el);
    });
});

// Add some interactive effects
document.addEventListener('DOMContentLoaded', function() {
    // Add click effect to buttons
    document.querySelectorAll('.btn').forEach(button => {
        button.addEventListener('click', function(e) {
            const ripple = document.createElement('span');
            const rect = this.getBoundingClientRect();
            const size = Math.max(rect.width, rect.height);
            const x = e.clientX - rect.left - size / 2;
            const y = e.clientY - rect.top - size / 2;

            ripple.style.width = ripple.style.height = size + 'px';
            ripple.style.left = x + 'px';
            ripple.style.top = y + 'px';
            ripple.classList.add('ripple');

            this.appendChild(ripple);

            setTimeout(() => {
                ripple.remove();
            }, 600);
        });
    });
});

// Add CSS for ripple effect
const style = document.createElement('style');
style.textContent = `
    .btn {
        position: relative;
        overflow: hidden;
    }

    .ripple {
        position: absolute;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.3);
        transform: scale(0);
        animation: ripple-animation 0.6s linear;
        pointer-events: none;
    }

    @keyframes ripple-animation {
        to {
            transform: scale(4);
            opacity: 0;
        }
    }
`;
document.head.appendChild(style);
