const express = require("express");
const router = express.Router();
const {
    AddUser,
    login,
    getoneUser,
    getAllUser,
    deleteUser,
    UpdateUser,
} = require("../Controllers/userController.js");
const {
    authenticateToken,
    authorizeRoles,
    authorizeRegistrationRole,
    authorizeOwnerOrAdmin,
    authorizeAccess,
} = require("../middleware/authMiddleware.js");

const adminAllowedIPs = [];
const configuredAdminIPs = (process.env.ADMIN_ALLOWED_IPS || "").split(",");
for (const ip of configuredAdminIPs) {
    const trimmedIP = ip.trim();
    if (trimmedIP) {
        adminAllowedIPs.push(trimmedIP);
    }
}

router.post("/register", authorizeRegistrationRole, AddUser);
router.post("/user", authorizeRegistrationRole, AddUser);
router.post("/login", login);
router.get("/user", authenticateToken, authorizeRoles("admin"), getAllUser);
router.get("/user/:id", authenticateToken, authorizeOwnerOrAdmin(), getoneUser);
router.put("/user/:id", authenticateToken, authorizeRoles("admin"), UpdateUser);
router.delete("/user/:id", authenticateToken, authorizeRoles("admin"), deleteUser);

router.get(
    "/departments/:department/resources",
    authenticateToken,
    authorizeAccess({ departmentParam: "department" }),
    (req, res) => res.status(200).json({ message: `${req.params.department} resources` })
);
router.get(
    "/manager/reports",
    authenticateToken,
    authorizeRoles("admin", "manager"),
    (req, res) => res.status(200).json({ message: "Manager reports" })
);
router.get(
    "/admin/tools",
    authenticateToken,
    authorizeAccess({
        roles: ["admin"],
        departments: ["IT"],
        workingHours: { start: 9, end: 17 },
        allowedIPs: adminAllowedIPs,
    }),
    (req, res) => res.status(200).json({ message: "Admin tools" })
);

module.exports = router;