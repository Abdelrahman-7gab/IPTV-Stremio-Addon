#!/usr/bin/env node

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const {
    normalizeLiveStream,
    normalizeVodStream,
    normalizeSeriesEntry,
    normalizeSeriesInfoEntry,
    normalizeSnapshot,
    fingerprintMediaItem
} = require('../snapshotNormalizer');
const {
    prepareSnapshotDataForTransport
} = require('../snapshotCompression');
const {
    getPrimarySnapshotForPublicRead,
    overwritePrimarySnapshot
} = require('../snapshotStore');
const { getDefaultXtreamSourceConfig } = require('../snapshotSourceConfig');

const CHECKPOINT_VERSION = 1;
const CHECKPOINT_DIR = path.join(__dirname, '..', '.cache');
const CHECKPOINT_PATH = process.env.SNAPSHOT_SYNC_CHECKPOINT ||
    path.join(CHECKPOINT_DIR, 'primary-snapshot-sync.json');
const SERIES_INFO_CONCURRENCY = Math.max(1, parseInt(process.env.SNAPSHOT_SYNC_SERIES_CONCURRENCY || '4', 10));
const CHECKPOINT_SAVE_EVERY = Math.max(1, parseInt(process.env.SNAPSHOT_SYNC_CHECKPOINT_EVERY || '25', 10));
const REFRESH_USER = {
    id: process.env.SNAPSHOT_SYNC_USER_ID || '11111111-1111-4111-8111-111111111111',
    email: process.env.SNAPSHOT_SYNC_USER_EMAIL || 'prenshegab@gmail.com'
};

const forceSeriesRefresh = process.argv.includes('--force-series');
const resetCheckpoint = process.argv.includes('--reset-checkpoint');

let interruptRequested = false;

function log(...args) {
    console.log('[snapshot-sync]', ...args);
}

function mapItemsById(items) {
    const map = new Map();
    (Array.isArray(items) ? items : []).forEach((item) => {
        if (item && item.id) map.set(item.id, item);
    });
    return map;
}

function getExistingSeriesInfo(seriesInfoIndex, seriesId) {
    if (!seriesInfoIndex || typeof seriesInfoIndex !== 'object') return null;
    const key = String(seriesId || '').trim();
    if (!key) return null;
    return seriesInfoIndex[key] || seriesInfoIndex[`iptv_series_${key}`] || null;
}

function normalizeExistingSeriesInfoValue(value) {
    if (!value) return null;
    if (Array.isArray(value)) return { videos: value, info: null };
    if (typeof value === 'object') {
        return {
            videos: Array.isArray(value.videos) ? value.videos : [],
            info: value.info || null
        };
    }
    return null;
}

function reuseNormalizedEntry(nextEntry, existingMap, counters) {
    const existingEntry = existingMap.get(nextEntry.id);
    if (existingEntry &&
        fingerprintMediaItem(existingEntry) === fingerprintMediaItem(nextEntry)) {
        counters.reused += 1;
        return existingEntry;
    }

    counters.changed += 1;
    return nextEntry;
}

async function fetchJson(url, label) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`${label} HTTP ${response.status}`);
    }
    return response.json();
}

async function fetchCategoryMap(baseApiUrl, action) {
    try {
        const rows = await fetchJson(`${baseApiUrl}&action=${action}`, action);
        const map = {};
        if (Array.isArray(rows)) {
            rows.forEach((row) => {
                if (row && row.category_id && row.category_name) {
                    map[row.category_id] = row.category_name;
                }
            });
        }
        return map;
    } catch (error) {
        log(`Skipping ${action}: ${error.message}`);
        return {};
    }
}

