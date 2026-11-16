const { pool } = require("../db/db.js");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const allowedRoles = ["admin", "user", "manager"];

async function query(sql, values = []) {
    const [results] = await pool.query(sql, values);
    return results;
}

function readUserId(req, res) {
    const userId = Number(req.params.id);
    if (!Number.isSafeInteger(userId) || userId < 1) {
        res.status(400).json({ message: "User ID must be a positive integer" });
        return null;
    }
    return userId;
}

function readUserFields(req, res) {
    let body = req.body;
    if (body === null || body === undefined) {
        body = {};
    }
    const { name, username, email, password } = body;
    const requiredFields = [name, username, email, password];
    for (const value of requiredFields) {
        if (typeof value !== "string" || value.trim() === "") {
            res.status(400).json({
                message: "name, username, email, and password are required strings",
            });
            return null;
        }
    }
    return [name.trim(), username.trim(), email.trim(), password];
}

// Creates a user after checking the submitted account details.
async function AddUser(req, res) {
    let body = req.body;
    if (body === null || body === undefined) {
        body = {};
    }
    const { username, password, role, department } = body;
    let roleIsAllowed = false;
    for (const allowedRole of allowedRoles) {
        if (role === allowedRole) {
            roleIsAllowed = true;
            break;
        }
    }
    if (
        typeof username !== "string" ||
        username.trim() === "" ||
        typeof password !== "string" ||
        password.trim() === "" ||
        !roleIsAllowed ||
        typeof department !== "string" ||
        department.trim() === ""
    ) {
        res.status(400).json({
            message: "username, password, role (admin/user/manager), and department are required",
        });
        return;
    }

    try {
        const hash = await bcrypt.hash(password, 10);
        const result = await query(
            "INSERT INTO users (username, password, role, department, is_active) VALUES (?, ?, ?, ?, TRUE)",
            [username.trim(), hash, role, department.trim()]
        );
        res.status(201).json({
            message: "User registered successfully",
            userID: result.insertId,
        });
    } catch (error) {
        if (error.code === "ER_DUP_ENTRY") {
            res.status(409).json({ message: "Username is already registered" });
            return;
        }
        console.error("Failed to create user:", error);
        res.status(500).json({ message: "Failed to create user" });
    }
}

// Checks login details before creating an access token.
async function login(req, res) {
    let body = req.body;
    if (body === null || body === undefined) {
        body = {};
    }
    const { username, password } = body;
    if (
        typeof username !== "string" ||
        username.trim() === "" ||
        typeof password !== "string" ||
        password === ""
    ) {
        res.status(400).json({ message: "username and password are required" });
        return;
    }

    try {
        const users = await query(
            "SELECT Id AS id, username, password, role, department, is_active FROM users WHERE username = ?",
            [username.trim()]
        );
        if (users.length === 0 || !(await bcrypt.compare(password, users[0].password))) {
            res.status(401).json({ message: "Invalid username or password" });
            return;
        }

        const user = users[0];
        if (!user.is_active) {
            res.status(403).json({ message: "User account is inactive" });
            return;
        }
        if (!process.env.JWT_SECRET) {
            console.error("JWT_SECRET is not configured");
            res.status(500).json({ message: "Authentication is not configured" });
            return;
        }

        const token = jwt.sign(
            {
                id: Number(user.id),
                role: user.role,
                department: user.department,
            },
            process.env.JWT_SECRET,
            { expiresIn: process.env.JWT_EXPIRES_IN || "1h" }
        );
        res.status(200).json({ token });
    } catch (error) {
        console.error("Failed to log in user:", {
            code: error.code,
            message: error.message,
        });
        res.status(500).json({ message: "Failed to log in" });
    }
}

async function getoneUser(req, res) {
    const userId = readUserId(req, res);
    if (userId === null) return;

    try {
        const users = await query(
            "SELECT Id AS userID, name, username, email, role, department FROM users WHERE Id = ?",
            [userId]
        );
        if (users.length === 0) {
            res.status(404).json({ message: "User not found" });
            return;
        }
        res.status(200).json(users[0]);
    } catch (error) {
        console.error("Failed to fetch user:", error);
        res.status(500).json({ message: "Failed to fetch user" });
    }
}

async function getAllUser(req, res) {
    try {
        const users = await query(
            "SELECT Id AS userID, name, username, email, role, department FROM users"
        );
        res.status(200).json(users);
    } catch (error) {
        console.error("Failed to fetch users:", error);
        res.status(500).json({ message: "Failed to fetch users" });
    }
}

async function deleteUser(req, res) {
    const userId = readUserId(req, res);
    if (userId === null) return;

    try {
        const result = await query("DELETE FROM users WHERE Id = ?", [userId]);
        if (result.affectedRows === 0) {
            res.status(404).json({ message: "User not found" });
            return;
        }
        res.status(200).json({ message: "User deleted successfully" });
    } catch (error) {
        console.error("Failed to delete user:", error);
        res.status(500).json({ message: "Failed to delete user" });
    }
}

async function UpdateUser(req, res) {
    const userId = readUserId(req, res);
    if (userId === null) return;
    const fields = readUserFields(req, res);
    if (!fields) return;

    try {
        const [name, username, email, password] = fields;
        const hash = await bcrypt.hash(password, 10);
        const result = await query(
            "UPDATE users SET name = ?, username = ?, email = ?, password = ? WHERE Id = ?",
            [name, username, email, hash, userId]
        );
        if (result.affectedRows === 0) {
            const existingUsers = await query(
                "SELECT Id FROM users WHERE Id = ?",
                [userId]
            );
            if (existingUsers.length === 0) {
                res.status(404).json({ message: "User not found" });
                return;
            }
        }
        res.status(200).json({ message: "User updated successfully" });
    } catch (error) {
        if (error.code === "ER_DUP_ENTRY") {
            res.status(409).json({ message: "Username is already registered" });
            return;
        }
        console.error("Failed to update user:", error);
        res.status(500).json({ message: "Failed to update user" });
    }
}

module.exports = {
    AddUser,
    login,
    getoneUser,
    getAllUser,
    deleteUser,
    UpdateUser,
};
