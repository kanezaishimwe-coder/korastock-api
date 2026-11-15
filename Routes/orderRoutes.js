const express = require("express");
const router = express.Router();
const {
    createOrder,
    getOrders,
    getOrder,
    cancelOrder,
    getSalesSummary,
} = require("../Controllers/orderController.js");
const {
    authenticateToken,
    authorizeRoles,
} = require("../middleware/authMiddleware.js");

router.get(
    "/summary/sales",
    authenticateToken,
    authorizeRoles("admin", "manager"),
    getSalesSummary
);
router.get("/", authenticateToken, getOrders);
router.get("/:id", authenticateToken, getOrder);
router.post("/", authenticateToken, createOrder);
router.patch(
    "/:id/cancel",
    authenticateToken,
    authorizeRoles("admin", "manager"),
    cancelOrder
);

module.exports = router;
