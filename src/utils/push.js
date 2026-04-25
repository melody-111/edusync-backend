'use strict';

const admin = require('firebase-admin');
const logger = require('./logger');

// Initialize Firebase Admin SDK
// This requires a serviceAccountKey.json file in the root
// For now, only initialize if the config exists
let isInitialized = false;

try {
  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './serviceAccountKey.json';
  
  if (require('fs').existsSync(serviceAccountPath)) {
    const serviceAccount = require(require('path').resolve(serviceAccountPath));
    
    // Check if it's the dummy file we created
    if (serviceAccount.project_id === 'your-firebase-project-id') {
      logger.info('Firebase push notifications disabled (Using dummy serviceAccountKey.json)');
    } else {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
      isInitialized = true;
      logger.info('Firebase Admin initialized for iOS/Android Push Notifications');
    }
  } else {
    logger.info('Firebase push notifications disabled (serviceAccountKey.json not found)');
  }
} catch {
  logger.info('Firebase push notifications disabled (Invalid serviceAccountKey.json)');
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
