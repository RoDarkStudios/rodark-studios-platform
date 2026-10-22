const manifest = require('../discord/server.json');

// Definitions saved before this switch existed had tickets enabled.
function ticketsEnabled(spec = manifest) {
    return spec.tickets?.enabled !== false;
}

function ticketSystemEnabled(control) {
    if (control?.ticketSystem?.enabled === false) return false;
    return ticketsEnabled(control?.infrastructure?.spec || manifest);
}

module.exports = { ticketsEnabled, ticketSystemEnabled };
