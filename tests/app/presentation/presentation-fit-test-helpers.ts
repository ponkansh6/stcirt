import { vi } from "vitest";

type Dimensions = { width: number; height: number };

export function installPresentationFitLayout() {
  let viewport: Dimensions = { width: 1280, height: 720 };
  let natural: Dimensions = { width: 1280, height: 400 };
  const observers: TestResizeObserver[] = [];

  class TestResizeObserver implements ResizeObserver {
    private disconnected = false;
    private readonly targets = new Set<Element>();

    constructor(private readonly callback: ResizeObserverCallback) {
      observers.push(this);
    }

    observe(target: Element) {
      this.targets.add(target);
    }

    unobserve(target: Element) {
      this.targets.delete(target);
    }

    disconnect() {
      this.disconnected = true;
      this.targets.clear();
    }

    notify(entries: ResizeObserverEntry[]) {
      if (!this.disconnected) this.callback(entries, this);
    }

    get observedTargets() {
      return this.targets;
    }

    get isDisconnected() {
      return this.disconnected;
    }
  }

  vi.stubGlobal("ResizeObserver", TestResizeObserver);

  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  const originalOffsetWidth = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetWidth",
  )?.get;
  const originalOffsetHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetHeight",
  )?.get;
  const originalScrollHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollHeight",
  )?.get;

  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this.dataset.testid === "presentation-fit-viewport") {
        return {
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          right: viewport.width,
          bottom: viewport.height,
          width: viewport.width,
          height: viewport.height,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return originalRect.call(this);
    },
  );
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.dataset.testid === "presentation-natural-layer"
        ? natural.width
        : (originalOffsetWidth?.call(this) ?? 0);
    },
  );
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.dataset.testid === "presentation-natural-layer"
        ? natural.height
        : (originalOffsetHeight?.call(this) ?? 0);
    },
  );
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.dataset.testid === "presentation-natural-layer"
        ? natural.height
        : (originalScrollHeight?.call(this) ?? 0);
    },
  );

  return {
    setViewport(width: number, height: number) {
      viewport = { width, height };
    },
    setNaturalSize(width: number, height: number) {
      natural = { width, height };
    },
    notifyResize(options: { includeContentBox?: boolean } = {}) {
      for (const observer of observers) {
        if (observer.isDisconnected) continue;
        const entries = Array.from(observer.observedTargets, (target) => {
          const contentBoxSize =
            target.getAttribute("data-testid") === "presentation-fit-viewport"
              ? [{ inlineSize: viewport.width, blockSize: viewport.height }]
              : [{ inlineSize: natural.width, blockSize: natural.height }];
          return {
            target,
            ...(options.includeContentBox === false ? {} : { contentBoxSize }),
          } as unknown as ResizeObserverEntry;
        });
        observer.notify(entries);
      }
    },
  };
}
