const test = require('node:test');
const assert = require('node:assert/strict');
const { compileBlueprint, clone } = require('./server-blueprint');
const { rulesScreeningBody, screeningMatches, syncRulesScreening } = require('./rules-screening');

const spec = compileBlueprint().spec;
const terms = (values = ['Old rules']) => ({ field_type: 'TERMS', label: 'Existing rules label', required: true,
    description: null, automations: null, values });
const form = (fields = [terms()]) => ({ description: 'Keep our welcome description', version: 'old', form_fields: fields });

test('screening uses the exact channel rules, preserves other fields and creates a missing required terms field', () => {
    const other = { field_type: 'TEXT_INPUT', label: 'An existing application question', required: false };
    const current = form([other, terms()]), before = clone(current);
    const body = rulesScreeningBody(spec, current);
    assert.deepEqual(body, { form_fields: [other, { ...terms(), values: spec.content.rules }] });
    assert.deepEqual(current, before);
    assert.equal(screeningMatches(spec, { ...current, ...body }), true);
    assert.equal(screeningMatches(spec, form([{ ...terms(spec.content.rules), required: false }])), false);
    const missing = rulesScreeningBody(spec, form([other]));
    assert.deepEqual(missing.form_fields[0], other);
    assert.equal(missing.form_fields[1].required, true);
    assert.deepEqual(missing.form_fields[1].values, spec.content.rules);
});

test('screening rejects invalid rules and unrecognized forms before editing', () => {
    for (const rules of [[], [' '], ['x'.repeat(301)], Array(17).fill('Be nice'), [null]]) {
        const invalid = clone(spec); invalid.content.rules = rules;
        assert.throws(() => compileBlueprint({}, invalid), /Rules Screening/);
    }
    for (const current of [null, {}, { form_fields: {} }, form([null]), form([terms(), terms()])]) {
        assert.throws(() => rulesScreeningBody(spec, current), /Rules Screening/);
    }
});

test('unchanged screening makes no writes, and changed screening verifies persisted text after a delayed read', async () => {
    let current = form([terms(spec.content.rules)]), reads = 0, writes = 0, guards = 0, pending, delays = [];
    const args = { spec, rest: { get: async () => {
        reads++;
        if (pending && reads >= 3) current = { ...current, ...pending };
        return clone(current);
    } }, write: async (method, path, body) => {
        assert.equal(method, 'patch'); assert.equal(path, `/guilds/${spec.guildId}/member-verification`);
        writes++; pending = body;
    }, guard: () => { guards++; }, wait: async pause => { delays.push(pause); } };
    await syncRulesScreening(args);
    assert.equal(writes, 0);
    current = form(); reads = 0;
    await syncRulesScreening(args);
    assert.equal(writes, 1);
    assert.equal(reads, 3);
    assert.equal(guards, 2);
    assert.deepEqual(delays, [500]);
    assert.equal(screeningMatches(spec, current), true);
    assert.equal(current.description, 'Keep our welcome description');
});

test('read errors, rejected edits and silently ignored edits never report successful screening sync', async () => {
    const args = { spec, rest: { get: async () => form() }, write: async () => {}, guard: () => {}, wait: async () => {} };
    await assert.rejects(syncRulesScreening({ ...args, rest: { get: async () => { throw new Error('Forbidden'); } } }), /Could not read Discord Rules Screening: Forbidden/);
    await assert.rejects(syncRulesScreening({ ...args, write: async () => { throw new Error('Bots cannot use this endpoint'); } }), /Could not update Discord Rules Screening: Bots cannot use this endpoint/);
    await assert.rejects(syncRulesScreening(args), /has not confirmed the updated Rules Screening/);
});
