const { methodNotAllowed, readJsonBody, sendJson } = require('../_lib/http');
const { requireUserFromSession } = require('../_lib/session');
const { getAdminGroupId, fetchUserGroupRole, getRoleRank } = require('../_lib/roblox-groups');
const {
    parseUniverseId,
    listAllGamePassConfigs,
    listAllDeveloperProductConfigs,
    parseConfigRepository,
    getConfigRepositoryValues,
    getConfigRepositoryFull,
    overwriteConfigRepositoryDraft,
    publishConfigRepositoryDraft,
    getUniverseDescription,
    updateUniverseDescription
} = require('../_lib/roblox-open-cloud');
const { getStoredGameConfig, saveStoredGameConfig } = require('../_lib/admin-game-config-store');

const TEST_PREFIX = '\u26A0\uFE0F THIS IS THE TEST GAME - THIS IS NOT THE OFFICIAL GAME';
const DEVELOPMENT_PREFIX = '\u26A0\uFE0F THIS IS THE DEVELOPMENT GAME - THIS IS NOT THE OFFICIAL GAME';
const ENVIRONMENT_PREFIX_REGEX = /^\u26A0(?:\uFE0F)? THIS IS THE (TEST|DEVELOPMENT) GAME - THIS IS NOT THE OFFICIAL GAME(?:\r?\n|\r)?(?:\r?\n|\r)?/i;
const MISSING_CONFIG_MESSAGE = 'Game IDs are not configured. Open Admin > Game Configuration and save Production/Test/Development IDs.';
const ARCHIVED_NAME_PREFIX = '[ARCHIVED] ';
const LEGACY_ARCHIVED_MONETIZATION_NAME_KEY = 'archived';
const DEFAULT_CONFIG_REPOSITORY = 'InExperienceConfig';

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
        developmentUniverseId: parseUniverseId(body && body.developmentUniverseId, 'developmentUniverseId'),
        testUniverseId: parseUniverseId(body && body.testUniverseId, 'testUniverseId'),
        productionUniverseId: parseUniverseId(body && body.productionUniverseId, 'productionUniverseId')
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

function normalizeDescriptionInput(value) {
    return String(value || '').replace(/\r\n/g, '\n').trim();
}

function normalizeNameKey(value) {
    return String(value || '').trim().toLowerCase();
}

function isArchivedMonetizationName(name) {
    const nameKey = normalizeNameKey(name);
    const archivedPrefixKey = normalizeNameKey(ARCHIVED_NAME_PREFIX);
    return nameKey === LEGACY_ARCHIVED_MONETIZATION_NAME_KEY || nameKey.startsWith(archivedPrefixKey);
}

function stripEnvironmentPrefix(description) {
    let cleaned = normalizeDescriptionInput(description);

    while (ENVIRONMENT_PREFIX_REGEX.test(cleaned)) {
        cleaned = cleaned.replace(ENVIRONMENT_PREFIX_REGEX, '').trimStart();
    }

    return cleaned;
}

