/**
 * Pure text and colour helpers for the Mission Control surfaces, kept out of the React modules so
 * they can be unit-tested without React Native.
 */

/**
 * A see-through version of a theme colour, for tinted pill and card backgrounds. Paseo themes give
 * hex or rgb() colours; anything else falls back to transparent so the text still reads.
 */
export function tint(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color.trim());
  if (hex) {
    let digits = hex[1] as string;
    if (digits.length === 3) digits = digits.replace(/./g, (c) => c + c);
    const [r, g, b] = [0, 2, 4].map((at) => parseInt(digits.slice(at, at + 2), 16));
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(color.trim());
  if (rgb) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})`;
  return "transparent";
}

/**
 * A shell permission arrives titled "Run <the whole command>". Show it as "Run this command" with
 * the command in a code block, so a long heredoc reads as code instead of a paragraph.
 */
export function presentRequest(title: string, detail: string | null): { title: string; detail: string | null } {
  if (detail === null && title.startsWith("Run ") && title.length > 4) return { title: "Run this command", detail: title.slice(4) };
  return { title, detail };
}

/**
 * The agent's last message, clamped to 8 lines in the card. Markdown marks (`code`, **bold**,
 * # headings, > quotes, list bullets) would show as raw characters in plain text, so they are
 * dropped. Lines inside ``` fences are code and stay as they are, only the fences go.
 */
export function plainSummary(text: string): string {
  return text
    .split(/^```[^\n]*\n?/m)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part
            .replace(/`([^`\n]+)`/g, "$1")
            .replace(/\*\*([^*\n]+)\*\*/g, "$1")
            .replace(/__([^_\n]+)__/g, "$1")
            .replace(/^#{1,6}\s+/gm, "")
            .replace(/^>\s?/gm, "")
            .replace(/^\s*[-*]\s+/gm, "• "),
    )
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
