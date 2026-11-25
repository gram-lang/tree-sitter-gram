/**
 * External scanner for tree-sitter-gram.
 *
 * Gram's reference grammar (grammar.ohm, in the Gram monorepo) is a PEG: a
 * sigil only opens an element when what follows completes it, and otherwise
 * falls back to text. Tree-sitter cannot backtrack, so this scanner looks
 * ahead on the line at each sigil and tells the parser which form follows:
 * `_full` (the name is closed by a `{`) or `_bare` (a single word), or plain
 * text. Names are scanned here as well, since their ends depend on the same
 * rules (`refName`, `singleWordName`, `declName`, `name`, `title`).
 *
 * It reproduces grammar.ohm, it does not fix it. A name closed by braces
 * stops at syntax characters, sigils and the end of the line, not at
 * punctuation: `@sel, puis ajouter l'eau{100 ml}` is one ingredient, as the
 * compiler reads it.
 *
 * C99, no state between tokens: every decision is made again from the text.
 */

#include "tree_sitter/alloc.h"
#include "tree_sitter/array.h"
#include "tree_sitter/parser.h"

#include <stdbool.h>
#include <stdint.h>

enum TokenType {
  NEWLINE,
  BLANK_LINE,
  TEXT,
  INGREDIENT_FULL,
  INGREDIENT_BARE,
  COOKWARE_FULL,
  COOKWARE_BARE,
  REFERENCE_FULL,
  REFERENCE_BARE,
  COMPOSITE_FULL,
  COMPOSITE_BARE,
  DECL_FULL,
  DECL_BARE,
  TIMER_SIGIL,
  TEMPERATURE_SIGIL,
  CHECKPOINT_OPEN,
  MODIFIER,
  REF_NAME,
  WORD_NAME,
  DECL_NAME,
  TIMER_NAME,
  TEMPERATURE_NAME,
  ALIAS_COLON,
  PREPARATION_OPEN,
  HEADER_MARKER,
  TITLE,
  ACTION_OPEN,
  USE_KEYWORD,
  FRONTMATTER_START,
  FRONTMATTER_BODY,
  FRONTMATTER_END,
  BLOCK_COMMENT,
  ERROR_SENTINEL,
};

typedef Array(int32_t) Line;

typedef struct {
  Line line; // the rest of the current line, read ahead
} Scanner;

typedef enum { FORM_NONE, FORM_FULL, FORM_BARE } Form;

/* Characters */

static inline bool is_blank(int32_t c) { return c == ' ' || c == '\t'; }

static inline bool is_eol(TSLexer *lexer) {
  return lexer->eof(lexer) || lexer->lookahead == '\n' || lexer->lookahead == '\r';
}

// refSigil
static inline bool is_ref_sigil(int32_t c) {
  return c == '@' || c == '#' || c == '~' || c == '^' || c == '&';
}

// sentencePunct
static inline bool is_punct(int32_t c) {
  return c == ',' || c == ';' || c == '!' || c == '?' || c == '.';
}

// modifier
static inline bool is_modifier(int32_t c) {
  return c == '?' || c == '-' || c == '*' || c == '&' || c == '=';
}

// syntaxChar, but for "={", which needs the next character
static inline bool is_syntax_char(int32_t c) {
  switch (c) {
    case '{': case '}': case '[': case ']': case '(': case ')':
    case '<': case '|': case ':':
      return true;
    default:
      return false;
  }
}

static inline void advance(TSLexer *lexer) { lexer->advance(lexer, false); }
static inline void skip(TSLexer *lexer) { lexer->advance(lexer, true); }
static inline void mark(TSLexer *lexer) { lexer->mark_end(lexer); }

static inline bool emit(TSLexer *lexer, enum TokenType type) {
  lexer->result_symbol = type;
  return true;
}

// LF, CRLF or a lone CR (nl)
static void consume_line_break(TSLexer *lexer, bool skipped) {
  if (lexer->lookahead == '\r') {
    lexer->advance(lexer, skipped);
    if (lexer->lookahead == '\n') lexer->advance(lexer, skipped);
  } else if (lexer->lookahead == '\n') {
    lexer->advance(lexer, skipped);
  }
}

