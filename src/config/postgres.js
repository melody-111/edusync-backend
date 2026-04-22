'use strict';

const { Pool } = require('pg');
const logger = require('../utils/logger');

// PostgreSQL connection pool configuration
const poolConfig = {
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432'),
  database: process.env.POSTGRES_DB || 'digital_classroom',
  user: process.env.POSTGRES_USER || 'postgres',
  password: process.env.POSTGRES_PASSWORD || 'postgres',
  max: parseInt(process.env.POSTGRES_MAX_CONNECTIONS || '20'),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
};

// Create connection pool
const pool = new Pool(poolConfig);

// Handle pool errors
pool.on('error', (err) => {
  logger.error('PostgreSQL pool error:', err.message);
});

// Test connection
const testConnection = async () => {
  try {
    const client = await pool.connect();
    await client.query('SELECT NOW()');
    client.release();
    logger.info('PostgreSQL connection successful');
    return true;
  } catch (error) {
    logger.error('PostgreSQL connection failed:', error.message);
    return false;
  }
};

// Initialize database schema
const initializeSchema = async () => {
  const schema = `
    -- Notes table
    CREATE TABLE IF NOT EXISTS notes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id VARCHAR(255) NOT NULL,
      title VARCHAR(500) NOT NULL,
      content TEXT,
      canvas_data JSONB,
      tags TEXT[],
      subject_id VARCHAR(255),
      subject_name VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      is_deleted BOOLEAN DEFAULT FALSE,
      deleted_at TIMESTAMP,
      INDEX idx_user_id (user_id),
      INDEX idx_subject_id (subject_id),
      INDEX idx_created_at (created_at),
      INDEX idx_is_deleted (is_deleted)
    );

    -- Classes table
    CREATE TABLE IF NOT EXISTS classes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      teacher_id VARCHAR(255) NOT NULL,
      subject_id VARCHAR(255),
      subject_name VARCHAR(255),
      title VARCHAR(500) NOT NULL,
      description TEXT,
      scheduled_at TIMESTAMP,
      duration INTEGER,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_teacher_id (teacher_id),
      INDEX idx_subject_id (subject_id),
      INDEX idx_scheduled_at (scheduled_at)
    );

    -- Students in classes
    CREATE TABLE IF NOT EXISTS class_students (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      class_id UUID NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      student_id VARCHAR(255) NOT NULL,
      joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_class_id (class_id),
      INDEX idx_student_id (student_id)
    );

    -- Note sync status
    CREATE TABLE IF NOT EXISTS note_sync (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      user_id VARCHAR(255) NOT NULL,
      device_id VARCHAR(255),
      synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_note_id (note_id),
      INDEX idx_user_id (user_id),
      INDEX idx_device_id (device_id)
    );
  `;

  try {
    const client = await pool.connect();
    await client.query(schema);
    client.release();
    logger.info('PostgreSQL schema initialized successfully');
  } catch (error) {
    logger.error('PostgreSQL schema initialization failed:', error.message);
    throw error;
  }
};

module.exports = {
  pool,
  testConnection,
  initializeSchema,
};
