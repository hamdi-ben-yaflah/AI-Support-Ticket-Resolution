import { createHash } from "node:crypto";

import { decode, encode } from "gpt-tokenizer/encoding/cl100k_base";
import matter from "gray-matter";
import type { Content, Heading } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toString } from "mdast-util-to-string";

import { KnowledgeDocumentFrontMatterSchema } from "@/domain/knowledge";
import {
  ParsedKnowledgeDocumentSchema,
  type ParsedChunk,
  type ParsedKnowledgeDocument,
} from "@/ingestion/types";

const MAX_CHUNK_TOKENS = 600;
const TARGET_CHUNK_TOKENS = 500;
const OVERLAP_TOKENS = 75;

type SemanticSection = {
  headingPath: string;
  content: string;
};

function sourceForNode(markdown: string, node: Content): string {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) {
    throw new Error("Markdown parser did not provide stable source positions.");
  }

  return markdown.slice(start, end);
}

function updateHeadingPath(path: string[], heading: Heading): string[] {
  const next = path.slice(0, heading.depth - 1);
  next[heading.depth - 1] = toString(heading).trim();
  return next;
}

function semanticSections(markdown: string): SemanticSection[] {
  const tree = fromMarkdown(markdown);
  const sections: SemanticSection[] = [];
  let path: string[] = [];
  let current: SemanticSection | undefined;

  for (const node of tree.children) {
    if (node.type === "heading") {
      if (current?.content.trim()) sections.push(current);
      path = updateHeadingPath(path, node);
      current = {
        headingPath: path.filter(Boolean).join(" > "),
        content: sourceForNode(markdown, node),
      };
      continue;
    }

    const block = sourceForNode(markdown, node);
    if (!block.trim()) continue;
    if (!current) {
      throw new Error("Knowledge documents must begin with a Markdown heading.");
    }
    current.content += `\n\n${block}`;
  }

  if (current?.content.trim()) sections.push(current);
  if (sections.length === 0) {
    throw new Error("Knowledge document must contain at least one non-empty section.");
  }

  return sections;
}

function tokenize(content: string): number[] {
  return encode(content, { disallowedSpecial: new Set() });
}

function splitSection(section: SemanticSection): Array<Omit<ParsedChunk, "chunkIndex" | "metadata">> {
  const tokens = tokenize(section.content);
  if (tokens.length <= MAX_CHUNK_TOKENS) {
    return [{
      section: section.headingPath,
      content: section.content.trim(),
      tokenCount: tokens.length,
    }];
  }

  const chunks: Array<Omit<ParsedChunk, "chunkIndex" | "metadata">> = [];
  const step = TARGET_CHUNK_TOKENS - OVERLAP_TOKENS;
  for (let start = 0; start < tokens.length; start += step) {
    const slice = tokens.slice(start, Math.min(start + TARGET_CHUNK_TOKENS, tokens.length));
    const content = decode(slice).trim();
    if (content) {
      chunks.push({
        section: section.headingPath,
        content,
        tokenCount: tokenize(content).length,
      });
    }
    if (start + TARGET_CHUNK_TOKENS >= tokens.length) break;
  }

  return chunks;
}

function canonicalInput(metadata: unknown, markdown: string): string {
  return `${JSON.stringify(metadata)}\n${markdown.replace(/\r\n/g, "\n").trim()}\n`;
}

export function parseKnowledgeDocument(
  sourcePath: string,
  rawMarkdown: string,
): ParsedKnowledgeDocument {
  if (!rawMarkdown.trim()) throw new Error("Knowledge document is empty.");

  const parsed = matter(rawMarkdown);
  const frontMatter = KnowledgeDocumentFrontMatterSchema.safeParse(
    parsed.data as unknown,
  );
  if (!frontMatter.success) {
    throw new Error(`Invalid knowledge document front matter in ${sourcePath}.`);
  }
  if (!parsed.content.trim()) {
    throw new Error(`Knowledge document body is empty in ${sourcePath}.`);
  }

  const metadata = frontMatter.data;
  const chunks = semanticSections(parsed.content).flatMap(splitSection).map(
    (chunk, chunkIndex): ParsedChunk => ({
      ...chunk,
      chunkIndex,
      metadata: {
        sourceId: metadata.sourceId,
        category: metadata.category,
        version: metadata.version,
      },
    }),
  );

  return ParsedKnowledgeDocumentSchema.parse({
    sourcePath,
    sourceId: metadata.sourceId,
    title: metadata.title,
    contentHash: createHash("sha256")
      .update(canonicalInput(metadata, parsed.content))
      .digest("hex"),
    metadata: { category: metadata.category, version: metadata.version },
    chunks,
  });
}
