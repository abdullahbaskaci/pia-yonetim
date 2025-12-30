const { Pool } = require('pg');

const pool = new Pool({
    // Bu satır Render'daki DATABASE_URL değişkenini okur
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Uzak sunucu bağlantısı için şarttır
    }
});

module.exports = {
    query: (text, params) => pool.query(text, params),
};
