# KoraStock

KoraStock is a REST API for inventory and order management. It provides
JWT-authenticated user access, product catalog and stock controls, transactional
checkout and cancellation, and sales reporting.

## Features

- JWT bearer authentication with active-account checks.
- Role-aware access for `admin`, `manager`, and `user` accounts.
- Product listing, category/low-stock filters, creation, stock updates, and
  guarded deletion.
- Transactional order checkout with row-level product locks, database-derived
  prices, and stock validation.
- Customer-scoped order history and itemized receipts.
- Transactional order cancellation with inventory restoration.
- Completed-sales totals and best-selling product reporting.

## Technology

- Node.js (CommonJS)
- Express 5
- MySQL with `mysql2/promise`
- JWT (`jsonwebtoken`) and bcrypt password hashing
- Node's built-in `node:test` test runner and `node:assert`

## Database schema

```text
users
  Id (primary key), name, username (unique), email, password,
  role, department, is_active
        │ 1
        │
        └──────────< orders
                       id (primary key), user_id (foreign key),
                       total_amount, status, created_at
                              │ 1
                              │
                              └──────────< order_items >────────── products
                                             order_id (FK)           id (PK)
                                             product_id (FK)         name, sku (unique)
                                             quantity                category
                                             price_at_purchase       unit_price
                                                                     stock_quantity
                                                                     low_stock_limit
```

`db/001_authentication.sql` alters an existing `users` table. The application
expects that table to already contain `Id` (or MySQL-equivalent `id`),
`name`, `username`, `email`, and `password` columns. The script adds role,
department, active status, and a unique username key. Resolve duplicate
usernames before applying it.

`sql/002_inventory_orders.sql` creates `products`, `orders`, and `order_items`,
including their foreign keys, and inserts sample products. It can be rerun;
the sample products are upserted by SKU.

## Local setup

Requirements: a supported Node.js release, npm, and MySQL with an existing
application `users` table.

1. Install the project dependencies:

   ```sh
   npm install
   ```

2. Create a MySQL database and make sure its existing `users` table contains
   the columns listed above.

3. Copy `.env.example` to `.env` and set your database credentials and a
   long, random JWT secret:

   ```dotenv
   DB_HOST=localhost
   DB_USER=root
   DB_PASSWORD=your-database-password
   DB_NAME=korastock

   JWT_SECRET=replace-with-a-long-random-secret
   JWT_EXPIRES_IN=1h
   ```

   `JWT_EXPIRES_IN` is optional and defaults to `1h`. Use a duration accepted
   by `jsonwebtoken`, such as `30m`. The server listens on port `7000`.
   `ADMIN_ALLOWED_IPS` is an optional comma-separated IP allowlist used only
   by the demonstration `/admin/tools` endpoint.

4. Apply the SQL scripts in order:

   ```sh
   mysql -u root -p korastock < db/001_authentication.sql
   mysql -u root -p korastock < sql/002_inventory_orders.sql
   ```

5. Start the server:

   ```sh
   node index.js
   ```

   The server verifies its database connection before listening at
   `http://localhost:7000`.

6. Run the tests:

   ```sh
   npm test
   ```

   The HTTP integration tests exercise the real Express routes and middleware
   with an in-memory MySQL-pool test double; they do not require a running
   MySQL service.

## Authentication

Register with `POST /register` (or its alias `POST /user`) and log in with
`POST /login`. Include the returned token on protected endpoints:

```http
Authorization: Bearer <token>
```

Public registration may create `user` accounts. Assigning `admin` or `manager`
requires an existing admin token. Responses generally use `401` for missing
authentication, `403` for invalid tokens or disallowed roles, `400` for invalid
input, and `404` for missing records.

## API reference

All request and response examples use JSON. The root endpoint `GET /` is public
and returns a welcome string.

### User and demonstration endpoints

