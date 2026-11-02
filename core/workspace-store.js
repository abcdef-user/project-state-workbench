import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { ProjectStateStore, StateError } from "./store.js";

function requireWorkspaceRoot(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new StateError(
      "WORKSPACE_REQUIRED",
      "workspaceRoot is required when PROJECT_STATE_DB is not configured",
    );
  }
  return value.trim();
}

function canonicalWorkspaceRoot(workspaceRoot) {
  const absolute = resolve(requireWorkspaceRoot(workspaceRoot));
  try {
    return realpathSync.native(absolute);
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    throw new StateError("WORKSPACE_NOT_FOUND", `workspace does not exist: ${absolute}`);
  }
}

function workspaceSlug(rootPath) {
  const cleaned = basename(rootPath)
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/[. ]+$/g, "")
    .slice(0, 48);
  return cleaned || "workspace";
}

// A moved leaf cannot be realpathed, but its surviving ancestors still can.
// This preserves Windows short-name and junction aliases during recovery.
function recoveryIdentity(value) {
  let ancestor = resolve(value);
  const missing = [];
  while (true) {
    try { ancestor = realpathSync.native(ancestor); break; }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      missing.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
  const canonical = join(ancestor, ...missing);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

export function describeWorkspace(workspaceRoot, dataRoot) {
  const rootPath = canonicalWorkspaceRoot(workspaceRoot);
  const identity = process.platform === "win32"
    ? rootPath.replaceAll("\\", "/").toLowerCase()
    : rootPath;
  const hash = createHash("sha256").update(identity).digest("hex").slice(0, 12);
  const name = basename(rootPath);
  const workspaceId = `${workspaceSlug(rootPath)}-${hash}`;
  const stateDirectory = join(resolve(dataRoot), workspaceId);
  return {
    workspaceId,
    name,
    rootPath,
    stateDirectory,
    databasePath: join(stateDirectory, "state.db"),
  };
}

function ensureWorkspaceMetadata(workspace) {
  mkdirSync(workspace.stateDirectory, { recursive: true });
  const metadataPath = join(workspace.stateDirectory, "workspace.json");
  try {
    writeFileSync(metadataPath, `${JSON.stringify({
      workspaceId: workspace.workspaceId,
      name: workspace.name,
      rootPath: workspace.rootPath,
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
}

export class WorkspaceStoreRouter {
  constructor({ dbPath = null, dataRoot = null, defaultWorkspaceRoot = null } = {}) {
    this.dbPath = dbPath;
    this.dataRoot = resolve(dataRoot ?? join(process.cwd(), "data", "workspaces"));
    this.defaultWorkspaceRoot = defaultWorkspaceRoot;
    this.stores = new Map();
    this.directStore = dbPath ? new ProjectStateStore(dbPath) : null;
  }

  open(workspaceRoot = null) {
    if (this.directStore) {
      return { store: this.directStore, workspace: null };
    }

    const root = workspaceRoot ?? this.defaultWorkspaceRoot;
    let workspace;
    try {
      workspace = describeWorkspace(root, this.dataRoot);
    } catch (error) {
      if (error.code !== 'WORKSPACE_NOT_FOUND') throw error;
      const requestedIdentity = recoveryIdentity(root);
      const matches = [];
      for (const entry of existsSync(this.dataRoot) ? readdirSync(this.dataRoot, { withFileTypes: true }) : []) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const stateDirectory = join(this.dataRoot, entry.name);
        let metadata;
        try { metadata = JSON.parse(readFileSync(join(stateDirectory, 'workspace.json'), 'utf8')); }
        catch { continue; }
        if (typeof metadata.rootPath !== 'string' || recoveryIdentity(metadata.rootPath) !== requestedIdentity) continue;
        const databasePath = join(stateDirectory, 'state.db');
        if (!existsSync(databasePath)) continue;
        matches.push({ workspaceId: entry.name, name: basename(metadata.rootPath), rootPath: metadata.rootPath,
          stateDirectory, databasePath, recovered: true });
      }
      if (matches.length !== 1) throw error;
      workspace = matches[0];
    }
    ensureWorkspaceMetadata(workspace);
    let store = this.stores.get(workspace.workspaceId);
    if (!store) {
      store = new ProjectStateStore(workspace.databasePath);
      this.stores.set(workspace.workspaceId, store);
    }
    return { store, workspace };
  }

  close() {
    this.directStore?.close();
    for (const store of this.stores.values()) store.close();
    this.stores.clear();
  }
}
