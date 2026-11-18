import { CommandError } from "./errors";
import type {
  ChildTurnOperation,
  ChildTurnRequest,
  ChildTurnScope,
} from "./child-turns";

export interface ChildInputDocument {
  text: string;
  generation: number;
  operation: {
    request: ChildTurnRequest;
    text: string;
    generation: number;
  } | null;
  receipt: ChildTurnOperation | null;
  unknown: boolean;
  status: string;
  error: string;
}
/** Private owner/API-bound memory, never AppState or plugin projection. No effect callbacks survive a view. */
export class ChildInputDocuments {
  private api: object | null = null;
  private owner = "";
  private documents = new Map<string, ChildInputDocument>();
  readonly maximumDocuments = 8;
  readonly maximumDraftCharacters = 262144;
  open(api: object, owner: string, scope: ChildTurnScope): ChildInputDocument {
    if (this.api !== api || this.owner !== owner) {
      this.documents.clear();
      this.api = api;
      this.owner = owner;
    }
    const key = JSON.stringify([scope.parentId, scope.childId]);
    const existing = this.documents.get(key);
    if (existing) return existing;
    if (this.documents.size >= this.maximumDocuments) {
      const vacant = [...this.documents].find(
        ([, document]) => !document.text && !document.operation,
      );
      if (!vacant)
        throw new CommandError(
          "child_draft_capacity",
          "Child draft capacity reached; finish or clear an existing child draft before opening another input",
        );
      this.documents.delete(vacant[0]);
    }
    const document: ChildInputDocument = {
      text: "",
      generation: 0,
      operation: null,
      receipt: null,
      unknown: false,
      status: "",
      error: "",
    };
    this.documents.set(key, document);
    return document;
  }
}
