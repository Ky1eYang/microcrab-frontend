import type { ToolPermissionDisplay } from "./tool-permission";

const permissionLabels = {
  allow: {
    tone: "allow",
    en: [
      "Allow",
      "The policy allows this tool; a particular invocation may still be unable to run.",
    ],
    "zh-CN": ["允许", "策略允许使用此工具，但不保证每次调用都能执行。"],
  },
  ask: {
    tone: "ask",
    en: ["Ask", "The configured review or confirmation flow applies."],
    "zh-CN": ["需确认", "适用已配置的审核或确认流程。"],
  },
  deny: {
    tone: "deny",
    en: ["Deny", "The policy denies use of this tool."],
    "zh-CN": ["拒绝", "策略拒绝使用此工具。"],
  },
  conditional: {
    tone: "neutral",
    en: [
      "Depends on arguments",
      "The policy decision depends on the invocation arguments.",
    ],
    "zh-CN": ["视参数而定", "策略判定取决于调用参数。"],
  },
  combined: {
    tone: "neutral",
    en: [
      "Combined policy",
      "Multiple policy layers apply; this is not a single decision.",
    ],
    "zh-CN": ["组合策略", "多层策略共同生效，此标签不代表单一判定。"],
  },
  unregistered: {
    tone: "neutral",
    en: [
      "Not currently registered",
      "No matching active registration was observed; this is not a policy denial.",
    ],
    "zh-CN": ["当前未注册", "未观察到匹配的活动注册；这不表示策略拒绝。"],
  },
  loading: {
    tone: "neutral",
    en: ["Reading policy…", "Checking the current Session policy."],
    "zh-CN": ["正在读取", "正在检查当前会话的权限策略。"],
  },
  unavailable: {
    tone: "neutral",
    en: [
      "Permission unavailable",
      "No fresh current Runtime permission list is available.",
    ],
    "zh-CN": ["权限不可用", "未能读取近期的运行时权限列表。"],
  },
} satisfies Record<
  ToolPermissionDisplay,
  {
    tone: "allow" | "ask" | "deny" | "neutral";
    en: [string, string];
    "zh-CN": [string, string];
  }
>;

function permissionLabel(locale: "en" | "zh-CN") {
  return (status: ToolPermissionDisplay) => {
    const entry = permissionLabels[status];
    const [label, explanation] = entry[locale];
    const scope =
      locale === "en" ? "Current Runtime permission" : "当前运行时权限";
    return { label, explanation: `${scope}: ${explanation}`, tone: entry.tone };
  };
}

export const promptLabels = {
  en: {
    title: "Frozen Prompt",
    system: "SYSTEM source",
    emptySystem: "The frozen SYSTEM source is empty.",
    tools: "Declared tools",
    noTools: "No tools were declared in this prompt.",
    declarationsOnly:
      "Tool declarations are frozen for this epoch. Current Runtime permission badges apply to the live tool with the same name, not its frozen schema, past decisions or whether a tool can run.",
    refreshPermissions: "Refresh permissions",
    permission: permissionLabel("en"),
    parameters: "Parameters schema (JSON)",
    rawSource: "Show exact source",
    parameterFields: "Declared parameters",
    required: "Required",
    noDescription: "No description declared.",
    noParameterFields: "No top-level property fields are listed.",
    parameterScope:
      "This summary shows top-level declarations only. See the original schema for conditions and other constraints.",
    parameterLimit:
      "Showing the first 64 top-level fields. See the original schema for the full declaration.",
    loading: "Reading the frozen prompt…",
    forbidden: "Reading this frozen prompt was not authorized.",
    outOfScope: "The frozen prompt is unavailable in this view.",
    unavailable:
      "No verified frozen prompt is available for this history selection.",
    stale:
      "This history selection is stale. Return to the conversation and reselect the history before reading its prompt.",
    responseLimit: "The frozen prompt exceeds the server’s response limit.",
    failed: "Could not read the frozen prompt.",
    retry: "Read again",
    previous: "Previous declarations",
    next: "Next declarations",
  },
  "zh-CN": {
    title: "冻结提示词",
    system: "SYSTEM 源文本",
    emptySystem: "冻结的 SYSTEM 源文本为空。",
    tools: "已声明的工具",
    noTools: "此提示词未声明任何工具。",
    declarationsOnly:
      "工具声明在此纪元保持冻结。当前运行时权限徽标适用于同名的实时工具，不适用于冻结的参数模式，不代表过去的判定，也不证明工具可以执行。",
    refreshPermissions: "刷新权限",
    permission: permissionLabel("zh-CN"),
    parameters: "参数模式（JSON）",
    rawSource: "显示原始文本",
    parameterFields: "已声明参数",
    required: "必填",
    noDescription: "未声明说明。",
    noParameterFields: "未列出顶层属性字段。",
    parameterScope: "这里只整理顶层字段；条件和其他约束请查看原始参数模式。",
    parameterLimit: "仅展示前 64 个顶层字段；完整声明请查看原始参数模式。",
    loading: "正在读取冻结提示词…",
    forbidden: "无权读取此冻结提示词。",
    outOfScope: "此视图中无法读取冻结提示词。",
    unavailable: "所选历史记录没有经过验证的冻结提示词。",
    stale: "所选历史记录已过期。请返回对话并重新选择历史记录后再读取提示词。",
    responseLimit: "冻结提示词超出服务器的响应大小限制。",
    failed: "无法读取冻结提示词。",
    retry: "重新读取",
    previous: "上一页工具声明",
    next: "下一页工具声明",
  },
};

export type PromptLabels = (typeof promptLabels)[keyof typeof promptLabels];
