const express = require("express");
const router = express.Router();
const {
    getAllProducts,
    getProduct,
    createProduct,
    updateProductStock,
    deleteProduct,
} = require("../Controllers/productController.js");
const {
    authenticateToken,
    authorizeRoles,
} = require("../middleware/authMiddleware.js");

router.get("/", authenticateToken, getAllProducts);
router.get("/:id", authenticateToken, getProduct);
router.post(
    "/",
    authenticateToken,
    authorizeRoles("admin", "manager"),
    createProduct
);
router.patch(
    "/:id/stock",
    authenticateToken,
    authorizeRoles("admin", "manager"),
    updateProductStock
);
router.delete(
    "/:id",
    authenticateToken,
    authorizeRoles("admin"),
    deleteProduct
);

module.exports = router;
