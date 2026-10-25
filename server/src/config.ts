// Everything the server reads from the environment, in one place. `npm start`
// loads .env if it exists (node --env-file-if-exists), so a fresh clone with no
// .env still starts - it just cannot call the model yet, and says so.

export interface Config {
  host: string;
  port: number;
  dbPath: string;
  rulesDir: string;
  anthropicApiKey: string | undefined;
  routerModel: string;
  agentModel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    // 🔴 127.0.0.1, not 0.0.0.0. The MVP has no sign-in for rule edits, so a
    //    server listening on every interface lets anyone on the event Wi-Fi
    //    rewrite the refund cap. claims.ini checks this default.
    host: env.HOST || "127.0.0.1",
    port: Number(env.PORT) || 3000,
    // *.db and its -wal/-shm files are gitignored, and claims.ini fails any
    // that get tracked: this file holds every customer message typed into
    // the demo.
    dbPath: env.DB_PATH || "data/bizos.db",
    // The business's own rules: one <domain>.rules.md per department, copied
    // from a starter pack in templates/ (templates/README.md).
    rulesDir: env.RULES_DIR || "business",
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    routerModel: env.ROUTER_MODEL || "claude-haiku-5-5",
    agentModel: env.AGENT_MODEL || "claude-sonnet-5-5",
  };
}
