const profitTrackerState = {
    games: [],
    expenseCategories: ['animations', 'models', 'vfx', 'map', 'advertising', 'other'],
    exchangeRate: null,
    analyticsRetentionDays: 1468,
    busy: false
};

const PROFIT_CATEGORY_LABELS = {
    animations: 'Animations',
    models: 'Models',
    vfx: 'VFX',
    map: 'Map',
    advertising: 'Advertising',
    other: 'Other'
};

function escapeProfitHtml(value) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function formatProfitMoney(cents) {
    const numericCents = Number(cents);
    if (!Number.isFinite(numericCents)) {
        return 'Unavailable';
    }

    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    }).format(numericCents / 100);
}

function formatProfitRobux(value) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
        return 'Unavailable';
    }
    return `${Math.round(numericValue).toLocaleString('en-US')} R$`;
}

function formatProfitDate(value) {
    if (!value) {
        return 'Unknown';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return 'Unknown';
    }
    return date.toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short'
    });
}

function centsToProfitInput(cents) {
    const numericCents = Number(cents);
    return Number.isFinite(numericCents) ? (numericCents / 100).toFixed(2) : '';
}

function setProfitTrackerStatus(message, type) {
    const status = document.getElementById('profit-tracker-status');
    if (!status) {
        return;
    }
    status.textContent = message || '';
    status.className = `admin-status ${type || 'info'}${message ? '' : ' hidden'}`;
}

function setProfitTrackerBusy(isBusy) {
    profitTrackerState.busy = isBusy;
    const ownedContent = document.getElementById('admin-owned-content');
    if (!ownedContent) {
        return;
    }
    ownedContent.classList.toggle('is-busy', isBusy);
    ownedContent.querySelectorAll('button, input, select').forEach((element) => {
        element.disabled = isBusy;
    });
}

async function profitTrackerRequest(method, payload, query) {
    const search = query ? `?${new URLSearchParams(query).toString()}` : '';
    const options = {
        method,
        credentials: 'include',
        headers: { Accept: 'application/json' }
    };
    if (payload !== undefined) {
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(payload);
    }

    const response = await fetch(`/api/admin/profit-tracker${search}`, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(data.error || `Request failed (${response.status})`);
        error.status = response.status;
        error.code = data.code || null;
        error.currentVersion = data.currentVersion;
        throw error;
    }
    return data;
}

function getProfitTrackerGame(gameId) {
    return profitTrackerState.games.find((game) => game.id === gameId) || null;
}

function renderProfitSummary() {
    const summary = document.getElementById('profit-tracker-summary');
    const rateNote = document.getElementById('profit-tracker-rate');
    if (!summary) {
        return;
    }

    const games = profitTrackerState.games;
    const gamesWithRevenue = games.filter((game) => game.revenue && game.revenue.status === 'available');
    const unavailableCount = games.length - gamesWithRevenue.length;
    const totalRevenueCents = gamesWithRevenue.reduce(
        (sum, game) => sum + Number(game.revenue.estimatedRevenueCents || 0),
        0
    );
    const totalExpenseCents = games.reduce(
        (sum, game) => sum + Number(game.totalExpenseCents || 0),
        0
    );
    const totalKnownProfitCents = gamesWithRevenue.reduce(
        (sum, game) => sum + Number(game.estimatedProfitCents || 0),
        0
    );
    const revenueDisplay = games.length > 0 && gamesWithRevenue.length === 0
        ? 'Unavailable'
        : formatProfitMoney(totalRevenueCents);
    const profitDisplay = games.length > 0 && gamesWithRevenue.length === 0
        ? 'Unavailable'
        : formatProfitMoney(totalKnownProfitCents);
    const coverageText = unavailableCount > 0
        ? `${gamesWithRevenue.length} of ${games.length} games loaded`
        : 'All tracked games loaded';

    summary.innerHTML = `
        <article class="profit-summary-stat revenue">
            <span>Estimated revenue</span>
            <strong>${escapeProfitHtml(revenueDisplay)}</strong>
            <small>${escapeProfitHtml(coverageText)}</small>
        </article>
        <article class="profit-summary-stat expenses">
            <span>Expenses</span>
            <strong>${escapeProfitHtml(formatProfitMoney(totalExpenseCents))}</strong>
            <small>Recorded in USD</small>
        </article>
        <article class="profit-summary-stat ${totalKnownProfitCents < 0 ? 'loss' : 'profit'}">
            <span>Estimated profit</span>
            <strong>${escapeProfitHtml(profitDisplay)}</strong>
            <small>${escapeProfitHtml(coverageText)}</small>
        </article>
        <article class="profit-summary-stat games">
            <span>Games</span>
            <strong>${games.length.toLocaleString('en-US')}</strong>
            <small>${games.length === 1 ? 'Tracked game' : 'Tracked games'}</small>
        </article>
    `;

    if (rateNote) {
        const usdPerRobux = Number(profitTrackerState.exchangeRate && profitTrackerState.exchangeRate.usdPerRobux);
        rateNote.textContent = Number.isFinite(usdPerRobux)
            ? `USD estimates use the current standard Roblox DevEx rate: 1 Earned Robux = $${usdPerRobux.toFixed(4)} USD.`
            : 'USD revenue is an estimate based on the current standard Roblox DevEx rate.';
    }
}

