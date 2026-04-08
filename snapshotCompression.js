(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.SnapshotCompression = factory();
    }
}(typeof self !== 'undefined' ? self : globalThis, function () {
    const SERIES_INFO_INDEX_COMPRESSION = 'gzip-base64-v1';

    function cloneJson(value, fallback) {
        if (value === null || typeof value === 'undefined') return fallback;
        return JSON.parse(JSON.stringify(value));
    }

    function uint8ArrayToBase64(bytes) {
        if (typeof Buffer !== 'undefined') {
            return Buffer.from(bytes).toString('base64');
        }

        let binary = '';
        const chunkSize = 0x8000;
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
            const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
            binary += String.fromCharCode.apply(null, Array.from(chunk));
        }
        return btoa(binary);
    }

    function base64ToUint8Array(value) {
        if (typeof Buffer !== 'undefined') {
            return Uint8Array.from(Buffer.from(String(value || ''), 'base64'));
        }

        const binary = atob(String(value || ''));
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
            bytes[index] = binary.charCodeAt(index);
        }
        return bytes;
    }

    async function gzipString(value) {
        const text = String(value || '');

        if (typeof CompressionStream !== 'undefined' && typeof TextEncoder !== 'undefined') {
            const stream = new Blob([new TextEncoder().encode(text)]).stream()
                .pipeThrough(new CompressionStream('gzip'));
            const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
            return uint8ArrayToBase64(compressed);
        }

        const zlib = require('zlib');
        return zlib.gzipSync(Buffer.from(text, 'utf8')).toString('base64');
    }

    function gunzipStringSync(value) {
        const bytes = base64ToUint8Array(value);
        const zlib = require('zlib');
        return zlib.gunzipSync(Buffer.from(bytes)).toString('utf8');
    }

    async function prepareSnapshotDataForTransport(snapshotData = {}) {
        const prepared = cloneJson(snapshotData, {});
        const seriesInfoIndex = prepared.seriesInfoIndex;

        if (seriesInfoIndex && typeof seriesInfoIndex === 'object' && Object.keys(seriesInfoIndex).length > 0) {
            prepared.seriesInfoIndexCompressed = await gzipString(JSON.stringify(seriesInfoIndex));
            prepared.seriesInfoIndexCompression = SERIES_INFO_INDEX_COMPRESSION;
            delete prepared.seriesInfoIndex;
        }

        return prepared;
    }

    function expandSnapshotData(snapshotData = {}) {
        const expanded = cloneJson(snapshotData, {});
        const hasInlineSeriesInfoIndex =
            expanded.seriesInfoIndex &&
            typeof expanded.seriesInfoIndex === 'object' &&
            !Array.isArray(expanded.seriesInfoIndex);

        if (!hasInlineSeriesInfoIndex &&
            expanded.seriesInfoIndexCompression === SERIES_INFO_INDEX_COMPRESSION &&
            typeof expanded.seriesInfoIndexCompressed === 'string' &&
            expanded.seriesInfoIndexCompressed) {
            try {
                expanded.seriesInfoIndex = JSON.parse(gunzipStringSync(expanded.seriesInfoIndexCompressed));
            } catch (error) {
                throw new Error(`Failed to expand compressed series info index: ${error.message}`);
            }
        }

        if (!expanded.seriesInfoIndex || typeof expanded.seriesInfoIndex !== 'object') {
            expanded.seriesInfoIndex = {};
        }

        return expanded;
    }

    return {
        SERIES_INFO_INDEX_COMPRESSION,
        expandSnapshotData,
        prepareSnapshotDataForTransport
    };
}));
