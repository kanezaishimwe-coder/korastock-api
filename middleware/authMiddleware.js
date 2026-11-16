const jwt = require("jsonwebtoken");
const { pool } = require("../db/db.js");
const allowedRoles = ["admin", "user", "manager"];

// Checks the token and confirms the user's account is active.
async function authenticateToken(req, res, next) {
    const authorization = req.get("Authorization");
    let match = null;
    if (typeof authorization === "string") {
        match = authorization.match(/^Bearer\s+(\S+)$/i);
    }

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
        if (error.name === "TokenExpiredError") {
            res.status(403).json({ message: "Invalid or expired token" });
            return;
        } else if (error.name === "JsonWebTokenError") {
            res.status(403).json({ message: "Invalid or expired token" });
            return;
        } else if (error.name === "NotBeforeError") {
            res.status(403).json({ message: "Invalid or expired token" });
            return;
        } else {
            console.error("Failed to verify authentication token:", error);
            res.status(500).json({ message: "Failed to verify authentication token" });
        }
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
        let roleIsAllowed = false;
        for (const role of roles) {
            if (role === req.user.role) {
                roleIsAllowed = true;
                break;
            }
        }
        if (!roleIsAllowed) {
            res.status(403).json({ message: "Your role is not allowed to access this resource" });
            return;
        }
        next();
    };
}

function authorizeRegistrationRole(req, res, next) {
    const role = req.body && req.body.role;
    let roleIsAllowed = false;
    for (const allowedRole of allowedRoles) {
        if (role === allowedRole) {
            roleIsAllowed = true;
            break;
        }
    }
    if (role === "user" || !roleIsAllowed) {
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

// Applies extra role, department, time, and address rules.
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
        if (roles) {
            let roleIsAllowed = false;
            for (const role of roles) {
                if (role === req.user.role) {
                    roleIsAllowed = true;
                    break;
                }
            }
            if (!roleIsAllowed) {
                res.status(403).json({ message: "Your role is not allowed to access this resource" });
                return;
            }
        }

        let requestedDepartment = null;
        if (departmentParam) {
            requestedDepartment = req.params[departmentParam];
        }

        let allowedDepartments = departments;
        if (!allowedDepartments && requestedDepartment) {
            allowedDepartments = [requestedDepartment];
        }
        if (allowedDepartments) {
            let departmentIsAllowed = false;
            for (const department of allowedDepartments) {
                if (
                    typeof department === "string" &&
                    department.toLowerCase() === req.user.department.toLowerCase()
                ) {
                    departmentIsAllowed = true;
                    break;
                }
            }
            if (!departmentIsAllowed) {
                res.status(403).json({ message: "Your department is not allowed to access this resource" });
                return;
            }
        }

        if (workingHours) {
            const hour = new Date().getHours();
            const { start, end } = workingHours;
            let withinHours = false;
            if (start <= end) {
                withinHours = hour >= start && hour < end;
            } else {
                withinHours = hour >= start || hour < end;
            }
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
            let matchesIP = false;
            for (const ip of allowedIPs) {
                const allowedIP = ip.trim().replace(/^::ffff:/, "");
                if (allowedIP === requestIP) {
                    matchesIP = true;
                    break;
                }
            }
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
