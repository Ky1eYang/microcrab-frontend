import { expect, test, type Page } from "@playwright/test";

// Exercise production presentation and styles without a provider/backend fixture.
async function mountImages(page: Page) {
  const errors: string[] = [];
  let omittedRequests = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://example.invalid/omitted-image", (route) => {
    omittedRequests++;
    return route.abort();
  });
  await page.route("**/image-presentation", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<html><body><div id="fixture"></div><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => (type) => type;
window.__vite_plugin_react_preamble_installed__ = true;
const { default: React } = await import('/node_modules/.vite/deps/react.js');
const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
const { ComposerImages } = await import('/src/features/composer/Images.tsx');
const { BlockView } = await import('/src/features/views.tsx');
const { setActiveLocale } = await import('/src/i18n/index.ts');
await import('/src/styles/tokens.css');
await import('/src/styles/chrome.css');
await import('/src/styles/components.css');
setActiveLocale('en');
const h = React.createElement;
const canvas = document.createElement('canvas');
canvas.width = 2400;
canvas.height = 1600;
canvas.getContext('2d').fillRect(0, 0, canvas.width, canvas.height);
const source = canvas.toDataURL('image/png');
const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
const previewUrl = URL.createObjectURL(blob);
const initial = Array.from({length:7}, (_, index) => ({id:'draft-'+index,
  name:'clipboard-'+index+'-long-image-name.png', mediaType:'image/png', previewUrl}));
const block = (id, text, attachments) => ({id, sessionId:'s', messageId:id, partId:'text', role:'user',
  kind:'text', stream:'complete', fold:'auto', isCompact:false, tool:null,
  payload:{text, mime:'text/markdown', formatHint:'markdown', attachments,
    structured:null, content:[], outputPaths:[], providerMetadata:null}});
function Fixture() {
  const [images, setImages] = React.useState(initial);
  return h(React.Fragment, null,
    h('div', {className:'home-composer-box'},
      h(ComposerImages, {images, onRemove:id => setImages(current => current.filter(image => image.id !== id))}),
      h('textarea', {className:'home-composer-textarea', 'aria-label':'Draft text', defaultValue:'Keep this draft'})),
    h('div', {className:'transcript-inner'},
      h(BlockView, {block:block('historical', 'Caption appears once', [
        {partId:'historical-image', mime:'image/png', name:'history.png', url:source},
        {partId:'omitted-image', mime:'image/png', name:'omitted.png', sourceOmitted:true,
          url:'https://example.invalid/omitted-image'},
        {partId:'broken-image', mime:'image/png', name:'broken.png', url:'data:image/png;base64,invalid'}])}),
      h(BlockView, {block:block('optimistic', '', [{partId:'optimistic-image', mime:'image/png', url:previewUrl}])})));
}
ReactDOM.createRoot(document.getElementById('fixture')).render(h(Fixture));
</script></body></html>`,
    }),
  );
  await page.goto("/image-presentation");
  await expect(page.getByTestId("composer-images")).toBeVisible();
  await expect(page.getByTestId("chat-message")).toHaveCount(2);
  expect(errors).toEqual([]);
  return { errors, omittedRequests: () => omittedRequests };
}

for (const width of [390, 1440]) {
  test(`image original preview traps focus, closes with Escape and fits ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const fixture = await mountImages(page);
    const rail = page.getByTestId("composer-images");
    const trigger = rail.getByTestId("image-preview-trigger").first();
    await expect(trigger).toHaveAccessibleName(
      /clipboard-0-long-image-name\.png/,
    );
    await trigger.click();
    const dialog = page.getByTestId("image-preview-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAccessibleName(
      "clipboard-0-long-image-name.png",
    );
    const original = page.getByTestId("image-preview-original");
    await expect
      .poll(() =>
        original.evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBe(2400);
    const close = dialog.getByRole("button");
    await expect(close).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(close).toBeFocused();
    const geometry = await dialog.boundingBox();
    expect(geometry!.x).toBeGreaterThanOrEqual(0);
    expect(geometry!.x + geometry!.width).toBeLessThanOrEqual(width);
    expect(geometry!.y).toBeGreaterThanOrEqual(0);
    expect(geometry!.y + geometry!.height).toBeLessThanOrEqual(844);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(fixture.errors).toEqual([]);
  });
}

test("removing a draft image preserves the editor and other attachments", async ({
  page,
}) => {
  const fixture = await mountImages(page);
  const rail = page.getByTestId("composer-images");
  await expect(rail.getByTestId("image-preview-trigger")).toHaveCount(7);
  await rail.getByTestId("composer-image-remove").first().click();
  await expect(rail.getByTestId("image-preview-trigger")).toHaveCount(6);
  await expect(
    rail.getByTestId("image-preview-trigger").first(),
  ).toHaveAccessibleName(/clipboard-1-long-image-name\.png/);
  await expect(page.getByRole("textbox", { name: "Draft text" })).toHaveValue(
    "Keep this draft",
  );
  expect(fixture.errors).toEqual([]);
});

test("historical and optimistic image payloads render once, with unavailable sources kept inert", async ({
  page,
}) => {
  const fixture = await mountImages(page);
  const messages = page.getByTestId("chat-message");
  await expect(
    messages.first().getByText("Caption appears once", { exact: true }),
  ).toHaveCount(1);
  await expect(messages.first().getByTestId("conversation-images")).toHaveCount(
    1,
  );
  await expect(
    messages.first().getByTestId("image-preview-trigger"),
  ).toHaveCount(1);
  await expect(messages.first().getByTestId("image-unavailable")).toHaveCount(
    2,
  );
  await expect(
    messages.nth(1).getByTestId("image-preview-trigger"),
  ).toHaveCount(1);
  await expect(messages.nth(1).locator(".markdown-body")).toHaveCount(0);
  expect(fixture.omittedRequests()).toBe(0);
  const trigger = messages.nth(1).getByTestId("image-preview-trigger");
  await trigger.click();
  const dialog = page.getByTestId("image-preview-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button").click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(fixture.errors).toEqual([]);
});
