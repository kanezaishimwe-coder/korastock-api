const { pool } = require("../db/db.js");

function readOrderId(req, res) {
    const orderId = Number(req.params.id);
    if (!Number.isSafeInteger(orderId) || orderId < 1) {
        res.status(400).json({ message: "Order ID must be a positive integer" });
        return null;
    }
    return orderId;
}

function priceToCents(price) {
    const priceString = String(price);
    if (!/^\d+(?:\.\d{1,2})?$/.test(priceString)) {
        return null;
    }
    const [whole, fraction = ""] = priceString.split(".");
    const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
    return Number.isSafeInteger(cents) ? cents : null;
}

// Shows orders allowed for the signed-in user's role.
async function getOrders(req, res) {
    const isPrivileged = req.user.role === "admin" || req.user.role === "manager";
    if (!isPrivileged && req.user.role !== "user") {
        res.status(403).json({ message: "Your role is not allowed to access this resource" });
        return;
    }

    try {
        const values = [];
        let where = "";
        if (!isPrivileged) {
            where = " WHERE o.user_id = ?";
            values.push(req.user.id);
        }
        const [orders] = await pool.execute(
            `SELECT o.id, o.user_id, u.name AS customer_name, u.email AS customer_email, o.total_amount, o.status, o.created_at FROM orders o JOIN users u ON u.Id = o.user_id${where} ORDER BY o.created_at DESC, o.id DESC`,
            values
        );
        res.status(200).json(orders);
    } catch (error) {
        console.error("Failed to fetch orders:", error);
        res.status(500).json({ message: "Failed to fetch orders" });
    }
}

async function getOrder(req, res) {
    const orderId = readOrderId(req, res);
    if (orderId === null) return;
    let roleCanReadOrder = false;
    const allowedRoles = ["admin", "manager", "user"];
    for (const role of allowedRoles) {
        if (role === req.user.role) {
            roleCanReadOrder = true;
            break;
        }
    }
    if (!roleCanReadOrder) {
        res.status(403).json({ message: "Your role is not allowed to access this resource" });
        return;
    }

    try {
        const [rows] = await pool.execute(
            "SELECT o.id, o.user_id, u.name AS customer_name, u.email AS customer_email, o.total_amount, o.status, o.created_at, oi.product_id, p.name AS product_name, oi.quantity, oi.price_at_purchase FROM orders o JOIN users u ON u.Id = o.user_id LEFT JOIN order_items oi ON oi.order_id = o.id LEFT JOIN products p ON p.id = oi.product_id WHERE o.id = ?",
            [orderId]
        );
        if (rows.length === 0) {
            res.status(404).json({ message: "Order not found" });
            return;
        }
        if (
            req.user.role === "user" &&
            Number(rows[0].user_id) !== req.user.id
        ) {
            res.status(403).json({ message: "You can only access your own orders" });
            return;
        }

        const items = [];
        for (const row of rows) {
            if (row.product_id !== null) {
                items.push({
                    product_id: row.product_id,
                    product_name: row.product_name,
                    quantity: row.quantity,
                    price_at_purchase: row.price_at_purchase,
                });
            }
        }

        const order = {
            id: rows[0].id,
            user_id: rows[0].user_id,
            customer_name: rows[0].customer_name,
            customer_email: rows[0].customer_email,
            total_amount: rows[0].total_amount,
            status: rows[0].status,
            created_at: rows[0].created_at,
            items,
        };
        res.status(200).json(order);
    } catch (error) {
        console.error("Failed to fetch order:", error);
        res.status(500).json({ message: "Failed to fetch order" });
    }
}

// Restores item stock inside the cancellation transaction.
async function cancelOrder(req, res) {
    const orderId = readOrderId(req, res);
    if (orderId === null) return;

    let connection;
    let transactionStarted = false;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        transactionStarted = true;

        const [orders] = await connection.execute(
            "SELECT id, status FROM orders WHERE id = ? FOR UPDATE",
            [orderId]
        );
        if (orders.length === 0) {
            await connection.rollback();
            transactionStarted = false;
            res.status(404).json({ message: "Order not found" });
            return;
        }
        if (orders[0].status === "cancelled") {
            await connection.rollback();
            transactionStarted = false;
            res.status(409).json({ message: "Order is already cancelled" });
            return;
        }

        await connection.execute(
            "UPDATE orders SET status = 'cancelled' WHERE id = ?",
            [orderId]
        );
        const [items] = await connection.execute(
            "SELECT product_id, SUM(quantity) AS quantity FROM order_items WHERE order_id = ? GROUP BY product_id",
            [orderId]
        );
        for (const item of items) {
            await connection.execute(
                "UPDATE products SET stock_quantity = stock_quantity + ? WHERE id = ?",
                [item.quantity, item.product_id]
            );
        }

        await connection.commit();
        transactionStarted = false;
        res.status(200).json({ message: "Order cancelled successfully" });
    } catch (error) {
        if (connection && transactionStarted) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error("Failed to roll back order cancellation:", rollbackError);
            }
        }
        console.error("Failed to cancel order:", error);
        res.status(500).json({ message: "Failed to cancel order" });
    } finally {
        if (connection) connection.release();
    }
}

