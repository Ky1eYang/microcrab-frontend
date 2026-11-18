/* Designer review scenarios. Each stages state ONLY through the existing
 * tests/native-fixture.ts backend plus the same payloads the Playwright
 * shot specs use (tests/shots/scenario-data.ts, interaction-polish-fixture,
 * subagent-fixture). No new product states are invented here. */
import { nativeBackend, nativeSnapshot } from "../tests/native-fixture";
import {
  liveToolOutcomes,
  permissionPolicy,
  toolHistory,
} from "../tests/interaction-polish-fixture";
import { subagentSnapshot } from "../tests/subagent-fixture";
import {
  mixedInbox,
  modelFailure,
  permissionRequest,
  roundLimit,
  travelConflict,
  zeroStatistics,
} from "../tests/shots/scenario-data";
import {
  click,
  clickText,
  connectHost,
  expandToolRows,
  fill,
  key,
  motionProbe,
  waitFor,
  waitText,
} from "./driver";

type Page = Parameters<typeof nativeBackend>[0];
type Backend = Awaited<ReturnType<typeof nativeBackend>>;
export type Scenario = {
  title: string;
  /** Before the app boots: create the fixture backend and any extra routes. */
  stage: (page: Page) => Promise<Backend>;
  /** After the app mounted: UI steps that reach the reviewed state. */
  steps?: (backend: Backend) => Promise<void>;
};

const permissionRoute = (
  page: Page,
  opts: { hold?: boolean; review?: boolean } = {},
) =>
  page.route("**/api/v1/sessions/s1/permission", async (route) => {
    if (opts.hold) await new Promise(() => {}); // stays loading for review
    const policy = permissionPolicy();
    if (opts.review)
      (policy.config as any).review_model = {
        provider_id: "retired-provider",
        model: "explicit-review-model",
        variant: "fast",
      };
    await route.fulfill({ json: policy });
  });
const openPermissions = async () => {
  for (
    let i = 0;
    i < 40 && !document.querySelector('[data-testid="session-permissions"]');
    i++
  ) {
    await click('[data-testid="composer-session-permissions"]');
    await new Promise((r) => setTimeout(r, 150));
  }
};
const plain = (page: Page) =>
  nativeBackend(page, {
    extraMethods: ["turn.retry", "inbox.update", "inbox.remove"],
  });

