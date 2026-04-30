'use strict';

const admin = require('firebase-admin');
const logger = require('./logger');

// Initialize Firebase Admin SDK
// Supports both file-based and environment variable configuration
let isInitialized = false;

try {
  // Priority 1: Use environment variables for Firebase config
  if (process.env.FIREBASE_PROJECT_ID && 
      process.env.FIREBASE_CLIENT_EMAIL && 
      process.env.FIREBASE_PRIVATE_KEY) {
    
    const serviceAccount = {
      project_id: process.env.FIREBASE_PROJECT_ID,
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    };
    
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    isInitialized = true;
    logger.info('Firebase Admin initialized using environment variables');
  }
  // Priority 2: Use service account file
  else {
    const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './serviceAccountKey.json';
    
    if (require('fs').existsSync(serviceAccountPath)) {
      const serviceAccount = require(require('path').resolve(serviceAccountPath));
      
      // Check if it's the dummy file
      if (serviceAccount.project_id === 'your-firebase-project-id') {
        logger.warn('Firebase push notifications disabled (Using dummy serviceAccountKey.json)');
        logger.warn('Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY environment variables to enable');
      } else {
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount)
        });
        isInitialized = true;
        logger.info('Firebase Admin initialized using service account file');
      }
    } else {
      logger.warn('Firebase push notifications disabled (serviceAccountKey.json not found)');
      logger.warn('Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY environment variables to enable');
    }
  }
} catch (error) {
  logger.error('Firebase initialization failed:', error.message);
  logger.warn('Firebase push notifications disabled due to initialization error');
}

/**
 * Send push notification to a list of device tokens
 */
const sendPushNotification = async (tokens, title, body, data = {}) => {
  if (!isInitialized || !tokens || tokens.length === 0) return;

  const message = {
    notification: { title, body },
    data: data,
    tokens: Array.isArray(tokens) ? tokens : [tokens],
    // Platform specific overrides
    android: {
      priority: 'high',
      notification: { sound: 'default', clickAction: 'FLUTTER_NOTIFICATION_CLICK' }
    },
    apns: {
      payload: {
        aps: { sound: 'default', badge: 1 }
      }
    }
  };

  try {
    const response = await admin.messaging().sendMulticast(message);
    logger.debug(`FCM multicast success. ${response.successCount} sent, ${response.failureCount} failed.`);
    return response;
  } catch (error) {
    logger.error('Error sending FCM notification:', error.message);
  }
};

module.exports = {
  sendPushNotification,
  isFCMEnabled: () => isInitialized
};
