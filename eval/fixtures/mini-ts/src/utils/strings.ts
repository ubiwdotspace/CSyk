/** "Hello World" → "hello-world". */
export function toKebabCase(text: string): string {
  return text
    .trim()
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase();
}

/** "hello world" → "Hello World". */
export function toTitleCase(text: string): string {
  return text.replace(/\b\w/g, (letter) => letter.toUpperCase());
}
