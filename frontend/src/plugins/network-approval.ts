import { t } from "../i18n";

let approvalOpen = false;

/** Host-owned top layer. Guest scripts cannot activate its approval button. */
export function approveNetworkGrant(
  plugin: string,
  endpoint: string,
  methods: readonly string[],
  signal: AbortSignal,
): Promise<boolean> {
  if (approvalOpen)
    throw Error("Another plugin network approval is already open");
  signal.throwIfAborted();
  const dialog = document.createElement("dialog");
  dialog.className = "dialog plugin-network-approval";
  const title = document.createElement("h2");
  title.id = "plugin-network-approval-title";
  title.textContent = t("plugins.networkGrantTitle");
  dialog.setAttribute("aria-labelledby", title.id);
  const details = document.createElement("p");
  details.textContent = t("plugins.networkGrantConfirm");
  const pluginName = document.createElement("p");
  pluginName.textContent = plugin;
  const destination = document.createElement("p");
  const address = document.createElement("code");
  address.textContent = endpoint;
  destination.append(address);
  const verbs = document.createElement("code");
  verbs.textContent = methods.join(", ");
  const actions = document.createElement("div");
  actions.className = "dialog-actions";
  const decline = document.createElement("button");
  decline.type = "button";
  decline.className = "ghost-btn";
  decline.textContent = t("plugins.networkGrantDecline");
  decline.autofocus = true;
  const accept = document.createElement("button");
  accept.type = "button";
  accept.className = "primary-btn";
  accept.textContent = t("plugins.networkGrantApprove");
  actions.append(decline, accept);
  dialog.append(title, details, pluginName, destination, verbs, actions);
  return new Promise<boolean>((resolve, reject) => {
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      if (dialog.open) dialog.close();
      dialog.remove();
      approvalOpen = false;
    };
    const finish = (approved: boolean) => {
      cleanup();
      resolve(approved);
    };
    const abort = () => finish(false);
    decline.addEventListener("click", abort);
    accept.addEventListener("click", (event) => {
      if (event.isTrusted) finish(true);
    });
    dialog.addEventListener("keydown", (event) => {
      if (event.key === "Escape") event.stopPropagation();
    });
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(false);
    });
    signal.addEventListener("abort", abort, { once: true });
    approvalOpen = true;
    try {
      document.body.append(dialog);
      dialog.showModal();
    } catch {
      cleanup();
      reject(Error("The Host could not show the network approval dialog"));
    }
  });
}
