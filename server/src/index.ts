import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { createApp } from "./app.ts";

const config = loadConfig();
const db = openDb(config.dbPath);
const server = createApp(db, config);

server.listen(config.port, config.host, () => {
  console.log(`BizOS listening on http://${config.host}:${config.port}`);
  console.log(`database: ${config.dbPath}`);
  if (!config.anthropicApiKey) {
    // Start anyway: the inbox, cases and audit work without a model. The
    // quickstart is still "npm start", and this line says what is missing.
    console.warn("ANTHROPIC_API_KEY is not set - copy .env.example to .env and add your key");
  }
});

// Close the database on Ctrl+C so the WAL is checkpointed into the main file
// rather than left beside it.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close();
    db.close();
    process.exit(0);
  });
}
