import type { Page } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import { CLIENT_TOOL_DEFINITIONS } from "../src/client/client-tools";
import type {
  ClientBinding,
  ClientInvocation,
} from "../src/client/client-tool-controller";

export async function richQuestion(page: Page, question: string) {
  const call: ClientInvocation = {
    invocation_id: "rich-question",
    parent_session_id: "s1",
    session_id: "s1",
    call_id: "rich-call",
    tool: "ask_user_question",
    arguments: {
      questions: [
        {
          id: "q",
          question,
          options: [
            {
              id: "yes",
              label: "Accept",
              description: "**plain description**",
            },
          ],
        },
      ],
    },
    epoch: 0,
    turn_id: 1,
    round_id: 1,
    catalog_digest: "rich-question-catalog",
    status: "pending",
    created_at_ms: 1,
    deadline_ms: 0,
    interaction: true,
    blocking_mode: "deferred",
  };
  const binding: ClientBinding = {
    role: "executor",
    lease_id: "rich-question-lease",
    catalog_digest: call.catalog_digest,
    definitions: CLIENT_TOOL_DEFINITIONS,
    calls: [call],
    pending: [call],
  };
  return nativeBackend(page, { clientTools: binding });
}

// Synthetic geometry fixture: the deleted original Session payload was unavailable.
export const catSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240" aria-label="Synthetic cat">
  <rect width="240" height="240" fill="#f7f4ee"/>
  <polygon points="70,95 60,35 115,70" fill="#f0a03c" stroke="#8a4b1a" stroke-width="4"/>
  <polygon points="170,95 180,35 125,70" fill="#f0a03c" stroke="#8a4b1a" stroke-width="4"/>
  <ellipse cx="120" cy="130" rx="72" ry="62" fill="#f7b955" stroke="#8a4b1a" stroke-width="4"/>
  <ellipse cx="94" cy="118" rx="10" ry="13" fill="#2b2b2b"/>
  <ellipse cx="146" cy="118" rx="10" ry="13" fill="#2b2b2b"/>
  <path d="M110 145 L130 145 L120 155 Z" fill="#8a4b1a"/>
  <path d="M120 155 Q104 174 92 160 M120 155 Q136 174 148 160" fill="none" stroke="#8a4b1a" stroke-width="3"/>
</svg>`;