/* Look-ahead on the line */

// Reads the rest of the line into the buffer, after the given prefix.
static void read_line(Scanner *s, TSLexer *lexer, const int32_t *prefix, uint32_t prefix_len) {
  array_clear(&s->line);
  for (uint32_t i = 0; i < prefix_len; i++) array_push(&s->line, prefix[i]);
  while (!is_eol(lexer)) {
    array_push(&s->line, lexer->lookahead);
    advance(lexer);
  }
}

#define B (s->line.contents)
#define N (s->line.size)

static bool syntax_at(const Scanner *s, uint32_t i) {
  if (B[i] == '=') return i + 1 < N && B[i + 1] == '{';
  return is_syntax_char(B[i]);
}

static bool starts_with(const Scanner *s, uint32_t i, const char *word) {
  for (; *word; word++, i++) {
    if (i >= N || B[i] != (int32_t)*word) return false;
  }
  return true;
}

static int64_t find(const Scanner *s, uint32_t i, int32_t c) {
  for (; i < N; i++) {
    if (B[i] == c) return i;
  }
  return -1;
}

// refName
static uint32_t ref_name_end(const Scanner *s, uint32_t i) {
  while (i < N && !syntax_at(s, i) && !is_ref_sigil(B[i])) i++;
  return i;
}

// wordStop
static bool word_stop_at(const Scanner *s, uint32_t i) {
  return syntax_at(s, i) || is_blank(B[i]) || is_punct(B[i]);
}

// singleWordName: a word made only of sigils is no name
static uint32_t word_name_end(const Scanner *s, uint32_t start) {
  uint32_t k = start;
  while (k < N && is_ref_sigil(B[k])) k++;
  if (k > start && (k == N || word_stop_at(s, k))) return start;
  uint32_t i = start;
  while (i < N && !word_stop_at(s, i)) i++;
  return i;
}

// declName: also stops at "~{"
static uint32_t decl_name_end(const Scanner *s, uint32_t i) {
  while (i < N && !syntax_at(s, i) && !starts_with(s, i, "~{")) i++;
  return i;
}

// name (timers, temperatures)
static uint32_t free_name_end(const Scanner *s, uint32_t i) {
  while (i < N && !syntax_at(s, i)) i++;
  return i;
}

/**
 * simpleIngredient, simpleCookware, composite, reference: the full form when a
 * `{` closes the name (refName, then an alias for ingredients and tools), the
 * bare form when a single word follows. A full form with malformed braces is
 * still full: the compiler reports it.
 */
static Form element_form(const Scanner *s, uint32_t start, bool modifiers, bool alias, bool leading_blank) {
  uint32_t m = start;
  if (modifiers) {
    while (m < N && is_modifier(B[m])) m++;
  }
  if (leading_blank || (m < N && !is_blank(B[m]))) {
    uint32_t r1 = ref_name_end(s, m);
    if (r1 > m && r1 < N) {
      if (B[r1] == '{') return FORM_FULL;
      if (alias && B[r1] == ':') {
        uint32_t r2 = ref_name_end(s, r1 + 1);
        if (r2 > r1 + 1 && r2 < N && B[r2] == '{') return FORM_FULL;
      }
    }
  }
  return word_name_end(s, m) > m ? FORM_BARE : FORM_NONE;
}

// intermediateDecl
static Form decl_form(const Scanner *s, uint32_t start) {
  uint32_t d = decl_name_end(s, start);
  if (d > start && starts_with(s, d, "{}")) return FORM_FULL;
  return word_name_end(s, start) > start ? FORM_BARE : FORM_NONE;
}

// header: `##` then blanks and a title, or nothing; an extension must be complete
static bool header_valid(const Scanner *s) {
  if (N == 0) return true;
  if (!is_blank(B[0])) return false;
  uint32_t i = 0;
  while (i < N && !starts_with(s, i, "->&") && !starts_with(s, i, "~{")) i++;
  if (i == N) return true;
  if (B[i] == '~') return find(s, i + 2, '}') >= 0;
  return decl_form(s, i + 3) != FORM_NONE;
}

