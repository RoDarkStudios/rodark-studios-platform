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

function getDiscordStartupSyncControl(control) {
    if (!control || typeof control !== 'object' || !control.startupContentSync || typeof control.startupContentSync !== 'object') {
        return {
            rulesChannelId: '',
            infoChannelId: '',
            rolesChannelId: '',
            staffInfoChannelId: '',
            gameTestInfoChannelId: ''
        };
    }

    return {
        rulesChannelId: control.startupContentSync.rulesChannelId ? String(control.startupContentSync.rulesChannelId) : '',
        infoChannelId: control.startupContentSync.infoChannelId ? String(control.startupContentSync.infoChannelId) : '',
        rolesChannelId: control.startupContentSync.rolesChannelId ? String(control.startupContentSync.rolesChannelId) : '',
        staffInfoChannelId: control.startupContentSync.staffInfoChannelId ? String(control.startupContentSync.staffInfoChannelId) : '',
        gameTestInfoChannelId: control.startupContentSync.gameTestInfoChannelId ? String(control.startupContentSync.gameTestInfoChannelId) : ''
    };
}

function getDiscordTicketSystemControl(control) {
    if (!control || typeof control !== 'object' || !control.ticketSystem || typeof control.ticketSystem !== 'object') {
        return {
            categoryChannelId: '',
            panelChannelId: '',
            helperRoleIds: []
        };
    }

    return {
        categoryChannelId: control.ticketSystem.categoryChannelId ? String(control.ticketSystem.categoryChannelId) : '',
        panelChannelId: control.ticketSystem.panelChannelId ? String(control.ticketSystem.panelChannelId) : '',
        helperRoleIds: Array.isArray(control.ticketSystem.helperRoleIds)
            ? control.ticketSystem.helperRoleIds.map((roleId) => String(roleId)).filter(Boolean)
            : []
    };
}

function getDiscordLevelSystemControl(control) {
    if (!control || typeof control !== 'object' || !control.levelSystem || typeof control.levelSystem !== 'object') {
        return {
            enabled: false,
            announcementChannelId: '',
            attachmentUnlockLevel: 5,
            mentionLevelUps: true
        };
    }

    const attachmentUnlockLevel = Number.parseInt(control.levelSystem.attachmentUnlockLevel || '5', 10);

    return {
        enabled: Boolean(control.levelSystem.enabled),
        announcementChannelId: control.levelSystem.announcementChannelId ? String(control.levelSystem.announcementChannelId) : '',
        attachmentUnlockLevel: [5, 10, 15, 25, 50, 75, 100].includes(attachmentUnlockLevel)
            ? attachmentUnlockLevel
            : 5,
        mentionLevelUps: control.levelSystem.mentionLevelUps !== false
    };
}

function getDiscordGameUpdatesControl(control) {
    if (!control || typeof control !== 'object' || !control.gameUpdates || typeof control.gameUpdates !== 'object') {
        return {
            channelId: '',
            pingEveryoneEnabled: true
        };
    }

    return {
        channelId: control.gameUpdates.channelId ? String(control.gameUpdates.channelId) : '',
        pingEveryoneEnabled: control.gameUpdates.pingEveryoneEnabled !== false
    };
}

function getDiscordChannelLookup(payload) {
    const channelLookup = payload && payload.channelLookup && typeof payload.channelLookup === 'object'
        ? payload.channelLookup
        : {};
    const channels = Array.isArray(channelLookup.channels) ? channelLookup.channels : [];

    return {
        guildId: channelLookup.guildId ? String(channelLookup.guildId) : '',
        error: channelLookup.error ? String(channelLookup.error) : '',
        channels: channels.map((channel) => ({
            id: channel && channel.id ? String(channel.id) : '',
            name: channel && channel.name ? String(channel.name) : '',
            type: Number(channel && channel.type),
            parentId: channel && channel.parentId ? String(channel.parentId) : '',
            parentName: channel && channel.parentName ? String(channel.parentName) : ''
        })).filter((channel) => channel.id && channel.name)
    };
}

function getDiscordRoleLookup(payload) {
    const roleLookup = payload && payload.roleLookup && typeof payload.roleLookup === 'object'
        ? payload.roleLookup
        : {};
    const roles = Array.isArray(roleLookup.roles) ? roleLookup.roles : [];

    return {
        guildId: roleLookup.guildId ? String(roleLookup.guildId) : '',
        error: roleLookup.error ? String(roleLookup.error) : '',
        roles: roles.map((role) => ({
            id: role && role.id ? String(role.id) : '',
            name: role && role.name ? String(role.name) : '',
            managed: Boolean(role && role.managed),
            position: Number(role && role.position)
        })).filter((role) => role.id && role.name)
    };
}

let discordChannelLookupState = {
    guildId: '',
    error: '',
    channels: []
};

let discordRoleLookupState = {
    guildId: '',
    error: '',
    roles: []
};

function formatDiscordChannelOptionLabel(channel) {
    if (!channel) {
        return '';
    }

    return `#${channel.name}`;
}

function formatDiscordRoleOptionLabel(role) {
    if (!role) {
        return '';
    }

    return `@${role.name}`;
}

function buildDiscordChannelLookupMaps(channelLookup) {
    const byId = new Map();
    const labelToId = new Map();

    (channelLookup && Array.isArray(channelLookup.channels) ? channelLookup.channels : []).forEach((channel) => {
        byId.set(channel.id, channel);
        labelToId.set(formatDiscordChannelOptionLabel(channel).toLowerCase(), channel.id);
    });

    return { byId, labelToId };
}

function buildDiscordRoleLookupMaps(roleLookup) {
    const byId = new Map();
    const labelToId = new Map();

    (roleLookup && Array.isArray(roleLookup.roles) ? roleLookup.roles : []).forEach((role) => {
        byId.set(role.id, role);
        labelToId.set(formatDiscordRoleOptionLabel(role).toLowerCase(), role.id);
    });

    return { byId, labelToId };
}

function fillDiscordChannelDatalist(elementId, channels) {
    const datalist = document.getElementById(elementId);
    if (!datalist) {
        return;
    }

    datalist.innerHTML = '';
    channels.forEach((channel) => {
        const option = document.createElement('option');
        option.value = formatDiscordChannelOptionLabel(channel);
        datalist.appendChild(option);
    });
}

