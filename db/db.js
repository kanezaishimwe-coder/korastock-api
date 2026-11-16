require("dotenv").config();

const mysql = require("mysql2/promise");

// Keeps database connections ready for application queries.
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
});

// Checks settings and releases connections after each check.
async function verifyDatabaseConnection() {
    const requiredVariables = ["DB_HOST", "DB_USER", "DB_PASSWORD", "DB_NAME"];
    const missingVariables = [];
    for (const name of requiredVariables) {
        const value = process.env[name];
        if (value === undefined) {
            missingVariables.push(name);
        } else if (name !== "DB_PASSWORD" && value.trim() === "") {
            missingVariables.push(name);
        }
    }

    if (missingVariables.length > 0) {
        throw new Error(`Missing database configuration: ${missingVariables.join(", ")}`);
    }

    const connection = await pool.getConnection();
    try {
        await connection.ping();
        console.log("Database is connected successfully");
    } finally {
        connection.release();
    }
}

module.exports = { pool, verifyDatabaseConnection };
