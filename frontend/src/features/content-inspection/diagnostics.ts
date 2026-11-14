export type EditDiagnostic = {
  path?: string;
  message: string;
  severity: "error" | "warning";
  from?: number;
  to?: number;
};