function renderCategoryOptions(selectedCategory) {
    return profitTrackerState.expenseCategories.map((category) => `
        <option value="${escapeProfitHtml(category)}"${category === selectedCategory ? ' selected' : ''}>
            ${escapeProfitHtml(PROFIT_CATEGORY_LABELS[category] || category)}
        </option>
    `).join('');
}

function renderExpenseRow(game, expense) {
    return `
        <article class="profit-expense-row" data-expense-id="${escapeProfitHtml(expense.id)}">
            <div class="profit-expense-view">
                <span class="profit-category-pill category-${escapeProfitHtml(expense.category)}">
                    ${escapeProfitHtml(PROFIT_CATEGORY_LABELS[expense.category] || expense.category)}
                </span>
                <div class="profit-expense-description">
                    <strong>${escapeProfitHtml(expense.description)}</strong>
                    <small>Updated ${escapeProfitHtml(formatProfitDate(expense.updatedAt))}${expense.updatedByUsername ? ` by @${escapeProfitHtml(expense.updatedByUsername)}` : ''}</small>
                </div>
                <strong class="profit-expense-amount">${escapeProfitHtml(formatProfitMoney(expense.amountCents))}</strong>
                <div class="profit-row-actions">
                    <button class="profit-icon-btn" type="button" data-action="edit-expense" aria-label="Edit expense" title="Edit expense">
                        <i class="fas fa-pen" aria-hidden="true"></i>
                    </button>
                    <button class="profit-icon-btn danger" type="button" data-action="delete-expense" aria-label="Delete expense" title="Delete expense">
                        <i class="fas fa-trash" aria-hidden="true"></i>
                    </button>
                </div>
            </div>
            <form class="profit-expense-edit-form hidden" data-form="edit-expense">
                <label class="admin-field">
                    <span class="admin-label">Amount (USD)</span>
                    <input class="admin-input" name="amountUsd" type="number" min="0.01" max="999999999.99" step="0.01" value="${escapeProfitHtml(centsToProfitInput(expense.amountCents))}" required>
                </label>
                <label class="admin-field profit-description-field">
                    <span class="admin-label">Description</span>
                    <input class="admin-input" name="description" type="text" maxlength="500" value="${escapeProfitHtml(expense.description)}" required>
                </label>
                <label class="admin-field">
                    <span class="admin-label">Category</span>
                    <select class="admin-input" name="category" required>
                        ${renderCategoryOptions(expense.category)}
                    </select>
                </label>
                <div class="profit-form-actions">
                    <button class="btn btn-primary admin-compact-btn" type="submit">Save</button>
                    <button class="btn btn-secondary admin-compact-btn" type="button" data-action="cancel-expense-edit">Cancel</button>
                </div>
            </form>
        </article>
    `;
}

function renderRevenueState(game) {
    const revenue = game.revenue || {};
    if (revenue.status !== 'available') {
        return `
            <div class="profit-revenue-error">
                <i class="fas fa-triangle-exclamation" aria-hidden="true"></i>
                <div>
                    <strong>Revenue unavailable</strong>
                    <span>${escapeProfitHtml(revenue.message || 'Roblox analytics could not be loaded.')}</span>
                </div>
            </div>
        `;
    }

    const historyLabel = revenue.historyComplete
        ? 'Complete history since this game was created'
        : `Available Roblox history since ${new Date(revenue.historyStart).toLocaleDateString()}`;
    return `
        <p class="profit-revenue-note">
            <i class="fas fa-circle-info" aria-hidden="true"></i>
            ${escapeProfitHtml(historyLabel)}. Refreshed ${escapeProfitHtml(formatProfitDate(revenue.fetchedAt))}.
        </p>
    `;
}

