/** Geometria dei test browser: cosa è davvero visibile dentro un contenitore. */
import type { Locator } from "@playwright/test";

/** Un elemento è dentro l'area VISIBILE del contenitore scorrevole. */
export async function insideVisibleArea(inner: Locator, outer: Locator): Promise<boolean> {
  const innerBox = await inner.boundingBox();
  const outerBox = await outer.boundingBox();
  if (!innerBox || !outerBox) return false;
  return (
    innerBox.y >= outerBox.y - 1 && innerBox.y + innerBox.height <= outerBox.y + outerBox.height + 1
  );
}

/** Il contenitore è sul fondo (distanza dalla fine entro la soglia in px). */
export async function scrolledToBottom(container: Locator, threshold = 4): Promise<boolean> {
  return (await container.evaluate((el, limit) => {
    const box = el as HTMLElement;
    return box.scrollHeight - box.scrollTop - box.clientHeight <= limit;
  }, threshold)) as boolean;
}
