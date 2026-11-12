// Shell IDs must remain addressable even when a document uses the same heading.
const APP_RESERVED_IDS = ["main-content", "app-main", "root"];

/** GitHub-style section IDs: lowercase Unicode text, punctuation removed, spaces become hyphens. */
export function createHeadingSlugger(reserved: Iterable<string> = APP_RESERVED_IDS) {
  const used = new Set(reserved);
  return (text: string): string => {
    const base = text
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
      .replace(/ /g, "-");
    let slug = base;
    let suffix = 0;
    while (used.has(slug)) slug = `${base}-${++suffix}`;
    used.add(slug);
    return slug;
  };
}

type HeadingNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HeadingNode[];
};

function headingText(node: HeadingNode): string {
  if (node.type === "text") return node.value ?? "";
  if (node.tagName === "img") return String(node.properties?.alt ?? "");
  return (node.children ?? []).map(headingText).join("");
}

/** Fresh slug state for every Markdown parse, including editor previews and rerenders. */
export function rehypeHeadingIds({ prefix = "" }: { prefix?: string } = {}) {
  return (tree: HeadingNode) => {
    const reserved: string[] = prefix ? [] : [...APP_RESERVED_IDS];
    const collect = (node: HeadingNode) => {
      if (typeof node.properties?.id === "string") reserved.push(node.properties.id);
      for (const child of node.children ?? []) collect(child);
    };
    collect(tree);
    const slug = createHeadingSlugger(reserved);
    const visit = (node: HeadingNode) => {
      if (/^h[1-6]$/.test(node.tagName ?? "") && !node.properties?.id) {
        node.properties = { ...node.properties, id: slug(headingText(node)) };
      }
      if (prefix && node.properties) {
        if (typeof node.properties.id === "string")
          node.properties.id = prefix + node.properties.id;
        for (const attribute of ["ariaDescribedBy", "ariaLabelledBy"]) {
          const value = node.properties[attribute];
          if (Array.isArray(value))
            node.properties[attribute] = value.map((id) => prefix + String(id));
        }
      }
      for (const child of node.children ?? []) visit(child);
    };
    visit(tree);
  };
}
