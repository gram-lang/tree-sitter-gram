// Compiles every query file against the grammar: a node type, field or
// pattern the grammar cannot produce fails the check. The colors themselves
// are tested by `tree-sitter test` (test/highlight/, with the Neovim
// highlights.scm that tree-sitter.json names).
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { root } from "./conformance.mjs";

const sample = join(root, "test", "highlight", "recipe.gram");

function queryFiles(dir) {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return queryFiles(path);
		return entry.name.endsWith(".scm") ? [path] : [];
	});
}

let failed = 0;
const files = queryFiles(join(root, "queries")).sort();
for (const file of files) {
	const result = spawnSync("tree-sitter", ["query", "--quiet", file, sample], {
		cwd: root,
		encoding: "utf8",
	});
	if (result.status === 0) continue;
	failed++;
	const output = `${result.stderr ?? ""}${result.error?.message ?? ""}`;
	const message = output
		.split("\n")
		.filter((line) => line.trim() && !/parser directories|init-config|configuration file|language grammars/.test(line))
		.join("\n    ");
	console.error(`✗ ${relative(root, file)}\n    ${message}`);
}

if (failed > 0) {
	console.error(`${failed} of ${files.length} query files do not compile`);
	process.exit(1);
}
console.log(`${files.length} query files compile against the grammar`);
