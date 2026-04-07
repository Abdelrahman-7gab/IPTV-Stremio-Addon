const { getPrimarySnapshotForAddon } = require('../../../snapshotStore');

function cloneJson(value, fallback) {
    if (value === null || typeof value === 'undefined') return fallback;
    return JSON.parse(JSON.stringify(value));
}

async function fetchData(addonInstance) {
    const snapshot = await getPrimarySnapshotForAddon();
    if (!snapshot) {
        throw new Error('Primary snapshot was not found');
    }

    const snapshotData = snapshot.snapshot_data || {};
    addonInstance.channels = Array.isArray(snapshotData.channels) ? cloneJson(snapshotData.channels, []) : [];
    addonInstance.movies = Array.isArray(snapshotData.movies) ? cloneJson(snapshotData.movies, []) : [];
    addonInstance.series = addonInstance.config.includeSeries === false
        ? []
        : (Array.isArray(snapshotData.series) ? cloneJson(snapshotData.series, []) : []);
    addonInstance.epgData = addonInstance.config.enableEpg === false
        ? {}
        : cloneJson(snapshotData.epgData, {});
    addonInstance.snapshotSeriesInfoIndex = cloneJson(snapshotData.seriesInfoIndex, {});
}

async function fetchSeriesInfo(addonInstance, seriesId) {
    const lookup = addonInstance.snapshotSeriesInfoIndex || {};
    const key = String(seriesId || '').replace(/^iptv_series_/, '');
    const value = lookup[key] || lookup[`iptv_series_${key}`];

    if (!value) return { videos: [] };
    if (Array.isArray(value)) return { videos: value, fetchedAt: Date.now() };
    return {
        videos: Array.isArray(value.videos) ? value.videos : [],
        fetchedAt: Date.now(),
        info: value.info || null
    };
}

module.exports = {
    fetchData,
    fetchSeriesInfo
};
