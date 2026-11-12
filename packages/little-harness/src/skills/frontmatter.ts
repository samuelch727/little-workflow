export function parseFrontmatter(markdown: string): { name?: string; description?: string } {
  markdown = markdown.replace(/^\uFEFF/u, "").replace(/\r\n/gu, "\n");
  if (!markdown.startsWith("---\n")) {
    return {};
  }

  const end = markdown.indexOf("\n---", 4);
  if (end === -1) {
    return {};
  }

  const out: { name?: string; description?: string } = {};
  const block = markdown.slice(4, end).split("\n");
  for (const line of block) {
    const match = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }

    const value = match[2]!.replace(/^["']|["']$/g, "");
    if (match[1] === "name") {
      out.name = value;
    }
    if (match[1] === "description") {
      out.description = value;
    }
  }

  return out;
}
