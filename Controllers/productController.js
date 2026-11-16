const { pool } = require("../db/db.js");

async function query(sql, values = []) {
    const [results] = await pool.execute(sql, values);
    return results;
}

function readProductId(req, res) {
    const productId = Number(req.params.id);
    if (!Number.isSafeInteger(productId) || productId < 1) {
        res.status(400).json({ message: "Product ID must be a positive integer" });
        return null;
    }
    return productId;
}

function isNonNegativeInteger(value) {
    return Number.isSafeInteger(value) && value >= 0;
}

// Lists products using the requested category and stock filters.
async function getAllProducts(req, res) {
    const { category, lowStock } = req.query;
    if (category !== undefined && typeof category !== "string") {
        res.status(400).json({ message: "category must be a string" });
        return;
    }
    if (
        lowStock !== undefined &&
        lowStock !== "true" &&
        lowStock !== "false"
    ) {
        res.status(400).json({ message: "lowStock must be true or false" });
        return;
    }

    const conditions = [];
    const values = [];
    if (category !== undefined) {
        conditions.push("category = ?");
        values.push(category);
    }
    if (lowStock === "true") {
        conditions.push("stock_quantity <= low_stock_limit");
    }

    const where = conditions.length > 0
        ? ` WHERE ${conditions.join(" AND ")}`
        : "";
    try {
        const products = await query(
            `SELECT id, name, sku, category, unit_price, stock_quantity, low_stock_limit, created_at, updated_at FROM products${where}`,
            values
        );
        res.status(200).json(products);
    } catch (error) {
        console.error("Failed to fetch products:", error);
        res.status(500).json({ message: "Failed to fetch products" });
    }
}

async function getProduct(req, res) {
    const productId = readProductId(req, res);
    if (productId === null) return;

    try {
        const products = await query(
            "SELECT id, name, sku, category, unit_price, stock_quantity, low_stock_limit, created_at, updated_at FROM products WHERE id = ?",
            [productId]
        );
        if (products.length === 0) {
            res.status(404).json({ message: "Product not found" });
            return;
        }
        res.status(200).json(products[0]);
    } catch (error) {
        console.error("Failed to fetch product:", error);
        res.status(500).json({ message: "Failed to fetch product" });
    }
}

async function createProduct(req, res) {
    let body = req.body;
    if (body === null || body === undefined) {
        body = {};
    }
    const {
        name,
        sku,
        category,
        unit_price: unitPrice,
        stock_quantity: stockQuantity,
        low_stock_limit: lowStockLimit,
    } = body;

    if (
        typeof name !== "string" ||
        name.trim() === "" ||
        typeof sku !== "string" ||
        sku.trim() === "" ||
        typeof category !== "string" ||
        category.trim() === "" ||
        typeof unitPrice !== "number" ||
        !Number.isFinite(unitPrice) ||
        unitPrice <= 0 ||
        !isNonNegativeInteger(stockQuantity) ||
        (
            lowStockLimit !== undefined &&
            !isNonNegativeInteger(lowStockLimit)
        )
    ) {
        res.status(400).json({
            message: "name, sku, category, a positive unit_price, and a non-negative integer stock_quantity are required; low_stock_limit must be a non-negative integer",
        });
        return;
    }

    try {
        const result = await query(
            "INSERT INTO products (name, sku, category, unit_price, stock_quantity, low_stock_limit) VALUES (?, ?, ?, ?, ?, ?)",
            [
                name.trim(),
                sku.trim(),
                category.trim(),
                unitPrice,
                stockQuantity,
                lowStockLimit === undefined ? 0 : lowStockLimit,
            ]
        );
        res.status(201).json({
            message: "Product created successfully",
            productID: result.insertId,
        });
    } catch (error) {
        if (error.code === "ER_DUP_ENTRY") {
            res.status(409).json({ message: "SKU is already registered" });
            return;
        }
        console.error("Failed to create product:", error);
        res.status(500).json({ message: "Failed to create product" });
    }
}

async function updateProductStock(req, res) {
    const productId = readProductId(req, res);
    if (productId === null) return;

    let body = req.body;
    if (body === null || body === undefined) {
        body = {};
    }
    const allowedFields = ["stock_quantity", "unit_price", "low_stock_limit"];
    const fields = [];
    let fieldsAreValid = true;
    for (const field of allowedFields) {
        if (Object.prototype.hasOwnProperty.call(body, field)) {
            fields.push(field);
            const value = body[field];
            if (field === "unit_price") {
                if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
                    fieldsAreValid = false;
                }
            } else if (!isNonNegativeInteger(value)) {
                fieldsAreValid = false;
            }
        }
    }
    if (
        !Object.prototype.hasOwnProperty.call(body, "stock_quantity") ||
        !fieldsAreValid
    ) {
        res.status(400).json({
            message: "A non-negative integer stock_quantity is required; low_stock_limit must be a non-negative integer and unit_price must be positive when provided",
        });
        return;
    }

    const assignments = [];
    const values = [];
    for (const field of fields) {
        assignments.push(`${field} = ?`);
        values.push(body[field]);
    }
    values.push(productId);

    try {
        const result = await query(
            `UPDATE products SET ${assignments} WHERE id = ?`,
            values
        );
        if (result.affectedRows === 0) {
            const products = await query(
                "SELECT id FROM products WHERE id = ?",
                [productId]
            );
            if (products.length === 0) {
                res.status(404).json({ message: "Product not found" });
                return;
            }
        }
        res.status(200).json({ message: "Product updated successfully" });
    } catch (error) {
        console.error("Failed to update product:", error);
        res.status(500).json({ message: "Failed to update product" });
    }
}

// Deletes products only after checking their order links.
async function deleteProduct(req, res) {
    const productId = readProductId(req, res);
    if (productId === null) return;

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        const [products] = await connection.execute(
            "SELECT id FROM products WHERE id = ? FOR UPDATE",
            [productId]
        );
        if (products.length === 0) {
            await connection.rollback();
            res.status(404).json({ message: "Product not found" });
            return;
        }

        const [orderItems] = await connection.execute(
            "SELECT id FROM order_items WHERE product_id = ? LIMIT 1",
            [productId]
        );
        if (orderItems.length > 0) {
            await connection.rollback();
            res.status(409).json({
                message: "Product cannot be deleted because it is linked to order items",
            });
            return;
        }

        await connection.execute("DELETE FROM products WHERE id = ?", [productId]);
        await connection.commit();
        res.status(200).json({ message: "Product deleted successfully" });
    } catch (error) {
        if (connection) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error("Failed to roll back product deletion:", rollbackError);
            }
        }
        console.error("Failed to delete product:", error);
        res.status(500).json({ message: "Failed to delete product" });
    } finally {
        if (connection) connection.release();
    }
}

module.exports = {
    getAllProducts,
    getProduct,
    createProduct,
    updateProductStock,
    deleteProduct,
};