function fillDiscordRoleDatalist(elementId, roles) {
    const datalist = document.getElementById(elementId);
    if (!datalist) {
        return;
    }

    datalist.innerHTML = '';

    roles.forEach((role) => {
        const option = document.createElement('option');
        option.value = formatDiscordRoleOptionLabel(role);
        datalist.appendChild(option);
    });
}

function getSelectedDiscordRoleIds(container) {
    if (!container) {
        return [];
    }

    try {
        const selectedRoleIds = JSON.parse(container.dataset.selectedIds || '[]');
        return Array.isArray(selectedRoleIds)
            ? selectedRoleIds.map((roleId) => String(roleId)).filter(Boolean)
            : [];
    } catch (error) {
        return [];
    }
}

function setSelectedDiscordRoleIds(container, roleIds) {
    if (!container) {
        return;
    }

    const seenRoleIds = new Set();
    const selectedRoleIds = [];
    (Array.isArray(roleIds) ? roleIds : []).forEach((roleId) => {
        const normalizedRoleId = String(roleId || '').trim();
        if (!normalizedRoleId || seenRoleIds.has(normalizedRoleId)) {
            return;
        }

        seenRoleIds.add(normalizedRoleId);
        selectedRoleIds.push(normalizedRoleId);
    });

    container.dataset.selectedIds = JSON.stringify(selectedRoleIds);
}

function renderDiscordSelectedRoles(container, selectedRoleIds, roleMaps) {
    if (!container) {
        return;
    }

    const normalizedRoleIds = (Array.isArray(selectedRoleIds) ? selectedRoleIds : [])
        .map((roleId) => String(roleId || '').trim())
        .filter(Boolean);

    setSelectedDiscordRoleIds(container, normalizedRoleIds);
    container.innerHTML = '';

    if (!normalizedRoleIds.length) {
        const empty = document.createElement('span');
        empty.className = 'admin-selected-empty';
        empty.textContent = container.dataset.emptyLabel || 'No helper roles selected.';
        container.appendChild(empty);
        return;
    }

    normalizedRoleIds.forEach((roleId) => {
        const role = roleMaps && roleMaps.byId ? roleMaps.byId.get(roleId) : null;
        const pill = document.createElement('span');
        pill.className = 'admin-selected-pill';

        const label = document.createElement('span');
        label.textContent = role ? formatDiscordRoleOptionLabel(role) : roleId;

        const removeButton = document.createElement('button');
        removeButton.type = 'button';
        removeButton.className = 'admin-selected-remove';
        removeButton.dataset.roleId = roleId;
        removeButton.setAttribute('aria-label', `Remove ${label.textContent}`);
        removeButton.textContent = 'x';

        pill.appendChild(label);
        pill.appendChild(removeButton);
        container.appendChild(pill);
    });
}

function resolveDiscordRoleInputValue(input, roleMaps) {
    if (!input) {
        return '';
    }

    const rawValue = String(input.value || '').trim();
    if (!rawValue) {
        return '';
    }

    if (/^\d{5,25}$/.test(rawValue)) {
        return rawValue;
    }

    return roleMaps && roleMaps.labelToId
        ? (roleMaps.labelToId.get(rawValue.toLowerCase()) || '')
        : '';
}

function setDiscordChannelInputDisplayValue(input, channelId, channelMaps) {
    if (!input) {
        return;
    }

    const normalizedChannelId = channelId ? String(channelId) : '';
    const channel = normalizedChannelId && channelMaps && channelMaps.byId ? channelMaps.byId.get(normalizedChannelId) : null;
    if (channel) {
        const label = formatDiscordChannelOptionLabel(channel);
        input.value = label;
        input.dataset.selectedId = channel.id;
        input.dataset.selectedLabel = label;
        return;
    }

    input.value = normalizedChannelId;
    input.dataset.selectedId = normalizedChannelId;
    input.dataset.selectedLabel = normalizedChannelId;
}

function resolveDiscordChannelInputValue(input, channelMaps) {
    if (!input) {
        return '';
    }

    const rawValue = String(input.value || '').trim();
    if (!rawValue) {
        input.dataset.selectedId = '';
        input.dataset.selectedLabel = '';
        return '';
    }

    if (/^\d{5,25}$/.test(rawValue)) {
        input.dataset.selectedId = rawValue;
        input.dataset.selectedLabel = rawValue;
        return rawValue;
    }

    const selectedId = input.dataset.selectedId ? String(input.dataset.selectedId) : '';
    const selectedLabel = input.dataset.selectedLabel ? String(input.dataset.selectedLabel) : '';
    if (selectedId && selectedLabel && rawValue.toLowerCase() === selectedLabel.toLowerCase()) {
        return selectedId;
    }

    const resolvedId = channelMaps && channelMaps.labelToId
        ? channelMaps.labelToId.get(rawValue.toLowerCase())
        : '';
    if (resolvedId) {
        input.dataset.selectedId = resolvedId;
        input.dataset.selectedLabel = rawValue;
        return resolvedId;
    }

    return rawValue;
}

function clearDiscordChannelSearchState(input) {
    if (!input) {
        return;
    }

    delete input.dataset.searchMode;
    delete input.dataset.searchRestoreId;
    delete input.dataset.searchRestoreLabel;
    delete input.dataset.searchRestoreValue;
}

