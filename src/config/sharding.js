'use strict';

const mongoose = require('mongoose');
const logger = require('../utils/logger');

/**
 * Database Sharding Configuration
 * Designed to handle 10M+ users across multiple shards
 */

class ShardingManager {
  constructor() {
    this.shards = new Map();
    this.shardCount = parseInt(process.env.SHARD_COUNT || '4');
    this.currentShard = 0;
  }

  /**
   * Initialize sharding strategy
   */
  initializeSharding() {
    // Determine sharding key based on user ID
    mongoose.plugin(this.shardingPlugin);
    logger.info(`Sharding initialized with ${this.shardCount} shards`);
  }

  /**
   * Mongoose plugin for automatic sharding
   */
  shardingPlugin(schema) {
    // Add shard key to documents
    schema.pre('save', function(next) {
      if (!this.shardKey) {
        this.shardKey = this.calculateShardKey(this._id);
      }
      next();
    });

    // Add index on shard key
    schema.index({ shardKey: 1 });
  }

  /**
   * Calculate shard key based on document ID
   */
  calculateShardKey(documentId) {
    const hash = this.hashCode(documentId.toString());
    return hash % this.shardCount;
  }

  /**
   * Simple hash function for sharding
   */
  hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash);
  }

  /**
   * Get shard connection string
   */
  getShardConnectionString(shardId) {
    const baseUri = process.env.MONGODB_URI;
    const shardSuffix = shardId > 0 ? `-${shardId}` : '';
    return baseUri.replace(/digital_classroom$/, `digital_classroom${shardSuffix}`);
  }

  /**
   * Connect to specific shard
   */
  async connectToShard(shardId) {
    const connectionString = this.getShardConnectionString(shardId);
    
    try {
      if (this.shards.has(shardId)) {
        return this.shards.get(shardId);
      }

      const connection = await mongoose.createConnection(connectionString, {
        maxPoolSize: parseInt(process.env.MAX_CONNECTIONS_PER_SHARD || '50'),
        minPoolSize: 5,
        socketTimeoutMS: 45000,
        serverSelectionTimeoutMS: 5000,
        heartbeatFrequencyMS: 10000,
      });

      this.shards.set(shardId, connection);
      logger.info(`Connected to shard ${shardId}`);
      
      return connection;
    } catch (error) {
      logger.error(`Failed to connect to shard ${shardId}:`, error);
      throw error;
    }
  }

  /**
   * Get appropriate shard for user
   */
  async getUserShard(userId) {
    const shardId = this.calculateShardKey(userId);
    return this.connectToShard(shardId);
  }

  /**
   * Distribute query across all shards
   */
  async distributeQuery(model, query, options = {}) {
    const results = [];
    const shardPromises = [];

    for (let i = 0; i < this.shardCount; i++) {
      const shardPromise = this.connectToShard(i).then(connection => {
        const ShardModel = connection.model(model.modelName, model.schema);
        return ShardModel.find(query, options.projection)
          .sort(options.sort)
          .limit(options.limit)
          .skip(options.skip)
          .lean()
          .exec();
      });
      
      shardPromises.push(shardPromise);
    }

    try {
      const shardResults = await Promise.all(shardPromises);
      shardResults.forEach(result => results.push(...result));
      
      // Sort and limit results if needed
      if (options.sort) {
        results.sort((a, b) => {
          const sortField = Object.keys(options.sort)[0];
          const sortOrder = options.sort[sortField] === 1 ? 1 : -1;
          return (a[sortField] > b[sortField] ? 1 : -1) * sortOrder;
        });
      }
      
      if (options.limit) {
        return results.slice(0, options.limit);
      }
      
      return results;
    } catch (error) {
      logger.error('Distributed query failed:', error);
      throw error;
    }
  }

  /**
   * Health check for all shards
   */
  async healthCheck() {
    const healthStatus = {
      totalShards: this.shardCount,
      healthyShards: 0,
      unhealthyShards: 0,
      shards: []
    };

    for (let i = 0; i < this.shardCount; i++) {
      try {
        const connection = this.shards.get(i);
        if (connection && connection.readyState === 1) {
          healthStatus.healthyShards++;
          healthStatus.shards.push({
            shardId: i,
            status: 'healthy',
            connections: connection.connections.length
          });
        } else {
          healthStatus.unhealthyShards++;
          healthStatus.shards.push({
            shardId: i,
            status: 'unhealthy',
            connections: 0
          });
        }
      } catch (error) {
        healthStatus.unhealthyShards++;
        healthStatus.shards.push({
          shardId: i,
          status: 'unhealthy',
          connections: 0,
          error: error.message
        });
      }
    }

    return healthStatus;
  }

  /**
   * Close all shard connections
   */
  async closeAllShards() {
    const closePromises = [];
    
    for (const [shardId, connection] of this.shards) {
      closePromises.push(
        connection.close().then(() => {
          logger.info(`Shard ${shardId} connection closed`);
        }).catch(error => {
          logger.error(`Failed to close shard ${shardId}:`, error);
        })
      );
    }

    await Promise.all(closePromises);
    this.shards.clear();
  }
}

module.exports = new ShardingManager();
