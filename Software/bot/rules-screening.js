// Discord no longer documents this route. Bot-authenticated GET/PATCH access
// was verified on our guild; keep it isolated and verify every saved update.
const screeningPath = (guildId) => `/guilds/${guildId}/member-verification`;

function screeningFields(screening) {
    const fields = screening?.form_fields;
    if (!Array.isArray(fields) || fields.some(field => !field || typeof field.field_type !== 'string')) {
        throw new Error('Discord returned an unexpected Rules Screening form. No acceptance rules were changed.');
    }
    if (fields.filter(field => field.field_type === 'TERMS').length > 1) {
        throw new Error('Discord returned multiple Rules Screening rules fields. Resolve the duplicate fields before deploying.');
    }
    return fields;
}

function rulesScreeningBody(spec, screening) {
    const fields = screeningFields(screening);
    const update = (field) => ({ ...field, required: true, values: [...spec.content.rules] });
    return { form_fields: fields.some(field => field.field_type === 'TERMS')
        ? fields.map(field => field.field_type === 'TERMS' ? update(field) : field)
        : [...fields, update({ field_type: 'TERMS', label: 'Read and agree to the server rules' })] };
}

function screeningMatches(spec, screening) {
    const terms = screeningFields(screening).find(field => field.field_type === 'TERMS');
    return Boolean(terms?.required) && JSON.stringify(terms.values) === JSON.stringify(spec.content.rules);
}

async function readRulesScreening(rest, guildId) {
    try {
        const result = await rest.get(screeningPath(guildId));
        screeningFields(result);
        return result;
    } catch (error) {
        throw new Error(`Could not read Discord Rules Screening: ${error.message}`, { cause: error });
    }
}

async function syncRulesScreening({ rest, spec, write, guard, wait }) {
    const current = await readRulesScreening(rest, spec.guildId);
    if (screeningMatches(spec, current)) return;
    // Only change the rules field. Keep the server description, the screening
    // enabled setting and any other application questions under manual control.
    try { await write('patch', screeningPath(spec.guildId), rulesScreeningBody(spec, current)); }
    catch (error) { throw new Error(`Could not update Discord Rules Screening: ${error.message}`, { cause: error }); }
    for (const pause of [0, 500, 1500]) {
        if (pause) await wait(pause);
        guard();
        if (screeningMatches(spec, await readRulesScreening(rest, spec.guildId))) return;
    }
    throw new Error('Discord has not confirmed the updated Rules Screening text. Click Deploy again to finish syncing the acceptance rules and rules channel.');
}

module.exports = { screeningFields, rulesScreeningBody, screeningMatches, readRulesScreening, syncRulesScreening };
