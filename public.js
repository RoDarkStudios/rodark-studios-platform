const ACTIVE_PLAYERS_DISPLAY_THRESHOLD = 1000;

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
        const error = new Error(data.error || `Request failed (${response.status})`);
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

    navAdminItem.classList.toggle('hidden', !isVisible);
}

function readAuthStatusFromQuery() {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('auth') && !params.has('reason')) {
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
        const response = await fetch('/api/auth/admin', {
            method: 'GET',
            credentials: 'include'
        });

        if (!response.ok) {
            return { isAdmin: false };
        }

        const data = await response.json();
        return { isAdmin: Boolean(data && data.isAdmin) };
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
    window.location.href = `/api/auth/login?returnTo=${encodeURIComponent(returnTo || '/')}`;
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

function calculateAge(birthDate) {
    const today = new Date();
    const birth = new Date(birthDate);
    let age = today.getFullYear() - birth.getFullYear();
    const monthDiff = today.getMonth() - birth.getMonth();

    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
        age -= 1;
    }

    return age;
}

function formatNumber(num) {
    return num.toLocaleString();
}

function formatCompactNumber(value) {
    const number = Math.trunc(value);
    if (number >= 1000000) {
        const millions = number / 1000000;
        return `${millions.toFixed(millions >= 10 ? 0 : 1).replace(/\.0$/, '')}M`;
    }

    if (number >= 1000) {
        const thousands = number / 1000;
        return `${thousands.toFixed(thousands >= 10 ? 0 : 1).replace(/\.0$/, '')}K`;
    }

    return formatNumber(number);
}

async function fetchRobloxGroupGames() {
    const response = await fetch('/api/roblox/group-games', { method: 'GET' });
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

async function fetchRobloxStudioStats() {
    const response = await fetch('/api/roblox/studio-stats', { method: 'GET' });
    if (!response.ok) {
        let payload = null;
        try {
            payload = await response.json();
        } catch (error) {
            payload = null;
        }

        const detail = payload && typeof payload.details === 'string' && payload.details.trim()
            ? payload.details.trim()
            : `Studio stats API failed (${response.status})`;
        throw new Error(detail);
    }

    return response.json();
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
    stats.append(createStat(
        'fas fa-eye',
        Number.isFinite(visits) && visits >= 0 ? formatNumber(Math.trunc(visits)) : 'Unavailable',
        'Total Visits'
    ));
    if (Number.isFinite(playing) && playing > ACTIVE_PLAYERS_DISPLAY_THRESHOLD) {
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

    prevButton.disabled = gameCards.length <= 1;
    nextButton.disabled = gameCards.length <= 1;
    prevButton.addEventListener('click', () => setActiveCard(activeIndex - 1));
    nextButton.addEventListener('click', () => setActiveCard(activeIndex + 1));
    carousel.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowLeft') {
            event.preventDefault();
            setActiveCard(activeIndex - 1);
        } else if (event.key === 'ArrowRight') {
            event.preventDefault();
            setActiveCard(activeIndex + 1);
        }
    });

    setActiveCard(activeIndex);
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