#undef B
#undef N

/* Tokens */

static bool scan_newline(TSLexer *lexer, const bool *valid) {
  consume_line_break(lexer, false);
  mark(lexer);
  bool blank = false;
  for (;;) {
    while (is_blank(lexer->lookahead)) advance(lexer);
    if (lexer->eof(lexer)) {
      blank = true;
      break;
    }
    if (lexer->lookahead == '\n' || lexer->lookahead == '\r') {
      consume_line_break(lexer, false);
      mark(lexer);
      blank = true;
      continue;
    }
    break;
  }
  if (blank) return emit(lexer, valid[BLANK_LINE] ? BLANK_LINE : NEWLINE);
  return emit(lexer, valid[NEWLINE] ? NEWLINE : BLANK_LINE);
}

typedef enum { NAME_REF, NAME_WORD, NAME_DECL, NAME_FREE } NameKind;

// A name, without its trailing blanks.
static bool scan_name(TSLexer *lexer, NameKind kind) {
  bool has = false;
  while (!is_eol(lexer)) {
    int32_t c = lexer->lookahead;
    if (is_blank(c)) {
      if (kind == NAME_WORD) break;
      advance(lexer);
      continue;
    }
    if (c == '=') {
      advance(lexer);
      if (lexer->lookahead == '{') break;
      mark(lexer);
      has = true;
      continue;
    }
    if (kind == NAME_DECL && c == '~') {
      advance(lexer);
      if (lexer->lookahead == '{') break;
      mark(lexer);
      has = true;
      continue;
    }
    if (is_syntax_char(c)) break;
    if (kind == NAME_REF && is_ref_sigil(c)) break;
    if (kind == NAME_WORD && is_punct(c)) break;
    advance(lexer);
    mark(lexer);
    has = true;
  }
  return has;
}

// title: up to "->&" or "~{", without its trailing blanks
static bool scan_title(TSLexer *lexer) {
  bool has = false;
  while (!is_eol(lexer)) {
    int32_t c = lexer->lookahead;
    if (is_blank(c)) {
      advance(lexer);
      continue;
    }
    advance(lexer);
    if (c == '~' && lexer->lookahead == '{') break;
    if (c == '-' && lexer->lookahead == '>') {
      advance(lexer);
      if (lexer->lookahead == '&') break;
    }
    mark(lexer);
    has = true;
  }
  return has;
}

// Prose, up to the next character that may start an element.
static bool scan_text(TSLexer *lexer, bool has) {
  while (!is_eol(lexer)) {
    int32_t c = lexer->lookahead;
    switch (c) {
      case '@': case '#': case '~': case '^': case '&': case '|':
        goto done;
      case '=':
        advance(lexer);
        if (lexer->lookahead == '{') goto done;
        break;
      case '/':
        advance(lexer);
        if (lexer->lookahead == '/' || lexer->lookahead == '*') goto done;
        break;
      case '-':
        advance(lexer);
        if (lexer->lookahead == '>') {
          advance(lexer);
          if (lexer->lookahead == '&') goto done;
        }
        break;
      case ' ': case '\t':
        advance(lexer);
        continue;
      default:
        advance(lexer);
        break;
    }
    mark(lexer);
    has = true;
  }
done:
  return has ? emit(lexer, TEXT) : false;
}

// The sigil was a character of prose after all (already marked).
static inline bool fallback(TSLexer *lexer, const bool *valid) {
  return valid[TEXT] ? emit(lexer, TEXT) : false;
}

static bool emit_form(TSLexer *lexer, const bool *valid, Form form, enum TokenType full, enum TokenType bare) {
  if (form == FORM_FULL && valid[full]) return emit(lexer, full);
  if (form == FORM_BARE && valid[bare]) return emit(lexer, bare);
  return fallback(lexer, valid);
}

