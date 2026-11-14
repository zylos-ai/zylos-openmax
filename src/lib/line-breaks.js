/**
 * Line breaks in text that goes into the C4 envelope.
 *
 * The envelope is line-framed: a sender line (`<name> (<id>) said:`), a
 * context line (`[<name>]: <text>`), a forwarded record (`<name>: <text>`) and
 * each element start at column 0. Text from a message must not be able to
 * start such a line, so every line break a reader may honour is handled the
 * same way everywhere:
 *
 *   - a name, file name or other one-line value: each run of breaks becomes
 *     one space (flattenBreaks);
 *   - message text that keeps its lines: each break continues on a line
 *     indented by two spaces (indentBreaks), so lists and code stay readable.
 *
 * Breaks: CR, LF, CRLF, VT, FF, NEL, U+2028, U+2029.
 */

export const LINE_BREAKS = /(?:\r\n|[\r\n\v\f\u0085\u2028\u2029])+/g;
export const ONE_BREAK = /\r\n|[\r\n\v\f\u0085\u2028\u2029]/g;
// A run of breaks with the spaces around it (joinLines). NEL is not in \s,
// so it is named on both sides.
const BREAKS_WITH_SPACE = /[\s\u0085]*[\r\n\v\f\u0085\u2028\u2029][\s\u0085]*/g;

export const INDENT = '  ';

/** Every line break continues on a line indented by INDENT. */
export const indentBreaks = (s) => String(s).replace(ONE_BREAK, `\n${INDENT}`);

/** Every run of line breaks becomes one space. */
export const flattenBreaks = (s) => String(s).replace(LINE_BREAKS, ' ');

/** All of the text on one line: breaks and the spaces around them become one space, trimmed. */
export const joinLines = (s) => String(s).replace(BREAKS_WITH_SPACE, ' ').trim();