function renderGameMessage(showcase, message, isError) {
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

async function fetchAllGameStats() {
    const showcase = document.getElementById('games-showcase');
    if (!showcase) {
        return;
    }

    try {
        setCarouselNavDisabled(true);
        const games = await fetchRobloxGroupGames();
        if (!games.length) {
            renderGameMessage(showcase, 'No group games with over 100,000 visits are available right now.', false);
            return;
        }

        showcase.replaceChildren(...games.map(createGameCard));
        initGamesCarousel();
    } catch (error) {
        console.error('Failed to fetch featured game metadata:', error);
        renderGameMessage(showcase, 'Games are unavailable right now.', true);
    }
}

async function fetchGroupStats() {
    const totalVisitsElement = document.getElementById('studio-total-visits');
    const activePlayersElement = document.getElementById('studio-active-players');
    const activePlayersStat = document.getElementById('studio-active-players-stat');
    const heroStatGrid = activePlayersStat ? activePlayersStat.closest('.hero-stat-grid') : null;
    const groupMemberCountElement = document.getElementById('group-member-count');
    if (!groupMemberCountElement && !totalVisitsElement && !activePlayersElement) {
        return;
    }

    try {
        const studioStats = await fetchRobloxStudioStats();
        const totalVisits = Number(studioStats && studioStats.totalVisits);
        const totalPlaying = Number(studioStats && studioStats.totalPlaying);
        const memberCount = Number(studioStats && studioStats.memberCount);
        const activePlayersDisplayThreshold = Number(studioStats && studioStats.activePlayersDisplayThreshold);
        const shouldShowActivePlayers = Boolean(studioStats && studioStats.showActivePlayers)
            && Number.isFinite(totalPlaying)
            && totalPlaying > activePlayersDisplayThreshold;

        if (!Number.isFinite(totalVisits) || totalVisits < 0) {
            throw new Error('Studio stats API returned invalid totalVisits');
        }

        if (!Number.isFinite(memberCount) || memberCount < 0) {
            throw new Error('Studio stats API returned invalid memberCount');
        }

        if (totalVisitsElement) {
            totalVisitsElement.textContent = formatCompactNumber(totalVisits);
        }

        if (groupMemberCountElement) {
            groupMemberCountElement.textContent = formatCompactNumber(memberCount);
        }

        if (activePlayersElement && activePlayersStat) {
            if (shouldShowActivePlayers) {
                activePlayersElement.textContent = formatCompactNumber(totalPlaying);
                activePlayersStat.classList.remove('hidden');
                if (heroStatGrid) {
                    heroStatGrid.classList.remove('is-two-up');
                }
            } else {
                activePlayersStat.classList.add('hidden');
                if (heroStatGrid) {
                    heroStatGrid.classList.add('is-two-up');
                }
            }
        }
    } catch (error) {
        console.error('Failed to fetch studio statistics:', error);
        if (totalVisitsElement) {
            totalVisitsElement.textContent = 'Unavailable';
        }
        if (activePlayersElement) {
            activePlayersElement.textContent = 'Unavailable';
        }
        if (activePlayersStat) {
            activePlayersStat.classList.remove('hidden');
        }
        if (heroStatGrid) {
            heroStatGrid.classList.remove('is-two-up');
        }
        if (groupMemberCountElement) {
            groupMemberCountElement.textContent = 'Unavailable';
        }
    }
}

function fetchUserAvatars() {
    document.querySelectorAll('.member-avatar .avatar-image').forEach((img) => {
        if (img.dataset.fallbackBound === '1') {
            return;
        }

        img.dataset.fallbackBound = '1';
        img.addEventListener('error', () => {
            const avatarElement = img.closest('.member-avatar');
            if (avatarElement) {
                avatarElement.innerHTML = '<i class="fas fa-user"></i>';
            }
        }, { once: true });
    });
}

function initAges() {
    const ages = {
        'myron-age': calculateAge('2008-05-31'),
        'tristan-age': calculateAge('2004-12-25'),
        'kasper-age': calculateAge('2004-12-25')
    };

    Object.entries(ages).forEach(([elementId, age]) => {
        const element = document.getElementById(elementId);
        if (element) {
            element.textContent = age;
        }
    });
}

function initCurrentYear() {
    const currentYearElement = document.getElementById('current-year');
    if (currentYearElement) {
        currentYearElement.textContent = new Date().getFullYear();
    }
}

function initMobileNav() {
    const hamburger = document.querySelector('.hamburger');
    const navMenu = document.querySelector('.nav-menu');
    if (!hamburger || !navMenu) {
        return;
    }

    hamburger.addEventListener('click', () => {
        hamburger.classList.toggle('active');
        navMenu.classList.toggle('active');
    });

    document.querySelectorAll('.nav-link').forEach((link) => {
        link.addEventListener('click', () => {
            hamburger.classList.remove('active');
            navMenu.classList.remove('active');
        });
    });
}

function initSmoothScrolling() {
    document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
        anchor.addEventListener('click', (event) => {
            event.preventDefault();
            const target = document.querySelector(anchor.getAttribute('href'));
            if (!target) {
                return;
            }

            window.scrollTo({
                top: target.offsetTop - 80,
                behavior: 'smooth'
            });
        });
    });
}

function initNavbarScroll() {
    const navbar = document.querySelector('.navbar');
    if (!navbar) {
        return;
    }

    window.addEventListener('scroll', () => {
        navbar.style.background = window.scrollY > 50
            ? 'rgba(23, 23, 23, 0.98)'
            : 'rgba(23, 23, 23, 0.95)';
    }, { passive: true });
}

function initFadeInAnimations() {
    if (!('IntersectionObserver' in window)) {
        return;
    }

    const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            if (entry.isIntersecting) {
                entry.target.style.opacity = '1';
                entry.target.style.transform = 'translateY(0)';
                observer.unobserve(entry.target);
            }
        });
    }, {
        threshold: 0.1,
        rootMargin: '0px 0px -50px 0px'
    });

    document.querySelectorAll('.team-member, .feature, .game-card, .social-link').forEach((el, index) => {
        el.style.opacity = '0';
        el.style.transform = 'translateY(30px)';
        el.style.transition = `opacity 0.6s ease ${index * 0.1}s, transform 0.6s ease ${index * 0.1}s`;
        observer.observe(el);
    });
}

function initRippleEffect() {
    document.addEventListener('click', (event) => {
        const button = event.target && event.target.closest ? event.target.closest('.btn') : null;
        if (!button) {
            return;
        }

        const ripple = document.createElement('span');
        const rect = button.getBoundingClientRect();
        const size = Math.max(rect.width, rect.height);
        ripple.style.width = `${size}px`;
        ripple.style.height = `${size}px`;
        ripple.style.left = `${event.clientX - rect.left - size / 2}px`;
        ripple.style.top = `${event.clientY - rect.top - size / 2}px`;
        ripple.classList.add('ripple');
        button.appendChild(ripple);

        window.setTimeout(() => {
            ripple.remove();
        }, 600);
    });
}

document.addEventListener('DOMContentLoaded', () => {
    initAuth();
    initAges();
    initCurrentYear();
    fetchAllGameStats();
    fetchGroupStats();
    fetchUserAvatars();
    initMobileNav();
    initSmoothScrolling();
    initNavbarScroll();
    initRippleEffect();
});

window.addEventListener('load', initFadeInAnimations);

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