export const SCENARIOS: Record<string, Scenario> = {
  default: {
    title: "Default fixture session (no extra staging)",
    stage: plain,
  },
  "permissions-tools-ready": {
    title: "Session permissions: tools tab ready",
    stage: async (page) => {
      const b = await plain(page);
      await permissionRoute(page);
      return b;
    },
    steps: openPermissions,
  },
  "permissions-review-unavailable": {
    title: "Session permissions: review tab, explicit unavailable model",
    stage: async (page) => {
      const b = await plain(page);
      await permissionRoute(page, { review: true });
      return b;
    },
    steps: async () => {
      await openPermissions();
      await click('[data-testid="session-permission-tab-review"]');
    },
  },
  "permissions-loading": {
    title: "Session permissions: loading (response held)",
    stage: async (page) => {
      const b = await plain(page);
      await permissionRoute(page, { hold: true });
      return b;
    },
    steps: openPermissions,
  },
  "permissions-json-invalid": {
    title: "Session permissions: advanced JSON invalid after Save",
    stage: async (page) => {
      const b = await plain(page);
      await permissionRoute(page);
      return b;
    },
    steps: async () => {
      await openPermissions();
      await click('[data-testid="session-permission-advanced"]');
      await fill(
        '[data-testid="session-permissions"] textarea',
        '{"overrides": [}',
      );
      await click('[data-testid="session-permission-save"]');
    },
  },
  "tools-mixed-status": {
    title: "Tool group: success / unknown / running / failed / cancelled",
    stage: async (page) => {
      const b = await plain(page);
      b.snapshot().session.status = "running";
      b.snapshot().messages = toolHistory();
      return b;
    },
    steps: async (b) => {
      await waitFor('[data-testid="chat-message"]');
      await liveToolOutcomes(b);
      // Opens every group (history + live) so all five statuses are on screen.
      await expandToolRows([
        "succeeded",
        "unknown",
        "running",
        "failed",
        "cancelled",
      ]);
    },
  },
  "tools-running-motion": {
    title:
      "Running tool glyph: compare motion vs DevTools > Rendering > prefers-reduced-motion: reduce (probe bottom-right)",
    stage: async (page) => {
      const b = await plain(page);
      b.snapshot().session.status = "running";
      b.snapshot().messages = toolHistory();
      return b;
    },
    steps: async (b) => {
      await waitFor('[data-testid="chat-message"]');
      await liveToolOutcomes(b);
      await expandToolRows(["running"]);
      motionProbe();
    },
  },
  "permission-request": {
    title: "One-shot permission request (expand resources with the summary)",
    stage: (page) =>
      nativeBackend(page, {
        permissionRequests: [permissionRequest()],
        holdPermissionReply: true,
      }),
    steps: async () => {
      await click('[data-testid="permission-request"] summary');
    },
  },
  "round-limit-tools": {
    title: "Round-limit prompt: tool calls",
    stage: (page) =>
      nativeBackend(page, {
        roundLimitRequests: [roundLimit()],
        holdRoundLimitReply: true,
      }),
  },
  "inbox-mixed-draft": {
    title:
      "Busy session: inbox steer/queue/claimed + draft (resize to 390px for the narrow composer)",
    stage: async (page) => {
      const b = await plain(page);
      b.snapshot().session.status = "running";
      b.snapshot().inbox = mixedInbox() as any;
      return b;
    },
    steps: async () => {
      await connectHost();
      await fill('[data-testid="composer"] textarea', "draft in progress");
    },
  },
  ...Object.fromEntries(
    [
      "running",
      "cancelled",
      "interrupted",
      "failed",
      "succeeded",
      "idle",
      "pending",
      "weird-unknown",
    ].map((status) => [
      `subagent-${status}`,
      {
        title: `SubAgent child execution status: ${status}`,
        stage: async (page: Page) => {
          const b = await plain(page);
          // Open presentation statuses render directly in fixture/main; they
          // must not become invalid NativeExecution.status values on the wire.
          if (!["idle", "pending", "weird-unknown"].includes(status))
            Object.assign(b.snapshot(), subagentSnapshot(status));
          return b;
        },
        steps: async () => {
          await click(".subagent-accordion-group .tool-accordion-group-header");
        },
      } satisfies Scenario,
    ]),
  ),
  "model-picker": {
    title: "Model picker popover",
    stage: plain,
    steps: () => click('[data-testid="composer-model-pill"]'),
  },
  "retry-failure": {
    title:
      "Failed streamed reply with retry action (retry-failure-path staging)",
    stage: async (page) => {
      const b = await plain(page);
      Object.assign(b.snapshot(), {
        ...structuredClone(nativeSnapshot),
        messages: [],
        operations: [],
      });
      return b;
    },
    steps: async (b) => {
      await connectHost();
      await fill(
        '[data-testid="composer"] textarea',
        "A new admitted model failure",
      );
      await key('[data-testid="composer"] textarea', "Enter");
      await waitFor('[data-testid="composer-stop"]');
      // Stop is visible during optimistic submission, before the shim delivers
      // turn.queue. Stage model events only after canonical input admission.
      const deadline = performance.now() + 8000;
      let admission;
      for (;;) {
        admission = b.commands.find((c: any) => c.method === "turn.queue");
        if (
          admission &&
          b
            .snapshot()
            .messages.some(
              (message) =>
                message.id === `user-${admission.params.operation_id}`,
            )
        )
          break;
        if (performance.now() >= deadline) {
          const snapshot = b.snapshot();
          throw new Error(
            `fixture: timed out waiting for turn.queue admission and its canonical user message; commands=${b.commands.map((command: any) => command.method).join(",")}; session=${snapshot.session.status}; messages=${snapshot.messages.length}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const id = admission.params.operation_id;
      const { observation, failure, position } = modelFailure(id);
      b.event("model_observation", { ...observation, phase: "started" });
      b.event("model_observation", {
        ...observation,
        phase: "text_delta",
        text: "Retained failed partial",
      });
      await waitText(".assistant-turn", /Retained failed partial/);
      b.event("model_observation", { ...observation, phase: "invalidated" });
      const snapshot = b.snapshot();
      snapshot.session = {
        ...snapshot.session,
        revision: snapshot.session.revision + 1,
        status: "idle",
        retry_ready: true,
        retry_operation_id: id,
      } as any;
      (snapshot.messages[0] as any).position = position;
      snapshot.operations = [failure as any];
      b.event("turn", failure);
      b.publish(snapshot);
    },
  },
  "undo-failure": {
    title:
      "Undo rejected by the server (409): history kept, real error shown — hover the user message and press Undo again to repeat",
    stage: async (page) => {
      const b = await plain(page);
      (b.snapshot() as any).history_available = { undo: true, redo: false };
      (b.snapshot() as any).history = { checkpoint_id: "head" };
      await page.route("**/api/v1/sessions/s1/history/travel", (route) =>
        route.fulfill({ status: 409, json: travelConflict }),
      );
      return b;
    },
    steps: async () => {
      await connectHost();
      await click('[data-testid="undo-user-block"]');
    },
  },
  "statistics-zero": {
    title: "Statistics: explicit zero measurements (usage popover open)",
    stage: async (page) => {
      const b = await plain(page);
      (b.snapshot() as any).statistics = zeroStatistics();
      return b;
    },
    steps: () => click('[data-testid="statistics-usage"]'),
  },
  "statistics-unknown": {
    title:
      "Statistics: not reported (usage popover open; click Turns for activity)",
    stage: plain,
    steps: () => click('[data-testid="statistics-usage"]'),
  },
  "composer-plus": {
    title: "Composer + menu",
    stage: plain,
    steps: async () => {
      await connectHost();
      await click(
        '.composer-wrapper [aria-haspopup="listbox"], [data-testid="composer"] [aria-haspopup="listbox"]',
      );
    },
  },
  "composer-slash": {
    title:
      "Composer slash menu filtered by /comp (type /zzz for the unknown state)",
    stage: plain,
    steps: async () => {
      await connectHost();
      await fill('[data-testid="composer"] textarea', "/comp");
    },
  },
  "client-tools-error": {
    title:
      "Settings › Client tools: failed execution with concrete Host diagnostics",
    stage: async (page) => {
      const b = await plain(page);
      b.snapshot().executions = [
        {
          execution_id: 23,
          session_id: "s1",
          call_id: "fixture-client-error",
          tool: "question",
          agent: "coding",
          mode: "plan",
          status: "failed",
          capabilities: { input: false },
          failure: {
            kind: "failed",
            code: "unavailable",
            message: "Question interaction unavailable",
            retryable: false,
          },
          diagnostic: {
            code: "unavailable",
            layer: "host",
            phase: "execution",
            effects: "none",
          },
        },
      ];
      return b;
    },
    steps: async () => {
      await connectHost();
      await click(".user-card-btn");
      await clickText("body", /^(设置|Settings)$/);
      await clickText(".settings-dialog", /^(客户端工具|Client tools)$/);
      await waitFor('[data-testid="execution-23"][data-status="failed"]');
      await waitText(
        ".client-tools-settings",
        /Question interaction unavailable/,
      );
    },
  },
  settings: {
    title: "Settings dialog (switch tabs freely)",
    stage: plain,
    steps: async () => {
      await click(".user-card-btn");
      await clickText("body", /^(设置|Settings)$/);
    },
  },
};