static bool is_closing_fence_ahead(TSLexer *lexer, uint32_t *dashes) {
  *dashes = 0;
  while (lexer->lookahead == '-' && *dashes < 4) {
    advance(lexer);
    (*dashes)++;
  }
  return *dashes == 3;
}

/**
 * Frontmatter, validated as grammar.ohm reads it: `---`, then lines that are
 * `key: value` (blank lines only before a key), then `---` alone. Anything
 * else and the whole block is prose.
 */
static bool frontmatter_valid(Scanner *s, TSLexer *lexer) {
  read_line(s, lexer, NULL, 0);
  for (uint32_t i = 0; i < s->line.size; i++) {
    if (!is_blank(s->line.contents[i])) return false;
  }
  bool pending_blank = false;
  while (!lexer->eof(lexer)) {
    consume_line_break(lexer, false);
    read_line(s, lexer, NULL, 0);
    uint32_t n = s->line.size;
    const int32_t *b = s->line.contents;
    uint32_t i = 0;
    while (i < n && is_blank(b[i])) i++;
    if (i == n) {
      pending_blank = true;
      continue;
    }
    if (i + 3 <= n && b[i] == '-' && b[i + 1] == '-' && b[i + 2] == '-') {
      uint32_t j = i + 3;
      while (j < n && is_blank(b[j])) j++;
      if (j == n) return !pending_blank;
    }
    // key = (alnum | "_" | "-")+, any non-ASCII character counted as a letter
    uint32_t k = i;
    while (k < n && (b[k] == '_' || b[k] == '-' || b[k] >= 0x80 || (b[k] >= '0' && b[k] <= '9') ||
                     (b[k] >= 'a' && b[k] <= 'z') || (b[k] >= 'A' && b[k] <= 'Z'))) {
      k++;
    }
    if (k == i) return false;
    while (k < n && is_blank(b[k])) k++;
    if (k == n || b[k] != ':') return false;
    pending_blank = false;
  }
  return false;
}

static bool scan_frontmatter_body(TSLexer *lexer, const bool *valid) {
  while (is_blank(lexer->lookahead)) skip(lexer);
  consume_line_break(lexer, true);
  while (is_blank(lexer->lookahead)) skip(lexer);
  bool first = true;
  for (;;) {
    uint32_t dashes;
    if (is_closing_fence_ahead(lexer, &dashes)) {
      if (first) mark(lexer);
      while (is_blank(lexer->lookahead)) advance(lexer);
      if (is_eol(lexer)) {
        if (first) return valid[FRONTMATTER_END] ? emit(lexer, FRONTMATTER_END) : false;
        return emit(lexer, FRONTMATTER_BODY);
      }
    }
    while (!is_eol(lexer)) advance(lexer);
    mark(lexer);
    first = false;
    if (lexer->eof(lexer) || !valid[FRONTMATTER_BODY]) return valid[FRONTMATTER_BODY] ? emit(lexer, FRONTMATTER_BODY) : false;
    consume_line_break(lexer, false);
    while (is_blank(lexer->lookahead)) advance(lexer);
  }
}

static bool scan_block_comment(TSLexer *lexer) {
  // after "/*"
  while (!lexer->eof(lexer)) {
    int32_t c = lexer->lookahead;
    advance(lexer);
    if (c == '*' && lexer->lookahead == '/') {
      advance(lexer);
      mark(lexer);
      return true;
    }
  }
  return false;
}

