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

    function normalizeLiveStream(stream, input = {}) {
        const liveCategories = input.liveCategories || {};
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
    }

    function normalizeLiveStreams(input = {}) {
        const streams = Array.isArray(input.liveStreams) ? input.liveStreams : [];
        return streams.map((stream) => normalizeLiveStream(stream, input));
    }

    function normalizeVodStream(stream, input = {}) {
        const vodCategories = input.vodCategories || {};
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
    }

    function normalizeVodStreams(input = {}) {
        const streams = Array.isArray(input.vodStreams) ? input.vodStreams : [];
        return streams.map((stream) => normalizeVodStream(stream, input));
    }

    function normalizeSeriesEntry(stream, input = {}) {
        const seriesCategories = input.seriesCategories || {};
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
    }

    function normalizeSeriesList(input = {}) {
        const streams = Array.isArray(input.seriesList) ? input.seriesList : [];
        return streams.map((stream) => normalizeSeriesEntry(stream, input));
    }

    function trimSeriesInfo(info = {}, fallbackSeries = {}) {
        const trimmed = {
            name: info.name || fallbackSeries.name || '',
            plot: info.plot || fallbackSeries.plot || '',
            cover: info.cover || info.cover_big || fallbackSeries.poster || '',
            backdrop_path: Array.isArray(info.backdrop_path)
                ? info.backdrop_path.filter(Boolean).slice(0, 4)
                : (info.backdrop_path || ''),
            releaseDate: info.releaseDate || info.release_date || info.releasedate || fallbackSeries.addedAt || ''
        };

        Object.keys(trimmed).forEach((key) => {
            const value = trimmed[key];
            if (value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
                delete trimmed[key];
            }
        });

        return Object.keys(trimmed).length ? trimmed : null;
    }

    function normalizeSeriesInfoEntry(input = {}) {
        const infoJson = input.infoJson || {};
        const videos = [];
        const episodesObj = infoJson.episodes || {};

        Object.keys(episodesObj).forEach((seasonKey) => {
            const seasonEpisodes = episodesObj[seasonKey];
            if (!Array.isArray(seasonEpisodes)) return;

            seasonEpisodes.forEach((episodeRow, index) => {
                const episodeId = episodeRow?.id;
                if (!episodeId) return;

                let season = parseInt(episodeRow.season || seasonKey, 10);
                if (!Number.isInteger(season) || season < 1) season = 1;

                let episode = parseInt(episodeRow.episode_num || episodeRow.episode || 0, 10);
                if (!Number.isInteger(episode) || episode < 1) episode = index + 1;

                const container = episodeRow.container_extension || 'mp4';
                const video = {
                    id: `iptv_series_ep_${episodeId}`,
                    title: episodeRow.title || `Episode ${episode}`,
                    season,
                    episode,
                    released: normalizeReleased(episodeRow.releasedate || episodeRow.added || null),
                    thumbnail: episodeRow.info?.movie_image || episodeRow.info?.episode_image || episodeRow.info?.cover_big || null,
                    url: `${input.xtreamUrl}/series/${encodeURIComponent(input.xtreamUsername)}/${encodeURIComponent(input.xtreamPassword)}/${episodeId}.${container}`
                };

                Object.keys(video).forEach((key) => {
                    const value = video[key];
                    if (value === null || value === '') {
                        delete video[key];
                    }
                });

                videos.push(video);
            });
        });

        videos.sort((left, right) => (left.season - right.season) || (left.episode - right.episode));

        return {
            videos,
            info: trimSeriesInfo(infoJson.info || {}, input.fallbackSeries || {})
        };
    }

    function fingerprintMediaItem(item = {}) {
        return [
            item.id || '',
            item.series_id || '',
            item.type || '',
            item.name || '',
            item.url || '',
            item.logo || '',
            item.poster || '',
            item.plot || '',
            item.year || '',
            item.addedAt || '',
            item.category || '',
            item.epg_channel_id || ''
        ].join('|');
    }

    function normalizeSnapshot(options = {}) {
        const channels = Array.isArray(options.channels) ? options.channels : normalizeLiveStreams(options);
        const movies = Array.isArray(options.movies) ? options.movies : normalizeVodStreams(options);
        const series = options.includeSeries === false
            ? []
            : (Array.isArray(options.series) ? options.series : normalizeSeriesList(options));

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
        fingerprintMediaItem,
        normalizeLiveStream,
        normalizeSeriesEntry,
        normalizeSeriesInfoEntry,
        normalizeSnapshot,
        normalizeVodStream,
        normalizeReleased,
        parseXmltv
    };
}));
