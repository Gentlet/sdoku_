const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'db',
  user: process.env.DB_USER || 'judge',
  password: process.env.DB_PASSWORD || 'judgepw',
  database: process.env.DB_NAME || 'judge',
  charset: 'utf8mb4',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0, // 무제한 대기 (기본값)
  enableKeepAlive: true, // 연결 유지로 재연결 오버헤드 감소
  keepAliveInitialDelay: 0
});


module.exports = pool;