function prefixDescription(prefix, description) {
    const base = stripEnvironmentPrefix(description);
    if (!base) {
        return prefix;
    }

    return `${prefix}\n\n${base}`;
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

async function getGameConfigPayload() {
    const config = await getStoredGameConfig();
    return {
        config: config || null
    };
}

async function saveGameConfigPayload(body, user) {
    const ids = parseGameUniverseIdsFromBody(body);
    validateDistinctUniverseIds(ids);

    const config = await saveStoredGameConfig({
        productionUniverseId: ids.productionUniverseId,
        testUniverseId: ids.testUniverseId,
        developmentUniverseId: ids.developmentUniverseId,
        updatedByUserId: user && user.id ? String(user.id) : null,
        updatedByUsername: user && user.username ? String(user.username) : null
    });

    return {
        config
    };
}

async function loadProductionDescription(ids) {
    const productionData = await getUniverseDescription(ids.productionUniverseId);

    return {
        productionUniverseId: ids.productionUniverseId,
        productionRootPlaceId: productionData.placeId,
        productionDescription: productionData.description || ''
    };
}

async function saveDescriptions(ids, descriptionRaw) {
    const editedDescription = normalizeDescriptionInput(descriptionRaw);
    const productionDescription = stripEnvironmentPrefix(editedDescription);
    const testDescription = prefixDescription(TEST_PREFIX, productionDescription);
    const developmentDescription = prefixDescription(DEVELOPMENT_PREFIX, productionDescription);

    const updates = [
        {
            label: 'Production',
            universeId: ids.productionUniverseId,
            description: productionDescription
        },
        {
            label: 'Test',
            universeId: ids.testUniverseId,
            description: testDescription
        },
        {
            label: 'Development',
            universeId: ids.developmentUniverseId,
            description: developmentDescription
        }
    ];

    const settled = await Promise.allSettled(updates.map(async (item) => {
        const updateInfo = await updateUniverseDescription(item.universeId, item.description);
        return {
            label: item.label,
            universeId: item.universeId,
            placeId: updateInfo.placeId,
            descriptionLength: item.description.length
        };
    }));

    const successes = [];
    const failures = [];

    settled.forEach((entry, index) => {
        const target = updates[index];
        if (entry.status === 'fulfilled') {
            successes.push(entry.value);
            return;
        }

        failures.push({
            label: target.label,
            universeId: target.universeId,
            error: entry.reason && entry.reason.message
                ? String(entry.reason.message)
                : 'Unknown error'
        });
    });

    if (failures.length > 0) {
        const summary = failures.map((item) => `${item.label} (${item.universeId}): ${item.error}`).join(' | ');
        const error = new Error(`Failed to update all games: ${summary}`);
        error.failures = failures;
        error.successes = successes;
        throw error;
    }

    return {
        productionDescription,
        testDescription,
        developmentDescription,
        updates: successes
    };
}

function buildConfigSyncMetadata(repository) {
    return {
        repository,
        deploymentStrategy: 'Immediate',
        note: 'Publishes Roblox Configs live without restarting servers.'
    };
}

function countConfigEntries(entries) {
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
        return 0;
    }

    return Object.keys(entries).length;
}

async function loadProductionConfigRepository(ids, repository) {
    const [full, values] = await Promise.all([
        getConfigRepositoryFull(ids.productionUniverseId, repository),
        getConfigRepositoryValues(ids.productionUniverseId, repository)
    ]);

    return {
        source: {
            label: 'Production',
            universeId: ids.productionUniverseId,
            configVersion: Number(full && full.metadata && full.metadata.configVersion) || null,
            entryCount: countConfigEntries(values && values.entries),
            fullEntries: full && full.entries ? full.entries : {},
            publishedEntries: values && values.entries ? values.entries : {}
        },
        ...buildConfigSyncMetadata(repository)
    };
}