static bool scan(Scanner *s, TSLexer *lexer, const bool *valid) {
  // Error recovery: let the internal lexer resynchronize.
  if (valid[ERROR_SENTINEL]) return false;

  if (valid[FRONTMATTER_BODY] || valid[FRONTMATTER_END]) return scan_frontmatter_body(lexer, valid);

  int32_t c = lexer->lookahead;

  // Glued to the previous element: nothing in between.
  if (valid[PREPARATION_OPEN] && c == '(') {
    advance(lexer);
    mark(lexer);
    read_line(s, lexer, NULL, 0);
    if (find(s, 0, ')') >= 0) return emit(lexer, PREPARATION_OPEN);
    return fallback(lexer, valid);
  }
  if (valid[ALIAS_COLON] && c == ':') {
    advance(lexer);
    mark(lexer);
    read_line(s, lexer, NULL, 0);
    if (ref_name_end(s, 0) > 0) return emit(lexer, ALIAS_COLON);
    return fallback(lexer, valid);
  }
  if ((valid[COMPOSITE_FULL] || valid[COMPOSITE_BARE]) && c == '<') {
    advance(lexer);
    mark(lexer);
    if (lexer->lookahead != '@') return fallback(lexer, valid);
    advance(lexer);
    mark(lexer);
    read_line(s, lexer, NULL, 0);
    return emit_form(lexer, valid, element_form(s, 0, true, false, true), COMPOSITE_FULL, COMPOSITE_BARE);
  }
  if (valid[MODIFIER] && is_modifier(c)) {
    advance(lexer);
    mark(lexer);
    return emit(lexer, MODIFIER);
  }

  while (is_blank(lexer->lookahead)) skip(lexer);
  c = lexer->lookahead;

  if ((valid[NEWLINE] || valid[BLANK_LINE]) && (c == '\n' || c == '\r')) return scan_newline(lexer, valid);
  if (lexer->eof(lexer)) {
    // The end of the file ends the last block: an empty line break.
    if (valid[BLANK_LINE]) {
      mark(lexer);
      return emit(lexer, BLANK_LINE);
    }
    return false;
  }

  // Names
  if (valid[REF_NAME]) return scan_name(lexer, NAME_REF) && emit(lexer, REF_NAME);
  if (valid[WORD_NAME]) return scan_name(lexer, NAME_WORD) && emit(lexer, WORD_NAME);
  if (valid[DECL_NAME]) return scan_name(lexer, NAME_DECL) && emit(lexer, DECL_NAME);
  if (valid[TIMER_NAME] && c != '_' && c != '{') return scan_name(lexer, NAME_FREE) && emit(lexer, TIMER_NAME);
  if (valid[TEMPERATURE_NAME] && c != '{') return scan_name(lexer, NAME_FREE) && emit(lexer, TEMPERATURE_NAME);
  if (valid[TITLE] && c != '~' && c != '-') return scan_title(lexer) && emit(lexer, TITLE);

  // A byte order mark opening the file is the internal lexer's.
  if (c == 0xFEFF && valid[FRONTMATTER_START]) return false;

  switch (c) {
    case '#': {
      advance(lexer);
      mark(lexer);
      int32_t prefix[1] = {'#'};
      uint32_t prefix_len = 0;
      if (valid[HEADER_MARKER] && lexer->lookahead == '#') {
        advance(lexer);
        if (is_blank(lexer->lookahead) || is_eol(lexer)) {
          mark(lexer);
          read_line(s, lexer, NULL, 0);
          if (header_valid(s)) return emit(lexer, HEADER_MARKER);
          return fallback(lexer, valid);
        }
        prefix_len = 1; // `##x`: the first `#` may still open a tool named `#x`
      }
      read_line(s, lexer, prefix, prefix_len);
      return emit_form(lexer, valid, element_form(s, 0, true, true, true), COOKWARE_FULL, COOKWARE_BARE);
    }

    case '@': {
      advance(lexer);
      mark(lexer);
      read_line(s, lexer, NULL, 0);
      if (valid[USE_KEYWORD] && starts_with(s, 0, "use") && s->line.size > 3 && is_blank(s->line.contents[3])) {
        uint32_t i = 3;
        while (i < s->line.size && is_blank(s->line.contents[i])) i++;
        if (i < s->line.size && s->line.contents[i] == '"') return emit(lexer, USE_KEYWORD);
      }
      return emit_form(lexer, valid, element_form(s, 0, true, true, true), INGREDIENT_FULL, INGREDIENT_BARE);
    }

    case '&': {
      advance(lexer);
      mark(lexer);
      read_line(s, lexer, NULL, 0);
      return emit_form(lexer, valid, element_form(s, 0, false, false, false), REFERENCE_FULL, REFERENCE_BARE);
    }

    case '~': {
      advance(lexer);
      mark(lexer);
      if (!valid[TIMER_SIGIL]) return fallback(lexer, valid);
      read_line(s, lexer, NULL, 0);
      uint32_t j = free_name_end(s, 0);
      if (j < s->line.size && s->line.contents[j] == '{') return emit(lexer, TIMER_SIGIL);
      return fallback(lexer, valid);
    }

    case '^': {
      advance(lexer);
      mark(lexer);
      if (!valid[TEMPERATURE_SIGIL]) return fallback(lexer, valid);
      read_line(s, lexer, NULL, 0);
      uint32_t j = free_name_end(s, 0);
      if (j < s->line.size && s->line.contents[j] == '{' && find(s, j + 1, '}') >= 0) {
        return emit(lexer, TEMPERATURE_SIGIL);
      }
      return fallback(lexer, valid);
    }

    case '=': {
      advance(lexer);
      mark(lexer);
      if (lexer->lookahead != '{') return valid[TEXT] ? scan_text(lexer, true) : false;
      advance(lexer);
      mark(lexer);
      if (!valid[CHECKPOINT_OPEN]) return fallback(lexer, valid);
      read_line(s, lexer, NULL, 0);
      if (find(s, 0, '}') > 0) return emit(lexer, CHECKPOINT_OPEN);
      return fallback(lexer, valid);
    }

    case '-': {
      advance(lexer);
      mark(lexer);
      if (lexer->lookahead == '>' && (valid[DECL_FULL] || valid[DECL_BARE])) {
        advance(lexer);
        if (lexer->lookahead != '&') {
          mark(lexer);
          return scan_text(lexer, true);
        }
        advance(lexer);
        mark(lexer);
        read_line(s, lexer, NULL, 0);
        return emit_form(lexer, valid, decl_form(s, 0), DECL_FULL, DECL_BARE);
      }
      if (lexer->lookahead == '-' && valid[FRONTMATTER_START]) {
        advance(lexer);
        if (lexer->lookahead != '-') {
          mark(lexer);
          return scan_text(lexer, true);
        }
        advance(lexer);
        mark(lexer);
        if (frontmatter_valid(s, lexer)) return emit(lexer, FRONTMATTER_START);
        return fallback(lexer, valid);
      }
      if (!valid[TEXT]) return false;
      return scan_text(lexer, true);
    }

    case '[': {
      advance(lexer);
      mark(lexer);
      if (!valid[ACTION_OPEN]) {
        if (!valid[TEXT]) return false;
        return scan_text(lexer, true);
      }
      read_line(s, lexer, NULL, 0);
      if (find(s, 0, ']') > 0) return emit(lexer, ACTION_OPEN);
      return fallback(lexer, valid);
    }

    case '/': {
      advance(lexer);
      mark(lexer);
      if (lexer->lookahead == '/') return false; // a line comment: the internal lexer's
      if (lexer->lookahead == '*') {
        advance(lexer);
        if (valid[BLOCK_COMMENT] && scan_block_comment(lexer)) return emit(lexer, BLOCK_COMMENT);
        return fallback(lexer, valid);
      }
      if (!valid[TEXT]) return false;
      return scan_text(lexer, true);
    }

    case '|':
      return false;

    default:
      if (!valid[TEXT]) return false;
      return scan_text(lexer, false);
  }
}

/* Tree-sitter interface */

void *tree_sitter_gram_external_scanner_create(void) {
  Scanner *s = ts_calloc(1, sizeof(Scanner));
  array_init(&s->line);
  return s;
}

void tree_sitter_gram_external_scanner_destroy(void *payload) {
  Scanner *s = payload;
  array_delete(&s->line);
  ts_free(s);
}

unsigned tree_sitter_gram_external_scanner_serialize(void *payload, char *buffer) {
  (void)payload;
  (void)buffer;
  return 0;
}

void tree_sitter_gram_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
  (void)payload;
  (void)buffer;
  (void)length;
}

bool tree_sitter_gram_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
  return scan(payload, lexer, valid_symbols);
}