async function getSalesSummary(req, res) {
    try {
        const [totals] = await pool.execute(
            "SELECT COALESCE(SUM(total_amount), 0) AS total_revenue, COUNT(*) AS total_completed_orders FROM orders WHERE status = 'completed'"
        );
        const [topProducts] = await pool.execute(
            "SELECT p.id AS product_id, p.name AS product_name, SUM(oi.quantity) AS total_quantity_sold, SUM(oi.quantity * oi.price_at_purchase) AS total_revenue FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.id = oi.product_id WHERE o.status = 'completed' GROUP BY p.id, p.name ORDER BY total_quantity_sold DESC, p.id ASC LIMIT 5"
        );
        res.status(200).json({
            total_revenue: totals[0].total_revenue,
            total_completed_orders: totals[0].total_completed_orders,
            top_products: topProducts,
        });
    } catch (error) {
        console.error("Failed to fetch sales summary:", error);
        res.status(500).json({ message: "Failed to fetch sales summary" });
    }
}

// Checks stock and saves order items in one transaction.
async function createOrder(req, res) {
    let body = req.body;
    if (body === null || body === undefined) {
        body = {};
    }
    const items = body.items;
    let itemsAreValid = Array.isArray(items) && items.length > 0;
    if (itemsAreValid) {
        for (const item of items) {
            if (
                !item ||
                !Number.isSafeInteger(item.product_id) ||
                item.product_id < 1 ||
                !Number.isSafeInteger(item.quantity) ||
                item.quantity < 1
            ) {
                itemsAreValid = false;
                break;
            }
        }
    }
    if (!itemsAreValid) {
        res.status(400).json({
            message: "items must be a non-empty array of objects with positive integer product_id and quantity values",
        });
        return;
    }

    let connection;
    let transactionStarted = false;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        transactionStarted = true;

        const lockedItems = [];
        const reservedByProduct = new Map();
        let totalCents = 0;

        for (const item of items) {
            const [products] = await connection.execute(
                "SELECT id, name, sku, unit_price, stock_quantity FROM products WHERE id = ? FOR UPDATE",
                [item.product_id]
            );
            if (products.length === 0) {
                await connection.rollback();
                transactionStarted = false;
                res.status(400).json({
                    message: `Product ${item.product_id} does not exist; 0 units remain`,
                    product_id: item.product_id,
                    quantity: item.quantity,
                    units_remaining: 0,
                });
                return;
            }

            const product = products[0];
            const stockQuantity = Number(product.stock_quantity);
            const previouslyReserved = reservedByProduct.get(item.product_id) || 0;
            const unitsRemaining = stockQuantity - previouslyReserved;
            if (unitsRemaining < item.quantity) {
                await connection.rollback();
                transactionStarted = false;
                res.status(400).json({
                    message: `Insufficient stock for product ${item.product_id}; ${unitsRemaining} units remain`,
                    product_id: item.product_id,
                    quantity: item.quantity,
                    units_remaining: unitsRemaining,
                });
                return;
            }

            const unitPriceCents = priceToCents(product.unit_price);
            const lineTotalCents = unitPriceCents === null
                ? null
                : unitPriceCents * item.quantity;
            if (
                lineTotalCents === null ||
                !Number.isSafeInteger(lineTotalCents) ||
                !Number.isSafeInteger(totalCents + lineTotalCents)
            ) {
                throw new Error(`Invalid product price or order total for product ${item.product_id}`);
            }

            totalCents += lineTotalCents;
            reservedByProduct.set(
                item.product_id,
                previouslyReserved + item.quantity
            );
            lockedItems.push({
                product_id: item.product_id,
                name: product.name,
                sku: product.sku,
                quantity: item.quantity,
                unit_price: (unitPriceCents / 100).toFixed(2),
                line_total: (lineTotalCents / 100).toFixed(2),
            });
        }

        const totalAmount = (totalCents / 100).toFixed(2);
        const [orderResult] = await connection.execute(
            "INSERT INTO orders (user_id, total_amount) VALUES (?, ?)",
            [req.user.id, totalAmount]
        );
        const orderId = orderResult.insertId;

        for (const item of lockedItems) {
            await connection.execute(
                "INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase) VALUES (?, ?, ?, ?)",
                [orderId, item.product_id, item.quantity, item.unit_price]
            );
            await connection.execute(
                "UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ?",
                [item.quantity, item.product_id]
            );
        }

        await connection.commit();
        transactionStarted = false;
        res.status(201).json({
            order_id: orderId,
            user_id: req.user.id,
            total_amount: totalAmount,
            items: lockedItems,
        });
    } catch (error) {
        if (connection && transactionStarted) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error("Failed to roll back order creation:", rollbackError);
            }
        }
        console.error("Failed to create order:", error);
        res.status(500).json({ message: "Failed to create order" });
    } finally {
        if (connection) connection.release();
    }
}

module.exports = {
    createOrder,
    getOrders,
    getOrder,
    cancelOrder,
    getSalesSummary,
};
