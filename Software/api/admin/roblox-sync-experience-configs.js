const { methodNotAllowed, readJsonBody, sendJson } = require('../_lib/http');
const { requireUserFromSession } = require('../_lib/session');
const { getAdminGroupId, fetchUserGroupRole, getRoleRank } = require('../_lib/roblox-groups');
const {
    parseUniverseId,
    getUniverseExperienceConfig,
    updateUniverseExperienceConfig,
    updateUniverseRootPlaceConfig
} = require('../_lib/roblox-open-cloud');
const { getStoredGameConfig } = require('../_lib/admin-game-config-store');

const MISSING_CONFIG_MESSAGE = 'Game IDs are not configured. Open Admin > Game Configuration and save Production/Test/Development IDs.';
const EXPERIENCE_CONFIG_FIELD_LABELS = [
    'Voice chat',
    'Private server price',
    'Supported devices (desktop, mobile, tablet, console, VR)',
    'Social links (Facebook, Twitter/X, YouTube, Twitch, Discord, Roblox group, Guilded)',
    'Root place server size'
];
const EXPERIENCE_CONFIG_EXCLUDED_FIELD_LABELS = [
    'Visibility (read-only in the Universes API)',
    'Name and description (managed separately via the root place and existing description tool)'
];

async function requireAdmin(req, res) {
    const groupId = getAdminGroupId();
    const { user } = await requireUserFromSession(req, res);
    if (!user) {
        return { user: null, isAdmin: false };
    }

    const roleEntry = await fetchUserGroupRole(user.id, groupId);
    const rank = getRoleRank(roleEntry);
    return {
        user,
        isAdmin: rank !== null && rank >= 254
    };
}

function parseGameUniverseIdsFromBody(body) {
    return {
        productionUniverseId: parseUniverseId(body && body.productionUniverseId, 'productionUniverseId'),
        testUniverseId: parseUniverseId(body && body.testUniverseId, 'testUniverseId'),
        developmentUniverseId: parseUniverseId(body && body.developmentUniverseId, 'developmentUniverseId')
    };
}

function validateDistinctUniverseIds(ids) {
    if (
        ids.productionUniverseId === ids.testUniverseId
        || ids.productionUniverseId === ids.developmentUniverseId
        || ids.testUniverseId === ids.developmentUniverseId
    ) {
        throw new Error('Production, Test, and Development universe IDs must be different');
    }
}

function hasUniverseIdValue(value) {
    return String(value || '').trim().length > 0;
}

function hasAnyUniverseIdFields(body) {
    return (
        hasUniverseIdValue(body && body.productionUniverseId)
        || hasUniverseIdValue(body && body.testUniverseId)
        || hasUniverseIdValue(body && body.developmentUniverseId)
    );
}

function hasAllUniverseIdFields(body) {
    return (
        hasUniverseIdValue(body && body.productionUniverseId)
        && hasUniverseIdValue(body && body.testUniverseId)
        && hasUniverseIdValue(body && body.developmentUniverseId)
    );
}

async function resolveGameUniverseIds(body) {
    if (hasAnyUniverseIdFields(body)) {
        if (!hasAllUniverseIdFields(body)) {
            throw new Error('Provide all three IDs or none. Leave all blank to use saved Game Configuration.');
        }

        const ids = parseGameUniverseIdsFromBody(body);
        validateDistinctUniverseIds(ids);
        return ids;
    }

    const storedConfig = await getStoredGameConfig();
    if (!storedConfig) {
        throw new Error(MISSING_CONFIG_MESSAGE);
    }

    const ids = {
        productionUniverseId: Number(storedConfig.productionUniverseId),
        testUniverseId: Number(storedConfig.testUniverseId),
        developmentUniverseId: Number(storedConfig.developmentUniverseId)
    };
    validateDistinctUniverseIds(ids);
    return ids;
}

function buildSyncMetadata() {
    return {
        fieldsSynced: EXPERIENCE_CONFIG_FIELD_LABELS,
        fieldsExcluded: EXPERIENCE_CONFIG_EXCLUDED_FIELD_LABELS
    };
}

async function loadProductionExperienceConfig(ids) {
    const source = await getUniverseExperienceConfig(ids.productionUniverseId);
    return {
        source,
        ...buildSyncMetadata()
    };
}

async function syncProductionExperienceConfig(ids) {
    const source = await getUniverseExperienceConfig(ids.productionUniverseId);
    const targets = [
        {
            label: 'Test',
            environment: 'test',
            universeId: ids.testUniverseId
        },
        {
            label: 'Development',
            environment: 'development',
            universeId: ids.developmentUniverseId
        }
    ];

    const settled = await Promise.allSettled(targets.map(async (target) => {
        const universeUpdate = await updateUniverseExperienceConfig(target.universeId, source.universeSettings);
        const placeUpdate = await updateUniverseRootPlaceConfig(target.universeId, source.placeSettings);

        return {
            label: target.label,
            environment: target.environment,
            universeId: target.universeId,
            rootPlaceId: placeUpdate.placeId,
            universeSettings: universeUpdate.universeSettings,
            placeSettings: placeUpdate.placeSettings
        };
    }));

    const successes = [];
    const failures = [];

    settled.forEach((entry, index) => {
        const target = targets[index];
        if (entry.status === 'fulfilled') {
            successes.push(entry.value);
            return;
        }

        failures.push({
            label: target.label,
            environment: target.environment,
            universeId: target.universeId,
            error: entry.reason && entry.reason.message
                ? String(entry.reason.message)
                : 'Unknown error'
        });
    });

    if (failures.length > 0) {
        const summary = failures.map((item) => `${item.label} (${item.universeId}): ${item.error}`).join(' | ');
        const error = new Error(`Failed to sync all experience configs: ${summary}`);
        error.source = source;
        error.successes = successes;
        error.failures = failures;
        throw error;
    }

    return {
        source,
        targets: successes,
        ...buildSyncMetadata()
    };
}

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return methodNotAllowed(req, res, ['POST']);
    }

    try {
        const auth = await requireAdmin(req, res);
        if (!auth.user) {
            return sendJson(res, 401, { error: 'Not authenticated' });
        }
        if (!auth.isAdmin) {
            return sendJson(res, 403, { error: 'Admin access required' });
        }

        const body = await readJsonBody(req);
        const operation = String(body && body.operation ? body.operation : 'sync').trim().toLowerCase();

        let ids;
        try {
            ids = await resolveGameUniverseIds(body);
        } catch (error) {
            return sendJson(res, 400, {
                error: error.message || 'Invalid game universe IDs'
            });
        }

        if (operation === 'load') {
            try {
                const payload = await loadProductionExperienceConfig(ids);
                return sendJson(res, 200, payload);
            } catch (error) {
                return sendJson(res, 500, {
                    error: error.message || 'Failed to load production experience config'
                });
            }
        }

        if (operation !== 'sync') {
            return sendJson(res, 400, {
                error: 'Invalid operation. Supported values: load, sync.'
            });
        }

        try {
            const payload = await syncProductionExperienceConfig(ids);
            return sendJson(res, 200, payload);
        } catch (error) {
            return sendJson(res, 500, {
                error: error.message || 'Failed to sync experience configs',
                source: error.source || null,
                successes: Array.isArray(error.successes) ? error.successes : null,
                failures: Array.isArray(error.failures) ? error.failures : null,
                ...buildSyncMetadata()
            });
        }
    } catch (error) {
        return sendJson(res, 500, {
            error: error.message || 'Failed to sync experience configs'
        });
    }
};
