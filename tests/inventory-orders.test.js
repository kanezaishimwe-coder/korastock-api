const assert = require("node:assert/strict");
const http = require("node:http");
const { after, before, test } = require("node:test");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = process.env.JWT_SECRET || "kora-stock-integration-test-secret";

const app = require("../index.js");
const { pool } = require("../db/db.js");

const state = {
    products: new Map(),
    orders: new Map(),
    orderItems: [],
    nextProductId: 1,
    nextOrderId: 1,
};

const originalExecute = pool.execute;
const originalGetConnection = pool.getConnection;
let server;
let baseUrl;
let createdProductId;
let createdOrderId;

function cloneState() {
    return {
        products: new Map(
            [...state.products].map(([id, product]) => [id, { ...product }])
        ),
        orders: new Map(
            [...state.orders].map(([id, order]) => [id, { ...order }])
        ),
        orderItems: state.orderItems.map((item) => ({ ...item })),
        nextProductId: state.nextProductId,
        nextOrderId: state.nextOrderId,
    };
}

function restoreState(snapshot) {
    state.products = snapshot.products;
    state.orders = snapshot.orders;
    state.orderItems = snapshot.orderItems;
    state.nextProductId = snapshot.nextProductId;
    state.nextOrderId = snapshot.nextOrderId;
}

function productRows(products) {
    return products.map((product) => ({ ...product }));
}

function getProductRows(sql, values) {
    if (sql.includes("WHERE id = ?")) {
        const product = state.products.get(Number(values[0]));
        return product ? [product] : [];
    }

    let products = [...state.products.values()];
    if (sql.includes("category = ?")) {
        products = products.filter((product) => product.category === values[0]);
    }
    if (sql.includes("stock_quantity <= low_stock_limit")) {
        products = products.filter(
            (product) => product.stock_quantity <= product.low_stock_limit
        );
    }
    return products;
}

pool.execute = async (sql, values = []) => {
    if (sql.startsWith("SELECT is_active FROM users")) {
        return [[{ is_active: true }], []];
    }

    if (sql.startsWith("INSERT INTO products")) {
        const [name, sku, category, unitPrice, stockQuantity, lowStockLimit] = values;
        const id = state.nextProductId++;
        state.products.set(id, {
            id,
            name,
            sku,
            category,
            unit_price: Number(unitPrice).toFixed(2),
            stock_quantity: stockQuantity,
            low_stock_limit: lowStockLimit,
        });
        return [{ insertId: id, affectedRows: 1 }, []];
    }

    if (sql.startsWith("SELECT") && sql.includes("FROM products")) {
        return [productRows(getProductRows(sql, values)), []];
    }

    throw new Error(`Unexpected pool query in integration test: ${sql}`);
};

pool.getConnection = async () => {
    let snapshot;
    return {
        beginTransaction: async () => {
            snapshot = cloneState();
        },
        execute: async (sql, values = []) => {
            if (sql.includes("FROM products") && sql.includes("FOR UPDATE")) {
                const product = state.products.get(Number(values[0]));
                return [product ? [{ ...product }] : [], []];
            }

            if (sql.startsWith("INSERT INTO orders")) {
                const id = state.nextOrderId++;
                state.orders.set(id, {
                    id,
                    user_id: values[0],
                    total_amount: String(values[1]),
                    status: "pending",
                });
                return [{ insertId: id, affectedRows: 1 }, []];
            }

            if (sql.startsWith("INSERT INTO order_items")) {
                state.orderItems.push({
                    order_id: Number(values[0]),
                    product_id: Number(values[1]),
                    quantity: Number(values[2]),
                    price_at_purchase: String(values[3]),
                });
                return [{ insertId: state.orderItems.length, affectedRows: 1 }, []];
            }

            if (sql.startsWith("UPDATE products SET stock_quantity = stock_quantity -")) {
                const product = state.products.get(Number(values[1]));
                product.stock_quantity -= Number(values[0]);
                return [{ affectedRows: 1 }, []];
            }

            if (sql.startsWith("SELECT id, status FROM orders")) {
                const order = state.orders.get(Number(values[0]));
                return [order ? [{ id: order.id, status: order.status }] : [], []];
            }

            if (sql.startsWith("UPDATE orders SET status = 'cancelled'")) {
                state.orders.get(Number(values[0])).status = "cancelled";
                return [{ affectedRows: 1 }, []];
            }

            if (sql.startsWith("SELECT product_id, SUM(quantity)")) {
                const quantities = new Map();
                for (const item of state.orderItems) {
                    if (item.order_id === Number(values[0])) {
                        quantities.set(
                            item.product_id,
                            (quantities.get(item.product_id) || 0) + item.quantity
                        );
                    }
                }
                return [[...quantities].map(([product_id, quantity]) => ({
                    product_id,
                    quantity,
                })), []];
            }

            if (sql.startsWith("UPDATE products SET stock_quantity = stock_quantity +")) {
                const product = state.products.get(Number(values[1]));
                product.stock_quantity += Number(values[0]);
                return [{ affectedRows: 1 }, []];
            }

            throw new Error(`Unexpected connection query in integration test: ${sql}`);
        },
        commit: async () => {
            snapshot = undefined;
        },
        rollback: async () => {
            if (snapshot) restoreState(snapshot);
            snapshot = undefined;
        },
        release: () => {},
    };
};

function tokenFor(role, id = 42) {
    return jwt.sign(
        { id, role, department: "General" },
        process.env.JWT_SECRET,
        { expiresIn: "5m" }
    );
}

