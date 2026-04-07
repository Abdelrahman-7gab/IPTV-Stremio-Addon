(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.SnapshotNormalizer = factory();
    }
}(typeof self !== 'undefined' ? self : globalThis, function () {
    function normalizeReleased(value) {
        if (!value) return null;
        const raw = String(value).trim();
        if (!raw) return null;

        if (/^\d{10}$/.test(raw)) {
            return new Date(parseInt(raw, 10) * 1000).toISOString();
        }
        if (/^\d{13}$/.test(raw)) {
            return new Date(parseInt(raw, 10)).toISOString();
        }

        const parsed = new Date(raw);
        return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString();
    }

    function decodeXmlEntities(value) {
        return String(value || '')
            .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'");
    }

    function stripTags(value) {
        return decodeXmlEntities(String(value || '').replace(/<[^>]+>/g, '')).trim();
    }

    function parseXmlAttributes(fragment) {
        const attrs = {};
        const regex = /([\w:-]+)\s*=\s*"([^"]*)"/g;
        let match;
        while ((match = regex.exec(fragment)) !== null) {
            attrs[match[1]] = decodeXmlEntities(match[2]);
        }
        return attrs;
    }

    function findFirstTagValue(body, tagName) {
        const regex = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
        const match = body.match(regex);
        return match ? stripTags(match[1]) : '';
    }

    function parseXmltv(xmlText) {
        const epgData = {};
        const programmeRegex = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/gi;
        const channelRegex = /<channel\b/gi;
        let programmeMatch;

        while ((programmeMatch = programmeRegex.exec(xmlText || '')) !== null) {
            const attrs = parseXmlAttributes(programmeMatch[1] || '');
            const channelId = attrs.channel;
            if (!channelId) continue;

            if (!epgData[channelId]) epgData[channelId] = [];
            epgData[channelId].push({
                start: attrs.start || '',
                stop: attrs.stop || '',
                title: findFirstTagValue(programmeMatch[2] || '', 'title') || 'Unknown',
                desc: findFirstTagValue(programmeMatch[2] || '', 'desc') || ''
            });
        }

        return {
            epgData,
            stats: {
                epgChannels: (xmlText.match(channelRegex) || []).length,
                epgProgrammes: Object.values(epgData).reduce((total, entries) => total + entries.length, 0)
            }
        };
    }

    function normalizeLiveStreams(input = {}) {
        const streams = Array.isArray(input.liveStreams) ? input.liveStreams : [];
        const liveCategories = input.liveCategories || {};
        return streams.map((stream) => {
            const category = liveCategories[stream.category_id] || stream.category_name || stream.category || stream.category_id || 'Live';
            return {
                id: `iptv_live_${stream.stream_id}`,
                name: stream.name,
                type: 'tv',
                url: `${input.xtreamUrl}/live/${encodeURIComponent(input.xtreamUsername)}/${encodeURIComponent(input.xtreamPassword)}/${stream.stream_id}.m3u8`,
                logo: stream.stream_icon,
                category,
                epg_channel_id: stream.epg_channel_id
            };
        });
    }

    function normalizeVodStreams(input = {}) {
        const streams = Array.isArray(input.vodStreams) ? input.vodStreams : [];
        const vodCategories = input.vodCategories || {};
        return streams.map((stream) => {
            const category = vodCategories[stream.category_id] || stream.category_name || stream.category || 'Movies';
            return {
                id: `iptv_vod_${stream.stream_id}`,
                name: stream.name,
                type: 'movie',
                url: `${input.xtreamUrl}/movie/${encodeURIComponent(input.xtreamUsername)}/${encodeURIComponent(input.xtreamPassword)}/${stream.stream_id}.${stream.container_extension || 'mp4'}`,
                poster: stream.stream_icon,
                plot: stream.plot || '',
                year: stream.releasedate ? new Date(stream.releasedate).getFullYear() : null,
                addedAt: normalizeReleased(stream.added || stream.releasedate || stream.last_modified || null),
                category
            };
        });
    }

    function normalizeSeriesList(input = {}) {
        const streams = Array.isArray(input.seriesList) ? input.seriesList : [];
        const seriesCategories = input.seriesCategories || {};
        return streams.map((stream) => {
            const category = seriesCategories[stream.category_id] || stream.category_name || stream.category || 'Series';
            return {
                id: `iptv_series_${stream.series_id}`,
                series_id: stream.series_id,
                name: stream.name,
                type: 'series',
                poster: stream.cover,
                plot: stream.plot || '',
                addedAt: normalizeReleased(stream.last_modified || stream.releaseDate || null),
                category
            };
        });
    }

    function normalizeSnapshot(options = {}) {
        const channels = normalizeLiveStreams(options);
        const movies = normalizeVodStreams(options);
        const series = options.includeSeries === false ? [] : normalizeSeriesList(options);

        const epg = options.epgXmlText ? parseXmltv(options.epgXmlText) : {
            epgData: {},
            stats: {
                epgChannels: 0,
                epgProgrammes: 0
            }
        };

        const snapshotData = {
            channels,
            movies,
            series,
            epgData: epg.epgData,
            seriesInfoIndex: options.seriesInfoIndex || {}
        };

        const stats = {
            liveCount: channels.length,
            vodCount: movies.length,
            seriesCount: series.length,
            epgChannels: epg.stats.epgChannels,
            epgProgrammes: epg.stats.epgProgrammes,
            lastDurationMs: Number(options.lastDurationMs || 0)
        };

        return {
            snapshotData,
            stats
        };
    }

    return {
        normalizeSnapshot,
        normalizeReleased,
        parseXmltv
    };
}));
