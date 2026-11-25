# tree-sitter-gram

A [tree-sitter](https://tree-sitter.github.io/) grammar for [Gram](https://gram-lang.org), the recipe markup language.

It is a surface grammar, written for highlighting, folding and outlines in editors. The reference grammar is `packages/parser/grammar.ohm` in the [Gram monorepo](https://git.gram-lang.org/gram-lang/gram): this one reads the same text the same way, including its tolerance. What is not an element is prose, never an error.

## How it reads Gram

- Gram is a PEG: a sigil (`@`, `#`, `~`, `^`, `&`, `={`, `->&`, `<@`, `[`, `##`) only opens an element when what follows completes it. The external scanner (`src/scanner.c`, C99) looks ahead on the line to decide, and scans the names.
- It reproduces `grammar.ohm`, it does not fix it. A name closed by braces runs over punctuation: `@sel, puis ajouter l'eau{100 ml}` is one ingredient, as the compiler reads it. A cut that looks wrong is a syntax question for `grammar.ohm`.
- Line breaks carry meaning: a blank line ends a step, and `##` only opens a section at the start of a block. Only spaces and tabs are skipped.

## Development

```sh
tree-sitter generate   # src/parser.c is committed: editors build from src/ without the CLI
tree-sitter test       # test/corpus/
```

## License

MIT
