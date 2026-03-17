/**
 * sanitize.js — server-side input sanitization helpers.
 * Strips HTML-significant characters to prevent XSS in any future
 * code path that renders user-supplied strings without escaping.
 */

const HTML_CHARS = /[&<>"']/g;
const HTML_MAP   = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * Escape HTML-significant characters from a string.
 * @param {string} str
 * @returns {string}
 */
function sanitizeText(str) {
  if (typeof str !== 'string') return '';
  return str.replace(HTML_CHARS, c => HTML_MAP[c]);
}

module.exports = { sanitizeText };
