export const promptLabels = {
  en: {
    title: "Frozen Prompt",
    system: "SYSTEM source",
    emptySystem: "The frozen SYSTEM source is empty.",
    tools: "Declared tools",
    noTools: "No tools were declared in this prompt.",
    declarationsOnly:
      "These are the frozen model-facing declarations, not permissions or evidence that a tool can run.",
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
      "这些是面向模型的冻结声明，不代表权限，也不证明工具可以执行。",
    parameters: "参数模式（JSON）",
    rawSource: "显示原始文本",
    parameterFields: "已声明参数",
    required: "必填",
    noDescription: "未声明说明。",
    noParameterFields: "未列出顶层属性字段。",
    parameterScope: "这里只整理顶层字段；条件和其他约束请查看原始参数模式。",
    parameterLimit: "仅展示前 64 个顶层字段；完整声明请查看原始参数模式。",
    loading: "正在读取冻结提示词…",
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
