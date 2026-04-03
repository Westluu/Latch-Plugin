import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { VerticalDiffBlock } from "./vertical/types";

const execFileAsync = promisify(execFile);

export interface ParsedHunkLine {
  type: "context" | "add" | "del";
  content: string;
}

export interface ParsedHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: ParsedHunkLine[];
}

export interface ParsedFilePatch {
  oldPath: string | null;
  newPath: string | null;
  hunks: ParsedHunk[];
}

export function buildReviewBlocksFromFilePatch(
  filePatch: ParsedFilePatch
): VerticalDiffBlock[] {
  return filePatch.hunks.map((hunk, index) => ({
    id: `block-${index}`,
    startLine: Math.max(0, hunk.oldStart - 1),
    numRed: hunk.oldCount,
    numGreen: hunk.newCount,
    originalLines: hunk.lines
      .filter((line) => line.type === "del")
      .map((line) => line.content),
    proposedLines: hunk.lines
      .filter((line) => line.type === "add")
      .map((line) => line.content),
    lines: hunk.lines.map((line) => ({
      type:
        line.type === "context"
          ? "context"
          : line.type === "del"
            ? "removed"
            : "added",
      content: line.content
    }))
  }));
}

function normalizePatchPath(value: string | null): string | null {
  if (!value || value === "/dev/null") {
    return value;
  }

  return value.replace(/^a\//, "").replace(/^b\//, "").replace(/\\/g, "/");
}

function parseHunkHeader(line: string): ParsedHunk | undefined {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!match) {
    return undefined;
  }

  return {
    oldStart: Number(match[1]),
    oldCount: Number(match[2] ?? "1"),
    newStart: Number(match[3]),
    newCount: Number(match[4] ?? "1"),
    lines: []
  };
}

export function parseUnifiedDiff(diffText: string): ParsedFilePatch[] {
  const lines = diffText.replace(/\r\n/g, "\n").split("\n");
  const patches: ParsedFilePatch[] = [];
  let currentPatch: ParsedFilePatch | undefined;
  let currentHunk: ParsedHunk | undefined;

  const pushHunk = () => {
    if (currentPatch && currentHunk) {
      currentPatch.hunks.push(currentHunk);
      currentHunk = undefined;
    }
  };

  const pushPatch = () => {
    pushHunk();
    if (currentPatch && currentPatch.hunks.length > 0) {
      patches.push(currentPatch);
    }
    currentPatch = undefined;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      pushPatch();
      currentPatch = { oldPath: null, newPath: null, hunks: [] };
      continue;
    }

    if (line.startsWith("--- ")) {
      currentPatch ??= { oldPath: null, newPath: null, hunks: [] };
      currentPatch.oldPath = normalizePatchPath(line.slice(4).trim());
      continue;
    }

    if (line.startsWith("+++ ")) {
      currentPatch ??= { oldPath: null, newPath: null, hunks: [] };
      currentPatch.newPath = normalizePatchPath(line.slice(4).trim());
      continue;
    }

    if (line.startsWith("@@ ")) {
      if (!currentPatch) {
        continue;
      }

      pushHunk();
      currentHunk = parseHunkHeader(line);
      continue;
    }

    if (!currentHunk || line === "\\ No newline at end of file") {
      continue;
    }

    const prefix = line[0];
    const content = line.slice(1);

    if (prefix === " ") {
      currentHunk.lines.push({ type: "context", content });
    } else if (prefix === "+") {
      currentHunk.lines.push({ type: "add", content });
    } else if (prefix === "-") {
      currentHunk.lines.push({ type: "del", content });
    }
  }

  pushPatch();
  return patches;
}

function matchesDocumentPath(
  documentUri: vscode.Uri,
  filePatch: ParsedFilePatch
): boolean {
  const relativePath = vscode.workspace.asRelativePath(documentUri, false).replace(/\\/g, "/");
  const basename = path.basename(documentUri.fsPath).replace(/\\/g, "/");
  const absolutePath = documentUri.fsPath.replace(/\\/g, "/");
  const candidates = [relativePath, basename, absolutePath];
  const patchPaths = [filePatch.newPath, filePatch.oldPath].filter(
    (value): value is string => !!value && value !== "/dev/null"
  );

  return patchPaths.some((patchPath) =>
    candidates.some(
      (candidate) =>
        candidate === patchPath ||
        candidate.endsWith(`/${patchPath}`) ||
        patchPath.endsWith(`/${candidate}`)
    )
  );
}

export function findPatchForDocument(
  diffText: string,
  documentUri: vscode.Uri
): ParsedFilePatch | undefined {
  return parseUnifiedDiff(diffText).find((filePatch) =>
    matchesDocumentPath(documentUri, filePatch)
  );
}

export function applyPatchToDocumentText(
  originalText: string,
  filePatch: ParsedFilePatch
): string {
  const lines = originalText.replace(/\r\n/g, "\n").split("\n");
  let offset = 0;

  for (const hunk of filePatch.hunks) {
    const startIndex = Math.max(0, hunk.oldStart - 1 + offset);
    const deleteCount = hunk.oldCount;
    const expected = hunk.lines
      .filter((line) => line.type !== "add")
      .map((line) => line.content);
    const replacement = hunk.lines
      .filter((line) => line.type !== "del")
      .map((line) => line.content);
    const actual = lines.slice(startIndex, startIndex + deleteCount);

    if (actual.join("\n") !== expected.join("\n")) {
      throw new Error(
        `Patch context mismatch near line ${hunk.oldStart}. The git diff does not match the active document.`
      );
    }

    lines.splice(startIndex, deleteCount, ...replacement);
    offset += replacement.length - deleteCount;
  }

  return lines.join("\n");
}

export function reversePatchToDocumentText(
  currentText: string,
  filePatch: ParsedFilePatch
): string {
  const lines = currentText.replace(/\r\n/g, "\n").split("\n");
  let offset = 0;

  for (const hunk of filePatch.hunks) {
    const startIndex = Math.max(0, hunk.newStart - 1 + offset);
    const deleteCount = hunk.newCount;
    const expected = hunk.lines
      .filter((line) => line.type !== "del")
      .map((line) => line.content);
    const replacement = hunk.lines
      .filter((line) => line.type !== "add")
      .map((line) => line.content);
    const actual = lines.slice(startIndex, startIndex + deleteCount);

    if (actual.join("\n") !== expected.join("\n")) {
      throw new Error(
        `Patch context mismatch near line ${hunk.newStart}. The active file no longer matches the git diff.`
      );
    }

    lines.splice(startIndex, deleteCount, ...replacement);
    offset += replacement.length - deleteCount;
  }

  return lines.join("\n");
}

export async function getGitDiffForDocument(
  document: vscode.TextDocument
): Promise<string> {
  const cwd = path.dirname(document.uri.fsPath);
  const { stdout: repoRootOutput } = await execFileAsync(
    "git",
    ["rev-parse", "--show-toplevel"],
    { cwd }
  );
  const repoRoot = repoRootOutput.trim();
  const relativePath = path.relative(repoRoot, document.uri.fsPath).replace(/\\/g, "/");
  const { stdout } = await execFileAsync(
    "git",
    ["diff", "--no-ext-diff", "--no-color", "HEAD", "--", relativePath],
    { cwd: repoRoot, maxBuffer: 10 * 1024 * 1024 }
  );

  return stdout;
}
