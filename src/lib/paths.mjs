import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SAMPLE_FIXTURES = path.join(ROOT, "sample");
export const BRIEFS = path.join(ROOT, "briefs");
export const DATA = path.join(ROOT, "data");
export const DEMO = path.join(ROOT, ".demo");
// IMPACT_REPO points the review pipeline at another local git repo (scripts/review-change.mjs sets it).
export const SAMPLE_REPO = process.env.IMPACT_REPO ? path.resolve(process.env.IMPACT_REPO) : path.join(DEMO, "shop-sample");
// IMPACT_LIVE_DIR keeps the artifacts of a live review (test runs, AI reviews) out of the tracked data/ folder.
export const LIVE_DIR = process.env.IMPACT_LIVE_DIR ? path.resolve(process.env.IMPACT_LIVE_DIR) : null;
export const SNAPSHOTS = path.join(DEMO, "snapshots");
export const DECISIONS_FILE = path.join(DEMO, "decisions.json");
export const REVISIONS_FILE = path.join(DATA, "revisions.json");
