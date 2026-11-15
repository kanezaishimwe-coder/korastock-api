require("dotenv").config();

const mysql = require("mysql2/promise");

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
});

async function verifyDatabaseConnection() {
    const requiredVariables = ["DB_HOST", "DB_USER", "DB_PASSWORD", "DB_NAME"];
    const missingVariables = requiredVariables.filter(
        (name) => process.env[name] === undefined ||
            (name !== "DB_PASSWORD" && process.env[name].trim() === "")
    );
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
