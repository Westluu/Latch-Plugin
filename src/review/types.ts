import * as vscode from "vscode";

export type ReviewBlockLineType = "context" | "removed" | "added";

export interface ReviewBlockLine {
  type: ReviewBlockLineType;
  content: string;
}

export interface ReviewBlock {
  id: string;
  startLine: number;
  numRed: number;
  numGreen: number;
  originalLines: string[];
  proposedLines: string[];
  lines: ReviewBlockLine[];
}

export interface PendingReviewBlockView {
  block: ReviewBlock;
  range: vscode.Range;
  previewText: string;
}

export interface FileReviewSession {
  id: string;
  uri: vscode.Uri;
  languageId: string;
  baselineText: string;
  workingText: string;
  blocks: ReviewBlock[];
  selectionStartLine: number;
  originalLineCount: number;
}