async function syncProductionConfigRepository(ids, repository) {
    const sourceValues = await getConfigRepositoryValues(ids.productionUniverseId, repository);
    const sourceEntries = sourceValues && sourceValues.entries ? sourceValues.entries : {};
    const sourceConfigVersion = Number(sourceValues && sourceValues.metadata && sourceValues.metadata.configVersion) || null;
    const publishMessage = `Sync ${repository} from Production ${ids.productionUniverseId} at ${new Date().toISOString()}`;

    const targets = [
        {
            label: 'Test',
            universeId: ids.testUniverseId
        },
        {
            label: 'Development',
            universeId: ids.developmentUniverseId
        }
    ];

    const settled = await Promise.allSettled(targets.map(async (target) => {
        const draft = await overwriteConfigRepositoryDraft(target.universeId, repository, sourceEntries);
        const publish = await publishConfigRepositoryDraft(
            target.universeId,
            repository,
            draft && draft.draftHash,
            {
                message: publishMessage,
                deploymentStrategy: 'Immediate'
            }
        );

        const latestValues = await getConfigRepositoryValues(target.universeId, repository);
        return {
            label: target.label,
            universeId: target.universeId,
            configVersion: Number(publish && publish.configVersion) || Number(latestValues && latestValues.metadata && latestValues.metadata.configVersion) || null,
            entryCount: countConfigEntries(latestValues && latestValues.entries),
            publishedEntries: latestValues && latestValues.entries ? latestValues.entries : {}
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
            universeId: target.universeId,
            error: entry.reason && entry.reason.message
                ? String(entry.reason.message)
                : 'Unknown error'
        });
    });

    if (failures.length > 0) {
        const summary = failures.map((item) => `${item.label} (${item.universeId}): ${item.error}`).join(' | ');
        const error = new Error(`Failed to sync all Roblox configs: ${summary}`);
        error.source = {
            label: 'Production',
            universeId: ids.productionUniverseId,
            configVersion: sourceConfigVersion,
            entryCount: countConfigEntries(sourceEntries),
            publishedEntries: sourceEntries
        };
        error.successes = successes;
        error.failures = failures;
        throw error;
    }

    return {
        source: {
            label: 'Production',
            universeId: ids.productionUniverseId,
            configVersion: sourceConfigVersion,
            entryCount: countConfigEntries(sourceEntries),
            publishedEntries: sourceEntries
        },
        targets: successes,
        ...buildConfigSyncMetadata(repository)
    };
}

function toGamePassRow(config) {
    const id = Number(config && config.gamePassId);
    if (!Number.isFinite(id)) {
        return null;
    }

    const name = String(config && config.name ? config.name : '').trim();
    if (isArchivedMonetizationName(name)) {
        return null;
    }

    return {
        id,
        name: name || '(Unnamed Game Pass)'
    };
}

function toDeveloperProductRow(config) {
    const id = Number(config && config.productId);
    if (!Number.isFinite(id)) {
        return null;
    }

    const name = String(config && config.name ? config.name : '').trim();
    if (isArchivedMonetizationName(name)) {
        return null;
    }

    return {
        id,
        name: name || '(Unnamed Developer Product)'
    };
}

async function fetchGameSection(label, universeId) {
    try {
        const [gamePassConfigs, developerProductConfigs] = await Promise.all([
            listAllGamePassConfigs(universeId),
            listAllDeveloperProductConfigs(universeId)
        ]);

        const gamePasses = gamePassConfigs
            .map(toGamePassRow)
            .filter(Boolean)
            .sort((a, b) => a.id - b.id);

        const developerProducts = developerProductConfigs
            .map(toDeveloperProductRow)
            .filter(Boolean)
            .sort((a, b) => a.id - b.id);

        return {
            label,
            universeId,
            gamePasses,
            developerProducts,
            error: null
        };
    } catch (error) {
        return {
            label,
            universeId,
            gamePasses: [],
            developerProducts: [],
            error: error.message || 'Failed to list monetization items'
        };
    }
}

function formatRows(rows, emptyLabel) {
    if (!Array.isArray(rows) || rows.length === 0) {
        return emptyLabel;
    }

    return rows.map((item) => {
        const name = String(item && item.name ? item.name : '').trim() || '(Unnamed)';
        const id = Number(item && item.id);
        return `${name} - ${Number.isFinite(id) ? id : 'Unknown ID'}`;
    }).join('\n');
}

