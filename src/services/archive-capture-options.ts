/** SingleFile inserts each entry directly into a regular-expression class. */
export const ARCHIVE_FILENAME_REPLACED_CHARACTERS = [
  "~",
  "+",
  "?",
  "%",
  "*",
  ":",
  "|",
  "\"",
  "<",
  ">",
  "\\\\",
  "\\x00-\\x1f",
  "\\x7F",
] as const;

/** Extension-owned shadow hosts must never become part of a saved web page. */
export const ARCHIVE_EXCLUDED_ELEMENT_SELECTOR = [
  "#__vibesearch_toast_root__",
  "#__vibesearch_picker_root__",
  "#__vibesearch_screenshot_selector__",
].join(",");
