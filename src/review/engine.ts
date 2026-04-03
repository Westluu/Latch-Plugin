import * as vscode from "vscode";
import {
  FileReviewSession,
  ReviewBlock,
  ReviewBlockLine
} from "./types";

function cloneReviewBlockLine(line: ReviewBlockLine): ReviewBlockLine {
  return { ...line };
}

export function cloneReviewBlock(block: ReviewBlock): ReviewBlock {
  return {
    ...block,
    originalLines: [...block.originalLines],
    proposedLines: [...block.proposedLines],
    lines: block.lines.map(cloneReviewBlockLine)
  };
}

export function splitReviewLines(text: string): string[] {
  return text.split("\n");
}

export function joinReviewLines(lines: string[]): string {
  return lines.join("\n");
}

export function buildReviewDocumentText(
  baselineLines: string[],
  blocks: ReviewBlock[]
): string {
  const reviewLines: string[] = [];
  let baselineIndex = 0;

  for (const block of blocks) {
    while (baselineIndex < block.startLine) {
      reviewLines.push(baselineLines[baselineIndex] ?? "");
      baselineIndex += 1;
    }

    for (const line of block.lines) {
      reviewLines.push(line.content);
      if (line.type !== "added") {
        baselineIndex += 1;
      }
    }
  }

  while (baselineIndex < baselineLines.length) {
    reviewLines.push(baselineLines[baselineIndex] ?? "");
    baselineIndex += 1;
  }

  return joinReviewLines(reviewLines);
}

export function getReviewBlockOriginalText(block: ReviewBlock): string {
  return joinReviewLines(
    block.lines
      .filter((line) => line.type !== "added")
      .map((line) => line.content)
  );
}

export function getReviewBlockProposedText(block: ReviewBlock): string {
  return joinReviewLines(
    block.lines
      .filter((line) => line.type !== "removed")
      .map((line) => line.content)
  );
}

export function createFileReviewSession(
  editor: vscode.TextEditor,
  workingText: string,
  reviewBlocks: ReviewBlock[]
): FileReviewSession | undefined {
  const baselineText = editor.document.getText();
  if (baselineText === workingText || reviewBlocks.length === 0) {
    return undefined;
  }

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    uri: editor.document.uri,
    languageId: editor.document.languageId,
    baselineText,
    workingText,
    blocks: reviewBlocks.map(cloneReviewBlock),
    selectionStartLine: 0,
    originalLineCount: editor.document.lineCount
  };
}
