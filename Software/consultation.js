async function consultationPostJson(url, payload) {
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

function setConsultationStatus(message, type) {
    const status = document.getElementById('consultation-status');
    if (!status) {
        return;
    }

    status.textContent = message || '';
    status.className = `admin-status ${type || 'info'}${message ? '' : ' hidden'}`;
}

function initConsultationCheckout() {
    const form = document.getElementById('consultation-checkout-form');
    const button = document.getElementById('consultation-checkout-btn');
    if (!form || !button) {
        return;
    }

    const params = new URLSearchParams(window.location.search);
    if (params.get('cancelled') === '1') {
        setConsultationStatus('Checkout was cancelled. Your card was not charged.', 'info');
    }

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        button.disabled = true;
        setConsultationStatus('Starting secure checkout...', 'info');

        try {
            const payload = {
                gameUrl: document.getElementById('consultation-game-url').value,
                contactDiscord: document.getElementById('consultation-discord').value,
                contactEmail: document.getElementById('consultation-email').value,
                goals: document.getElementById('consultation-goals').value
            };
            const data = await consultationPostJson('/api/consultations/checkout', payload);
            window.location.href = data.checkoutUrl;
        } catch (error) {
            if (error && error.status === 401 && error.data && error.data.loginRequired) {
                const returnTo = `${window.location.pathname}${window.location.search}`;
                window.location.href = `/api/auth/login?returnTo=${encodeURIComponent(returnTo || '/consultation')}`;
                return;
            }

            setConsultationStatus(error.message || 'Failed to start checkout.', 'error');
            button.disabled = false;
        }
    });
}

document.addEventListener('DOMContentLoaded', () => {
    initConsultationCheckout();
});
