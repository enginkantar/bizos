import { readdirSync, readFileSync, statSync, writeFileSync, renameSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { parseRulesFile, withVersion, RulesError, type RulesFile } from "./rules.ts";

// Holds the active rules for every domain, read from <dir>/<domain>.rules.md.
//
// 🔴 THE LAST GOOD VERSION STAYS ACTIVE. An owner can break a file - in the
//    editor on stage, or in their own text editor - and the business must keep
//    answering under the rules it had. A file that fails to parse is reported
//    beside the active version, never swapped in, and never swapped in empty.
//
// Files edited outside the API are picked up on the next read (mtime), so the
// gate and the agents always see the same version without a restart - the
// DAY_PLAN acceptance "rule edit v3->v4 changes model AND gate without restart".

export interface DomainState {
  active?: RulesFile;
  // Set while the file on disk is broken; cleared when it parses again.
  error?: { errors: string[]; at: string };
  mtimeMs: number;
}

const SUFFIX = ".rules.md";

export class RuleStore {
  private dir: string;
  private domains = new Map<string, DomainState>();

  constructor(dir: string) {
    this.dir = dir;
    this.refresh();
  }

  get directory() { return this.dir; }

  private fileFor(domain: string) { return join(this.dir, domain + SUFFIX); }

  // Re-reads any file whose mtime changed. Cheap: one stat per file.
  refresh(): void {
    if (!existsSync(this.dir)) return;
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(SUFFIX)) continue;
      const domain = name.slice(0, -SUFFIX.length);
      const path = join(this.dir, name);
      const mtimeMs = statSync(path).mtimeMs;
      const prev = this.domains.get(domain);
      if (prev && prev.mtimeMs === mtimeMs) continue;
      const state: DomainState = { active: prev?.active, mtimeMs };
      try {
        state.active = parseRulesFile(readFileSync(path, "utf8"), domain);
        state.error = undefined;
      } catch (e) {
        const errors = e instanceof RulesError ? e.errors : [(e as Error).message];
        state.error = { errors, at: new Date().toISOString() };
      }
      this.domains.set(domain, state);
    }
  }

  list(): { domain: string; state: DomainState }[] {
    this.refresh();
    return [...this.domains.entries()]
      .map(([domain, state]) => ({ domain, state }))
      .sort((a, b) => a.domain.localeCompare(b.domain));
  }

  get(domain: string): DomainState | undefined {
    this.refresh();
    return this.domains.get(domain);
  }

  active(domain: string): RulesFile | undefined {
    return this.get(domain)?.active;
  }

  // Validates `raw`, bumps the version past the active one, and writes it
  // atomically (temp file, then rename) so a crash mid-save can never leave a
  // half-written policy on disk. `expectedVersion` is the version the editor
  // loaded: if someone else saved in between, this refuses rather than
  // silently overwriting their change.
  save(domain: string, raw: string, expectedVersion: number | undefined): { file: RulesFile; previous?: RulesFile } {
    if (!/^[a-z][a-z0-9-]*$/.test(domain)) throw new RulesError([`not a domain name: ${domain}`]);
    const current = this.get(domain);
    const previous = current?.active;
    const currentVersion = previous?.version ?? 0;
    if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
      throw new ConflictError(currentVersion);
    }
    // Parse what the owner wrote first, so their mistakes are reported against
    // their own text - then stamp the next version on it.
    parseRulesFile(raw, domain);
    const next = withVersion(raw, currentVersion + 1);
    const file = parseRulesFile(next, domain);

    const path = this.fileFor(domain);
    const tmp = path + ".tmp";
    writeFileSync(tmp, next, "utf8");
    renameSync(tmp, path);
    this.domains.set(domain, { active: file, mtimeMs: statSync(path).mtimeMs });
    return { file, previous };
  }
}

// First start of a fresh clone: copy a starter pack from templates/ into the
// business's own rules folder. Only when that folder does not exist at all -
// an owner who emptied it on purpose, or edited it, is never overwritten.
// business/ is gitignored: it is the business's data, like .env, and the
// owner's edits during the demo must not show up as repo changes.
export function seedFromTemplate(rulesDir: string, template: string, templatesRoot = "templates"): string[] {
  if (!template || existsSync(rulesDir)) return [];
  const from = join(templatesRoot, template);
  if (!existsSync(from)) return [];
  mkdirSync(rulesDir, { recursive: true });
  const copied = readdirSync(from).filter((n) => n.endsWith(SUFFIX));
  for (const name of copied) copyFileSync(join(from, name), join(rulesDir, name));
  return copied;
}

export class ConflictError extends Error {
  currentVersion: number;
  constructor(currentVersion: number) {
    super("version_conflict");
    this.currentVersion = currentVersion;
  }
}
