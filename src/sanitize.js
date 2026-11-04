/**
 * sanitize.js — server-side cleanup for user-supplied text (names, chat).
 *
 * Text is stored and sent as plain text: every place that renders it escapes
 * it there (browser esc()/escapeHtml()/textContent, esc() in server-rendered
 * pages). HTML-encoding here as well made chat and names show &quot; / &#39;
 * literally, so this only removes control characters.
 */

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * Replace control characters (newlines, tabs, NUL, …) with spaces.
 * @param {string} str
 * @returns {string}
 */
function sanitizeText(str) {
  if (typeof str !== 'string') return '';
  return str.replace(CONTROL_CHARS, ' ');
}

module.exports = { sanitizeText };
