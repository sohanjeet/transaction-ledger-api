import "dotenv/config";
import { app } from "./app.js";
import { disconnectPrisma } from "./lib/prisma.js";

const port = Number(process.env.PORT ?? 3000);
const server = app.listen(port, () => {
  console.log(`Transaction Ledger API listening on port ${port}`);
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received; shutting down`);
  server.close(async (error) => {
    try {
      await disconnectPrisma();
      if (error) {
        console.error("HTTP server close failed", error);
        process.exitCode = 1;
      }
    } catch (disconnectError) {
      console.error("Database disconnect failed", disconnectError);
      process.exitCode = 1;
    }
  });
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
