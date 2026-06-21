const CONSULTATION_ACTIVE_STATUSES = new Set(['checkout_created', 'new', 'scheduled']);
const CONSULTATION_DONE_STATUSES = new Set(['completed', 'cancelled', 'refunded']);

const consultationAdminState = {
    bookings: [],
    filter: 'active',
    search: ''
};

function setConsultationAdminStatus(message, type) {
    const status = document.getElementById('consultation-admin-status');
    if (!status) {
        return;
    }

    status.textContent = message || '';
    status.className = `admin-status ${type || 'info'}${message ? '' : ' hidden'}`;
}

function formatConsultationMoney(amountTotal, currency) {
    const amount = Number(amountTotal || 0) / 100;
    try {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: String(currency || 'usd').toUpperCase()
        }).format(amount);
    } catch (error) {
        return `$${amount.toFixed(2)}`;
    }
}

function formatConsultationDate(value, options) {
    if (!value) {
        return 'Not set';
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return 'Not set';
    }

    return date.toLocaleString(undefined, options || {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
    });
}

function toDatetimeLocalValue(value) {
    if (!value) {
        return '';
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return '';
    }

    const offsetMs = date.getTimezoneOffset() * 60 * 1000;
    return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function getConsultationStatusLabel(status) {
    return {
        checkout_created: 'Checkout',
        new: 'New',
        scheduled: 'Scheduled',
        completed: 'Completed',
        cancelled: 'Cancelled',
        refunded: 'Refunded'
    }[status] || status || 'New';
}

function getBookingSearchText(booking) {
    return [
        booking.robloxUsername,
        booking.robloxDisplayName,
        booking.contactDiscord,
        booking.contactEmail,
        booking.stripeCustomerEmail,
        booking.gameUrl,
        booking.goals,
        booking.status,
        booking.paymentStatus
    ].filter(Boolean).join(' ').toLowerCase();
}

function isActiveConsultationBooking(booking) {
    return CONSULTATION_ACTIVE_STATUSES.has(booking.status || 'new');
}

function isUnscheduledConsultationBooking(booking) {
    return isActiveConsultationBooking(booking) && !booking.scheduledAt;
}

function getConsultationFilterCount(key) {
    return consultationAdminState.bookings.filter((booking) => matchesConsultationFilter(booking, key)).length;
}

function matchesConsultationFilter(booking, filter) {
    const status = booking.status || 'new';

    if (filter === 'active') {
        return isActiveConsultationBooking(booking);
    }
    if (filter === 'new') {
        return status === 'new' || status === 'checkout_created';
    }
    if (filter === 'unscheduled') {
        return isUnscheduledConsultationBooking(booking);
    }
    if (filter === 'scheduled') {
        return status === 'scheduled';
    }
    if (filter === 'completed') {
        return CONSULTATION_DONE_STATUSES.has(status);
    }

    return true;
}

function getFilteredConsultationBookings() {
    const query = consultationAdminState.search.trim().toLowerCase();
    return consultationAdminState.bookings
        .filter((booking) => matchesConsultationFilter(booking, consultationAdminState.filter))
        .filter((booking) => !query || getBookingSearchText(booking).includes(query))
        .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
}

async function fetchConsultationBookings() {
    const response = await fetch('/api/admin/consultations', {
        method: 'GET',
        credentials: 'include'
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data.error || `Request failed (${response.status})`);
    }

    return Array.isArray(data.bookings) ? data.bookings : [];
}

async function saveConsultationBooking(payload) {
    const response = await fetch('/api/admin/consultations', {
        method: 'PATCH',
        headers: {
            'Content-Type': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify(payload)
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data.error || `Request failed (${response.status})`);
    }

    return data.booking;
}

function renderConsultationSummary() {
    const summary = document.getElementById('consultation-bookings-summary');
    if (!summary) {
        return;
    }

    const bookings = consultationAdminState.bookings;
    const paidBookings = bookings.filter((booking) => booking.paymentStatus === 'paid');
    const revenue = paidBookings.reduce((total, booking) => total + Number(booking.amountTotal || 0), 0);
    const currency = paidBookings[0] ? paidBookings[0].currency : 'usd';

    summary.innerHTML = `
        <div class="consultation-admin-stat">
            <span>Active</span>
            <strong>${getConsultationFilterCount('active')}</strong>
        </div>
        <div class="consultation-admin-stat">
            <span>Unscheduled</span>
            <strong>${getConsultationFilterCount('unscheduled')}</strong>
        </div>
        <div class="consultation-admin-stat">
            <span>Scheduled</span>
            <strong>${getConsultationFilterCount('scheduled')}</strong>
        </div>
        <div class="consultation-admin-stat">
            <span>Paid total</span>
            <strong>${escapeHtml(formatConsultationMoney(revenue, currency))}</strong>
        </div>
    `;
}

function renderConsultationFilters() {
    const filters = document.getElementById('consultation-bookings-filters');
    if (!filters) {
        return;
    }

    const filterItems = [
        ['active', 'Active'],
        ['new', 'New'],
        ['unscheduled', 'Unscheduled'],
        ['scheduled', 'Scheduled'],
        ['completed', 'Completed'],
        ['all', 'All']
    ];

    filters.innerHTML = filterItems.map(([key, label]) => `
        <button class="consultation-filter-btn${consultationAdminState.filter === key ? ' active' : ''}" type="button" data-filter="${key}">
            <span>${label}</span>
            <strong>${getConsultationFilterCount(key)}</strong>
        </button>
    `).join('');

    filters.querySelectorAll('[data-filter]').forEach((button) => {
        button.addEventListener('click', () => {
            consultationAdminState.filter = button.dataset.filter || 'active';
            renderConsultationBookings();
        });
    });
}

function setRowBusy(row, isBusy) {
    row.querySelectorAll('button, input, select').forEach((element) => {
        element.disabled = isBusy;
    });
}

function createBookingRow(booking) {
    const row = document.createElement('article');
    row.className = 'consultation-booking-row';
    row.dataset.bookingId = booking.id;

    const submittedAt = formatConsultationDate(booking.createdAt);
    const scheduledAt = booking.scheduledAt
        ? formatConsultationDate(booking.scheduledAt)
        : 'Unscheduled';
    const contact = booking.contactDiscord || booking.contactEmail || booking.stripeCustomerEmail || 'No contact';

    row.innerHTML = `
        <div class="consultation-booking-main">
            <button class="consultation-row-toggle" type="button" aria-expanded="false" aria-label="Show booking details">
                <i class="fas fa-chevron-right" aria-hidden="true"></i>
            </button>
            <div class="consultation-booking-client">
                <strong>@${escapeHtml(booking.robloxUsername || 'unknown')}</strong>
                <span>${escapeHtml(contact)}</span>
            </div>
            <div class="consultation-booking-meta">
                <span class="consultation-status-pill">${escapeHtml(getConsultationStatusLabel(booking.status))}</span>
                <span>${escapeHtml(booking.paymentStatus || 'unknown')}</span>
            </div>
            <div class="consultation-booking-time">
                <span>Submitted</span>
                <strong>${escapeHtml(submittedAt)}</strong>
            </div>
            <div class="consultation-booking-time">
                <span>Schedule</span>
                <strong>${escapeHtml(scheduledAt)}</strong>
            </div>
            <div class="consultation-booking-price">
                ${escapeHtml(formatConsultationMoney(booking.amountTotal, booking.currency))}
            </div>
        </div>
        <div class="consultation-booking-detail hidden">
            <div class="consultation-booking-links">
                <a href="${escapeHtml(booking.gameUrl)}" target="_blank" rel="noopener noreferrer">Open Roblox game</a>
                ${booking.robloxProfileUrl ? `<a href="${escapeHtml(booking.robloxProfileUrl)}" target="_blank" rel="noopener noreferrer">Open Roblox profile</a>` : ''}
                <span>Discord: ${escapeHtml(booking.contactDiscord || 'Not provided')}</span>
                <span>Email: ${escapeHtml(booking.contactEmail || booking.stripeCustomerEmail || 'Not provided')}</span>
            </div>
            <p class="consultation-booking-goals">${escapeHtml(booking.goals || '')}</p>
            <form class="consultation-admin-form">
                <label class="admin-field">
                    <span class="admin-label">Status</span>
                    <select class="admin-input" name="status">
                        <option value="checkout_created">Checkout created</option>
                        <option value="new">New</option>
                        <option value="scheduled">Scheduled</option>
                        <option value="completed">Completed</option>
                        <option value="cancelled">Cancelled</option>
                        <option value="refunded">Refunded</option>
                    </select>
                </label>
                <label class="admin-field">
                    <span class="admin-label">Scheduled time</span>
                    <input class="admin-input" name="scheduledAt" type="datetime-local">
                </label>
                <div class="consultation-admin-actions">
                    <button class="btn btn-primary admin-submit-btn" type="submit">Save</button>
                    <button class="btn btn-secondary consultation-archive-btn" type="button">Archive</button>
                </div>
            </form>
        </div>
    `;

    const detail = row.querySelector('.consultation-booking-detail');
    const toggleButton = row.querySelector('.consultation-row-toggle');
    const form = row.querySelector('form');
    const archiveButton = row.querySelector('.consultation-archive-btn');

    form.elements.status.value = booking.status || 'new';
    form.elements.scheduledAt.value = toDatetimeLocalValue(booking.scheduledAt);

    toggleButton.addEventListener('click', () => {
        const isOpen = !detail.classList.contains('hidden');
        detail.classList.toggle('hidden', isOpen);
        row.classList.toggle('expanded', !isOpen);
        toggleButton.setAttribute('aria-expanded', String(!isOpen));
    });

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        setRowBusy(row, true);
        setConsultationAdminStatus('Saving booking...', 'info');

        try {
            await saveConsultationBooking({
                id: booking.id,
                status: form.elements.status.value,
                scheduledAt: form.elements.scheduledAt.value
            });
            setConsultationAdminStatus('Booking saved.', 'success');
            await refreshConsultationBookings(false);
        } catch (error) {
            setConsultationAdminStatus(error.message || 'Failed to save booking.', 'error');
        } finally {
            setRowBusy(row, false);
        }
    });

    archiveButton.addEventListener('click', async () => {
        if (!window.confirm('Archive this booking? It will be hidden from the active list.')) {
            return;
        }

        setRowBusy(row, true);
        setConsultationAdminStatus('Archiving booking...', 'info');

        try {
            await saveConsultationBooking({
                id: booking.id,
                status: 'archived',
                scheduledAt: form.elements.scheduledAt.value
            });
            setConsultationAdminStatus('Booking archived.', 'success');
            await refreshConsultationBookings(false);
        } catch (error) {
            setConsultationAdminStatus(error.message || 'Failed to archive booking.', 'error');
        } finally {
            setRowBusy(row, false);
        }
    });

    return row;
}

