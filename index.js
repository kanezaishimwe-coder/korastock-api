const express = require('express');
const routes = require('./Routes/userroutes.js');
const productRoutes = require('./Routes/productRoutes.js');
const orderRoutes = require('./Routes/orderRoutes.js');
const { verifyDatabaseConnection } = require('./db/db.js');
const app = express();
const port = 7000;

app.use(express.json());
app.use(routes);
app.use("/api/products", productRoutes);
app.use("/api/orders", orderRoutes);

app.get("/", showWelcomeMessage);

// Sends the welcome message on the home page.
function showWelcomeMessage(req, res) {
    res.send("Welcome to my application");
}

// Checks the database before starting the web server.
async function startServer() {
    await verifyDatabaseConnection();
    return app.listen(port, () => {
        console.log(`Server running on http://localhost:${port}`);
    });
}

if (require.main === module) {
    startServer().catch((error) => {
        console.error("Failed to start server:", error);
        process.exitCode = 1;
    });
}
module.exports = app;