function renderProfitGame(game) {
    const revenueAvailable = game.revenue && game.revenue.status === 'available';
    const revenueCents = revenueAvailable ? game.revenue.estimatedRevenueCents : null;
    const revenueRobux = revenueAvailable ? game.revenue.revenueRobux : null;
    const profitCents = revenueAvailable ? game.estimatedProfitCents : null;
    const profitClass = Number(profitCents) < 0 ? 'loss' : 'profit';
    const expenses = Array.isArray(game.expenses) ? game.expenses : [];

    return `
        <article class="profit-game-card" data-game-id="${escapeProfitHtml(game.id)}">
            <header class="profit-game-header">
                <div class="profit-game-identity">
                    <img src="/api/roblox/game-icon?universeId=${encodeURIComponent(game.universeId)}&size=150x150" alt="" class="profit-game-icon" loading="lazy">
                    <div>
                        <h3>${escapeProfitHtml(game.displayName)}</h3>
                        <a href="https://create.roblox.com/dashboard/creations/experiences/${encodeURIComponent(game.universeId)}/overview" target="_blank" rel="noopener noreferrer">
                            Universe ${escapeProfitHtml(game.universeId)}
                            <i class="fas fa-arrow-up-right-from-square" aria-hidden="true"></i>
                        </a>
                    </div>
                </div>
                <div class="profit-game-actions">
                    <span class="profit-version-pill" title="Concurrency version">Version ${escapeProfitHtml(game.version)}</span>
                    <button class="profit-icon-btn" type="button" data-action="edit-game" aria-label="Edit game" title="Edit game">
                        <i class="fas fa-pen" aria-hidden="true"></i>
                    </button>
                    <button class="profit-icon-btn danger" type="button" data-action="delete-game" aria-label="Delete game" title="Delete game">
                        <i class="fas fa-trash" aria-hidden="true"></i>
                    </button>
                </div>
            </header>

            <form class="profit-game-edit-form hidden" data-form="edit-game">
                <label class="admin-field">
                    <span class="admin-label">Display name</span>
                    <input class="admin-input" name="displayName" type="text" maxlength="120" value="${escapeProfitHtml(game.displayName)}" required>
                </label>
                <label class="admin-field">
                    <span class="admin-label">Universe ID</span>
                    <input class="admin-input" name="universeId" type="text" inputmode="numeric" pattern="[0-9]+" value="${escapeProfitHtml(game.universeId)}" required>
                </label>
                <div class="profit-form-actions">
                    <button class="btn btn-primary admin-compact-btn" type="submit">Save game</button>
                    <button class="btn btn-secondary admin-compact-btn" type="button" data-action="cancel-game-edit">Cancel</button>
                </div>
            </form>

            <section class="profit-game-metrics" aria-label="${escapeProfitHtml(game.displayName)} financial summary">
                <article>
                    <span>Estimated revenue</span>
                    <strong>${escapeProfitHtml(formatProfitMoney(revenueCents))}</strong>
                    <small>${escapeProfitHtml(formatProfitRobux(revenueRobux))}</small>
                </article>
                <article>
                    <span>Expenses</span>
                    <strong>${escapeProfitHtml(formatProfitMoney(game.totalExpenseCents))}</strong>
                    <small>${expenses.length} ${expenses.length === 1 ? 'expense' : 'expenses'}</small>
                </article>
                <article class="${profitClass}">
                    <span>Estimated profit</span>
                    <strong>${escapeProfitHtml(formatProfitMoney(profitCents))}</strong>
                    <small>Revenue minus expenses</small>
                </article>
            </section>

            ${renderRevenueState(game)}

            <section class="profit-expenses-section">
                <div class="profit-section-heading">
                    <div>
                        <h4>Expenses</h4>
                        <p>All amounts are stored and calculated in USD.</p>
                    </div>
                </div>

                <form class="profit-add-expense-form" data-form="add-expense">
                    <label class="admin-field">
                        <span class="admin-label">Amount (USD)</span>
                        <input class="admin-input" name="amountUsd" type="number" min="0.01" max="999999999.99" step="0.01" placeholder="0.00" required>
                    </label>
                    <label class="admin-field profit-description-field">
                        <span class="admin-label">Description</span>
                        <input class="admin-input" name="description" type="text" maxlength="500" placeholder="What was purchased?" required>
                    </label>
                    <label class="admin-field">
                        <span class="admin-label">Category</span>
                        <select class="admin-input" name="category" required>
                            <option value="" selected disabled>Select a category</option>
                            ${renderCategoryOptions('')}
                        </select>
                    </label>
                    <button class="btn btn-secondary profit-add-expense-btn" type="submit">
                        <i class="fas fa-plus" aria-hidden="true"></i>
                        Add expense
                    </button>
                </form>

                <div class="profit-expense-list">
                    ${expenses.length > 0
                        ? expenses.map((expense) => renderExpenseRow(game, expense)).join('')
                        : '<p class="profit-no-expenses">No expenses recorded for this game.</p>'}
                </div>
            </section>
        </article>
    `;
}

