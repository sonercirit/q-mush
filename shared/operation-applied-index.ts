import type { AppliedIdentityNode } from "./operation-core";

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
const appliedPriority = (key: string): number => {
  let hash = 2_166_136_261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
};
const rotateLeft = (node: AppliedIdentityNode): AppliedIdentityNode => {
  const right = node.right;
  return right === undefined
    ? node
    : { ...right, left: { ...node, right: right.left } };
};
const rotateRight = (node: AppliedIdentityNode): AppliedIdentityNode => {
  const left = node.left;
  return left === undefined
    ? node
    : { ...left, right: { ...node, left: left.right } };
};

export const setAppliedNode = (
  node: AppliedIdentityNode | undefined,
  key: string,
  value: string,
): AppliedIdentityNode => {
  if (node === undefined)
    return {
      key,
      value,
      priority: appliedPriority(key),
      left: undefined,
      right: undefined,
    };
  const comparison = compareText(key, node.key);
  if (comparison === 0) return { ...node, value };
  if (comparison < 0) {
    const next = { ...node, left: setAppliedNode(node.left, key, value) };
    return next.left.priority < next.priority ? rotateRight(next) : next;
  }
  const next = { ...node, right: setAppliedNode(node.right, key, value) };
  return next.right.priority < next.priority ? rotateLeft(next) : next;
};
