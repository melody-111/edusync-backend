'use strict';

const axios = require('axios');
const { asyncHandler, sendSuccess, sendError } = require('../utils/helpers');
const { logActivity } = require('../utils/activityLogger');

/**
 * Search YouTube videos
 * GET /youtube/search?query=physics&maxResults=10
 */
const searchVideos = asyncHandler(async (req, res) => {
  const { query, maxResults = 10, pageToken } = req.query;

  if (!query) {
    return sendError(res, 'Query parameter is required', 400);
  }

  // yt-search doesn't need API key, so we skip checking it here.

  try {
    const yts = require('yt-search');
    // Ensure the query returns educational content
    const educationalQuery = query + ' educational tutorial lesson';
    const r = await yts(educationalQuery);
    
    const videos = r.videos.slice(0, Math.min(parseInt(maxResults), 50)).map(v => ({
      videoId: v.videoId,
      title: v.title,
      description: v.description,
      thumbnail: v.thumbnail || v.image,
      channelTitle: v.author.name,
      publishedAt: v.ago,
    }));

    if (req.user) {
      logActivity({
        userId: req.user._id,
        actorRole: req.user.role || 'student',
        action: 'youtube.search',
        category: 'media',
        details: { query, maxResults },
      });
    }

    return sendSuccess(res, {
      videos,
      nextPageToken: null,
      prevPageToken: null,
      totalResults: videos.length,
    });
  } catch (error) {
    console.error('YouTube Scraper Error:', error);
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
};
