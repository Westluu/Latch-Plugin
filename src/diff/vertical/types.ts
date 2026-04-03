import * as vscode from "vscode";

export interface VerticalDiffBlock {
  id: string;
  startLine: number;
  numRed: number;
  numGreen: number;
  originalLines: string[];
  proposedLines: string[];
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
