import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOrCreateToken } from '../lib/auth.mjs';
import { dataDir, ensureDataDir } from '../lib/store.mjs';

// Paths, environment settings and the access token, shared by every module.

export const PORT = Number(process.env.PORT) || 7777;
export const HOST = '127.0.0.1';
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
export const SESS_DIR = path.join(CLAUDE_DIR, 'sessions');
export const PROJ_DIR = path.join(CLAUDE_DIR, 'projects');
// Everything this tool writes lives here.
export const DATA_DIR = ensureDataDir(dataDir());
export const USAGE_TASK_ID = 'cc-mission-control-usage';
export const APP_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'Claude');
export const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
export const RECENT_HOURS = Number(process.env.RECENT_HOURS) || 0;
export const TAIL_BYTES = 768 * 1024;
// Kept across restarts (owner-only file), so a signed-in browser stays signed in.
export const TOKEN = loadOrCreateToken(DATA_DIR);
// The repository root (this file is in src/).
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The only image types the console serves; anything else could be rendered as a page on this origin.
export const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
