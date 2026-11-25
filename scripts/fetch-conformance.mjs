// Fetches conformance/cases from the Gram monorepo at the pinned ref into
// .conformance/. GRAM_MONOREPO points to another clone (a local path works).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { corpusDir, pkg } from "./conformance.mjs";

const repository = process.env.GRAM_MONOREPO || pkg.gram.repository;
const { ref } = pkg.gram;
const stamp = join(corpusDir, "REF");

if (existsSync(stamp) && readFileSync(stamp, "utf8").trim() === ref) {
	console.log(`Conformance corpus already at ${ref}.`);
	process.exit(0);
}

rmSync(corpusDir, { recursive: true, force: true });
mkdirSync(corpusDir, { recursive: true });
const git = (...args) => execFileSync("git", args, { cwd: corpusDir, stdio: ["ignore", "ignore", "inherit"] });
git("init", "--quiet");
git("fetch", "--quiet", "--depth", "1", repository, ref);
git("checkout", "--quiet", "FETCH_HEAD", "--", "conformance/cases");
rmSync(join(corpusDir, ".git"), { recursive: true, force: true });
writeFileSync(stamp, `${ref}\n`);
console.log(`Conformance corpus fetched at ${ref}.`);
