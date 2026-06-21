const { methodNotAllowed, readJsonBody, sendJson } = require('../_lib/http');
const { requireAdmin } = require('../_lib/admin-auth');
const {
    listConsultationBookings,
    updateConsultationBooking
} = require('../_lib/consultation-bookings-store');

module.exports = async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'PATCH') {
        return methodNotAllowed(req, res, ['GET', 'PATCH']);
    }

    try {
        const auth = await requireAdmin(req, res);
        if (!auth.user) {
            return sendJson(res, 401, { error: 'Not authenticated' });
        }
        if (!auth.isAdmin) {
            return sendJson(res, 403, { error: 'Admin access required' });
        }

        if (req.method === 'GET') {
            const bookings = await listConsultationBookings();
            return sendJson(res, 200, { bookings });
        }

        const body = await readJsonBody(req);
        const id = String(body && body.id || '').trim();
        if (!id) {
            return sendJson(res, 400, { error: 'Missing booking ID' });
        }

        const booking = await updateConsultationBooking({
            id,
            status: body && body.status,
            scheduledAt: body && body.scheduledAt,
            adminNotes: body && body.adminNotes
        });

        if (!booking) {
            return sendJson(res, 404, { error: 'Booking not found' });
        }

        return sendJson(res, 200, { booking });
    } catch (error) {
        const message = String(error && error.message || '');
        const statusCode = /invalid|missing/i.test(message) ? 400 : 500;
        return sendJson(res, statusCode, {
            error: statusCode === 400 ? message : 'Failed to manage consultations',
            details: statusCode === 400 ? undefined : message
        });
    }
};
