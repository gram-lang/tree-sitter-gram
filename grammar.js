/**
 * @file Gram grammar for tree-sitter: the declarative recipe DSL
 * @author abiwab
 * @license MIT
 *
 * A surface grammar for highlighting, folding and outlines. It mirrors the
 * tolerance of the reference grammar, `packages/parser/grammar.ohm` in the
 * Gram monorepo: what is not an element is text, never an error.
 *
 * Gram is a PEG language: a sigil (`@`, `#`, `~`, `^`, `&`, `={`, `->&`,
 * `<@`, `[`, `##`) only opens an element when what follows completes it;
 * otherwise it is text. Tree-sitter cannot backtrack, so every such decision
 * is made ahead of time by the external scanner (`src/scanner.c`), which looks
 * ahead on the line and tells the parser which form follows (`_full`, with a
 * `{…}`, or `_bare`). The scanner reproduces grammar.ohm, it does not fix it:
 * if a cut looks wrong, it is a syntax question for grammar.ohm.
 */

/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

// Inside braces: a timer accepts free text (`~{1:30 h}`, `~{5'30"}`), so the
// content is a flat run of numbers, units, operators and ratio targets rather
// than a typed quantity. The compiler reads the meaning; we only color it.
const NUMBER = /\d+([.,]\d+)?(\/\d+)?|\d*[¼½¾⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]/;
const UNIT = /[^\s\d{}@&%+\-–\/×*:'"’′”″][^\s{}@&%+\-–\/×*:"”″]*/;
const PRIME = /''|['"’′”″]/;
const OPERATOR = /[+\-–\/%×*:]/;

// A name inside a ratio target, `{1 / 100 g @&flour}`: up to `*` or `×`
// (where a cycle multiplier will go) or a syntax character (ratioTargetName).
const TARGET_NAME = /[^\s{}\[\]()<|:*×]([^\n\r{}\[\]()<|:*×]*[^\s{}\[\]()<|:*×])?/;

module.exports = grammar({
  name: 'gram',

  // Spaces and tabs only: line breaks carry meaning (blank lines end a step,
  // `##` only opens a section at the start of a block).
  extras: (_) => [/[ \t]/],

  externals: ($) => [
    $._newline, // a line break followed by a non-blank line
    $._blank_line, // a line break that ends a block: blank lines, or the end of the file
    $.text,
    $._ingredient_full,
    $._ingredient_bare,
    $._cookware_full,
    $._cookware_bare,
    $._reference_full,
    $._reference_bare,
    $._composite_full,
    $._composite_bare,
    $._decl_full,
    $._decl_bare,
    $._timer_sigil,
    $._temperature_sigil,
    $._checkpoint_open,
    $.modifier,
    $._ref_name,
    $._word_name,
    $._decl_name,
    $._timer_name,
    $._temperature_name,
    $._alias_colon,
    $._preparation_open,
    $._header_marker,
    $._title,
    $._action_open,
    $._use_keyword,
    $._frontmatter_start,
    $._frontmatter_body,
    $._frontmatter_end,
    $.block_comment,
    $._error_sentinel,
  ],

  rules: {
    // Every item ends with its line break (`_separator`), the one at the end
    // of the file included (an empty `_blank_line`): an element can never
    // start where a new block would, so `##` or `[` in the middle of a line
    // stays prose.
    document: ($) =>
      seq(
        optional('﻿'),
        optional(choice($.frontmatter, $._separator)),
        optional($.use_block),
        repeat($._block),
        repeat($.section),
      ),

    _separator: ($) => choice($._newline, $._blank_line),

    // Frontmatter

    frontmatter: ($) =>
      seq(
        alias($._frontmatter_start, '---'),
        optional(alias($._frontmatter_body, $.yaml)),
        alias($._frontmatter_end, '---'),
        $._separator,
      ),

    // Imports, only at the top of the document (UseBlock). A comment between
    // or after the directives belongs to the block.

    use_block: ($) =>
      prec.right(
        seq(
          $.use_directive,
          repeat(choice($.use_directive, $._comment_line)),
        ),
      ),

    use_directive: ($) =>
      seq(
        alias($._use_keyword, '@'),
        token.immediate('use'),
        field('source', $.string),
        'as',
        choice(
          seq('{', commaSep1($.binding), '}'),
          $.binding,
        ),
        optional($.retro_planning),
        $._separator,
      ),

    string: (_) => /"[^"\n\r]+"/,

    binding: ($) =>
      seq(
        '&',
        field('exported', $.binding_name),
        optional(seq('as', '&', field('local', $.binding_name))),
      ),

    binding_name: (_) =>
      choice(
        // bindingFullName "{}": stops at "," and at sigils
        token(/[^\s{}\[\]()<|:,@#~^&]([^\n\r{}\[\]()<|:,@#~^&]*[^\s{}\[\]()<|:,@#~^&])?\{\}/),
        // bindingBareName
        /[^\s{}\[\]()<|:,;!?.~]+/,
      ),

    // Sections

    section: ($) =>
      prec.right(
        seq(
          $.header,
          repeat($._block),
        ),
      ),

    header: ($) =>
      seq(
        alias($._header_marker, '##'),
        optional(field('title', alias($._title, $.title))),
        optional(
          choice(
            seq($.retro_planning, optional($.intermediate_decl)),
            seq($.intermediate_decl, optional($.retro_planning)),
          ),
        ),
        $._separator,
      ),

    retro_planning: ($) =>
      seq(
        '~{',
        optional(alias(/[^\s}]([^\n\r}]*[^\s}])?/, $.value)),
        '}',
      ),

    // Blocks

    // A comment line opening a block is a block of its own (Block_comment):
    // the next line starts a new block, a `##` header included.
    _block: ($) => choice($.step, $._comment_line),

    _comment_line: ($) => prec(1, seq($.comment, $._separator)),

    // Consecutive lines make one step; a blank line ends it.
    step: ($) =>
      seq(
        optional($.action),
        $._inline,
        repeat(choice($._inline, seq($._newline, $._inline))),
        $._blank_line,
      ),

    action: ($) =>
      seq(
        alias($._action_open, '['),
        alias(/[^\s\]]([^\n\r\]]*[^\s\]])?/, $.name),
        ']',
      ),

    _inline: ($) =>
      choice(
        $.text,
        $.ingredient,
        $.alternative,
        $.cookware,
        $.timer,
        $.temperature,
        $.checkpoint,
        $.reference,
        $.intermediate_decl,
        $.comment,
        $.block_comment,
      ),

    // Elements

    ingredient: ($) =>
      choice(
        seq(
          alias($._ingredient_full, '@'),
          repeat($.modifier),
          field('name', alias($._ref_name, $.name)),
          optional(seq(':', field('alias', alias($._ref_name, $.alias)))),
          field('amount', $.amount),
          optional($.preparation),
          optional($.composite),
        ),
        seq(
          alias($._ingredient_bare, '@'),
          repeat($.modifier),
          field('name', alias($._word_name, $.name)),
          optional(seq(alias($._alias_colon, ':'), field('alias', alias($._ref_name, $.alias)))),
          optional($.preparation),
          optional($.composite),
        ),
      ),

    alternative: ($) =>
      choice(
        seq($.ingredient, repeat1(seq('|', $.ingredient))),
        seq($.cookware, repeat1(seq('|', $.cookware))),
      ),

    composite: ($) =>
      choice(
        seq(
          alias($._composite_full, '<@'),
          repeat($.modifier),
          field('name', alias($._ref_name, $.name)),
          field('amount', $.amount),
          optional($.preparation),
        ),
        seq(
          alias($._composite_bare, '<@'),
          repeat($.modifier),
          field('name', alias($._word_name, $.name)),
          optional($.preparation),
        ),
      ),

    cookware: ($) =>
      choice(
        seq(
          alias($._cookware_full, '#'),
          repeat($.modifier),
          field('name', alias($._ref_name, $.name)),
          optional(seq(':', field('alias', alias($._ref_name, $.alias)))),
          field('amount', $.amount),
          optional($.preparation),
        ),
        seq(
          alias($._cookware_bare, '#'),
          repeat($.modifier),
          field('name', alias($._word_name, $.name)),
          optional(seq(alias($._alias_colon, ':'), field('alias', alias($._ref_name, $.alias)))),
          optional($.preparation),
        ),
      ),

    timer: ($) =>
      seq(
        alias($._timer_sigil, '~'),
        optional(alias('_', $.passive)),
        optional(field('name', alias($._timer_name, $.name))),
        field('amount', $.amount),
      ),

    temperature: ($) =>
      seq(
        alias($._temperature_sigil, '^'),
        optional(field('name', alias($._temperature_name, $.name))),
        field('amount', $.amount),
        optional($.preparation),
      ),

    checkpoint: ($) =>
      seq(
        alias($._checkpoint_open, '={'),
        field('state', alias(/[^\s}]([^\n\r}]*[^\s}])?/, $.state)),
        '}',
        optional($.preparation),
      ),

    reference: ($) =>
      choice(
        seq(
          alias($._reference_full, '&'),
          field('name', alias($._ref_name, $.name)),
          field('amount', $.amount),
        ),
        seq(
          alias($._reference_bare, '&'),
          field('name', alias($._word_name, $.name)),
        ),
      ),

    intermediate_decl: ($) =>
      choice(
        seq(alias($._decl_full, '->&'), field('name', alias($._decl_name, $.name)), '{}'),
        seq(alias($._decl_bare, '->&'), field('name', alias($._word_name, $.name))),
      ),

    preparation: ($) =>
      seq(
        alias($._preparation_open, '('),
        optional(alias(/[^\s)]([^\n\r)]*[^\s)])?/, $.note)),
        ')',
      ),

    amount: ($) =>
      seq(
        '{',
        repeat(choice($.number, $.unit, $.operator, $.target)),
        '}',
      ),

    number: (_) => NUMBER,

    unit: (_) => choice(UNIT, PRIME),

    operator: (_) => OPERATOR,

    target: ($) =>
      seq(choice('@&', '&'), alias(TARGET_NAME, $.name)),

    comment: (_) => token(seq('//', /[^\n\r]*/)),
  },
});

/**
 * @param {RuleOrLiteral} rule
 */
function commaSep1(rule) {
  return seq(rule, repeat(seq(',', rule)));
}