function renderProfitTracker() {
    const gamesElement = document.getElementById('profit-tracker-games');
    const emptyElement = document.getElementById('profit-tracker-empty');
    if (!gamesElement) {
        return;
    }

    renderProfitSummary();
    gamesElement.innerHTML = profitTrackerState.games.map(renderProfitGame).join('');
    if (emptyElement) {
        emptyElement.classList.toggle('hidden', profitTrackerState.games.length > 0);
    }
}

async function loadProfitTracker(options) {
    const settings = options || {};
    if (settings.showLoading !== false) {
        setProfitTrackerStatus(
            settings.forceRevenue ? 'Refreshing Roblox revenue...' : 'Loading games and Roblox revenue...',
            'info'
        );
    }

    const data = await profitTrackerRequest(
        'GET',
        undefined,
        settings.forceRevenue ? { refresh: '1' } : undefined
    );
    profitTrackerState.games = Array.isArray(data.games) ? data.games : [];
    profitTrackerState.expenseCategories = Array.isArray(data.expenseCategories)
        ? data.expenseCategories
        : profitTrackerState.expenseCategories;
    profitTrackerState.exchangeRate = data.exchangeRate || null;
    profitTrackerState.analyticsRetentionDays = Number(data.analyticsRetentionDays) || 1468;
    renderProfitTracker();

    if (settings.showLoading !== false) {
        setProfitTrackerStatus('', 'info');
    }
}

async function runProfitTrackerMutation(method, payload, progressMessage, successMessage) {
    if (profitTrackerState.busy) {
        return false;
    }

    setProfitTrackerBusy(true);
    setProfitTrackerStatus(progressMessage, 'info');
    try {
        await profitTrackerRequest(method, payload);
        await loadProfitTracker({ showLoading: false });
        setProfitTrackerStatus(successMessage, 'success');
        return true;
    } catch (error) {
        if (error.status === 409 && error.code === 'VERSION_CONFLICT') {
            await loadProfitTracker({ showLoading: false }).catch(() => {});
            setProfitTrackerStatus(
                'Another admin changed this game first. Your change was not applied; the latest data is now loaded.',
                'error'
            );
        } else {
            setProfitTrackerStatus(error.message || 'The change could not be saved.', 'error');
        }
        return false;
    } finally {
        setProfitTrackerBusy(false);
    }
}

function findProfitGameElement(target) {
    return target.closest('.profit-game-card');
}

