'use strict';

const logger = require('../utils/logger');

/**
 * Monitoring and Alerting System
 * Designed for high traffic production environment
 */

class MonitoringSystem {
  constructor() {
    this.metrics = {
      requests: {
        total: 0,
        success: 0,
        error: 0,
        avgResponseTime: 0
      },
      database: {
        mongodb: { connections: 0, queryTime: 0, errors: 0 },
        postgres: { connections: 0, queryTime: 0, errors: 0 },
        redis: { connections: 0, operations: 0, errors: 0 }
      },
      system: {
        cpu: 0,
        memory: 0,
        uptime: 0
      },
      errors: []
    };
    this.alertThresholds = {
      errorRate: 0.05, // 5% error rate
      responseTime: 5000, // 5 seconds
      memoryUsage: 0.9, // 90% memory usage
      cpuUsage: 0.8 // 80% CPU usage
    };
    this.startTime = Date.now();
  }

  /**
   * Record request metrics
   */
  recordRequest(duration, success = true) {
    this.metrics.requests.total++;
    if (success) {
      this.metrics.requests.success++;
    } else {
      this.metrics.requests.error++;
    }

    // Calculate moving average response time
    const currentAvg = this.metrics.requests.avgResponseTime;
    this.metrics.requests.avgResponseTime = 
      (currentAvg * (this.metrics.requests.total - 1) + duration) / this.metrics.requests.total;

    // Check for alerts
    this.checkAlerts();
  }

  /**
   * Record database metrics
   */
  recordDatabaseMetrics(dbType, queryTime, error = false) {
    if (this.metrics.database[dbType]) {
      this.metrics.database[dbType].queryTime = queryTime;
      if (error) {
        this.metrics.database[dbType].errors++;
      }
    }
  }

  /**
   * Update system metrics
   */
  updateSystemMetrics() {
    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();

    this.metrics.system.memory = memUsage.heapUsed / memUsage.heapTotal;
    this.metrics.system.cpu = (cpuUsage.user + cpuUsage.system) / 1000000; // Convert to seconds
    this.metrics.system.uptime = (Date.now() - this.startTime) / 1000;
  }

  /**
   * Check for alert conditions
   */
  checkAlerts() {
    const errorRate = this.metrics.requests.error / this.metrics.requests.total;
    const avgResponseTime = this.metrics.requests.avgResponseTime;
    const memoryUsage = this.metrics.system.memory;
    const cpuUsage = this.metrics.system.cpu;

    // Error rate alert
    if (errorRate > this.alertThresholds.errorRate) {
      this.triggerAlert('HIGH_ERROR_RATE', {
        errorRate: (errorRate * 100).toFixed(2) + '%',
        threshold: (this.alertThresholds.errorRate * 100).toFixed(2) + '%'
      });
    }

    // Response time alert
    if (avgResponseTime > this.alertThresholds.responseTime) {
      this.triggerAlert('HIGH_RESPONSE_TIME', {
        avgResponseTime: avgResponseTime.toFixed(2) + 'ms',
        threshold: this.alertThresholds.responseTime + 'ms'
      });
    }

    // Memory usage alert
    if (memoryUsage > this.alertThresholds.memoryUsage) {
      this.triggerAlert('HIGH_MEMORY_USAGE', {
        memoryUsage: (memoryUsage * 100).toFixed(2) + '%',
        threshold: (this.alertThresholds.memoryUsage * 100).toFixed(2) + '%'
      });
    }

    // CPU usage alert
    if (cpuUsage > this.alertThresholds.cpuUsage) {
      this.triggerAlert('HIGH_CPU_USAGE', {
        cpuUsage: cpuUsage.toFixed(2) + '%',
        threshold: (this.alertThresholds.cpuUsage * 100).toFixed(2) + '%'
      });
    }
  }

  /**
   * Trigger alert
   */
  triggerAlert(type, details) {
    const alert = {
      type,
      timestamp: new Date().toISOString(),
      details,
      severity: this.getSeverity(type)
    };

    this.metrics.errors.push(alert);
    logger.warn(`ALERT: ${type}`, details);

    // Keep only last 100 errors
    if (this.metrics.errors.length > 100) {
      this.metrics.errors.shift();
    }

    // In production, send to alerting service (PagerDuty, Slack, etc.)
    this.sendAlert(alert);
  }

  /**
   * Get alert severity
   */
  getSeverity(type) {
    const severityMap = {
      'HIGH_ERROR_RATE': 'critical',
      'HIGH_RESPONSE_TIME': 'warning',
      'HIGH_MEMORY_USAGE': 'critical',
      'HIGH_CPU_USAGE': 'warning'
    };
    return severityMap[type] || 'info';
  }

  /**
   * Send alert to external service
   */
  sendAlert(alert) {
    if (process.env.NODE_ENV === 'production') {
      // Integrate with PagerDuty, Slack, or other alerting services
      // Example: Send to Slack webhook
      // this.sendToSlack(alert);
      // Example: Send to PagerDuty
      // this.sendToPagerDuty(alert);
    }
  }

  /**
   * Get current metrics
   */
  getMetrics() {
    this.updateSystemMetrics();
    return {
      ...this.metrics,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Reset metrics (for testing)
   */
  resetMetrics() {
    this.metrics = {
      requests: {
        total: 0,
        success: 0,
        error: 0,
        avgResponseTime: 0
      },
      database: {
        mongodb: { connections: 0, queryTime: 0, errors: 0 },
        postgres: { connections: 0, queryTime: 0, errors: 0 },
        redis: { connections: 0, operations: 0, errors: 0 }
      },
      system: {
        cpu: 0,
        memory: 0,
        uptime: 0
      },
      errors: []
    };
    this.startTime = Date.now();
  }

  /**
   * Middleware for request tracking
   */
  requestTracker() {
    return (req, res, next) => {
      const startTime = Date.now();

      res.on('finish', () => {
        const duration = Date.now() - startTime;
        const success = res.statusCode < 400;
        this.recordRequest(duration, success);
      });

      next();
    };
  }

  /**
   * Get health status
   */
  getHealthStatus() {
    const metrics = this.getMetrics();
    const errorRate = metrics.requests.error / metrics.requests.total;
    const isHealthy = 
      errorRate < this.alertThresholds.errorRate &&
      metrics.requests.avgResponseTime < this.alertThresholds.responseTime &&
      metrics.system.memory < this.alertThresholds.memoryUsage &&
      metrics.system.cpu < this.alertThresholds.cpuUsage;

    return {
      status: isHealthy ? 'healthy' : 'unhealthy',
      metrics,
      uptime: metrics.system.uptime
    };
  }
}

module.exports = new MonitoringSystem();
