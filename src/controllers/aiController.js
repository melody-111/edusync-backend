'use strict';

const { body } = require('express-validator');
const axios = require('axios');
const AppControls = require('../models/AppControls');
const Session = require('../models/Session');
const { asyncHandler, sendSuccess, sendError } = require('../utils/helpers');
const { logActivity } = require('../utils/activityLogger');
const { cache } = require('../config/redis');
const logger = require('../utils/logger');

const AI_API_KEY = process.env.AI_API_KEY;
const AI_API_BASE_URL = process.env.AI_API_BASE_URL || 'https://api.openai.com/v1';
const AI_MODEL = process.env.AI_MODEL || 'gpt-4o';

const STUDENT_DAILY_LIMIT = 20;
const TEACHER_DAILY_LIMIT = 200;

/**
 * POST /ai/chat
 * Handles AI chat with role-based access control
 */
const aiChat = asyncHandler(async (req, res) => {
  let { messages, sessionId, context, message, image } = req.body;
  const user = req.user;

  // Compatibility: Handle single message string or image
  if ((message || image) && !messages) {
    if (image) {
      messages = [{ 
        role: 'user', 
        content: [
          { type: 'text', text: message || 'Analyze this image and explain the problem and its solution.' },
          { type: 'image_url', image_url: { url: image.startsWith('data:image') ? image : `data:image/jpeg;base64,${image}` } }
        ]
      }];
    } else {
      messages = [{ role: 'user', content: message }];
    }
  }


  // Check if student AI is enabled (if in a session)
  if (user.role === 'student' && sessionId) {
    const mongoose = require('mongoose');
    const isObjId = mongoose.Types.ObjectId.isValid(sessionId);
    const session = await Session.findOne(
      isObjId ? { $or: [{ _id: sessionId }, { sessionId }] } : { sessionId }
    );
    if (session) {
      const controls = await AppControls.findOne({ sessionId: session._id });
      if (controls && !controls.aiEnabled) {
        return sendError(res, 'AI access is currently disabled by your teacher', 403);
      }
    }
  }


  // Daily usage limit check
  const dailyLimit = user.role === 'teacher' ? TEACHER_DAILY_LIMIT : STUDENT_DAILY_LIMIT;
  const usageKey = `ai:usage:${user._id}:${new Date().toISOString().split('T')[0]}`;
  const usageRaw = await cache.get(usageKey);
  const usage = parseInt(usageRaw, 10) || 0;

  if (usage >= dailyLimit) {
    return sendError(res, `Daily AI limit of ${dailyLimit} requests reached`, 429);
  }

  if (!AI_API_KEY || AI_API_KEY === 'your_ai_api_key') {
    return sendError(res, 'AI service not configured', 503);
  }

  // Build system message
  const systemMessage = {
    role: 'system',
    content: user.role === 'teacher'
      ? `You are an intelligent teaching assistant. Help the teacher create lesson plans, explain concepts, generate quiz questions, and support classroom activities.`
      : `You are a helpful study assistant for a student. Answer questions clearly, encourage learning, and provide educational support. ${context ? `Context: ${context}` : ''}`,
  };

  const payload = {
    model: AI_MODEL,
    messages: [systemMessage, ...messages],
    max_tokens: user.role === 'teacher' ? 2000 : 800,
    temperature: 0.7,
  };

  let aiResponse;
  try {
    const response = await axios.post(`${AI_API_BASE_URL}/chat/completions`, payload, {
      headers: {
        Authorization: `Bearer ${AI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });
    aiResponse = response.data;
  } catch (err) {
    logger.error(`AI API error: ${err.response?.data?.error?.message || err.message}`);
    return sendError(res, 'AI service unavailable. Please try again.', 503);
  }

  // Increment usage counter
  await cache.set(usageKey, (usage + 1).toString(), 86400); // Expires end of day

  logActivity({
    userId: user._id,
    actorRole: user.role,
    action: 'ai.request',
    category: 'ai',
    details: { sessionId, model: AI_MODEL, usage: usage + 1 },
  });

  const choice = aiResponse.choices?.[0];
  return sendSuccess(res, {
    message: choice?.message || null,
    usage: {
      today: usage + 1,
      limit: dailyLimit,
      remaining: dailyLimit - usage - 1,
    },
    model: aiResponse.model,
    tokens: aiResponse.usage,
  });
});

/**
 * POST /ai/generate-image
 * Generates an image using OpenAI DALL-E in the specified dimension
 */
const generateImage = asyncHandler(async (req, res) => {
  const { prompt, size = '1024x1024', sessionId } = req.body;
  const user = req.user;

  // Check if student AI is enabled (if in a session)
  if (user.role === 'student' && sessionId) {
    const mongoose = require('mongoose');
    const isObjId = mongoose.Types.ObjectId.isValid(sessionId);
    const session = await Session.findOne(
      isObjId ? { $or: [{ _id: sessionId }, { sessionId }] } : { sessionId }
    );
    if (session) {
      const controls = await AppControls.findOne({ sessionId: session._id });
      if (controls && !controls.aiEnabled) {
        return sendError(res, 'AI access is currently disabled by your teacher', 403);
      }
    }
  }

  // Daily usage limit check (images are more expensive, so we count them as 5 text requests)
  const costFactor = 5;
  const dailyLimit = user.role === 'teacher' ? TEACHER_DAILY_LIMIT : STUDENT_DAILY_LIMIT;
  const usageKey = `ai:usage:${user._id}:${new Date().toISOString().split('T')[0]}`;
  const usageRaw = await cache.get(usageKey);
  const usage = parseInt(usageRaw, 10) || 0;

  if (usage + costFactor > dailyLimit) {
    return sendError(res, `Daily AI limit reached. Generating an image costs ${costFactor} requests.`, 429);
  }

  if (!AI_API_KEY || AI_API_KEY === 'your_ai_api_key') {
    return sendError(res, 'AI service not configured', 503);
  }

  let imageUrl;
  try {
    const response = await axios.post(`${AI_API_BASE_URL}/images/generations`, {
      prompt,
      n: 1,
      size,
      model: 'dall-e-3', // or dall-e-2 depending on the account
    }, {
      headers: {
        Authorization: `Bearer ${AI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 60000,
    });
    
    imageUrl = response.data?.data?.[0]?.url;
  } catch (err) {
    logger.error(`AI Image API error: ${err.response?.data?.error?.message || err.message}`);
    
    // Fallback to dall-e-2 if dall-e-3 is not available
    if (err.response?.data?.error?.message?.includes('model')) {
        try {
            const fallbackResponse = await axios.post(`${AI_API_BASE_URL}/images/generations`, {
                prompt,
                n: 1,
                size: size === '1024x1024' ? '1024x1024' : '512x512', // DALL-E 2 sizes
                model: 'dall-e-2',
              }, {
                headers: {
                  Authorization: `Bearer ${AI_API_KEY}`,
                  'Content-Type': 'application/json',
                },
                timeout: 60000,
            });
            imageUrl = fallbackResponse.data?.data?.[0]?.url;
        } catch {
            return sendError(res, 'AI Image generation failed. Please try again.', 503);
        }
    } else {
        return sendError(res, 'AI Image generation failed. Please try again.', 503);
    }
  }

  // Increment usage counter
  await cache.set(usageKey, (usage + costFactor).toString(), 86400);

  logActivity({
    userId: user._id,
    actorRole: user.role,
    action: 'ai.image.generate',
    category: 'ai',
    details: { sessionId, size },
  });

  return sendSuccess(res, {
    imageUrl,
    usage: {
      today: usage + costFactor,
      limit: dailyLimit,
      remaining: Math.max(0, dailyLimit - usage - costFactor),
    },
  });
});

// ─── Get AI Usage Stats ────────────────────────────────────────────────────────
const getAiUsage = asyncHandler(async (req, res) => {
  const user = req.user;
  const dailyLimit = user.role === 'teacher' ? TEACHER_DAILY_LIMIT : STUDENT_DAILY_LIMIT;
  const usageKey = `ai:usage:${user._id}:${new Date().toISOString().split('T')[0]}`;
  const usageRaw = await cache.get(usageKey);
  const usage = parseInt(usageRaw, 10) || 0;

  return sendSuccess(res, {
    today: usage,
    limit: dailyLimit,
    remaining: Math.max(0, dailyLimit - usage),
    role: user.role,
  });
});

// ─── Validation ────────────────────────────────────────────────────────────────
const aiChatValidation = [
  body('messages')
    .optional()
    .isArray({ min: 1 })
    .withMessage('messages array required'),
  body('message')
    .optional()
    .isString()
    .isLength({ max: 4000 })
    .withMessage('Message too long'),
  body('messages.*.role')
    .optional()
    .isIn(['user', 'assistant'])
    .withMessage('Message role must be user or assistant'),

  body('messages.*.content')
    .optional() // made optional because it could be an array for vision
    .custom((val) => typeof val === 'string' || Array.isArray(val))
    .withMessage('Message content invalid format'),
  body('sessionId').optional().isString(),
  body('context').optional().isString().isLength({ max: 500 }),
  body('image').optional().isString(),
];

const generateImageValidation = [
  body('prompt').isString().notEmpty().withMessage('Prompt is required'),
  body('size').optional().isString().isIn(['256x256', '512x512', '1024x1024']).withMessage('Invalid dimension'),
  body('sessionId').optional().isString(),
];

module.exports = { aiChat, generateImage, getAiUsage, aiChatValidation, generateImageValidation };
