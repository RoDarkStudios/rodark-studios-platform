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

function formatConsultationDate(value) {
    if (!value) {
        return 'Not set';
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return 'Not set';
    }

    return date.toLocaleString();
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

function createBookingCard(booking) {
    const card = document.createElement('article');
    card.className = 'consultation-admin-card';
    card.dataset.bookingId = booking.id;

    const header = document.createElement('div');
    header.className = 'consultation-admin-card-header';
    header.innerHTML = `
        <div>
            <h3>@${escapeHtml(booking.robloxUsername || 'unknown')}</h3>
            <p>${escapeHtml(formatConsultationMoney(booking.amountTotal, booking.currency))} - ${escapeHtml(booking.paymentStatus || 'unknown')} - ${escapeHtml(formatConsultationDate(booking.createdAt))}</p>
        </div>
        <span class="consultation-status-pill">${escapeHtml(booking.status || 'new')}</span>
    `;

    const details = document.createElement('div');
    details.className = 'consultation-admin-details';
    details.innerHTML = `
        <a href="${escapeHtml(booking.gameUrl)}" target="_blank" rel="noopener noreferrer">Open Roblox game</a>
        ${booking.robloxProfileUrl ? `<a href="${escapeHtml(booking.robloxProfileUrl)}" target="_blank" rel="noopener noreferrer">Open Roblox profile</a>` : ''}
        <span>Discord: ${escapeHtml(booking.contactDiscord || 'Not provided')}</span>
        <span>Email: ${escapeHtml(booking.contactEmail || booking.stripeCustomerEmail || 'Not provided')}</span>
        <span>Paid: ${escapeHtml(formatConsultationDate(booking.paidAt))}</span>
    `;

    const goals = document.createElement('p');
    goals.className = 'consultation-admin-goals';
    goals.textContent = booking.goals || '';

    const form = document.createElement('form');
    form.className = 'consultation-admin-form';
    form.innerHTML = `
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
        <label class="admin-field">
            <span class="admin-label">Assigned to</span>
            <input class="admin-input" name="assignedTo" type="text" placeholder="Team member">
        </label>
        <label class="admin-field consultation-admin-notes-field">
            <span class="admin-label">Admin notes</span>
            <textarea class="admin-textarea" name="adminNotes" rows="3" placeholder="Internal notes"></textarea>
        </label>
        <button class="btn btn-primary admin-submit-btn" type="submit">Save Booking</button>
    `;

    form.elements.status.value = booking.status || 'new';
    form.elements.scheduledAt.value = toDatetimeLocalValue(booking.scheduledAt);
    form.elements.assignedTo.value = booking.assignedTo || '';
    form.elements.adminNotes.value = booking.adminNotes || '';

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = form.querySelector('button[type="submit"]');
        button.disabled = true;
        setConsultationAdminStatus('Saving booking...', 'info');

        try {
            await saveConsultationBooking({
                id: booking.id,
                status: form.elements.status.value,
                scheduledAt: form.elements.scheduledAt.value,
                assignedTo: form.elements.assignedTo.value,
                adminNotes: form.elements.adminNotes.value
            });
            setConsultationAdminStatus('Booking saved.', 'success');
            await renderConsultationBookings();
        } catch (error) {
            setConsultationAdminStatus(error.message || 'Failed to save booking.', 'error');
        } finally {
            button.disabled = false;
        }
    });

    card.append(header, details, goals, form);
    return card;
}

async function renderConsultationBookings() {
    const list = document.getElementById('consultation-bookings-list');
    if (!list) {
        return;
    }

    setConsultationAdminStatus('Loading bookings...', 'info');
    const bookings = await fetchConsultationBookings();
    list.innerHTML = '';

    if (!bookings.length) {
        list.innerHTML = '<p class="admin-tool-note">No consultation bookings yet.</p>';
        setConsultationAdminStatus('', 'info');
        return;
    }

    bookings.forEach((booking) => {
        list.appendChild(createBookingCard(booking));
    });
    setConsultationAdminStatus('', 'info');
}

async function initConsultationAdmin() {
    const ownedContent = document.getElementById('admin-owned-content');
    const deniedElement = document.getElementById('admin-access-denied');
    const refreshButton = document.getElementById('consultation-admin-refresh');
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
            renderConsultationBookings().catch((error) => {
                setConsultationAdminStatus(error.message || 'Failed to load bookings.', 'error');
            });
        });
    }

    await renderConsultationBookings();
}

document.addEventListener('DOMContentLoaded', () => {
    initConsultationAdmin().catch((error) => {
        setConsultationAdminStatus(error.message || 'Failed to load consultation admin.', 'error');
    });
});
