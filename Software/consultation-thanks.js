async function confirmConsultationPayment(sessionId) {
    const response = await fetch('/api/consultations/confirm', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify({ sessionId })
    });

    let data = {};
    try {
        data = await response.json();
    } catch (error) {
        data = {};
    }

    if (!response.ok) {
        throw new Error(data.error || `Request failed (${response.status})`);
    }

    return data;
}

document.addEventListener('DOMContentLoaded', async () => {
    const status = document.getElementById('consultation-thanks-status');
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('session_id');

    if (!status) {
        return;
    }

    if (!sessionId) {
        status.textContent = 'Booking details were received. We will contact you on Discord if payment has completed.';
        return;
    }

    try {
        const data = await confirmConsultationPayment(sessionId);
        if (data && data.booking && data.booking.paymentStatus === 'paid') {
            status.textContent = 'Payment confirmed. We will contact you on Discord to schedule the call.';
            return;
        }

        status.textContent = 'Payment is still processing. We will confirm it and contact you on Discord.';
    } catch (error) {
        status.textContent = 'We could not confirm payment in the browser. If Stripe charged you, the booking can still be verified by an admin.';
    }
});
