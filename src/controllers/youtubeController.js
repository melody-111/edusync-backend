'use strict';

const axios = require('axios');
const { asyncHandler, sendSuccess, sendError } = require('../utils/helpers');
const { logActivity } = require('../utils/activityLogger');

const ADULT_PATTERNS = [
  /\bporn\b/i, /\bxxx\b/i, /\bsex\b/i, /\bnude\b/i, /\bnaked\b/i, /\berotic\b/i,
  /\bx-rated\b/i, /\b18\+\b/i, /\bhentai\b/i, /\bnsfw\b/i, /\badult\b/i, /\bblowjob\b/i,
  /\bmature\b/i, /\bsexy\b/i, /\bstrip\b/i, /\bescort\b/i, /\bboobs\b/i, /\bbikini\b/i
];

const ENTERTAINMENT_PATTERNS = [
  /\b(song|songs|music|lyrics|lyric|remix|mashup|official video|official audio|audio track|dj|gana|gaana|geet|album|singer|rap|hip hop|bollywood|dance video|full movie|movie scene|gaming stream|bgmi|pubg|vlog|comedy sketch|t-series|zee music|sony music|speed records|white hill|yash raj films|shemaroo|tips official)\b/i,
  /\b(feat\.|ft\.|prod\sby|lo-fi|slowed|reverb|ringtone|status|tiktok|reels)\b/i
];

const containsAdultContent = (text) => {
  if (!text) return false;
  return ADULT_PATTERNS.some(rx => rx.test(text));
};

const containsEntertainmentContent = (text) => {
  if (!text) return false;
  return ENTERTAINMENT_PATTERNS.some(rx => rx.test(text));
};

/**
 * Reusable YouTube search helper with strict educational and non-entertainment filtering
 */
const searchYouTubeHelper = async (query, maxResults = 10, strictEducationOnly = true) => {
  if (!query || containsAdultContent(query)) return [];

  const apiKey = process.env.YOUTUBE_API_KEY;
  const limit = Math.min(parseInt(maxResults, 10) || 10, 50);
  const cleanBase = String(query).replace(/[^\w\s\+\-\*\/\=\.\,]/g, ' ').trim();
  const educationalQuery = strictEducationOnly
    ? `${cleanBase} educational lecture tutorial -song -music -remix -lyrics -official -dance -audio -teaser -trailer -movie`
    : cleanBase;

  // 1. Try official YouTube Data API v3 with Google safeSearch
  if (apiKey) {
    try {
      const response = await axios.get('https://www.googleapis.com/youtube/v3/search', {
        params: {
          part: 'snippet',
          q: educationalQuery,
          key: apiKey,
          maxResults: limit,
          type: 'video',
          safeSearch: 'strict', // Strict content filtering
        },
        timeout: 10000,
      });

      if (response.data?.items?.length > 0) {
        return response.data.items
          .filter(item => {
            const title = item.snippet?.title || '';
            const desc = item.snippet?.description || '';
            const channel = item.snippet?.channelTitle || '';
            if (containsAdultContent(title) || containsAdultContent(desc)) return false;
            if (strictEducationOnly && (containsEntertainmentContent(title) || containsEntertainmentContent(channel))) return false;
            return true;
          })
          .map(item => ({
            videoId: item.id.videoId,
            title: item.snippet.title,
            description: item.snippet.description,
            thumbnail: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url,
            channelTitle: item.snippet.channelTitle,
            publishedAt: item.snippet.publishedAt,
          }));
      }
    } catch (apiErr) {
      console.warn('[YouTube API] Fallback to scraper:', apiErr.message);
    }
  }

  // 2. Fallback to yt-search scraper
  try {
    const yts = require('yt-search');
    const r = await yts(educationalQuery);
    return (r.videos || [])
      .filter(v => {
        if (containsAdultContent(v.title) || containsAdultContent(v.description)) return false;
        if (strictEducationOnly && (containsEntertainmentContent(v.title) || containsEntertainmentContent(v.author?.name))) return false;
        return true;
      })
      .slice(0, limit)
      .map(v => ({
        videoId: v.videoId,
        title: v.title,
        description: v.description,
        thumbnail: v.thumbnail || v.image,
        channelTitle: v.author?.name || 'YouTube',
        publishedAt: v.ago || '',
      }));
  } catch (err) {
    console.error('[YouTube Scraper] Error:', err.message);
    return [];
  }
};

/**
 * Search YouTube videos
 * GET /youtube/search?query=physics&maxResults=10
 */
const searchVideos = asyncHandler(async (req, res) => {
  const { query, maxResults = 10, pageToken } = req.query;

  if (!query) {
    return sendError(res, 'Query parameter is required', 400);
  }

  // Strictly block 18+ or adult searches
  if (containsAdultContent(query)) {
    return sendError(res, 'Warning: 18+ or adult content is strictly prohibited on EduSync.', 400);
  }

  // Strictly block songs, music, and entertainment queries on EduSync
  if (containsEntertainmentContent(query)) {
    return sendError(res, 'Only educational, academic, and study videos are permitted on EduSync. Songs and entertainment are restricted.', 400);
  }

  try {
    const videos = await searchYouTubeHelper(query, maxResults, true);

    if (req.user) {
      logActivity({
        userId: req.user._id,
        actorRole: req.user.role || 'student',
        action: 'youtube.search',
        category: 'media',
        details: { query, maxResults: videos.length },
      });
    }

    return sendSuccess(res, {
      videos,
      nextPageToken: null,
      prevPageToken: null,
      totalResults: videos.length,
    });
  } catch (error) {
    console.error('YouTube Search Error:', error);
    return sendError(res, 'Failed to search YouTube videos', 500);
  }
});

/**
 * Get video details by ID
 * GET /youtube/video/:videoId
 */
const getVideoDetails = asyncHandler(async (req, res) => {
  const { videoId } = req.params;

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    return sendError(res, 'YouTube API key not configured', 500);
  }

  try {
    const response = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
      params: {
        part: 'snippet,contentDetails,statistics',
        id: videoId,
        key: apiKey,
      },
    });

    if (!response.data.items || response.data.items.length === 0) {
      return sendError(res, 'Video not found', 404);
    }

    const video = response.data.items[0];

    if (req.user) {
      logActivity({
        userId: req.user._id,
        actorRole: req.user.role || 'student',
        action: 'youtube.watch',
        category: 'media',
        details: { videoId: video.id, title: video.snippet.title },
      });
    }

    return sendSuccess(res, {
      videoId: video.id,
      title: video.snippet.title,
      description: video.snippet.description,
      thumbnail: video.snippet.thumbnails?.high?.url || video.snippet.thumbnails?.medium?.url,
      channelTitle: video.snippet.channelTitle,
      publishedAt: video.snippet.publishedAt,
      duration: video.contentDetails?.duration,
      viewCount: video.statistics?.viewCount,
      likeCount: video.statistics?.likeCount,
    });
  } catch (error) {
    console.error('YouTube API Error:', error.response?.data || error.message);
    return sendError(res, 'Failed to get video details', 500);
  }
});

module.exports = {
  searchVideos,
  getVideoDetails,
  searchYouTubeHelper,
  containsAdultContent,
  containsEntertainmentContent,
};