function bindProfitTrackerEvents() {
    const addGameForm = document.getElementById('profit-add-game-form');
    const gamesElement = document.getElementById('profit-tracker-games');
    const refreshButton = document.getElementById('profit-tracker-refresh');

    if (addGameForm) {
        addGameForm.addEventListener('submit', async (event) => {
            event.preventDefault();
            const formData = new FormData(addGameForm);
            const saved = await runProfitTrackerMutation('POST', {
                action: 'createGame',
                displayName: formData.get('displayName'),
                universeId: formData.get('universeId')
            }, 'Adding game...', 'Game added.');
            if (saved) {
                addGameForm.reset();
            }
        });
    }

    if (refreshButton) {
        refreshButton.addEventListener('click', async () => {
            if (profitTrackerState.busy) {
                return;
            }
            setProfitTrackerBusy(true);
            try {
                await loadProfitTracker({ forceRevenue: true });
                setProfitTrackerStatus('Roblox revenue refreshed.', 'success');
            } catch (error) {
                setProfitTrackerStatus(error.message || 'Revenue could not be refreshed.', 'error');
            } finally {
                setProfitTrackerBusy(false);
            }
        });
    }

    if (!gamesElement) {
        return;
    }

    gamesElement.addEventListener('submit', async (event) => {
        const form = event.target;
        if (!(form instanceof HTMLFormElement)) {
            return;
        }
        event.preventDefault();

        const gameElement = findProfitGameElement(form);
        const game = gameElement ? getProfitTrackerGame(gameElement.dataset.gameId) : null;
        if (!game) {
            setProfitTrackerStatus('This game is no longer available. Refresh and try again.', 'error');
            return;
        }
        const formData = new FormData(form);

        if (form.dataset.form === 'add-expense') {
            await runProfitTrackerMutation('POST', {
                action: 'createExpense',
                gameId: game.id,
                expectedVersion: game.version,
                amountUsd: formData.get('amountUsd'),
                description: formData.get('description'),
                category: formData.get('category')
            }, 'Adding expense...', 'Expense added.');
            return;
        }

        if (form.dataset.form === 'edit-game') {
            await runProfitTrackerMutation('PATCH', {
                action: 'updateGame',
                gameId: game.id,
                expectedVersion: game.version,
                displayName: formData.get('displayName'),
                universeId: formData.get('universeId')
            }, 'Saving game...', 'Game saved.');
            return;
        }

        if (form.dataset.form === 'edit-expense') {
            const expenseElement = form.closest('.profit-expense-row');
            await runProfitTrackerMutation('PATCH', {
                action: 'updateExpense',
                gameId: game.id,
                expenseId: expenseElement && expenseElement.dataset.expenseId,
                expectedVersion: game.version,
                amountUsd: formData.get('amountUsd'),
                description: formData.get('description'),
                category: formData.get('category')
            }, 'Saving expense...', 'Expense saved.');
        }
    });

    gamesElement.addEventListener('click', async (event) => {
        const button = event.target.closest('button[data-action]');
        if (!button || profitTrackerState.busy) {
            return;
        }

        const gameElement = findProfitGameElement(button);
        const game = gameElement ? getProfitTrackerGame(gameElement.dataset.gameId) : null;
        if (!game) {
            return;
        }
        const action = button.dataset.action;

        if (action === 'edit-game' || action === 'cancel-game-edit') {
            const form = gameElement.querySelector('[data-form="edit-game"]');
            if (form) {
                form.classList.toggle('hidden', action === 'cancel-game-edit');
            }
            return;
        }

        const expenseElement = button.closest('.profit-expense-row');
        if (action === 'edit-expense' || action === 'cancel-expense-edit') {
            const form = expenseElement && expenseElement.querySelector('[data-form="edit-expense"]');
            const view = expenseElement && expenseElement.querySelector('.profit-expense-view');
            const cancel = action === 'cancel-expense-edit';
            if (form) {
                form.classList.toggle('hidden', cancel);
            }
            if (view) {
                view.classList.toggle('hidden', !cancel);
            }
            return;
        }

        if (action === 'delete-game') {
            if (!window.confirm(`Delete ${game.displayName} and all of its expenses? This cannot be undone.`)) {
                return;
            }
            await runProfitTrackerMutation('DELETE', {
                action: 'deleteGame',
                gameId: game.id,
                expectedVersion: game.version
            }, 'Deleting game...', 'Game deleted.');
            return;
        }

        if (action === 'delete-expense') {
            const expenseId = expenseElement && expenseElement.dataset.expenseId;
            const expense = game.expenses.find((item) => item.id === expenseId);
            if (!expense || !window.confirm(`Delete the ${formatProfitMoney(expense.amountCents)} expense "${expense.description}"?`)) {
                return;
            }
            await runProfitTrackerMutation('DELETE', {
                action: 'deleteExpense',
                gameId: game.id,
                expenseId,
                expectedVersion: game.version
            }, 'Deleting expense...', 'Expense deleted.');
        }
    });
}

async function initProfitTracker() {
    const ownedContent = document.getElementById('admin-owned-content');
    const deniedElement = document.getElementById('admin-access-denied');
    const gamesElement = document.getElementById('profit-tracker-games');
    if (!ownedContent || !gamesElement) {
        return;
    }

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
    bindProfitTrackerEvents();
    await loadProfitTracker();
}

document.addEventListener('DOMContentLoaded', () => {
    initProfitTracker().catch((error) => {
        setProfitTrackerStatus(error.message || 'The game profit tracker could not be loaded.', 'error');
    });
});
