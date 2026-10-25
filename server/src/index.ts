import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { createApp } from "./app.ts";
import { RuleStore } from "./rulestore.ts";

const config = loadConfig();
const db = openDb(config.dbPath);
const store = new RuleStore(config.rulesDir);
const server = createApp(db, config, store);

// Say at startup what the gate will enforce - and what it cannot load - so a
// broken or missing rules file is visible before the first message, not after.
const loaded = store.list();
if (loaded.length === 0) {
  console.warn(`no rules in ${config.rulesDir}/ - copy a starter pack from templates/ (see templates/README.md)`);
}
for (const { domain, state } of loaded) {
  if (state.active) {
    console.log(`rules: ${domain} v${state.active.version}, ${state.active.thresholds.length} limit(s)`);
    for (const w of state.active.warnings) console.warn(`  warning: ${w}`);
  }
  if (state.error) console.error(`rules: ${domain} FAILED to load: ${state.error.errors.join("; ")}`);
}

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