| Method and path | Permission | Request | Successful response |
|---|---|---|---|
| `POST /register` | Public for `user`; admin token for `admin`/`manager` registration | `{"username":"maya","password":"secret","role":"user","department":"Sales"}` | `201 {"message":"User registered successfully","userID":12}` |
| `POST /user` | Same as `/register` | Same registration body | Same as `/register` |
| `POST /login` | Public | `{"username":"maya","password":"secret"}` | `200 {"token":"<signed-jwt>"}` |
| `GET /user` | `admin` | None | `200 [{"userID":12,"name":null,"username":"maya","email":null,"role":"user","department":"Sales"}]` |
| `GET /user/:id` | Account owner or `admin` | None | `200 {"userID":12,"name":null,"username":"maya","email":null,"role":"user","department":"Sales"}` |
| `PUT /user/:id` | `admin` | `{"name":"Maya Lee","username":"maya","email":"maya@example.com","password":"new-secret"}` | `200 {"message":"User updated successfully"}` |
| `DELETE /user/:id` | `admin` | None | `200 {"message":"User deleted successfully"}` |
| `GET /departments/:department/resources` | Authenticated account in the matching department | None | `200 {"message":"Sales resources"}` |
| `GET /manager/reports` | `admin`, `manager` | None | `200 {"message":"Manager reports"}` |
| `GET /admin/tools` | `admin`, IT department, local server time 09:00–16:59, allowed IP | None | `200 {"message":"Admin tools"}` |

The `/admin/tools` IP check uses the direct peer address; proxy headers are not
trusted by default.

### Product endpoints

| Method and path | Permission | Request | Successful response |
|---|---|---|---|
| `GET /api/products` | Any authenticated role | Optional `?category=Equipment&lowStock=true` | `200 [{"id":1,"name":"Barcode Scanner","sku":"KST-EQP-001","category":"Equipment","unit_price":"89.99","stock_quantity":4,"low_stock_limit":5}]` |
| `GET /api/products/:id` | Any authenticated role | None | `200 {"id":1,"name":"Barcode Scanner","sku":"KST-EQP-001","category":"Equipment","unit_price":"89.99","stock_quantity":4,"low_stock_limit":5}` |
| `POST /api/products` | `admin`, `manager` | `{"name":"Label Printer","sku":"KST-PRN-010","category":"Equipment","unit_price":129.5,"stock_quantity":12,"low_stock_limit":3}` | `201 {"message":"Product created successfully","productID":6}` |
| `PATCH /api/products/:id/stock` | `admin`, `manager` | `{"stock_quantity":20,"unit_price":129.5,"low_stock_limit":4}` | `200 {"message":"Product updated successfully"}` |
| `DELETE /api/products/:id` | `admin` | None | `200 {"message":"Product deleted successfully"}` |

`lowStock=true` filters to products where `stock_quantity <= low_stock_limit`.
The stock PATCH sets `stock_quantity` to the provided non-negative integer; it
does not apply a relative increment. A product referenced by any `order_items`
cannot be deleted (`409`). Duplicate SKUs also return `409`.

### Order endpoints

| Method and path | Permission | Request | Successful response |
|---|---|---|---|
| `POST /api/orders` | Any authenticated role | `{"items":[{"product_id":1,"quantity":2}]}` | `201 {"order_id":24,"user_id":12,"total_amount":"179.98","items":[{"product_id":1,"name":"Barcode Scanner","sku":"KST-EQP-001","quantity":2,"unit_price":"89.99","line_total":"179.98"}]}` |
| `GET /api/orders` | Any authenticated role; users see their orders only, admins/managers see all | None | `200 [{"id":24,"user_id":12,"customer_name":"Maya Lee","customer_email":"maya@example.com","total_amount":"179.98","status":"pending","created_at":"2026-01-01T10:00:00.000Z"}]` |
| `GET /api/orders/:id` | Any authenticated role; users can see only their own | None | `200 {"id":24,"user_id":12,"customer_name":"Maya Lee","customer_email":"maya@example.com","total_amount":"179.98","status":"pending","items":[{"product_id":1,"product_name":"Barcode Scanner","quantity":2,"price_at_purchase":"89.99"}]}` |
| `PATCH /api/orders/:id/cancel` | `admin`, `manager` | None | `200 {"message":"Order cancelled successfully"}` |
| `GET /api/orders/summary/sales` | `admin`, `manager` | None | `200 {"total_revenue":"179.98","total_completed_orders":1,"top_products":[{"product_id":1,"product_name":"Barcode Scanner","total_quantity_sold":"2","total_revenue":"179.98"}]}` |

Checkout uses current database product prices, locks product rows, and changes
stock only when the complete order commits. Insufficient stock or a missing
product returns `400` with `product_id`, requested `quantity`, and
`units_remaining`; the transaction is rolled back. Cancellation restores stock
and a duplicate cancellation returns `409`. Sales totals and top products are
based on completed orders.