async function writeJsonAtomic(filePath, value) {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp`;
    await fs.promises.writeFile(tempPath, JSON.stringify(value));
    await fs.promises.rename(tempPath, filePath);
}

async function loadCheckpoint(sourceKey) {
    if (resetCheckpoint) {
        await fs.promises.rm(CHECKPOINT_PATH, { force: true }).catch(() => {});
        return {
            version: CHECKPOINT_VERSION,
            sourceKey,
            seriesInfoEntries: {},
            updatedAt: null,
            lastUploadedAt: null
        };
    }

    try {
        const raw = await fs.promises.readFile(CHECKPOINT_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.version !== CHECKPOINT_VERSION || parsed.sourceKey !== sourceKey) {
            return {
                version: CHECKPOINT_VERSION,
                sourceKey,
                seriesInfoEntries: {},
                updatedAt: null,
                lastUploadedAt: null
            };
        }
        return {
            version: CHECKPOINT_VERSION,
            sourceKey,
            seriesInfoEntries: parsed.seriesInfoEntries && typeof parsed.seriesInfoEntries === 'object'
                ? parsed.seriesInfoEntries
                : {},
            updatedAt: parsed.updatedAt || null,
            lastUploadedAt: parsed.lastUploadedAt || null
        };
    } catch (error) {
        return {
            version: CHECKPOINT_VERSION,
            sourceKey,
            seriesInfoEntries: {},
            updatedAt: null,
            lastUploadedAt: null
        };
    }
}

async function mapWithConcurrency(items, limit, worker) {
    if (!Array.isArray(items) || items.length === 0) return [];
    const results = new Array(items.length);
    let nextIndex = 0;

    async function runWorker() {
        while (true) {
            if (interruptRequested) return;
            const currentIndex = nextIndex;
            nextIndex += 1;
            if (currentIndex >= items.length) return;
            results[currentIndex] = await worker(items[currentIndex], currentIndex);
        }
    }

    const workerCount = Math.max(1, Math.min(limit, items.length));
    await Promise.all(Array.from({ length: workerCount }, runWorker));
    return results;
}

function buildSourceKey(sourceConfig) {
    return JSON.stringify({
        xtreamUrl: sourceConfig.xtreamUrl,
        xtreamUsername: sourceConfig.xtreamUsername,
        includeSeries: sourceConfig.includeSeries
    });
}

async function main() {
    process.on('SIGINT', () => {
        if (interruptRequested) return;
        interruptRequested = true;
        log('Interrupt received. Finishing in-flight requests, saving checkpoint, and exiting.');
    });

    const sourceConfig = getDefaultXtreamSourceConfig();
    const sourceKey = buildSourceKey(sourceConfig);
    const checkpoint = await loadCheckpoint(sourceKey);
    const startedAt = Date.now();

    log(`Using checkpoint ${CHECKPOINT_PATH}`);
    log(`Checkpoint currently has ${Object.keys(checkpoint.seriesInfoEntries).length} series info entries.`);

    const baseApiUrl =
        `${sourceConfig.xtreamUrl}/player_api.php?username=${encodeURIComponent(sourceConfig.xtreamUsername)}&password=${encodeURIComponent(sourceConfig.xtreamPassword)}`;

    const existingSnapshot = await getPrimarySnapshotForPublicRead();
    const existingSnapshotData = existingSnapshot?.snapshotData || {};
    log(
        `Existing snapshot: ` +
        `${Array.isArray(existingSnapshotData.channels) ? existingSnapshotData.channels.length : 0} live, ` +
        `${Array.isArray(existingSnapshotData.movies) ? existingSnapshotData.movies.length : 0} vod, ` +
        `${Array.isArray(existingSnapshotData.series) ? existingSnapshotData.series.length : 0} series, ` +
        `${existingSnapshotData.seriesInfoIndex && typeof existingSnapshotData.seriesInfoIndex === 'object'
            ? Object.keys(existingSnapshotData.seriesInfoIndex).length
            : 0} series info entries.`
    );

    const [liveStreams, vodStreams, seriesList, liveCategories, vodCategories, seriesCategories] = await Promise.all([
        fetchJson(`${baseApiUrl}&action=get_live_streams`, 'live streams'),
        fetchJson(`${baseApiUrl}&action=get_vod_streams`, 'vod streams'),
        sourceConfig.includeSeries === false ? Promise.resolve([]) : fetchJson(`${baseApiUrl}&action=get_series`, 'series list'),
        fetchCategoryMap(baseApiUrl, 'get_live_categories'),
        fetchCategoryMap(baseApiUrl, 'get_vod_categories'),
        sourceConfig.includeSeries === false ? Promise.resolve({}) : fetchCategoryMap(baseApiUrl, 'get_series_categories')
    ]);

    const existingChannelsById = mapItemsById(existingSnapshotData.channels);
    const existingMoviesById = mapItemsById(existingSnapshotData.movies);
    const existingSeriesById = mapItemsById(existingSnapshotData.series);
    const existingSeriesInfoIndex =
        existingSnapshotData.seriesInfoIndex && typeof existingSnapshotData.seriesInfoIndex === 'object'
            ? existingSnapshotData.seriesInfoIndex
            : {};

    const liveCounters = { reused: 0, changed: 0 };
    const normalizedChannels = (Array.isArray(liveStreams) ? liveStreams : []).map((stream) => reuseNormalizedEntry(
        normalizeLiveStream(stream, {
            xtreamUrl: sourceConfig.xtreamUrl,
            xtreamUsername: sourceConfig.xtreamUsername,
            xtreamPassword: sourceConfig.xtreamPassword,
            liveCategories
        }),
        existingChannelsById,
        liveCounters
    ));

    const vodCounters = { reused: 0, changed: 0 };
    const normalizedMovies = (Array.isArray(vodStreams) ? vodStreams : []).map((stream) => reuseNormalizedEntry(
        normalizeVodStream(stream, {
            xtreamUrl: sourceConfig.xtreamUrl,
            xtreamUsername: sourceConfig.xtreamUsername,
            xtreamPassword: sourceConfig.xtreamPassword,
            vodCategories
        }),
        existingMoviesById,
        vodCounters
    ));

    const normalizedSeries = [];
    const seriesWorkItems = [];
    const seriesCounters = { reused: 0, changed: 0 };
    const activeSeriesKeys = new Set();

    if (sourceConfig.includeSeries !== false) {
        (Array.isArray(seriesList) ? seriesList : []).forEach((stream) => {
            const nextSeriesEntry = reuseNormalizedEntry(
                normalizeSeriesEntry(stream, { seriesCategories }),
                existingSeriesById,
                seriesCounters
            );
            normalizedSeries.push(nextSeriesEntry);

            const seriesKey = String(stream.series_id);
            activeSeriesKeys.add(seriesKey);

            const checkpointEntry = checkpoint.seriesInfoEntries[seriesKey];
            const nextFingerprint = fingerprintMediaItem(nextSeriesEntry);
            const existingInfo = normalizeExistingSeriesInfoValue(
                getExistingSeriesInfo(existingSeriesInfoIndex, stream.series_id)
            );
            const existingSeriesEntry = existingSeriesById.get(nextSeriesEntry.id);
            const canReuseExistingInfo = !forceSeriesRefresh &&
                existingInfo &&
                existingSeriesEntry &&
                fingerprintMediaItem(existingSeriesEntry) === nextFingerprint;

            const canReuseCheckpoint = !forceSeriesRefresh &&
                checkpointEntry &&
                checkpointEntry.fingerprint === nextFingerprint &&
                checkpointEntry.value;

            seriesWorkItems.push({
                seriesKey,
                entry: nextSeriesEntry,
                fingerprint: nextFingerprint,
                reuseExistingInfo: canReuseExistingInfo ? existingInfo : null,
                reuseCheckpointInfo: canReuseCheckpoint ? normalizeExistingSeriesInfoValue(checkpointEntry.value) : null
            });
        });
    }

    Object.keys(checkpoint.seriesInfoEntries).forEach((seriesKey) => {
        if (!activeSeriesKeys.has(seriesKey)) {
            delete checkpoint.seriesInfoEntries[seriesKey];
        }
    });

    const nextSeriesInfoIndex = {};
    const episodeCounters = { reusedCheckpoint: 0, reusedSnapshot: 0, refreshed: 0, fallback: 0, empty: 0 };
    const changedItems = [];

    for (const item of seriesWorkItems) {
        if (item.reuseCheckpointInfo) {
            nextSeriesInfoIndex[item.seriesKey] = item.reuseCheckpointInfo;
            episodeCounters.reusedCheckpoint += 1;
            continue;
        }
        if (item.reuseExistingInfo) {
            nextSeriesInfoIndex[item.seriesKey] = item.reuseExistingInfo;
            episodeCounters.reusedSnapshot += 1;
            checkpoint.seriesInfoEntries[item.seriesKey] = {
                fingerprint: item.fingerprint,
                value: item.reuseExistingInfo
            };
            continue;
        }
        changedItems.push(item);
    }

    log(
        `Reuse summary: ` +
        `${liveCounters.reused}/${normalizedChannels.length} live, ` +
        `${vodCounters.reused}/${normalizedMovies.length} vod, ` +
        `${seriesCounters.reused}/${normalizedSeries.length} series.`
    );
    log(
        `Series info reuse: ` +
        `${episodeCounters.reusedCheckpoint} from checkpoint, ` +
        `${episodeCounters.reusedSnapshot} from snapshot, ` +
        `${changedItems.length} to fetch.`
    );

    let sinceCheckpointSave = 0;
    let checkpointSavePromise = Promise.resolve();

    async function flushCheckpoint(reason) {
        checkpoint.updatedAt = new Date().toISOString();
        checkpointSavePromise = checkpointSavePromise.then(async () => {
            await writeJsonAtomic(CHECKPOINT_PATH, checkpoint);
        });
        await checkpointSavePromise;
        sinceCheckpointSave = 0;
        log(`Checkpoint saved (${reason}). ${Object.keys(checkpoint.seriesInfoEntries).length} entries cached.`);
    }

    if (changedItems.length > 0) {
        await mapWithConcurrency(changedItems, SERIES_INFO_CONCURRENCY, async (item, index) => {
            let shouldSaveCheckpoint = false;
            let current = index + 1;
            try {
                const infoJson = await fetchJson(
                    `${baseApiUrl}&action=get_series_info&series_id=${encodeURIComponent(item.seriesKey)}`,
                    `series info ${item.entry.name}`
                );
                const normalizedInfo = normalizeSeriesInfoEntry({
                    xtreamUrl: sourceConfig.xtreamUrl,
                    xtreamUsername: sourceConfig.xtreamUsername,
                    xtreamPassword: sourceConfig.xtreamPassword,
                    seriesId: item.seriesKey,
                    infoJson,
                    fallbackSeries: item.entry
                });

                nextSeriesInfoIndex[item.seriesKey] = normalizedInfo;
                checkpoint.seriesInfoEntries[item.seriesKey] = {
                    fingerprint: item.fingerprint,
                    value: normalizedInfo
                };
                episodeCounters.refreshed += 1;
                sinceCheckpointSave += 1;
                if (current === 1 || current === changedItems.length || current % CHECKPOINT_SAVE_EVERY === 0) {
                    log(`Fetched series info ${current}/${changedItems.length}: ${item.entry.name} (${normalizedInfo.videos.length} episodes).`);
                }
                shouldSaveCheckpoint = sinceCheckpointSave >= CHECKPOINT_SAVE_EVERY;
            } catch (error) {
                const fallback = normalizeExistingSeriesInfoValue(getExistingSeriesInfo(existingSeriesInfoIndex, item.seriesKey));
                if (fallback) {
                    nextSeriesInfoIndex[item.seriesKey] = fallback;
                    checkpoint.seriesInfoEntries[item.seriesKey] = {
                        fingerprint: item.fingerprint,
                        value: fallback
                    };
                    episodeCounters.fallback += 1;
                    return;
                }

                nextSeriesInfoIndex[item.seriesKey] = { videos: [], info: null };
                checkpoint.seriesInfoEntries[item.seriesKey] = {
                    fingerprint: item.fingerprint,
                    value: { videos: [], info: null }
                };
                episodeCounters.empty += 1;
                log(`Failed to fetch ${item.entry.name}: ${error.message}`);
            }

            if (shouldSaveCheckpoint) {
                await flushCheckpoint(`progress ${current}/${changedItems.length}`);
            }
        });
    }

    if (sinceCheckpointSave > 0 || interruptRequested) {
        await flushCheckpoint(interruptRequested ? 'interrupt' : 'final fetch phase');
    }

    if (interruptRequested) {
        log('Stopped before upload. Re-run the same command to resume from checkpoint.');
        process.exit(130);
    }

    const normalized = normalizeSnapshot({
        channels: normalizedChannels,
        movies: normalizedMovies,
        series: normalizedSeries,
        includeSeries: sourceConfig.includeSeries,
        epgXmlText: '',
        seriesInfoIndex: nextSeriesInfoIndex,
        lastDurationMs: Date.now() - startedAt
    });

    const preparedSnapshotData = await prepareSnapshotDataForTransport(normalized.snapshotData);
    const rawPayloadBytes = Buffer.byteLength(JSON.stringify({
        snapshotData: normalized.snapshotData,
        stats: normalized.stats
    }), 'utf8');
    const preparedPayloadBytes = Buffer.byteLength(JSON.stringify({
        snapshotData: preparedSnapshotData,
        stats: normalized.stats
    }), 'utf8');

    log(
        `Prepared snapshot: ` +
        `${normalized.stats.liveCount} live, ` +
        `${normalized.stats.vodCount} vod, ` +
        `${normalized.stats.seriesCount} series, ` +
        `${Object.keys(preparedSnapshotData.seriesInfoIndexCompressed ? checkpoint.seriesInfoEntries : nextSeriesInfoIndex).length} series info entries.`
    );
    log(
        `Payload size: raw ${(rawPayloadBytes / (1024 * 1024)).toFixed(2)} MiB, ` +
        `prepared ${(preparedPayloadBytes / (1024 * 1024)).toFixed(2)} MiB.`
    );

    const result = await overwritePrimarySnapshot({
        user: REFRESH_USER,
        snapshotData: preparedSnapshotData,
        stats: normalized.stats
    });

    checkpoint.lastUploadedAt = result.lastRefreshedAt;
    checkpoint.updatedAt = new Date().toISOString();
    await writeJsonAtomic(CHECKPOINT_PATH, checkpoint);

    log(`Upload complete. Last refreshed at ${result.lastRefreshedAt}.`);
    log(
        `Episode summary: ` +
        `${episodeCounters.reusedCheckpoint} checkpoint reused, ` +
        `${episodeCounters.reusedSnapshot} snapshot reused, ` +
        `${episodeCounters.refreshed} refreshed, ` +
        `${episodeCounters.fallback} fallback, ` +
        `${episodeCounters.empty} empty.`
    );
}

main().catch((error) => {
    console.error('[snapshot-sync] fatal', error);
    process.exit(1);
});
