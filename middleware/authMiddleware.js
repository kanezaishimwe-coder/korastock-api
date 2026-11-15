const jwt = require("jsonwebtoken");
const { pool } = require("../db/db.js");
const allowedRoles = ["admin", "user", "manager"];

async function authenticateToken(req, res, next) {
    const authorization = req.get("Authorization");
    const match = typeof authorization === "string"
        ? authorization.match(/^Bearer\s+(\S+)$/i)
        : null;

    if (!match) {
        res.status(401).json({ message: "Authorization token is required" });
        return;
    }
    if (!process.env.JWT_SECRET) {
        console.error("JWT_SECRET is not configured");
        res.status(500).json({ message: "Authentication is not configured" });
        return;
    }

    let payload;
    try {
        payload = jwt.verify(match[1], process.env.JWT_SECRET);
    } catch (error) {
        if (
            error.name === "TokenExpiredError" ||
            error.name === "JsonWebTokenError" ||
            error.name === "NotBeforeError"
        ) {
            res.status(403).json({ message: "Invalid or expired token" });
            return;
        }
        console.error("Failed to verify authentication token:", error);
        res.status(500).json({ message: "Failed to verify authentication token" });
        return;
    }

    const userId = Number(payload.id);
    if (
        !Number.isSafeInteger(userId) ||
        userId < 1 ||
        typeof payload.role !== "string" ||
        typeof payload.department !== "string"
    ) {
        res.status(403).json({ message: "Invalid or expired token" });
        return;
    }

    let users;
    try {
        [users] = await pool.execute(
            "SELECT is_active FROM users WHERE Id = ?",
            [userId]
        );
    } catch (error) {
        console.error("Failed to verify user account status:", error);
        res.status(500).json({ message: "Failed to verify user account" });
        return;
    }

    if (users.length === 0 || !users[0].is_active) {
        res.status(403).json({ message: "User account is inactive" });
        return;
    }

    req.user = {
        id: userId,
        role: payload.role,
        department: payload.department,
        isActive: true,
    };
    next();
}

function authorizeRoles(...roles) {
    return (req, res, next) => {
        if (!req.user) {
            res.status(401).json({ message: "Authentication is required" });
            return;
        }
        if (!roles.includes(req.user.role)) {
            res.status(403).json({ message: "Your role is not allowed to access this resource" });
            return;
        }
        next();
    };
}

function authorizeRegistrationRole(req, res, next) {
    const role = req.body && req.body.role;
    if (role === "user" || !allowedRoles.includes(role)) {
        next();
        return;
    }

    authenticateToken(req, res, () => {
        authorizeRoles("admin")(req, res, next);
    });
}

function authorizeOwnerOrAdmin(parameterName = "id") {
    return (req, res, next) => {
        const resourceId = Number(req.params[parameterName]);
        if (!Number.isSafeInteger(resourceId) || resourceId < 1) {
            res.status(400).json({ message: "User ID must be a positive integer" });
            return;
        }
        if (!req.user) {
            res.status(401).json({ message: "Authentication is required" });
            return;
        }
        if (req.user.role !== "admin" && req.user.id !== resourceId) {
            res.status(403).json({ message: "You can only access your own data" });
            return;
        }
        next();
    };
}

function authorizeAccess({
    roles,
    departments,
    departmentParam,
    workingHours,
    allowedIPs,
} = {}) {
    return (req, res, next) => {
        if (!req.user) {
            res.status(401).json({ message: "Authentication is required" });
            return;
        }
        if (!req.user.isActive) {
            res.status(403).json({ message: "User account is inactive" });
            return;
        }
        if (roles && !roles.includes(req.user.role)) {
            res.status(403).json({ message: "Your role is not allowed to access this resource" });
            return;
        }

        const requestedDepartment = departmentParam
            ? req.params[departmentParam]
            : null;
        const allowedDepartments = departments || (requestedDepartment ? [requestedDepartment] : null);
        if (
            allowedDepartments &&
            !allowedDepartments.some(
                (department) =>
                    typeof department === "string" &&
                    department.toLowerCase() === req.user.department.toLowerCase()
            )
        ) {
            res.status(403).json({ message: "Your department is not allowed to access this resource" });
            return;
        }

        if (workingHours) {
            const hour = new Date().getHours();
            const { start, end } = workingHours;
            const withinHours = start <= end
                ? hour >= start && hour < end
                : hour >= start || hour < end;
            if (!withinHours) {
                res.status(403).json({ message: "Access is allowed only during working hours" });
                return;
            }
        }

        if (allowedIPs) {
            if (allowedIPs.length === 0) {
                res.status(503).json({ message: "IP access rules are not configured" });
                return;
            }
            const requestIP = (req.ip || req.socket.remoteAddress || "").replace(/^::ffff:/, "");
            const matchesIP = allowedIPs.some(
                (ip) => ip.trim().replace(/^::ffff:/, "") === requestIP
            );
            if (!matchesIP) {
                res.status(403).json({ message: "Access from this IP address is not allowed" });
                return;
            }
        }

        next();
    };
}

module.exports = {
    authenticateToken,
    authorizeRoles,
    authorizeRegistrationRole,
    authorizeOwnerOrAdmin,
    authorizeAccess,
};