function bindDiscordChannelAutocompleteInput(input, getChannelMaps) {
    if (!input) {
        return;
    }

    input.addEventListener('focus', () => {
        const channelMaps = typeof getChannelMaps === 'function'
            ? getChannelMaps()
            : { byId: new Map(), labelToId: new Map() };
        const currentValue = String(input.value || '').trim();
        const selectedId = input.dataset.selectedId ? String(input.dataset.selectedId) : '';
        const selectedLabel = input.dataset.selectedLabel ? String(input.dataset.selectedLabel) : '';
        const hasKnownSelectedChannel = selectedId && selectedLabel && channelMaps && channelMaps.byId && channelMaps.byId.has(selectedId);

        if (!hasKnownSelectedChannel || !currentValue || currentValue.toLowerCase() !== selectedLabel.toLowerCase()) {
            return;
        }

        input.dataset.searchMode = 'true';
        input.dataset.searchRestoreId = selectedId;
        input.dataset.searchRestoreLabel = selectedLabel;
        input.dataset.searchRestoreValue = currentValue;
        input.value = '';
    });

    input.addEventListener('input', () => {
        const channelMaps = typeof getChannelMaps === 'function'
            ? getChannelMaps()
            : { byId: new Map(), labelToId: new Map() };
        const resolvedId = resolveDiscordChannelInputValue(input, channelMaps);
        if (resolvedId && channelMaps && channelMaps.byId && channelMaps.byId.has(resolvedId)) {
            input.dataset.selectedId = resolvedId;
            input.dataset.selectedLabel = formatDiscordChannelOptionLabel(channelMaps.byId.get(resolvedId));
            clearDiscordChannelSearchState(input);
            return;
        }

        if (!String(input.value || '').trim()) {
            if (input.dataset.searchMode === 'true') {
                return;
            }

            input.dataset.selectedId = '';
            input.dataset.selectedLabel = '';
            clearDiscordChannelSearchState(input);
        }
    });

    input.addEventListener('change', () => {
        const channelMaps = typeof getChannelMaps === 'function'
            ? getChannelMaps()
            : { byId: new Map(), labelToId: new Map() };
        const resolvedId = resolveDiscordChannelInputValue(input, channelMaps);
        setDiscordChannelInputDisplayValue(input, resolvedId, channelMaps);
        clearDiscordChannelSearchState(input);
    });

    input.addEventListener('blur', () => {
        const hasValue = String(input.value || '').trim();
        if (hasValue || input.dataset.searchMode !== 'true') {
            clearDiscordChannelSearchState(input);
            return;
        }

        const restoreValue = input.dataset.searchRestoreValue ? String(input.dataset.searchRestoreValue) : '';
        const restoreId = input.dataset.searchRestoreId ? String(input.dataset.searchRestoreId) : '';
        const restoreLabel = input.dataset.searchRestoreLabel ? String(input.dataset.searchRestoreLabel) : restoreValue;

        input.value = restoreValue;
        input.dataset.selectedId = restoreId;
        input.dataset.selectedLabel = restoreLabel;
        clearDiscordChannelSearchState(input);
    });
}

