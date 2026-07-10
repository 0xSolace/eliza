/**
 * Shared repository paths for app-side issue evidence harnesses.
 *
 * Device and desktop capture scripts need stable paths while running from
 * different working directories. Evidence is scratch output, so it defaults to
 * the operating-system temp directory and may be redirected explicitly with
 * `ELIZA_ISSUE_EVIDENCE_DIR`.
 */

import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(THIS_DIR, "../../../..");
const configuredEvidenceDir = process.env.ELIZA_ISSUE_EVIDENCE_DIR?.trim();
export const ISSUE_EVIDENCE_DIR = configuredEvidenceDir
  ? path.resolve(configuredEvidenceDir)
  : path.join(os.tmpdir(), "eliza-issue-evidence");

mkdirSync(ISSUE_EVIDENCE_DIR, { recursive: true });
