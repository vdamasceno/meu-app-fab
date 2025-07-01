const { Pool } = require('pg');
require('dotenv').config();

// O Pool gerencia múltiplas conexões com o banco de forma eficiente
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_DATABASE,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

// Exportamos um método query para ser usado em outras partes do nosso app
module.exports = {
  query: (text, params) => pool.query(text, params),
};