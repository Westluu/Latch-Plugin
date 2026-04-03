import * as vscode from "vscode";

export type VerticalDiffBlockLineType = "context" | "removed" | "added";

export interface VerticalDiffBlockLine {
  type: VerticalDiffBlockLineType;
  content: string;
}

export interface VerticalDiffBlock {
  id: string;
  startLine: number;
  numRed: number;
  numGreen: number;
  originalLines: string[];
  proposedLines: string[];
  lines: VerticalDiffBlockLine[];
}

export interface PendingVerticalDiffBlock {
  block: VerticalDiffBlock;
  range: vscode.Range;
  previewText: string;
}

export interface VerticalDiffSession {
  id: string;
  uri: vscode.Uri;
  languageId: string;
  originalText: string;
  proposedText: string;
  blocks: VerticalDiffBlock[];
  selectionStartLine: number;
  originalLineCount: number;
}