function request(path, { method = "GET", token, body } = {}) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const headers = {};
        if (token) headers.Authorization = `Bearer ${token}`;
        if (payload !== undefined) headers["Content-Type"] = "application/json";

        const req = http.request(
            `${baseUrl}${path}`,
            { method, headers },
            (res) => {
                const chunks = [];
                res.on("data", (chunk) => chunks.push(chunk));
                res.on("end", () => {
                    const responseText = Buffer.concat(chunks).toString();
                    let responseBody;
                    try {
                        responseBody = responseText ? JSON.parse(responseText) : undefined;
                    } catch (error) {
                        reject(error);
                        return;
                    }
                    resolve({
                        status: res.statusCode,
                        body: responseBody,
                    });
                });
            }
        );
        req.on("error", reject);
        if (payload !== undefined) req.write(payload);
        req.end();
    });
}

before(async () => {
    server = app.listen(0);
    await new Promise((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
    });
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
    pool.execute = originalExecute;
    pool.getConnection = originalGetConnection;
    if (server) {
        await new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        });
    }
});

test("KoraStock product and order HTTP integration", async (t) => {
    await t.test("rejects unauthenticated and insufficiently privileged requests", async () => {
        const productList = await request("/api/products");
        assert.equal(productList.status, 401);

        const stockUpdate = await request("/api/products/1/stock", {
            method: "PATCH",
        });
        assert.equal(stockUpdate.status, 401);

        const productDelete = await request("/api/products/1", {
            method: "DELETE",
        });
        assert.equal(productDelete.status, 401);

        const orderList = await request("/api/orders");
        assert.equal(orderList.status, 401);

        const orderCheckout = await request("/api/orders", {
            method: "POST",
            body: { items: [{ product_id: 1, quantity: 1 }] },
        });
        assert.equal(orderCheckout.status, 401);

        const orderDetail = await request("/api/orders/1");
        assert.equal(orderDetail.status, 401);

        const createAsUser = await request("/api/products", {
            method: "POST",
            token: tokenFor("user"),
            body: {
                name: "Blocked product",
                sku: "BLOCKED-001",
                category: "Test",
                unit_price: 1,
                stock_quantity: 1,
            },
        });
        assert.equal(createAsUser.status, 403);

        const salesAsUser = await request("/api/orders/summary/sales", {
            token: tokenFor("user"),
        });
        assert.equal(salesAsUser.status, 403);

        const cancelAsUser = await request("/api/orders/1/cancel", {
            method: "PATCH",
            token: tokenFor("user"),
        });
        assert.equal(cancelAsUser.status, 403);

        const invalidToken = await request("/api/orders", {
            token: "invalid-token",
        });
        assert.equal(invalidToken.status, 403);
    });

    await t.test("allows an admin to create a product", async () => {
        const response = await request("/api/products", {
            method: "POST",
            token: tokenFor("admin"),
            body: {
                name: "Integration Test Widget",
                sku: "TEST-WIDGET-001",
                category: "Test",
                unit_price: 4.25,
                stock_quantity: 10,
                low_stock_limit: 2,
            },
        });
        assert.equal(response.status, 201);
        assert.equal(typeof response.body.productID, "number");
        createdProductId = response.body.productID;

        const product = await request(`/api/products/${createdProductId}`, {
            token: tokenFor("admin"),
        });
        assert.equal(product.status, 200);
        assert.equal(product.body.stock_quantity, 10);
    });

    await t.test("checks out an order and deducts exact stock", async () => {
        const response = await request("/api/orders", {
            method: "POST",
            token: tokenFor("user"),
            body: { items: [{ product_id: createdProductId, quantity: 3 }] },
        });
        assert.equal(response.status, 201);
        assert.equal(response.body.total_amount, "12.75");
        assert.equal(response.body.items[0].unit_price, "4.25");
        createdOrderId = response.body.order_id;

        const product = await request(`/api/products/${createdProductId}`, {
            token: tokenFor("user"),
        });
        assert.equal(product.status, 200);
        assert.equal(product.body.stock_quantity, 7);
    });

    await t.test("rolls back an order with insufficient stock", async () => {
        const response = await request("/api/orders", {
            method: "POST",
            token: tokenFor("user"),
            body: { items: [{ product_id: createdProductId, quantity: 8 }] },
        });
        assert.equal(response.status, 400);
        assert.equal(response.body.product_id, createdProductId);
        assert.equal(response.body.units_remaining, 7);

        const product = await request(`/api/products/${createdProductId}`, {
            token: tokenFor("user"),
        });
        assert.equal(product.body.stock_quantity, 7);
        assert.equal(state.orders.size, 1);
        assert.equal(state.orderItems.length, 1);
    });

    await t.test("restores stock on cancellation and rejects duplicate cancellation", async () => {
        const cancellation = await request(`/api/orders/${createdOrderId}/cancel`, {
            method: "PATCH",
            token: tokenFor("admin"),
        });
        assert.equal(cancellation.status, 200);

        let product = await request(`/api/products/${createdProductId}`, {
            token: tokenFor("admin"),
        });
        assert.equal(product.body.stock_quantity, 10);

        const duplicateCancellation = await request(
            `/api/orders/${createdOrderId}/cancel`,
            { method: "PATCH", token: tokenFor("manager") }
        );
        assert.equal(duplicateCancellation.status, 409);

        product = await request(`/api/products/${createdProductId}`, {
            token: tokenFor("admin"),
        });
        assert.equal(product.body.stock_quantity, 10);
    });
});
