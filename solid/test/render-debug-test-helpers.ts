import { vi } from "vitest";

function nodeList(nodes: readonly Node[]): NodeList {
  return {
    entries: () => nodes.entries(),
    forEach: (callback) => {
      nodes.forEach((node, index) => {
        callback(node, index, nodeList(nodes));
      });
    },
    item: (index) => nodes[index] ?? null,
    keys: () => nodes.keys(),
    length: nodes.length,
    values: () => nodes.values(),
    [Symbol.iterator]: () => nodes[Symbol.iterator](),
  };
}

export function createMutationRecord(options: {
  readonly addedNodes?: readonly Node[];
  readonly attributeName?: string;
  readonly removedNodes?: readonly Node[];
  readonly target: Node;
  readonly type: MutationRecordType;
}): MutationRecord {
  return {
    addedNodes: nodeList(options.addedNodes ?? []),
    attributeName: options.attributeName ?? null,
    attributeNamespace: null,
    nextSibling: null,
    oldValue: null,
    previousSibling: null,
    removedNodes: nodeList(options.removedNodes ?? []),
    target: options.target,
    type: options.type,
  };
}

export function installFrames(): {
  readonly flush: (timestamp?: number) => void;
  readonly pending: () => number;
  readonly request: ReturnType<typeof vi.fn>;
} {
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const request = vi
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((callback) => {
      nextFrame += 1;
      callbacks.set(nextFrame, callback);
      return nextFrame;
    });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frame) => {
    callbacks.delete(frame);
  });
  return {
    flush: (timestamp = 0) => {
      const scheduled = [...callbacks.values()];
      callbacks.clear();
      for (const callback of scheduled) {
        callback(timestamp);
      }
    },
    pending: () => callbacks.size,
    request,
  };
}
