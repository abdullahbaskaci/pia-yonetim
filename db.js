const { Pool } = require('pg');
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Uzak sunucu bağlantısı için gerekli
});
module.exports = { query: (text, params) => pool.query(text, params) };