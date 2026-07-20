/** Hashline read — file content with LINE#HASH: prefixes. */

import { readFileSync, existsSync } from "node:fs";

import { computeLineHash } from "./hash";
import { isImageFile } from "./file-kind";
import { resolveToCwd } from "./path-utils";

export interface HashlineReadResult {
  content: string;
  totalLines: number;
  startLine: number;
  endLine: number;
}

export function hashlineRead(
  filePath: string,
  startLine = 1,
  endLine?: number,
  cwd = process.cwd(),
): HashlineReadResult {
  const resolved = resolveToCwd(filePath, cwd);

  if (!existsSync(resolved)) {
    throw new Error(`File not found: ${filePath}`);
  }

  if (isImageFile(resolved)) {
    throw new Error(`Image files cannot be read as text: ${filePath}`);
  }

  const raw = readFileSync(resolved, "utf-8");
  const allLines = raw.split("\n");
  // Remove trailing empty line from final newline
  if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
    allLines.pop();
  }

  const totalLines = allLines.length;
  const start = Math.max(1, startLine);
  const end = Math.min(totalLines, endLine ?? start + 99);

  if (start > totalLines) {
    return { content: "(empty)", totalLines, startLine: start, endLine: start };
  }

  const selectedLines = allLines.slice(start - 1, end);
  const maxLineNum = String(end).length;

  const formatted = selectedLines
    .map((line, i) => {
      const lineNum = start + i;
      const hash = computeLineHash(allLines, lineNum - 1);
      const paddedNum = String(lineNum).padStart(maxLineNum);
      return `${paddedNum}#${hash}: ${line}`;
    })
    .join("\n");

  return {
    content: formatted,
    totalLines,
    startLine: start,
    endLine: end,
  };
}
