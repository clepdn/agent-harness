/** Hashline edit — hash-anchored file modifications. */

import { readFileSync, existsSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { resolveToCwd } from "./path-utils";
import { applyHashlineEdits } from "./apply";
import { formatHashlineRegion } from "./format";
import type { HashlineEdit } from "./parse";

export interface HashlineEditResult {
  success: boolean;
  message: string;
  preview?: string;
}

function parseAnchor(anchor: string): { line: number; hash: string } | undefined {
  const match = anchor.match(/^(\d+)#([A-Z]+)/);
  if (!match) return undefined;
  return { line: parseInt(match[1], 10), hash: match[2] };
}

export async function hashlineEdit(
  filePath: string,
  edits: Array<{
    op: string;
    pos?: string;
    end?: string;
    lines?: string[];
    oldText?: string;
    newText?: string;
  }>,
  cwd = process.cwd(),
): Promise<HashlineEditResult> {
  const resolved = resolveToCwd(filePath, cwd);

  if (!existsSync(resolved)) {
    return { success: false, message: `File not found: ${filePath}` };
  }

  const content = readFileSync(resolved, "utf-8");

  // Parse anchor strings into Anchor objects
  const parsedEdits: HashlineEdit[] = [];
  for (const edit of edits) {
    if (edit.op === "replace_text") {
      if (!edit.oldText || !edit.newText) {
        return { success: false, message: "replace_text requires oldText and newText" };
      }
      parsedEdits.push({ op: "replace_text", oldText: edit.oldText, newText: edit.newText });
      continue;
    }

    const pos = edit.pos ? parseAnchor(edit.pos) : undefined;
    const end = edit.end ? parseAnchor(edit.end) : undefined;

    if (edit.op === "replace") {
      if (!pos) return { success: false, message: "replace requires pos anchor" };
      parsedEdits.push({ op: "replace", pos, end, lines: edit.lines ?? [] });
    } else if (edit.op === "append") {
      parsedEdits.push({ op: "append", pos, lines: edit.lines ?? [] });
    } else if (edit.op === "prepend") {
      parsedEdits.push({ op: "prepend", pos, lines: edit.lines ?? [] });
    } else {
      return { success: false, message: `Unknown op: ${edit.op}` };
    }
  }

  // Apply edits — applyHashlineEdits takes content as string, returns result with content string
  const result = applyHashlineEdits(content, parsedEdits);

  // Write atomically
  const tmp = join(dirname(resolved), `.${process.pid}-${Date.now()}.tmp`);
  writeFileSync(tmp, result.content, "utf-8");
  renameSync(tmp, resolved);

  // Format preview
  const lines = result.content.split("\n");
  const firstLine = result.firstChangedLine ?? 1;
  const lastLine = result.lastChangedLine ?? lines.length;
  const preview = formatHashlineRegion(lines, firstLine, lastLine);

  return {
    success: true,
    message: `Applied ${parsedEdits.length} edit(s)${result.warnings?.length ? " (with warnings: " + result.warnings.join("; ") + ")" : ""}`,
    preview,
  };
}
