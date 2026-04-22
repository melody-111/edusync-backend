const { Pool } = require('pg');

const pgPool = new Pool({
  connectionString: process.env.POSTGRES_URL || 'postgresql://user:pass@localhost:5432/scholarAnalytics',
  max: 100, // Handle high traffic connections concurrently
  idleTimeoutMillis: 30000,
});

pgPool.on('error', (err, client) => {
  console.error('Unexpected error on idle pg client', err);
});

module.exports = {
  query: (text, params) => pgPool.query(text, params),
};