function renderConsultationBookings() {
    const list = document.getElementById('consultation-bookings-list');
    const empty = document.getElementById('consultation-bookings-empty');
    const sortLabel = document.getElementById('consultation-bookings-sort-label');
    if (!list) {
        return;
    }

    renderConsultationSummary();
    renderConsultationFilters();

    const bookings = getFilteredConsultationBookings();
    list.innerHTML = '';

    if (sortLabel) {
        sortLabel.textContent = `${bookings.length} shown - newest first`;
    }

    if (empty) {
        empty.classList.toggle('hidden', bookings.length > 0);
    }

    bookings.forEach((booking) => {
        list.appendChild(createBookingRow(booking));
    });
}

async function refreshConsultationBookings(showLoading) {
    if (showLoading !== false) {
        setConsultationAdminStatus('Loading bookings...', 'info');
    }

    consultationAdminState.bookings = await fetchConsultationBookings();
    renderConsultationBookings();
    if (showLoading !== false) {
        setConsultationAdminStatus('', 'info');
    }
}

async function initConsultationAdmin() {
    const ownedContent = document.getElementById('admin-owned-content');
    const deniedElement = document.getElementById('admin-access-denied');
    const refreshButton = document.getElementById('consultation-admin-refresh');
    const searchInput = document.getElementById('consultation-bookings-search');
    const list = document.getElementById('consultation-bookings-list');
    if (!ownedContent || !list) {
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

    if (refreshButton) {
        refreshButton.addEventListener('click', () => {
            refreshConsultationBookings().catch((error) => {
                setConsultationAdminStatus(error.message || 'Failed to load bookings.', 'error');
            });
        });
    }

    if (searchInput) {
        searchInput.addEventListener('input', () => {
            consultationAdminState.search = searchInput.value || '';
            renderConsultationBookings();
        });
    }

    await refreshConsultationBookings();
}

document.addEventListener('DOMContentLoaded', () => {
    initConsultationAdmin().catch((error) => {
        setConsultationAdminStatus(error.message || 'Failed to load consultation admin.', 'error');
    });
});
