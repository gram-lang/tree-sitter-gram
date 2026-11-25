// The cutting oracle: on every recipe of the conformance corpus and of
// test/corpus, the ranges of the elements read by @gram-lang/parser (the
// reference, pinned in package.json) must be those of the tree-sitter nodes.
// A grammar that cuts `@sel, puis ajouter l'eau{100 ml}` into two ingredients
// fails here, with no fixture to maintain.
//
// Compared: ingredients, tools, timers, temperatures, target states,
// references, intermediate declarations, composite parents, anchors, imports,
// their bindings and section headers. Ranges are compared without the blanks
// and line breaks at their ends.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { getAST } from "@gram-lang/parser";
import { casesDir, corpusFiles, root } from "./conformance.mjs";

// AST node type -> tree-sitter node type
const KINDS = {
	Ingredient: "ingredient",
	Cookware: "cookware",
	Timer: "timer",
	Temperature: "temperature",
	Checkpoint: "checkpoint",
	Reference: "reference",
	IntermediateDecl: "intermediate_decl",
	Composite: "composite",
	ImportDecl: "use_directive",
};
const TS_KINDS = new Set([...Object.values(KINDS), "retro_planning", "binding", "header"]);

/** [start, end) without the blanks and line breaks at both ends. */
function trim(source, start, end) {
	while (start < end && /\s/.test(source[start])) start++;
	while (end > start && /\s/.test(source[end - 1])) end--;
	return [start, end];
}

function endOfLine(source, start) {
	const m = /[\r\n]/.exec(source.slice(start));
	return m ? start + m.index : source.length;
}

/** The elements of the reference parser, as "kind start end" keys. */
function referenceElements(source) {
	const keys = [];
	const add = (kind, loc) => {
		const [s, e] = trim(source, loc.start, loc.end);
		keys.push(`${kind} ${s} ${e}`);
	};
	const walk = (node) => {
		if (Array.isArray(node)) return node.forEach(walk);
		if (!node || typeof node !== "object") return;
		if (node.type === "Section" && node.loc) {
			const [s] = trim(source, node.loc.start, node.loc.end);
			// A section starts with its header line.
			add("header", { start: s, end: endOfLine(source, s) });
		} else if (KINDS[node.type] && node.loc) {
			add(KINDS[node.type], node.loc);
		}
		if (node.retroPlanning?.loc) add("retro_planning", node.retroPlanning.loc);
		if (node.type === "ImportDecl") for (const b of node.bindings) if (b.loc) add("binding", b.loc);
		for (const key of ["imports", "children", "options", "composite", "intermediateDecl"]) {
			if (node[key]) walk(node[key]);
		}
	};
	walk(getAST(source));
	return keys;
}

/** UTF-16 offset of a tree-sitter point (rows split on LF, columns in UTF-8 bytes). */
function offsetResolver(source) {
	const lines = source.split("\n");
	const starts = [];
	let offset = 0;
	for (const line of lines) {
		starts.push(offset);
		offset += line.length + 1;
	}
	return (row, column) => starts[row] + Buffer.from(lines[row], "utf8").subarray(0, column).toString("utf8").length;
}

/** The trees printed by `tree-sitter parse`, one per file, in order. */
function treeSitterTrees(files) {
	const result = spawnSync(process.env.TREE_SITTER || "tree-sitter", ["parse", ...files], {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 256 * 1024 * 1024,
	});
	if (result.error) throw result.error;
	const trees = [];
	for (const line of result.stdout.split("\n")) {
		if (line.startsWith("(document")) trees.push([]);
		if (trees.length > 0) trees.at(-1).push(line);
	}
	if (trees.length !== files.length) throw new Error(`Expected ${files.length} trees, got ${trees.length}.`);
	return trees;
}

function treeSitterElements(source, treeLines) {
	const at = offsetResolver(source);
	const keys = [];
	for (const line of treeLines) {
		const m = /^\s*(?:\w+: )?\((\w+) \[(\d+), (\d+)\] - \[(\d+), (\d+)\]/.exec(line);
		if (!m || !TS_KINDS.has(m[1])) continue;
		const start = at(Number(m[2]), Number(m[3]));
		const end = m[1] === "header" ? endOfLine(source, start) : at(Number(m[4]), Number(m[5]));
		const [s, e] = trim(source, start, end);
		keys.push(`${m[1]} ${s} ${e}`);
	}
	return keys;
}

/** Keys in `a` and not in `b`, as a multiset. */
function missing(a, b) {
	const rest = [...b];
	return a.filter((k) => {
		const i = rest.indexOf(k);
		if (i < 0) return true;
		rest.splice(i, 1);
		return false;
	});
}

/** The inputs of test/corpus, but for the `:error` ones, written to `dir`. */
function corpusInputs(dir) {
	const corpus = join(root, "test", "corpus");
	const files = [];
	for (const name of readdirSync(corpus).sort()) {
		const text = readFileSync(join(corpus, name), "utf8");
		const re = /^={3,}(\|\|\|)?\n(.+)\n((?::\w+\n)*)={3,}(\|\|\|)?\n\n?([\s\S]*?)\n-{3,}(\|\|\|)?\n\n\(/gm;
		let i = 0;
		for (const m of text.matchAll(re)) {
			i++;
			if (m[3].includes(":error")) continue;
			const file = join(dir, `${name.replace(/\.txt$/, "")}-${String(i).padStart(2, "0")}.gram`);
			writeFileSync(file, m[5]);
			files.push({ file, label: `test/corpus/${name} #${i} (${m[2]})` });
		}
	}
	return files;
}

const show = (source, key) => {
	const [kind, s, e] = key.split(" ");
	return `${kind} ${JSON.stringify(source.slice(Number(s), Number(e)))} at ${s}`;
};

const tmp = mkdtempSync(join(tmpdir(), "tree-sitter-gram-oracle-"));
try {
	const inputs = [
		...corpusFiles().map((file) => ({ file, label: relative(casesDir, file) })),
		...corpusInputs(tmp),
	];
	const trees = treeSitterTrees(inputs.map((i) => i.file));
	let failures = 0;
	let compared = 0;
	inputs.forEach(({ file, label }, n) => {
		const source = readFileSync(file, "utf8");
		const expected = referenceElements(source);
		const actual = treeSitterElements(source, trees[n]);
		compared += expected.length;
		const lost = missing(expected, actual);
		const extra = missing(actual, expected);
		if (lost.length === 0 && extra.length === 0) return;
		failures++;
		console.log(`✗ ${label}`);
		for (const k of lost) console.log(`    parser only:      ${show(source, k)}`);
		for (const k of extra) console.log(`    tree-sitter only: ${show(source, k)}`);
	});
	console.log(`${inputs.length - failures}/${inputs.length} recipes cut alike (${compared} elements compared).`);
	process.exitCode = failures > 0 ? 1 : 0;
} finally {
	rmSync(tmp, { recursive: true, force: true });
}
