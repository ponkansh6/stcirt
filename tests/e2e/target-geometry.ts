import { expect, type Locator } from "./fixtures/test";

export async function expectPrimaryTargetGeometry(locator: Locator, name: string) {
  await locator.scrollIntoViewIfNeeded();

  const geometry = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(centerX, centerY);

    return {
      width: rect.width,
      height: rect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      centerX,
      centerY,
      hitAcceptsTarget: hit === element || (hit !== null && element.contains(hit)),
    };
  });

  expect(geometry.width, `${name} width`).toBeGreaterThanOrEqual(44);
  expect(geometry.height, `${name} height`).toBeGreaterThanOrEqual(44);
  expect(geometry.centerX, `${name} center is in viewport horizontally`).toBeGreaterThanOrEqual(0);
  expect(geometry.centerX, `${name} center is in viewport horizontally`).toBeLessThan(
    geometry.viewportWidth,
  );
  expect(geometry.centerY, `${name} center is in viewport vertically`).toBeGreaterThanOrEqual(0);
  expect(geometry.centerY, `${name} center is in viewport vertically`).toBeLessThan(
    geometry.viewportHeight,
  );
  expect(geometry.hitAcceptsTarget, `${name} center is not occluded`).toBe(true);
}