function buildCombinedTextBlob(games) {
    const list = Array.isArray(games) ? games : [];
    if (list.length === 0) {
        return 'No monetization data returned.';
    }

    return list.map((game) => {
        const label = String(game && game.label ? game.label : 'Game');
        const universeId = Number(game && game.universeId);
        const error = String(game && game.error ? game.error : '').trim();
        const gamePasses = Array.isArray(game && game.gamePasses) ? game.gamePasses : [];
        const developerProducts = Array.isArray(game && game.developerProducts) ? game.developerProducts : [];

        const lines = [
            `${label} (Universe ${Number.isFinite(universeId) ? universeId : 'Unknown'})`,
            'Gamepasses:',
            formatRows(gamePasses, 'No gamepasses found'),
            '',
            'Products:',
            formatRows(developerProducts, 'No products found')
        ];

        if (error) {
            lines.push('', `Error: ${error}`);
        }

        return lines.join('\n');
    }).join('\n\n------------------------------\n\n');
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
        const operation = String(body && body.operation ? body.operation : '').trim().toLowerCase();

        if (operation === 'game-config:get') {
            const payload = await getGameConfigPayload();
            return sendJson(res, 200, payload);
        }

        if (operation === 'game-config:save') {
            try {
                const payload = await saveGameConfigPayload(body, auth.user);
                return sendJson(res, 200, payload);
            } catch (error) {
                return sendJson(res, 400, {
                    error: error.message || 'Invalid game configuration'
                });
            }
        }

        if (operation === 'load') {
            try {
                const ids = await resolveGameUniverseIds(body);
                const payload = await loadProductionDescription(ids);
                return sendJson(res, 200, payload);
            } catch (error) {
                return sendJson(res, 400, {
                    error: error.message || 'Failed to load production description'
                });
            }
        }

        if (operation === 'save') {
            try {
                const ids = await resolveGameUniverseIds(body);
                const payload = await saveDescriptions(ids, body && body.description);
                return sendJson(res, 200, payload);
            } catch (error) {
                const failures = Array.isArray(error && error.failures) ? error.failures : null;
                const successes = Array.isArray(error && error.successes) ? error.successes : null;
                return sendJson(res, 500, {
                    error: error.message || 'Failed to sync game descriptions',
                    failures,
                    successes
                });
            }
        }

        if (operation === 'config:load') {
            try {
                const ids = await resolveGameUniverseIds(body);
                const repository = parseConfigRepository(body && body.repository, 'repository');
                const payload = await loadProductionConfigRepository(ids, repository);
                return sendJson(res, 200, payload);
            } catch (error) {
                return sendJson(res, 400, {
                    error: error.message || 'Failed to load production config repository'
                });
            }
        }

        if (operation === 'config:sync') {
            let repository = DEFAULT_CONFIG_REPOSITORY;
            try {
                const ids = await resolveGameUniverseIds(body);
                repository = parseConfigRepository(body && body.repository, 'repository');
                const payload = await syncProductionConfigRepository(ids, repository);
                return sendJson(res, 200, payload);
            } catch (error) {
                const failures = Array.isArray(error && error.failures) ? error.failures : null;
                const successes = Array.isArray(error && error.successes) ? error.successes : null;
                return sendJson(res, 500, {
                    error: error.message || 'Failed to sync Roblox configs',
                    source: error.source || null,
                    failures,
                    successes,
                    ...buildConfigSyncMetadata(repository)
                });
            }
        }

        let ids;
        try {
            ids = await resolveGameUniverseIds(body);
        } catch (error) {
            return sendJson(res, 400, { error: error.message || 'Invalid game universe IDs' });
        }

        const games = await Promise.all([
            fetchGameSection('Production Game', ids.productionUniverseId),
            fetchGameSection('Test Game', ids.testUniverseId),
            fetchGameSection('Development Game', ids.developmentUniverseId)
        ]);

        return sendJson(res, 200, {
            config: {
                productionUniverseId: ids.productionUniverseId,
                testUniverseId: ids.testUniverseId,
                developmentUniverseId: ids.developmentUniverseId
            },
            games,
            combinedText: buildCombinedTextBlob(games)
        });
    } catch (error) {
        return sendJson(res, 500, {
            error: error.message || 'Failed to list monetization items'
        });
    }
};
