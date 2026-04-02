import * as vscode from "vscode";

export type VerticalDiffHunkStatus = "pending" | "accepted" | "rejected";

export interface VerticalDiffHunk {
  id: string;
  originalStart: number;
  originalEnd: number;
  originalText: string;
  proposedText: string;
  status: VerticalDiffHunkStatus;
}

export interface PendingVerticalDiffBlock {
  hunk: VerticalDiffHunk;
  range: vscode.Range;
  previewText: string;
}

export interface VerticalDiffSession {
  id: string;
  uri: vscode.Uri;
  languageId: string;
  selectionAnchorOffset: number;
  originalText: string;
  proposedText: string;
  currentText: string;
  hunks: VerticalDiffHunk[];
}
