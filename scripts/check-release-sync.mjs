#!/usr/bin/env node
/**
 * release-sync check (issue #31).
 *
 * Confirms every FIRST-PARTY public surface we publish to is tracking the
 * current release — i.e. matches `package.json#version` (the source of truth the
 * release pipeline fans out from). A silent drift here means a release half-
 * landed (e.g. npm published but the registry publish failed), which is exactly
 * the failure mode that makes a directory mark us "unmaintained".
 *
 * First-party surfaces (we publish; gated → a mismatch FAILS the check):
 *   - npm                     registry.npmjs.org  → dist-tags.latest
 *   - Official MCP Registry   registry.modelcontextprotocol.io → latest version
 *                             (+ the hosted `remotes` endpoint must be present)
 *   - GitHub release          api.github.com → releases/latest tag
 *
 * Downstream surfaces (PulseMCP / Glama / VS Code gallery) AUTO-INGEST from the
 * registry on their own schedule, so they're reported FOR INFO ONLY — never gated
 * (a lag there is expected, not a drift we caused).
 *
 * Usage: `node scripts/check-release-sync.mjs` (no deps; needs Node 18+ fetch).
 *
 * Exit 0 = every first-party surface answered AND matched.
 * Exit 1 = at least one surface DRIFTED (it answered, with the wrong version) or
 *          COULD NOT BE CHECKED (it did not answer at all).
 *
 * Those two outcomes are counted and reported separately, and they must stay
 * separate. A timeout against npm is not evidence that a release half-landed;
 * it is evidence that nothing is known about npm this run. Folding it into
 * "drift" produced an alarm claiming a partial release on the strength of a
 * network blip, and sent a responder into release recovery for it. Both are
 * still red, because a surface nobody could read is a surface nobody verified,
 * and a green run that verified nothing is the malfunction this check exists to
 * prevent. What changed is what the red run CLAIMS.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PKG = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
);
const EXPECTED = PKG.version;
const NPM_NAME = "@mnemoverse/mcp-memory-server";
const REGISTRY_NAME = "io.github.mnemoverse/mcp-memory-server";
const GH_REPO = "mnemoverse/mcp-memory-server";

const TIMEOUT_MS = 20_000;

async function getJson(url, headers = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "user-agent": "mnemoverse-release-sync-check", ...headers },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

const norm = (v) => (v ?? "").toString().replace(/^v/, "").trim();

async function checkNpm() {
  const j = await getJson(`https://registry.npmjs.org/${NPM_NAME}/latest`);
  return { version: norm(j.version) };
}

async function checkRegistry() {
  // limit=100 keeps every version snapshot of our (single) server on one page —
  // we have <20 versions, so this sidesteps cursor pagination for any realistic
  // count without a follow-the-cursor loop.
  const j = await getJson(
    "https://registry.modelcontextprotocol.io/v0/servers?search=mnemoverse&limit=100",
  );
  // The API returns every version snapshot as a separate entry; each carries a
  // server doc + a _meta with the registry's isLatest flag.
  const isLatest = (entry) =>
    entry?._meta?.["io.modelcontextprotocol.registry/official"]?.isLatest ??
    entry?._meta?.isLatest ??
    false;
  const mine = (j.servers ?? j).filter((e) => (e.server ?? e).name === REGISTRY_NAME);
  if (mine.length === 0) throw new Error(`server ${REGISTRY_NAME} not found in registry`);
  const chosen =
    mine.find(isLatest) ??
    [...mine].sort((a, b) =>
      norm((b.server ?? b).version).localeCompare(norm((a.server ?? a).version), undefined, {
        numeric: true,
      }),
    )[0];
  const srv = chosen.server ?? chosen;
  const hasRemote = Array.isArray(srv.remotes) && srv.remotes.length > 0;
  return { version: norm(srv.version), extra: hasRemote ? "remote ✓" : "remote MISSING" };
}

async function checkGithubRelease() {
  const headers = process.env.GITHUB_TOKEN
    ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
    : {};
  const j = await getJson(`https://api.github.com/repos/${GH_REPO}/releases/latest`, headers);
  return { version: norm(j.tag_name) };
}

function line(name, status, version, extra = "") {
  const v = version ? `v${version}`.padEnd(10) : "—".padEnd(10);
  return `  ${name.padEnd(24)} ${v} ${status}${extra ? `  (${extra})` : ""}`;
}

async function main() {
  console.log(`release-sync check — expected v${EXPECTED} (package.json)\n`);
  const firstParty = [
    ["npm", checkNpm],
    ["Official MCP Registry", checkRegistry],
    ["GitHub release", checkGithubRelease],
  ];

  // Two distinct outcomes, never merged into one boolean. See the header.
  const drifted = [];
  const unchecked = [];
  for (const [name, fn] of firstParty) {
    try {
      const { version, extra } = await fn();
      const ok = version === EXPECTED && extra !== "remote MISSING";
      if (!ok) drifted.push(name);
      const status = version === EXPECTED ? (extra === "remote MISSING" ? "✗ remote missing" : "✓") : `✗ DRIFT (have v${version || "?"})`;
      console.log(line(name, status, version, extra && extra !== "remote MISSING" ? extra : ""));
    } catch (err) {
      // NOT drift. A timeout, a 5xx or a rate limit means this surface did not
      // answer, so the version it serves is UNKNOWN. Recording that as drift
      // asserted a half-landed release the run had no evidence for.
      unchecked.push(name);
      console.log(line(name, `? could not be checked: ${err.message}`, null));
    }
  }

  console.log(
    "\n  (note) downstream surfaces — PulseMCP / Glama / VS Code gallery — auto-ingest from the registry on their own schedule; not gated here.",
  );

  if (drifted.length > 0) {
    console.error(`\nDRIFT: ${drifted.join(", ")} answered, but not with v${EXPECTED} (or the registry entry has no remote). A release half-landed. Investigate the release pipeline (release.yml).`);
  }
  if (unchecked.length > 0) {
    console.error(`\nCOULD NOT BE CHECKED: ${unchecked.join(", ")} did not answer this run, so the version served there is unknown. This is NOT drift and is not by itself evidence of a failed release. Re-run, or let tomorrow's scheduled run decide, before touching the release pipeline.`);
  }
  if (drifted.length > 0 || unchecked.length > 0) {
    process.exit(1);
  }
  console.log(`\nAll first-party surfaces in sync at v${EXPECTED}.`);
}

main().catch((err) => {
  console.error("check-release-sync failed:", err);
  process.exit(1);
});
