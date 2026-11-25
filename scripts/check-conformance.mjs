// Parses every recipe of the conformance corpus: no ERROR or MISSING node is
// allowed, except in the syntax-error cases, which are left out.
import { spawnSync } from "node:child_process";
import { relative } from "node:path";
import { casesDir, corpusFiles, root } from "./conformance.mjs";

const files = corpusFiles();
const result = spawnSync(process.env.TREE_SITTER || "tree-sitter", ["parse", "--quiet", "--json-summary", ...files], {
	cwd: root,
	encoding: "utf8",
	maxBuffer: 64 * 1024 * 1024,
});
if (result.error) throw result.error;

// The summary follows the lines the CLI prints for failing files.
const json = result.stdout.slice(result.stdout.indexOf("\n{") + 1);
const { parse_summaries: summaries } = JSON.parse(json.startsWith("{") ? json : result.stdout);
const failed = summaries.filter((s) => !s.successful);

for (const s of failed) console.log(`ERROR or MISSING: ${relative(casesDir, s.file)}`);
console.log(`${summaries.length - failed.length}/${summaries.length} conformance recipes parse cleanly.`);
process.exit(failed.length > 0 || summaries.length !== files.length ? 1 : 0);
