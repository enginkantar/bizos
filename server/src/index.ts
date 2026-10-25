import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { createApp } from "./app.ts";
import { RuleStore, seedFromTemplate } from "./rulestore.ts";
import { startOutboxLoop } from "./outbox.ts";
import { anthropicJsonModel } from "./agents/llm.ts";

const config = loadConfig();
const db = openDb(config.dbPath);
const seeded = seedFromTemplate(config.rulesDir, config.starterTemplate);
if (seeded.length) {
  console.log(`first start: copied the ${config.starterTemplate} starter pack into ${config.rulesDir}/ (${seeded.join(", ")})`);
}
const store = new RuleStore(config.rulesDir);
// Haiku routes, Sonnet drafts (design v1.2). Without a key, or with
// AGENTS=off, the server runs exactly as before and drafts come only from
// POST /api/cases/:id/drafts.
const agents = config.anthropicApiKey && config.agentsEnabled
  ? { json: anthropicJsonModel(config.anthropicApiKey), routerModel: config.routerModel, agentModel: config.agentModel }
  : undefined;
const server = createApp(db, config, store, agents);

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

// The outbox is in SQLite, so anything queued before a restart is sent now,
// then every second. Approvals also dispatch immediately; this loop is what
// catches retries and work left over from a crash. It logs and retries on any
// error instead of crashing the server (issue #23).
const outbox = startOutboxLoop(db, store);

server.listen(config.port, config.host, () => {
  console.log(`BizOS listening on http://${config.host}:${config.port}`);
  console.log(`database: ${config.dbPath}`);
  if (!config.anthropicApiKey) {
    // Start anyway: the inbox, cases and audit work without a model. The
    // quickstart is still "npm start", and this line says what is missing.
    console.warn("ANTHROPIC_API_KEY is not set - copy .env.example to .env and add your key");
  }
  console.log(agents
    ? `agents: on (router ${config.routerModel}, drafter ${config.agentModel})`
    : `agents: off${config.anthropicApiKey ? " (AGENTS=off)" : ""} - drafts come only from POST /api/cases/:id/drafts`);
});

// Close the database on Ctrl+C so the WAL is checkpointed into the main file
// rather than left beside it.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    outbox.stop();
    server.close();
    db.close();
    process.exit(0);
  });
}
