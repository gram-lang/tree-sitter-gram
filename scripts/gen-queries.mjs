// Writes the editor queries from one table: pattern -> role -> capture name
// in Neovim, Helix and Zed. The three editors name the same color
// differently (a section title is @markup.heading in Neovim, markup.heading
// in Helix and @title in Zed); the table keeps them in step.
//
//   node scripts/gen-queries.mjs          write queries/
//   node scripts/gen-queries.mjs --check  fail if queries/ is not up to date
//
// Roles follow the scopes of `packages/parser/syntaxes/gram.tmLanguage.json`
// in the Gram monorepo, so that a recipe has the same colors in VS Code and
// Sublime as in a tree-sitter editor. Every capture name must be one the
// editor documents (DOCUMENTED below); the script refuses any other.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// The capture names each editor documents, as read on 2026-11-25:
// - Neovim: https://neovim.io/doc/user/treesitter/ ("treesitter-highlight-groups",
//   and @spell); @fold is the capture of the folds.scm files Neovim ships.
// - Helix: https://docs.helix-editor.com/themes.html ("Syntax highlighting").
// - Zed: https://zed.dev/docs/extensions/languages ("Syntax highlighting").
// Only the names this table uses are listed.
const DOCUMENTED = {
	nvim: [
		"comment",
		"function",
		"keyword",
		"keyword.import",
		"keyword.modifier",
		"markup.heading",
		"number",
		"operator",
		"punctuation.bracket",
		"punctuation.delimiter",
		"punctuation.special",
		"spell",
		"string",
		"tag",
		"type",
		"type.builtin",
	],
	helix: [
		"comment.block",
		"comment.line",
		"constant.numeric",
		"function",
		"keyword",
		"keyword.control",
		"keyword.control.import",
		"keyword.storage.modifier",
		"markup.heading",
		"markup.heading.marker",
		"operator",
		"punctuation.bracket",
		"punctuation.delimiter",
		"punctuation.special",
		"string",
		"tag",
		"type",
		"type.builtin",
	],
	zed: [
		"comment",
		"function",
		"keyword",
		"number",
		"operator",
		"punctuation.bracket",
		"punctuation.delimiter",
		"punctuation.special",
		"string",
		"tag",
		"title",
		"type",
		"type.builtin",
	],
};

// role -> { tm: the TextMate scope it mirrors, nvim, helix, zed }.
// A null capture leaves the role out of that editor's file.
const ROLES = {
	import: { tm: "keyword.control.import", nvim: "keyword.import", helix: "keyword.control.import", zed: "keyword" },
	sigil: { tm: "keyword.control.<element>", nvim: "keyword", helix: "keyword.control", zed: "keyword" },
	modifier: { tm: "storage.modifier", nvim: "keyword.modifier", helix: "keyword.storage.modifier", zed: "keyword" },
	ingredient: { tm: "entity.name.type.ingredient", nvim: "type", helix: "type", zed: "type" },
	cookware: { tm: "support.class.cookware", nvim: "type.builtin", helix: "type.builtin", zed: "type.builtin" },
	label: { tm: "support.type.timer|temperature", nvim: "type.builtin", helix: "type.builtin", zed: "type.builtin" },
	reference: { tm: "entity.name.tag.reference|intermediate|retro", nvim: "tag", helix: "tag", zed: "tag" },
	action: { tm: "entity.name.function.action", nvim: "function", helix: "function", zed: "function" },
	heading: { tm: "entity.name.section", nvim: "markup.heading", helix: "markup.heading", zed: "title" },
	headingMarker: { tm: "markup.heading.marker", nvim: "markup.heading", helix: "markup.heading.marker", zed: "title" },
	number: { tm: "constant.numeric", nvim: "number", helix: "constant.numeric", zed: "number" },
	unit: { tm: "keyword.other.unit", nvim: "keyword", helix: "keyword", zed: "keyword" },
	operator: { tm: "keyword.operator", nvim: "operator", helix: "operator", zed: "operator" },
	string: { tm: "string.*", nvim: "string", helix: "string", zed: "string" },
	bracket: { tm: "punctuation.section.embedded, punctuation.definition.tag", nvim: "punctuation.bracket", helix: "punctuation.bracket", zed: "punctuation.bracket" },
	delimiter: { tm: "punctuation.separator", nvim: "punctuation.delimiter", helix: "punctuation.delimiter", zed: "punctuation.delimiter" },
	fence: { tm: "(none: meta.embedded.block.frontmatter)", nvim: "punctuation.special", helix: "punctuation.special", zed: "punctuation.special" },
	lineComment: { tm: "comment.line.double-slash", nvim: "comment", helix: "comment.line", zed: "comment" },
	blockComment: { tm: "comment.block", nvim: "comment", helix: "comment.block", zed: "comment" },
	spell: { tm: "(none: Neovim spell checking)", nvim: "spell", helix: null, zed: null },
};

