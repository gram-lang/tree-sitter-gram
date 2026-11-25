// The conformance corpus of the Gram monorepo, pinned in package.json
// (`gram.ref`, a tag or a commit), fetched into .conformance/.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
export const corpusDir = join(root, ".conformance");
export const casesDir = join(corpusDir, "conformance", "cases");

// The cases that are syntax errors in grammar.ohm: a parse error is expected
// there. The other err-* cases (ScaleError) are valid recipes.
export function isSyntaxErrorCase(name) {
	return pkg.gram.syntaxErrorCases.some((id) => name === id || name.startsWith(`${id}-`));
}

// Every .gram file of every case (`mod-*` cases hold their modules beside
// input.gram), syntax-error cases left out.
export function corpusFiles() {
	if (!existsSync(casesDir)) {
		throw new Error("No conformance corpus: run `npm run conformance:fetch` first.");
	}
	const files = [];
	for (const name of readdirSync(casesDir).sort()) {
		if (isSyntaxErrorCase(name)) continue;
		const dir = join(casesDir, name);
		for (const file of readdirSync(dir).sort()) {
			if (file.endsWith(".gram")) files.push(join(dir, file));
		}
	}
	return files;
}
