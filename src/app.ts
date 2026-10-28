import express from "express";
import accountsRouter from "./routes/accounts.routes.js";
import transfersRouter from "./routes/transfers.routes.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";

export const app = express();

app.use(express.json());
app.use("/api/accounts", accountsRouter);
app.use("/api/transfers", transfersRouter);
app.use(notFoundHandler);
app.use(errorHandler);