// pattern -> role(s). `@{role}` stands for the role's capture in each
// editor; a role with no capture in an editor is dropped from the pattern,
// and the pattern too when it has no capture left.
// Each node gets at most one capture and no captured node holds another, so
// the result does not depend on which editor lets the first or the last
// pattern win.
const HIGHLIGHTS = [
	["Frontmatter (the YAML is injected, see injections.scm)"],
	['(frontmatter "---" @{fence})', "fence"],

	["Imports: `@use` is two anonymous nodes, `@` and `use`"],
	['(use_directive ["@" "use" "as"] @{import})', "import"],
	["(use_directive source: (string) @{string})", "string"],
	['(use_directive ["{" "}"] @{bracket})', "bracket"],
	['(use_directive "," @{delimiter})', "delimiter"],
	['(binding "as" @{import})', "import"],
	['(binding "&" @{sigil})', "sigil"],
	["(binding_name) @{reference}", "reference"],

	["Sections"],
	['(header "##" @{headingMarker})', "headingMarker"],
	["(header title: (title) @{heading})", "heading"],
	['(retro_planning ["~{" "}"] @{reference})', "reference"],
	["(retro_planning (value) @{reference})", "reference"],

	["Steps"],
	['(action ["[" "]"] @{bracket})', "bracket"],
	["(action (name) @{action})", "action"],
	["(text) @{spell}", "spell"],

	["Ingredients and composite parents (`<@`)"],
	['(ingredient "@" @{sigil})', "sigil"],
	["(ingredient name: (name) @{ingredient})", "ingredient"],
	['(composite "<@" @{sigil})', "sigil"],
	["(composite name: (name) @{ingredient})", "ingredient"],
	['(alternative "|" @{operator})', "operator"],

	["Cookware"],
	['(cookware "#" @{sigil})', "sigil"],
	["(cookware name: (name) @{cookware})", "cookware"],

	["Aliases and modifiers, shared by ingredients and cookware"],
	['(ingredient ":" @{operator})', "operator"],
	["(ingredient alias: (alias) @{string})", "string"],
	['(cookware ":" @{operator})', "operator"],
	["(cookware alias: (alias) @{string})", "string"],
	["(modifier) @{modifier}", "modifier"],

	["Timers: `_` marks a passive timer"],
	['(timer "~" @{sigil})', "sigil"],
	["(timer (passive) @{modifier})", "modifier"],
	["(timer name: (name) @{label})", "label"],

	["Temperatures: the name is the heat source (`^oven{180°C}`), a label like a timer's"],
	['(temperature "^" @{sigil})', "sigil"],
	["(temperature name: (name) @{label})", "label"],

	["Checkpoints"],
	['(checkpoint "={" @{sigil})', "sigil"],
	['(checkpoint "}" @{bracket})', "bracket"],
	["(checkpoint state: (state) @{string})", "string"],

	["References and intermediate declarations"],
	['(reference "&" @{sigil})', "sigil"],
	["(reference name: (name) @{reference})", "reference"],
	['(intermediate_decl "->&" @{operator})', "operator"],
	["(intermediate_decl name: (name) @{reference})", "reference"],
	['(intermediate_decl "{}" @{bracket})', "bracket"],

	["Preparation notes"],
	['(preparation ["(" ")"] @{bracket})', "bracket"],
	["(preparation (note) @{string})", "string"],

	["Quantities, durations and ratio targets"],
	['(amount ["{" "}"] @{bracket})', "bracket"],
	["(number) @{number}", "number"],
	["(unit) @{unit}", "unit"],
	["(operator) @{operator}", "operator"],
	['(target ["@&" "&"] @{sigil})', "sigil"],
	["(target (name) @{reference})", "reference"],

	["Comments"],
	["(comment) @{spell} @{lineComment}", ["spell", "lineComment"]],
	["(block_comment) @{spell} @{blockComment}", ["spell", "blockComment"]],
];

