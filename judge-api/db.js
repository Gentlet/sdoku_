const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'db',
  user: process.env.DB_USER || 'judge',
  password: process.env.DB_PASSWORD || 'judgepw',
  database: process.env.DB_NAME || 'judge',
  charset: 'utf8mb4',
  waitForConnections: true,
  connectionLimit: 10
});


module.exports = pool;
