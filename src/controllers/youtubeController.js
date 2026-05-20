'use strict';

const axios = require('axios');
const { asyncHandler, sendSuccess, sendError } = require('../utils/helpers');

/**
 * Search YouTube videos
 * GET /youtube/search?query=physics&maxResults=10
 */
const searchVideos = asyncHandler(async (req, res) => {
  const { query, maxResults = 10, pageToken } = req.query;

  if (!query) {
    return sendError(res, 'Query parameter is required', 400);
  }

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    return sendError(res, 'YouTube API key not configured', 500);
  }

  try {
    const response = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: {
        part: 'snippet',
        q: query,
        type: 'video',
        videoCategoryId: '27', // Education Category ID
        maxResults: Math.min(parseInt(maxResults), 50),
        pageToken: pageToken || undefined,
        key: apiKey,
        relevanceLanguage: 'en',
        videoEmbeddable: 'true',
        videoSyndicated: 'true',
      },
    });

    const videos = response.data.items.map(item => ({
      videoId: item.id.videoId,
      title: item.snippet.title,
      description: item.snippet.description,
      thumbnail: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url,
      channelTitle: item.snippet.channelTitle,
      publishedAt: item.snippet.publishedAt,
    }));

    return sendSuccess(res, {
      videos,
      nextPageToken: response.data.nextPageToken,
      prevPageToken: response.data.prevPageToken,
      totalResults: response.data.pageInfo?.totalResults,
    });
  } catch (error) {
    console.error('YouTube API Error:', error.response?.data || error.message);
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