const HEADER = [
	"; Generated by scripts/gen-queries.mjs from its role table: do not edit.",
	"; Run `npm run queries` after changing the table.",
];

function highlights(editor) {
	const lines = [...HEADER];
	for (const [pattern, roles] of HIGHLIGHTS) {
		if (roles === undefined) {
			lines.push("", `; ${pattern}`);
			continue;
		}
		let query = pattern;
		let kept = 0;
		for (const role of [roles].flat()) {
			const spec = ROLES[role];
			if (!spec) throw new Error(`Unknown role "${role}" in ${pattern}`);
			const capture = spec[editor];
			if (capture === null) {
				query = query.replace(` @{${role}}`, "");
				continue;
			}
			if (!DOCUMENTED[editor].includes(capture)) {
				throw new Error(`@${capture} (role "${role}") is not a capture ${editor} documents`);
			}
			query = query.replace(`@{${role}}`, `@${capture}`);
			kept++;
		}
		if (kept > 0) lines.push(query);
	}
	return `${lines.join("\n")}\n`;
}

// The YAML of the frontmatter, for the three editors. Helix and Zed get their
// own copy, so that each editor's folder holds all its queries.
const INJECTIONS = `${HEADER.join("\n")}

((yaml) @injection.content
  (#set! injection.language "yaml"))
`;

// Neovim: fold the frontmatter and each section, trailing blank lines left out.
const FOLDS = `${HEADER.join("\n")}

([
  (frontmatter)
  (section)
] @fold
  (#trim! @fold))
`;

// Zed: the outline lists the sections that have a title, by their title.
const OUTLINE = `${HEADER.join("\n")}

(section
  (header
    title: (title) @name)) @item
`;

// Zed: matching pairs. `~{` and `={` open with their sigil.
const BRACKETS = `${HEADER.join("\n")}

("{" @open "}" @close)
("~{" @open "}" @close)
("={" @open "}" @close)
("(" @open ")" @close)
("[" @open "]" @close)
`;

const files = {
	"queries/highlights.scm": highlights("nvim"),
	"queries/injections.scm": INJECTIONS,
	"queries/helix/injections.scm": INJECTIONS,
	"queries/zed/injections.scm": INJECTIONS,
	"queries/folds.scm": FOLDS,
	"queries/helix/highlights.scm": highlights("helix"),
	"queries/zed/highlights.scm": highlights("zed"),
	"queries/zed/outline.scm": OUTLINE,
	"queries/zed/brackets.scm": BRACKETS,
};

const check = process.argv.includes("--check");
const stale = [];
for (const [path, content] of Object.entries(files)) {
	const file = join(root, path);
	const current = existsSync(file) ? readFileSync(file, "utf8") : null;
	if (current === content) continue;
	if (check) {
		stale.push(relative(root, file));
		continue;
	}
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
	console.log(`wrote ${path}`);
}

if (stale.length > 0) {
	console.error(`Out of date, run \`npm run queries\`:\n${stale.map((f) => `  ${f}`).join("\n")}`);
	process.exit(1);
}
if (check) console.log(`${Object.keys(files).length} query files up to date`);
