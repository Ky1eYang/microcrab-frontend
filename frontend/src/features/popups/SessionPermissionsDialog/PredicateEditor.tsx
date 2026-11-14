import type { Permission, ArgumentPredicate } from "../../../client/types";
import { t } from "../../../i18n";

/** Edit declarative predicates only. The shared runtime compiler owns regex
 * syntax, full-string matching, resource bounds and authorization. */
export function PredicateEditor({
  rules,
  onChange,
  disabled = false,
}: {
  rules: Permission[];
  onChange: (rules: Permission[]) => void;
  disabled?: boolean;
}) {
  const update = (index: number, rule: Permission) =>
    onChange(rules.map((current, at) => (at === index ? rule : current)));
  const predicate = (
    ruleIndex: number,
    index: number,
    next: ArgumentPredicate,
  ) => {
    const rule = rules[ruleIndex];
    update(ruleIndex, {
      ...rule,
      args: (rule.args ?? []).map((current, at) =>
        at === index ? next : current,
      ),
    });
  };
  return (
    <fieldset
      disabled={disabled}
      className="predicate-editor settings-flat-fieldset"
      data-testid="permission-predicate-editor"
    >
      <legend>{t("permission.predicates.title")}</legend>
      <p className="perm-help">{t("permission.predicates.help")}</p>
      {rules.map((rule, ruleIndex) => (
        <div
          className="settings-section"
          key={ruleIndex}
          data-testid="permission-predicate-rule"
        >
          <div className="settings-actions-row">
            <input
              className="settings-input"
              aria-label={t("permission.predicates.agent")}
              placeholder={t("ownerSettings.inherit")}
              value={rule.agent ?? ""}
              onChange={(e) =>
                update(ruleIndex, { ...rule, agent: e.target.value || null })
              }
            />
            <input
              className="settings-input"
              aria-label={t("permission.predicates.mode")}
              placeholder={t("ownerSettings.inherit")}
              value={rule.mode ?? ""}
              onChange={(e) =>
                update(ruleIndex, { ...rule, mode: e.target.value || null })
              }
            />
          </div>
          <label className="settings-form-group">
            {t("permission.predicates.tool")}
            <input
              className="settings-input"
              value={rule.tool?.value ?? ""}
              onChange={(e) =>
                update(ruleIndex, {
                  ...rule,
                  tool: e.target.value
                    ? {
                        kind: rule.tool?.kind === "glob" ? "glob" : "exact",
                        value: e.target.value,
                      }
                    : null,
                })
              }
            />
          </label>
          <select
            className="settings-input"
            aria-label={t("permission.predicates.toolMatcher")}
            value={rule.tool?.kind ?? "exact"}
            onChange={(e) =>
              update(ruleIndex, {
                ...rule,
                tool: {
                  kind: e.target.value as "exact" | "glob",
                  value: rule.tool?.value ?? "",
                },
              })
            }
          >
            <option value="exact">exact</option>
            <option value="glob">glob</option>
          </select>
          <select
            className="settings-input"
            aria-label={t("permission.predicates.action")}
            value={rule.action}
            onChange={(e) =>
              update(ruleIndex, {
                ...rule,
                action: e.target.value as Permission["action"],
              })
            }
          >
            {["allow", "ask", "deny"].map((action) => (
              <option key={action} value={action}>
                {t(`permission.action.${action}`)}
              </option>
            ))}
          </select>
          {(rule.args ?? []).map((arg, index) => (
            <div
              className="settings-section"
              key={index}
              data-testid="permission-predicate-row"
            >
              <label>
                {t("permission.predicates.pointer")}
                <input
                  className="settings-input monospace-text"
                  value={arg.pointer}
                  onChange={(e) =>
                    predicate(ruleIndex, index, {
                      ...arg,
                      pointer: e.target.value,
                    })
                  }
                />
              </label>
              <select
                className="settings-input"
                aria-label={t("permission.predicates.matcher")}
                value={arg.matcher.kind}
                onChange={(e) =>
                  predicate(ruleIndex, index, {
                    ...arg,
                    matcher: {
                      ...arg.matcher,
                      kind: e.target
                        .value as ArgumentPredicate["matcher"]["kind"],
                    },
                  })
                }
              >
                {["exact", "glob", "regex"].map((kind) => (
                  <option key={kind}>{kind}</option>
                ))}
              </select>
              <label>
                {t("permission.predicates.pattern")}
                <input
                  className="settings-input monospace-text"
                  value={arg.matcher.value}
                  onChange={(e) =>
                    predicate(ruleIndex, index, {
                      ...arg,
                      matcher: { ...arg.matcher, value: e.target.value },
                    })
                  }
                />
              </label>
              <button
                type="button"
                className="ghost-btn"
                onClick={() =>
                  update(ruleIndex, {
                    ...rule,
                    args: rule.args?.filter((_, at) => at !== index),
                  })
                }
              >
                {t("ownerSettings.remove")}
              </button>
            </div>
          ))}
          <div className="settings-actions-row">
            <button
              type="button"
              className="ghost-btn"
              disabled={(rule.args?.length ?? 0) >= 16}
              onClick={() =>
                update(ruleIndex, {
                  ...rule,
                  args: [
                    ...(rule.args ?? []),
                    { pointer: "", matcher: { kind: "regex", value: "" } },
                  ],
                })
              }
            >
              {t("permission.predicates.add")}
            </button>
            <button
              type="button"
              className="ghost-btn"
              onClick={() =>
                onChange(rules.filter((_, index) => index !== ruleIndex))
              }
            >
              {t("permission.predicates.removeRule")}
            </button>
          </div>
        </div>
      ))}
      <button
        type="button"
        className="ghost-btn"
        disabled={rules.length >= 256}
        onClick={() =>
          onChange([
            ...rules,
            { tool: { kind: "exact", value: "" }, action: "ask", args: [] },
          ])
        }
      >
        {t("permission.predicates.addRule")}
      </button>
    </fieldset>
  );
}