function renderDiscordBotControl(control, options) {
    const statusDot = document.getElementById('discord-bot-status-dot');
    const statusTitle = document.getElementById('discord-bot-status-title');
    const statusDetail = document.getElementById('discord-bot-status-detail');
    const toggleButton = document.getElementById('discord-bot-toggle-btn');
    const guildIdInput = document.getElementById('discord-guild-id');
    const guildSaveButton = document.getElementById('discord-guild-save-btn');
    const startupRulesChannelInput = document.getElementById('discord-content-rules-channel-id');
    const startupInfoChannelInput = document.getElementById('discord-content-info-channel-id');
    const startupRolesChannelInput = document.getElementById('discord-content-roles-channel-id');
    const startupStaffInfoChannelInput = document.getElementById('discord-content-staff-info-channel-id');
    const startupGameTestInfoChannelInput = document.getElementById('discord-content-game-test-info-channel-id');
    const startupSyncSaveButton = document.getElementById('discord-startup-sync-save-btn');
    const ticketCategoryChannelInput = document.getElementById('discord-ticket-category-channel-id');
    const ticketPanelChannelInput = document.getElementById('discord-ticket-panel-channel-id');
    const ticketHelperRoleInput = document.getElementById('discord-ticket-helper-role-input');
    const ticketHelperRoleList = document.getElementById('discord-ticket-helper-role-list');
    const ticketSystemSaveButton = document.getElementById('discord-ticket-system-save-btn');
    const levelSystemEnabledInput = document.getElementById('discord-level-system-enabled');
    const levelMentionEnabledInput = document.getElementById('discord-level-mention-enabled');
    const levelAnnouncementChannelInput = document.getElementById('discord-level-announcement-channel-id');
    const levelAttachmentUnlockLevelInput = document.getElementById('discord-level-attachment-unlock-level');
    const levelSystemSaveButton = document.getElementById('discord-level-system-save-btn');
    const gameUpdatesChannelInput = document.getElementById('discord-game-updates-channel-id');
    const gameUpdatesPingEveryoneInput = document.getElementById('discord-game-updates-ping-everyone');
    const gameUpdatesSaveButton = document.getElementById('discord-game-updates-save-btn');
    const gameUpdateSendButton = document.getElementById('discord-game-update-send-btn');
    const channelLookupSummary = document.getElementById('discord-channel-lookup-summary');
    const formatted = formatDiscordBotStatus(control);
    const preserveGuildForm = Boolean(options && options.preserveGuildForm);
    const preserveStartupSyncForm = Boolean(options && options.preserveStartupSyncForm);
    const preserveTicketSystemForm = Boolean(options && options.preserveTicketSystemForm);
    const preserveLevelSystemForm = Boolean(options && options.preserveLevelSystemForm);
    const preserveGameUpdatesForm = Boolean(options && options.preserveGameUpdatesForm);
    const preserveLookupData = Boolean(options && options.preserveLookupData);
    const startupSyncControl = getDiscordStartupSyncControl(control);
    const ticketSystemControl = getDiscordTicketSystemControl(control);
    const levelSystemControl = getDiscordLevelSystemControl(control);
    const gameUpdatesControl = getDiscordGameUpdatesControl(control);
    const requestedChannelLookup = preserveLookupData
        ? discordChannelLookupState
        : getDiscordChannelLookup(options);
    const requestedRoleLookup = preserveLookupData
        ? discordRoleLookupState
        : getDiscordRoleLookup(options);
    const shouldKeepExistingChannelLookup = !requestedChannelLookup.channels.length
        && Array.isArray(discordChannelLookupState.channels)
        && discordChannelLookupState.channels.length > 0;
    const shouldKeepExistingRoleLookup = !requestedRoleLookup.roles.length
        && Array.isArray(discordRoleLookupState.roles)
        && discordRoleLookupState.roles.length > 0;
    const channelLookup = shouldKeepExistingChannelLookup
        ? {
            guildId: discordChannelLookupState.guildId,
            channels: discordChannelLookupState.channels,
            error: requestedChannelLookup.error
        }
        : requestedChannelLookup;
    const roleLookup = shouldKeepExistingRoleLookup
        ? {
            guildId: discordRoleLookupState.guildId,
            roles: discordRoleLookupState.roles,
            error: requestedRoleLookup.error
        }
        : requestedRoleLookup;
    discordChannelLookupState = channelLookup;
    discordRoleLookupState = roleLookup;
    const channelMaps = buildDiscordChannelLookupMaps(channelLookup);
    const roleMaps = buildDiscordRoleLookupMaps(roleLookup);
    const categoryMaps = buildDiscordChannelLookupMaps({
        channels: channelLookup.channels.filter((channel) => channel.type === 4)
    });
    const textChannels = channelLookup.channels.filter((channel) => channel.type === 0 || channel.type === 5);
    const categoryChannels = channelLookup.channels.filter((channel) => channel.type === 4);

    if (!preserveLookupData) {
        fillDiscordChannelDatalist('discord-text-channel-options', textChannels);
        fillDiscordChannelDatalist('discord-category-channel-options', categoryChannels);
        fillDiscordRoleDatalist('discord-role-options', roleLookup.roles);
    }

    if (statusDot) {
        statusDot.className = `admin-discord-status-dot ${formatted.dotClass}`.trim();
    }
    if (statusTitle) {
        statusTitle.textContent = formatted.title;
    }
    if (statusDetail) {
        statusDetail.textContent = formatted.detail;
    }
    if (toggleButton) {
        toggleButton.textContent = formatted.buttonText;
        toggleButton.dataset.desiredEnabled = formatted.desiredEnabled ? 'true' : 'false';
        toggleButton.disabled = false;
    }
    if (!preserveGuildForm && guildIdInput) {
        guildIdInput.value = control && control.guildId ? control.guildId : '';
    }
    if (guildSaveButton) {
        guildSaveButton.disabled = false;
    }
    if (!preserveStartupSyncForm && startupRulesChannelInput) {
        setDiscordChannelInputDisplayValue(startupRulesChannelInput, startupSyncControl.rulesChannelId, channelMaps);
    }
    if (!preserveStartupSyncForm && startupInfoChannelInput) {
        setDiscordChannelInputDisplayValue(startupInfoChannelInput, startupSyncControl.infoChannelId, channelMaps);
    }
    if (!preserveStartupSyncForm && startupRolesChannelInput) {
        setDiscordChannelInputDisplayValue(startupRolesChannelInput, startupSyncControl.rolesChannelId, channelMaps);
    }
    if (!preserveStartupSyncForm && startupStaffInfoChannelInput) {
        setDiscordChannelInputDisplayValue(startupStaffInfoChannelInput, startupSyncControl.staffInfoChannelId, channelMaps);
    }
    if (!preserveStartupSyncForm && startupGameTestInfoChannelInput) {
        setDiscordChannelInputDisplayValue(startupGameTestInfoChannelInput, startupSyncControl.gameTestInfoChannelId, channelMaps);
    }
    if (startupSyncSaveButton) {
        startupSyncSaveButton.disabled = false;
    }
    if (!preserveTicketSystemForm && ticketCategoryChannelInput) {
        setDiscordChannelInputDisplayValue(ticketCategoryChannelInput, ticketSystemControl.categoryChannelId, categoryMaps);
    }
    if (!preserveTicketSystemForm && ticketPanelChannelInput) {
        setDiscordChannelInputDisplayValue(ticketPanelChannelInput, ticketSystemControl.panelChannelId, channelMaps);
    }
    if (!preserveTicketSystemForm && ticketHelperRoleList) {
        renderDiscordSelectedRoles(ticketHelperRoleList, ticketSystemControl.helperRoleIds, roleMaps);
    }
    if (!preserveTicketSystemForm && ticketHelperRoleInput) {
        ticketHelperRoleInput.value = '';
    }
    if (ticketSystemSaveButton) {
        ticketSystemSaveButton.disabled = false;
    }
    if (!preserveLevelSystemForm && levelSystemEnabledInput) {
        levelSystemEnabledInput.checked = levelSystemControl.enabled;
    }
    if (!preserveLevelSystemForm && levelMentionEnabledInput) {
        levelMentionEnabledInput.checked = levelSystemControl.mentionLevelUps;
    }
    if (!preserveLevelSystemForm && levelAnnouncementChannelInput) {
        setDiscordChannelInputDisplayValue(levelAnnouncementChannelInput, levelSystemControl.announcementChannelId, channelMaps);
    }
    if (!preserveLevelSystemForm && levelAttachmentUnlockLevelInput) {
        levelAttachmentUnlockLevelInput.value = String(levelSystemControl.attachmentUnlockLevel);
    }
    if (levelSystemSaveButton) {
        levelSystemSaveButton.disabled = false;
    }
    if (!preserveGameUpdatesForm && gameUpdatesChannelInput) {
        setDiscordChannelInputDisplayValue(gameUpdatesChannelInput, gameUpdatesControl.channelId, channelMaps);
    }
    if (!preserveGameUpdatesForm && gameUpdatesPingEveryoneInput) {
        gameUpdatesPingEveryoneInput.checked = gameUpdatesControl.pingEveryoneEnabled !== false;
    }
    if (gameUpdatesSaveButton) {
        gameUpdatesSaveButton.disabled = false;
    }
    if (gameUpdateSendButton) {
        gameUpdateSendButton.disabled = false;
    }
    if (channelLookupSummary) {
        let lookupMessage = '';

        if (!channelLookup.channels.length && channelLookup.error) {
            if (/DISCORD_BOT_TOKEN/i.test(channelLookup.error)) {
                lookupMessage = 'Channel lookup is unavailable because DISCORD_BOT_TOKEN is not configured on the web service.';
            } else if (/rate limit/i.test(channelLookup.error)) {
                lookupMessage = 'Channel lookup is temporarily unavailable. Existing selections are still kept.';
            } else {
                lookupMessage = 'Channel lookup is temporarily unavailable. You can still enter IDs manually.';
            }
        } else if (!channelLookup.channels.length) {
            lookupMessage = 'Set the Discord server ID to enable searchable channel pickers.';
        }

        channelLookupSummary.textContent = lookupMessage;
        channelLookupSummary.classList.toggle('hidden', !lookupMessage);
    }
    if (control && control.serverLayoutManaged) {
        for (const id of ['discord-guild-id', 'discord-guild-save-btn', 'discord-startup-sync-save-btn',
            'discord-content-rules-channel-id', 'discord-content-info-channel-id', 'discord-content-roles-channel-id',
            'discord-content-staff-info-channel-id', 'discord-content-game-test-info-channel-id',
            'discord-ticket-category-channel-id', 'discord-ticket-panel-channel-id', 'discord-ticket-helper-role-input',
            'discord-ticket-helper-role-add-btn', 'discord-ticket-system-save-btn', 'discord-level-announcement-channel-id',
            'discord-level-system-enabled', 'discord-game-updates-channel-id', 'discord-game-updates-ping-everyone', 'discord-game-updates-save-btn']) {
            const field = document.getElementById(id);
            if (field) { field.disabled = true; field.title = 'Managed through Server Layout → Deploy'; }
        }
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

async function fetchDiscordBotControl(options) {
    const includeLookups = Boolean(options && options.includeLookups);
    const requestUrl = includeLookups
        ? '/api/admin/discord-bot-control'
        : '/api/admin/discord-bot-control?includeLookups=0';
    const response = await fetchWithTimeout(requestUrl, {
        method: 'GET',
        credentials: 'include'
    }, includeLookups ? 8000 : 12000);

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(payload.error || `Discord bot status failed (${response.status})`);
    }

    return {
        control: payload.control || null,
        channelLookup: getDiscordChannelLookup(payload),
        roleLookup: getDiscordRoleLookup(payload)
    };
}

async function setDiscordBotDesiredState(desiredEnabled) {
    const payload = await postJson('/api/admin/discord-bot-control', { desiredEnabled });
    return {
        control: payload.control || null,
        channelLookup: getDiscordChannelLookup(payload),
        roleLookup: getDiscordRoleLookup(payload)
    };
}

async function saveDiscordBotGuildConfig(guildId) {
    const payload = await postJson('/api/admin/discord-bot-control', {
        guildId: guildId ? String(guildId).trim() : ''
    });

    return {
        control: payload.control || null,
        channelLookup: getDiscordChannelLookup(payload),
        roleLookup: getDiscordRoleLookup(payload)
    };
}

async function saveDiscordBotStartupSyncConfig(config) {
    const payload = await postJson('/api/admin/discord-bot-control', {
        startupContentSync: {
            rulesChannelId: config && config.rulesChannelId ? String(config.rulesChannelId).trim() : '',
            infoChannelId: config && config.infoChannelId ? String(config.infoChannelId).trim() : '',
            rolesChannelId: config && config.rolesChannelId ? String(config.rolesChannelId).trim() : '',
            staffInfoChannelId: config && config.staffInfoChannelId ? String(config.staffInfoChannelId).trim() : '',
            gameTestInfoChannelId: config && config.gameTestInfoChannelId ? String(config.gameTestInfoChannelId).trim() : ''
        }
    });

    return {
        control: payload.control || null,
        channelLookup: getDiscordChannelLookup(payload),
        roleLookup: getDiscordRoleLookup(payload)
    };
}

async function saveDiscordTicketSystemConfig(config) {
    const payload = await postJson('/api/admin/discord-bot-control', {
        ticketSystem: {
            categoryChannelId: config && config.categoryChannelId ? String(config.categoryChannelId).trim() : '',
            panelChannelId: config && config.panelChannelId ? String(config.panelChannelId).trim() : '',
            helperRoleIds: config && Array.isArray(config.helperRoleIds) ? config.helperRoleIds : []
        }
    });

    return {
        control: payload.control || null,
        channelLookup: getDiscordChannelLookup(payload),
        roleLookup: getDiscordRoleLookup(payload)
    };
}

async function saveDiscordLevelSystemConfig(config) {
    const payload = await postJson('/api/admin/discord-bot-control', {
        levelSystem: {
            enabled: Boolean(config && config.enabled),
            mentionLevelUps: config && Object.prototype.hasOwnProperty.call(config, 'mentionLevelUps')
                ? Boolean(config.mentionLevelUps)
                : true,
            announcementChannelId: config && config.announcementChannelId ? String(config.announcementChannelId).trim() : '',
            attachmentUnlockLevel: config && config.attachmentUnlockLevel ? Number.parseInt(config.attachmentUnlockLevel, 10) : 5
        }
    });

    return {
        control: payload.control || null,
        channelLookup: getDiscordChannelLookup(payload),
        roleLookup: getDiscordRoleLookup(payload)
    };
}

async function saveDiscordGameUpdatesConfig(config) {
    const payload = await postJson('/api/admin/discord-bot-control', {
        gameUpdates: {
            channelId: config && config.channelId ? String(config.channelId).trim() : '',
            pingEveryoneEnabled: !(config && config.pingEveryoneEnabled === false)
        }
    });

    return {
        control: payload.control || null,
        channelLookup: getDiscordChannelLookup(payload),
        roleLookup: getDiscordRoleLookup(payload)
    };
}

async function sendDiscordGameUpdateAnnouncement(config) {
    const payload = await postJson('/api/admin/discord-bot-control', {
        operation: 'game-update:send',
        gameUpdateAnnouncement: {
            channelId: config && config.channelId ? String(config.channelId).trim() : '',
            title: config && config.title ? String(config.title).trim() : '',
            body: config && config.body ? String(config.body).trim() : '',
            pingEveryoneEnabled: !(config && config.pingEveryoneEnabled === false)
        }
    });

    return {
        control: payload.control || null,
        channelLookup: getDiscordChannelLookup(payload),
        roleLookup: getDiscordRoleLookup(payload),
        announcement: payload.announcement || null
    };
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
    const guildIdInput = document.getElementById('discord-guild-id');
    const guildSaveButton = document.getElementById('discord-guild-save-btn');
    const startupRulesChannelInput = document.getElementById('discord-content-rules-channel-id');
    const startupInfoChannelInput = document.getElementById('discord-content-info-channel-id');
    const startupRolesChannelInput = document.getElementById('discord-content-roles-channel-id');
    const startupStaffInfoChannelInput = document.getElementById('discord-content-staff-info-channel-id');
    const startupGameTestInfoChannelInput = document.getElementById('discord-content-game-test-info-channel-id');
    const startupSyncSaveButton = document.getElementById('discord-startup-sync-save-btn');
    const ticketCategoryChannelInput = document.getElementById('discord-ticket-category-channel-id');
    const ticketPanelChannelInput = document.getElementById('discord-ticket-panel-channel-id');
    const ticketHelperRoleInput = document.getElementById('discord-ticket-helper-role-input');
    const ticketHelperRoleAddButton = document.getElementById('discord-ticket-helper-role-add-btn');
    const ticketHelperRoleList = document.getElementById('discord-ticket-helper-role-list');
    const ticketSystemSaveButton = document.getElementById('discord-ticket-system-save-btn');
    const levelSystemEnabledInput = document.getElementById('discord-level-system-enabled');
    const levelMentionEnabledInput = document.getElementById('discord-level-mention-enabled');
    const levelAnnouncementChannelInput = document.getElementById('discord-level-announcement-channel-id');
    const levelAttachmentUnlockLevelInput = document.getElementById('discord-level-attachment-unlock-level');
    const levelSystemSaveButton = document.getElementById('discord-level-system-save-btn');
    const gameUpdatesChannelInput = document.getElementById('discord-game-updates-channel-id');
    const gameUpdatesPingEveryoneInput = document.getElementById('discord-game-updates-ping-everyone');
    const gameUpdatesSaveButton = document.getElementById('discord-game-updates-save-btn');
    const gameUpdateTitleInput = document.getElementById('discord-game-update-title');
    const gameUpdateBodyInput = document.getElementById('discord-game-update-body');
    const gameUpdateSendButton = document.getElementById('discord-game-update-send-btn');
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
    dashboard.dataset.guildDirty = 'false';
    dashboard.dataset.startupSyncDirty = 'false';
    dashboard.dataset.ticketSystemDirty = 'false';
    dashboard.dataset.levelSystemDirty = 'false';
    dashboard.dataset.gameUpdatesDirty = 'false';
    let currentTicketTranscriptId = '';
    let currentTicketTranscripts = [];
    let ticketTranscriptOffset = 0;
    let hasMoreTicketTranscripts = false;
    let discordLookupRefreshPending = false;
    let discordLookupRefreshAt = 0;

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
            const activeElement = document.activeElement;
            const isEditingDiscordForm = Boolean(activeElement && dashboard.contains(activeElement) && activeElement.matches('input, select, textarea'));
            const control = await fetchDiscordBotControl({ includeLookups: false });
            renderDiscordBotControl(control.control, {
                preserveGuildForm: isEditingDiscordForm || dashboard.dataset.guildDirty === 'true',
                preserveStartupSyncForm: isEditingDiscordForm || dashboard.dataset.startupSyncDirty === 'true',
                preserveTicketSystemForm: isEditingDiscordForm || dashboard.dataset.ticketSystemDirty === 'true',
                preserveLevelSystemForm: isEditingDiscordForm || dashboard.dataset.levelSystemDirty === 'true',
                preserveGameUpdatesForm: isEditingDiscordForm || dashboard.dataset.gameUpdatesDirty === 'true',
                preserveLookupData: true
            });
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
            if (startupSyncSaveButton) {
                startupSyncSaveButton.disabled = true;
            }
            if (guildSaveButton) {
                guildSaveButton.disabled = true;
            }
            if (ticketSystemSaveButton) {
                ticketSystemSaveButton.disabled = true;
            }
            if (levelSystemSaveButton) {
                levelSystemSaveButton.disabled = true;
            }
            if (gameUpdatesSaveButton) {
                gameUpdatesSaveButton.disabled = true;
            }
            if (gameUpdateSendButton) {
                gameUpdateSendButton.disabled = true;
            }
            setDiscordBotStatusMessage(error.message || 'Failed to load Discord bot status.', 'error');
        }
    }

    async function refreshDiscordLookups() {
        const now = Date.now();
        if (discordLookupRefreshPending || now - discordLookupRefreshAt < 60 * 1000) {
            return;
        }

        discordLookupRefreshPending = true;
        try {
            const control = await fetchDiscordBotControl({ includeLookups: true });
            discordLookupRefreshAt = Date.now();
            renderDiscordBotControl(control.control, {
                preserveGuildForm: dashboard.dataset.guildDirty === 'true',
                preserveStartupSyncForm: dashboard.dataset.startupSyncDirty === 'true',
                preserveTicketSystemForm: dashboard.dataset.ticketSystemDirty === 'true',
                preserveLevelSystemForm: dashboard.dataset.levelSystemDirty === 'true',
                preserveGameUpdatesForm: dashboard.dataset.gameUpdatesDirty === 'true',
                channelLookup: control.channelLookup,
                roleLookup: control.roleLookup
            });
        } catch (error) {
            setDiscordBotStatusMessage('Discord channel/role lookup is unavailable. Status and manual ID entry still work.', 'error');
        } finally {
            discordLookupRefreshPending = false;
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
                renderDiscordBotControl(control.control, {
                    channelLookup: control.channelLookup,
                    roleLookup: control.roleLookup
                });
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

    function markGuildFormDirty() {
        dashboard.dataset.guildDirty = 'true';
    }

    function markStartupSyncFormDirty() {
        dashboard.dataset.startupSyncDirty = 'true';
    }

    function markTicketSystemFormDirty() {
        dashboard.dataset.ticketSystemDirty = 'true';
    }

    function markLevelSystemFormDirty() {
        dashboard.dataset.levelSystemDirty = 'true';
    }

    function markGameUpdatesFormDirty() {
        dashboard.dataset.gameUpdatesDirty = 'true';
    }

    function getCurrentDiscordChannelMaps() {
        return buildDiscordChannelLookupMaps(discordChannelLookupState);
    }

    function getCurrentDiscordCategoryMaps() {
        return buildDiscordChannelLookupMaps({
            channels: discordChannelLookupState.channels.filter((channel) => channel.type === 4)
        });
    }

    function getCurrentDiscordRoleMaps() {
        return buildDiscordRoleLookupMaps(discordRoleLookupState);
    }

    dashboard.querySelectorAll('[data-discord-tab-target]').forEach((button) => {
        button.addEventListener('click', () => {
            const targetId = String(button.dataset.discordTabTarget || '');
            if (targetId) {
                activateDiscordDashboardTab(targetId);
            }
        });
    });

    if (guildIdInput) {
        guildIdInput.addEventListener('input', markGuildFormDirty);
    }
    if (startupRulesChannelInput) {
        startupRulesChannelInput.addEventListener('input', markStartupSyncFormDirty);
    }
    if (startupInfoChannelInput) {
        startupInfoChannelInput.addEventListener('input', markStartupSyncFormDirty);
    }
    if (startupRolesChannelInput) {
        startupRolesChannelInput.addEventListener('input', markStartupSyncFormDirty);
    }
    if (startupStaffInfoChannelInput) {
        startupStaffInfoChannelInput.addEventListener('input', markStartupSyncFormDirty);
    }
    if (startupGameTestInfoChannelInput) {
        startupGameTestInfoChannelInput.addEventListener('input', markStartupSyncFormDirty);
    }
    if (ticketCategoryChannelInput) {
        ticketCategoryChannelInput.addEventListener('input', markTicketSystemFormDirty);
    }
    if (ticketPanelChannelInput) {
        ticketPanelChannelInput.addEventListener('input', markTicketSystemFormDirty);
    }
    if (ticketHelperRoleInput) {
        ticketHelperRoleInput.addEventListener('input', markTicketSystemFormDirty);
    }
    if (levelSystemEnabledInput) {
        levelSystemEnabledInput.addEventListener('change', markLevelSystemFormDirty);
    }
    if (levelMentionEnabledInput) {
        levelMentionEnabledInput.addEventListener('change', markLevelSystemFormDirty);
    }
    if (levelAnnouncementChannelInput) {
        levelAnnouncementChannelInput.addEventListener('input', markLevelSystemFormDirty);
    }
    if (levelAttachmentUnlockLevelInput) {
        levelAttachmentUnlockLevelInput.addEventListener('change', markLevelSystemFormDirty);
    }
    if (gameUpdatesChannelInput) {
        gameUpdatesChannelInput.addEventListener('input', markGameUpdatesFormDirty);
    }
    if (gameUpdatesPingEveryoneInput) {
        gameUpdatesPingEveryoneInput.addEventListener('change', markGameUpdatesFormDirty);
    }
    bindDiscordChannelAutocompleteInput(startupRulesChannelInput, getCurrentDiscordChannelMaps);
    bindDiscordChannelAutocompleteInput(startupInfoChannelInput, getCurrentDiscordChannelMaps);
    bindDiscordChannelAutocompleteInput(startupRolesChannelInput, getCurrentDiscordChannelMaps);
    bindDiscordChannelAutocompleteInput(startupStaffInfoChannelInput, getCurrentDiscordChannelMaps);
    bindDiscordChannelAutocompleteInput(startupGameTestInfoChannelInput, getCurrentDiscordChannelMaps);
    bindDiscordChannelAutocompleteInput(ticketCategoryChannelInput, getCurrentDiscordCategoryMaps);
    bindDiscordChannelAutocompleteInput(ticketPanelChannelInput, getCurrentDiscordChannelMaps);
    bindDiscordChannelAutocompleteInput(levelAnnouncementChannelInput, getCurrentDiscordChannelMaps);
    bindDiscordChannelAutocompleteInput(gameUpdatesChannelInput, getCurrentDiscordChannelMaps);

    if (ticketHelperRoleAddButton) {
        ticketHelperRoleAddButton.addEventListener('click', () => {
            const roleId = resolveDiscordRoleInputValue(ticketHelperRoleInput, getCurrentDiscordRoleMaps());
            if (!roleId || !ticketHelperRoleList) {
                return;
            }

            const selectedRoleIds = getSelectedDiscordRoleIds(ticketHelperRoleList);
            if (!selectedRoleIds.includes(roleId)) {
                selectedRoleIds.push(roleId);
            }

            renderDiscordSelectedRoles(ticketHelperRoleList, selectedRoleIds, getCurrentDiscordRoleMaps());
            if (ticketHelperRoleInput) {
                ticketHelperRoleInput.value = '';
            }
            markTicketSystemFormDirty();
        });
    }

    if (ticketHelperRoleList) {
        ticketHelperRoleList.addEventListener('click', (event) => {
            const removeButton = event.target && event.target.closest
                ? event.target.closest('.admin-selected-remove')
                : null;
            if (!removeButton) {
                return;
            }

            const removedRoleId = String(removeButton.dataset.roleId || '');
            const selectedRoleIds = getSelectedDiscordRoleIds(ticketHelperRoleList)
                .filter((roleId) => roleId !== removedRoleId);
            renderDiscordSelectedRoles(ticketHelperRoleList, selectedRoleIds, getCurrentDiscordRoleMaps());
            markTicketSystemFormDirty();
        });
    }

    if (guildSaveButton) {
        guildSaveButton.addEventListener('click', async () => {
            guildSaveButton.disabled = true;
            setDiscordBotStatusMessage('Saving Discord server ID...', 'info');

            try {
                const control = await saveDiscordBotGuildConfig(guildIdInput ? guildIdInput.value : '');
                dashboard.dataset.guildDirty = 'false';
                renderDiscordBotControl(control.control, {
                    channelLookup: control.channelLookup,
                    roleLookup: control.roleLookup
                });
                setDiscordBotStatusMessage('Discord server ID saved.', 'success');
            } catch (error) {
                guildSaveButton.disabled = false;
                setDiscordBotStatusMessage(error.message || 'Failed to save Discord server ID.', 'error');
            }
        });
    }

    if (startupSyncSaveButton) {
        startupSyncSaveButton.addEventListener('click', async () => {
            startupSyncSaveButton.disabled = true;
            setDiscordBotStatusMessage('Saving startup sync settings...', 'info');

            try {
                const control = await saveDiscordBotStartupSyncConfig({
                    rulesChannelId: startupRulesChannelInput ? resolveDiscordChannelInputValue(startupRulesChannelInput, getCurrentDiscordChannelMaps()) : '',
                    infoChannelId: startupInfoChannelInput ? resolveDiscordChannelInputValue(startupInfoChannelInput, getCurrentDiscordChannelMaps()) : '',
                    rolesChannelId: startupRolesChannelInput ? resolveDiscordChannelInputValue(startupRolesChannelInput, getCurrentDiscordChannelMaps()) : '',
                    staffInfoChannelId: startupStaffInfoChannelInput ? resolveDiscordChannelInputValue(startupStaffInfoChannelInput, getCurrentDiscordChannelMaps()) : '',
                    gameTestInfoChannelId: startupGameTestInfoChannelInput ? resolveDiscordChannelInputValue(startupGameTestInfoChannelInput, getCurrentDiscordChannelMaps()) : ''
                });
                dashboard.dataset.startupSyncDirty = 'false';
                renderDiscordBotControl(control.control, {
                    channelLookup: control.channelLookup,
                    roleLookup: control.roleLookup
                });
                setDiscordBotStatusMessage('Startup sync settings saved. They will apply on bot startup/reconnect.', 'success');
            } catch (error) {
                startupSyncSaveButton.disabled = false;
                setDiscordBotStatusMessage(error.message || 'Failed to save startup sync settings.', 'error');
            }
        });
    }

    if (ticketSystemSaveButton) {
        ticketSystemSaveButton.addEventListener('click', async () => {
            ticketSystemSaveButton.disabled = true;
            setDiscordBotStatusMessage('Saving ticket settings...', 'info');

            try {
                const control = await saveDiscordTicketSystemConfig({
                    categoryChannelId: ticketCategoryChannelInput ? resolveDiscordChannelInputValue(ticketCategoryChannelInput, getCurrentDiscordCategoryMaps()) : '',
                    panelChannelId: ticketPanelChannelInput ? resolveDiscordChannelInputValue(ticketPanelChannelInput, getCurrentDiscordChannelMaps()) : '',
                    helperRoleIds: getSelectedDiscordRoleIds(ticketHelperRoleList)
                });
                dashboard.dataset.ticketSystemDirty = 'false';
                renderDiscordBotControl(control.control, {
                    channelLookup: control.channelLookup,
                    roleLookup: control.roleLookup
                });
                setDiscordBotStatusMessage('Ticket settings saved. The panel message will sync while the bot is online.', 'success');
            } catch (error) {
                ticketSystemSaveButton.disabled = false;
                setDiscordBotStatusMessage(error.message || 'Failed to save ticket settings.', 'error');
            }
        });
    }

    if (levelSystemSaveButton) {
        levelSystemSaveButton.addEventListener('click', async () => {
            levelSystemSaveButton.disabled = true;
            setDiscordBotStatusMessage('Saving level settings...', 'info');

            try {
                const control = await saveDiscordLevelSystemConfig({
                    enabled: levelSystemEnabledInput ? levelSystemEnabledInput.checked : false,
                    mentionLevelUps: levelMentionEnabledInput ? levelMentionEnabledInput.checked : true,
                    announcementChannelId: levelAnnouncementChannelInput ? resolveDiscordChannelInputValue(levelAnnouncementChannelInput, getCurrentDiscordChannelMaps()) : '',
                    attachmentUnlockLevel: levelAttachmentUnlockLevelInput ? levelAttachmentUnlockLevelInput.value : 5
                });
                dashboard.dataset.levelSystemDirty = 'false';
                renderDiscordBotControl(control.control, {
                    channelLookup: control.channelLookup,
                    roleLookup: control.roleLookup
                });
                setDiscordBotStatusMessage('Level settings saved. The level roles will sync while the bot is online.', 'success');
            } catch (error) {
                levelSystemSaveButton.disabled = false;
                setDiscordBotStatusMessage(error.message || 'Failed to save level settings.', 'error');
            }
        });
    }

    if (gameUpdatesSaveButton) {
        gameUpdatesSaveButton.addEventListener('click', async () => {
            gameUpdatesSaveButton.disabled = true;
            setDiscordBotStatusMessage('Saving game updates channel...', 'info');

            try {
                const control = await saveDiscordGameUpdatesConfig({
                    channelId: gameUpdatesChannelInput ? resolveDiscordChannelInputValue(gameUpdatesChannelInput, getCurrentDiscordChannelMaps()) : '',
                    pingEveryoneEnabled: gameUpdatesPingEveryoneInput ? gameUpdatesPingEveryoneInput.checked : true
                });
                dashboard.dataset.gameUpdatesDirty = 'false';
                renderDiscordBotControl(control.control, {
                    channelLookup: control.channelLookup,
                    roleLookup: control.roleLookup
                });
                setDiscordBotStatusMessage('Game updates channel saved.', 'success');
            } catch (error) {
                gameUpdatesSaveButton.disabled = false;
                setDiscordBotStatusMessage(error.message || 'Failed to save game updates channel.', 'error');
            }
        });
    }

    if (gameUpdateSendButton) {
        gameUpdateSendButton.addEventListener('click', async () => {
            gameUpdateSendButton.disabled = true;
            setDiscordBotStatusMessage('Sending game update announcement...', 'info');

            try {
                const control = await sendDiscordGameUpdateAnnouncement({
                    channelId: gameUpdatesChannelInput ? resolveDiscordChannelInputValue(gameUpdatesChannelInput, getCurrentDiscordChannelMaps()) : '',
                    title: gameUpdateTitleInput ? gameUpdateTitleInput.value : '',
                    body: gameUpdateBodyInput ? gameUpdateBodyInput.value : '',
                    pingEveryoneEnabled: gameUpdatesPingEveryoneInput ? gameUpdatesPingEveryoneInput.checked : true
                });
                dashboard.dataset.gameUpdatesDirty = 'false';
                if (gameUpdateTitleInput) {
                    gameUpdateTitleInput.value = '';
                }
                if (gameUpdateBodyInput) {
                    gameUpdateBodyInput.value = '';
                }
                renderDiscordBotControl(control.control, {
                    channelLookup: control.channelLookup,
                    roleLookup: control.roleLookup
                });
                const announcement = control.announcement || {};
                const channelLabel = announcement.channelName ? `#${announcement.channelName}` : 'the selected channel';
                const messageUrl = announcement.messageUrl ? ` ${announcement.messageUrl}` : '';
                setDiscordBotStatusMessage(`Game update announcement sent to ${channelLabel}.${messageUrl}`, 'success');
            } catch (error) {
                gameUpdateSendButton.disabled = false;
                const detail = error && error.data && error.data.details
                    ? String(error.data.details)
                    : '';
                setDiscordBotStatusMessage(detail || error.message || 'Failed to send game update announcement.', 'error');
            }
        });
    }

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
    refreshDiscordLookups();
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
