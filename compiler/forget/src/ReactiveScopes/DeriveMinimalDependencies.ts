import invariant from "invariant";
import { Identifier, ReactiveScopeDependency } from "../HIR";
import { printIdentifier } from "../HIR/PrintHIR";
import { assertExhaustive } from "../Utils/utils";

export type ReactiveScopeDependencyInfo = ReactiveScopeDependency & {
  cond: boolean;
};

/**
 * Finalizes a set of ReactiveScopeDependencies to produce a set of minimal unconditional
 * dependencies, preserving granular accesses when possible.
 *
 * Correctness properties:
 *  - All dependencies to a ReactiveBlock must be tracked.
 *    We can always truncate a dependency's path to a subpath, due to Forget assuming
 *    deep immutability. If the value produced by a subpath has not changed, then
 *    dependency must have not changed.
 *    i.e. props.a === $[..] implies props.a.b === $[..]
 *
 *    Note the inverse is not true, but this only means a false positive (we run the
 *    reactive block more than needed).
 *    i.e. props.a !== $[..] does not imply props.a.b !== $[..]
 *
 *  - The dependencies of a finalized ReactiveBlock must be all safe to access
 *    unconditionally (i.e. preserve program semantics with respect to nullthrows).
 *    If a dependency is only accessed within a conditional, we must track the nearest
 *    unconditionally accessed subpath instead.
 * @param initialDeps
 * @returns
 */
export class ReactiveScopeDependencyTree {
  #roots: Map<Identifier, DependencyNode> = new Map();

  #getOrCreateRoot(identifier: Identifier): DependencyNode {
    // roots can always be accessed unconditionally in JS
    let rootNode = this.#roots.get(identifier);

    if (rootNode === undefined) {
      rootNode = {
        properties: new Map(),
        accessType: PropertyAccessType.UnconditionalAccess,
      };
      this.#roots.set(identifier, rootNode);
    }
    return rootNode;
  }

  add(dep: ReactiveScopeDependencyInfo): void {
    const path = dep.path ?? [];
    let currNode = this.#getOrCreateRoot(dep.identifier);

    const accessType = dep.cond
      ? PropertyAccessType.ConditionalAccess
      : PropertyAccessType.UnconditionalAccess;
    const depType = dep.cond
      ? PropertyAccessType.ConditionalDependency
      : PropertyAccessType.UnconditionalDependency;

    for (const property of path) {
      // all properties read 'on the way' to a dependency are marked as 'access'
      let currChild = currNode.properties.get(property);
      if (currChild == null) {
        currChild = {
          properties: new Map(),
          accessType,
        };
        currNode.properties.set(property, currChild);
      } else {
        currChild.accessType = merge(currChild.accessType, accessType);
      }
      currNode = currChild;
    }

    // final property read should be marked as `dependency`
    currNode.accessType = merge(currNode.accessType, depType);
  }

  deriveMinimalDependencies(): Set<ReactiveScopeDependency> {
    const results = new Set<ReactiveScopeDependency>();
    for (const [rootId, rootNode] of this.#roots.entries()) {
      const deps = deriveMinimalDependenciesInSubtree(rootNode);
      invariant(
        deps.every(
          (dep) => dep.accessType === PropertyAccessType.UnconditionalDependency
        ),
        "[PropagateScopeDependencies] All dependencies must be reduced to unconditional dependencies."
      );

      for (const dep of deps) {
        results.add({
          identifier: rootId,
          path: dep.relativePath,
        });
      }
    }

    return results;
  }

  addDepsFromInnerScope(
    depsFromInnerScope: ReactiveScopeDependencyTree,
    innerScopeInConditionalWithinParent: boolean,
    checkValidDepIdFn: (id: Identifier) => boolean
  ): void {
    for (const [id, otherRoot] of depsFromInnerScope.#roots) {
      if (!checkValidDepIdFn(id)) {
        continue;
      }
      let currRoot = this.#getOrCreateRoot(id);
      addSubtree(currRoot, otherRoot, innerScopeInConditionalWithinParent);
      if (!isUnconditional(currRoot.accessType)) {
        currRoot.accessType = isDependency(currRoot.accessType)
          ? PropertyAccessType.UnconditionalDependency
          : PropertyAccessType.UnconditionalAccess;
      }
    }
  }

  promoteDepsFromExhaustiveConditionals(
    trees: Array<ReactiveScopeDependencyTree>
  ): void {
    invariant(
      trees.length > 1,
      "Expected trees to be at least 2 elements long."
    );

    for (const [id, root] of this.#roots) {
      const nodesForRootId = mapNonNull(trees, (tree) => tree.#roots.get(id));
      if (nodesForRootId) {
        addSubtreeIntersection(
          nodesForRootId.map((root) => root.properties),
          root.properties
        );
      }
    }
  }

  /**
   * Prints dependency tree to string for debugging.
   * @param includeAccesses
   * @returns string representation of DependencyTree
   */
  printDeps(includeAccesses: boolean): string {
    let res = [];

    for (const [rootId, rootNode] of this.#roots.entries()) {
      const rootResults = printSubtree(rootNode, includeAccesses).map(
        (result) => `${printIdentifier(rootId)}.${result}`
      );
      res.push(rootResults);
    }
    return res.flat().join("\n");
  }
}

/**
 * Enum representing the access type of single property on a parent object.
 * We distinguish on two independent axes:
 * Conditional / Unconditional:
 *   - whether this property is accessed unconditionally (within the ReactiveBlock)
 * Access / Dependency:
 *   - Access: this property is read on the path of a dependency. We do not
 *     need to track change variables for accessed properties. Tracking accesses
 *     helps Forget do more granular dependency tracking.
 *   - Dependency: this property is read as a dependency and we must track changes
 *     to it for correctness.
 *
 *   ```javascript
 *   // props.a is a dependency here and must be tracked
 *   deps: {props.a, props.a.b} ---> minimalDeps: {props.a}
 *   // props.a is just an access here and does not need to be tracked
 *   deps: {props.a.b} ---> minimalDeps: {props.a.b}
 *   ```
 */
enum PropertyAccessType {
  ConditionalAccess = "ConditionalAccess",
  UnconditionalAccess = "UnconditionalAccess",
  ConditionalDependency = "ConditionalDependency",
  UnconditionalDependency = "UnconditionalDependency",
}

function isUnconditional(access: PropertyAccessType): boolean {
  return (
    access === PropertyAccessType.UnconditionalAccess ||
    access === PropertyAccessType.UnconditionalDependency
  );
}
function isDependency(access: PropertyAccessType): boolean {
  return (
    access === PropertyAccessType.ConditionalDependency ||
    access === PropertyAccessType.UnconditionalDependency
  );
}

function merge(
  access1: PropertyAccessType,
  access2: PropertyAccessType
): PropertyAccessType {
  const resultIsUnconditional =
    isUnconditional(access1) || isUnconditional(access2);
  const resultIsDependency = isDependency(access1) || isDependency(access2);

  // Straightforward merge.
  // This can be represented as bitwise OR, but is written out for readability
  //
  // Observe that `UnconditionalAccess | ConditionalDependency` produces an
  // unconditionally accessed conditional dependency. We currently use these
  // as we use unconditional dependencies. (i.e. to codegen change variables)
  if (resultIsUnconditional) {
    if (resultIsDependency) {
      return PropertyAccessType.UnconditionalDependency;
    } else {
      return PropertyAccessType.UnconditionalAccess;
    }
  } else {
    if (resultIsDependency) {
      return PropertyAccessType.ConditionalDependency;
    } else {
      return PropertyAccessType.ConditionalAccess;
    }
  }
}

type DependencyNode = {
  properties: Map<string, DependencyNode>;
  accessType: PropertyAccessType;
};

type ReduceResultNode = {
  relativePath: Array<string>;
  accessType: PropertyAccessType;
};

const promoteUncondResult = [
  {
    relativePath: [],
    accessType: PropertyAccessType.UnconditionalDependency,
  },
];

const promoteCondResult = [
  {
    relativePath: [],
    accessType: PropertyAccessType.ConditionalDependency,
  },
];

/**
 * Recursively calculates minimal dependencies in a subtree.
 * @param dep DependencyNode representing a dependency subtree.
 * @returns a minimal list of dependencies in this subtree.
 */
function deriveMinimalDependenciesInSubtree(
  dep: DependencyNode
): Array<ReduceResultNode> {
  const results: Array<ReduceResultNode> = [];
  for (const [childName, childNode] of dep.properties) {
    const childResult = deriveMinimalDependenciesInSubtree(childNode).map(
      ({ relativePath, accessType }) => {
        return {
          relativePath: [childName, ...relativePath],
          accessType,
        };
      }
    );
    results.push(...childResult);
  }

  switch (dep.accessType) {
    case PropertyAccessType.UnconditionalDependency: {
      return promoteUncondResult;
    }
    case PropertyAccessType.UnconditionalAccess: {
      if (
        results.every(
          ({ accessType }) =>
            accessType === PropertyAccessType.UnconditionalDependency
        )
      ) {
        // all children are unconditional dependencies, return them to preserve granularity
        return results;
      } else {
        // at least one child is accessed conditionally, so this node needs to be promoted to
        // unconditional dependency
        return promoteUncondResult;
      }
    }
    case PropertyAccessType.ConditionalAccess:
    case PropertyAccessType.ConditionalDependency: {
      if (
        results.every(
          ({ accessType }) =>
            accessType === PropertyAccessType.ConditionalDependency
        )
      ) {
        // No children are accessed unconditionally, so we cannot promote this node to
        // unconditional access.
        // Truncate results of child nodes here, since we shouldn't access them anyways
        return promoteCondResult;
      } else {
        // at least one child is accessed unconditionally, so this node can be promoted to
        // unconditional dependency
        return promoteUncondResult;
      }
    }
    default: {
      assertExhaustive(
        dep.accessType,
        "[PropgateScopeDependencies] Unhandled access type!"
      );
    }
  }
}

/**
 * Demote all unconditional accesses + dependencies in subtree to the
 * conditional equivalent, mutating subtree in place.
 * @param subtree unconditional node representing a subtree of dependencies
 */
function demoteSubtreeToConditional(subtree: DependencyNode): void {
  const stack: Array<DependencyNode> = [subtree];

  let node;
  while ((node = stack.pop()) !== undefined) {
    const { accessType, properties } = node;
    invariant(isUnconditional(accessType), "");
    node.accessType = isDependency(accessType)
      ? PropertyAccessType.ConditionalDependency
      : PropertyAccessType.ConditionalAccess;

    for (const childNode of properties.values()) {
      if (isUnconditional(accessType)) {
        // No conditional node can have an unconditional node as a child, so
        // we only process childNode if it is unconditional
        stack.push(childNode);
      }
    }
  }
}

/**
 * Calculates currNode = union(currNode, otherNode), mutating currNode in place
 * If demoteOtherNode is specified, we demote the subtree represented by
 * otherNode to conditional access/deps before taking the union.
 *
 * This is a helper function used to join an inner scope to its parent scope.
 * @param currNode (mutable) return by argument
 * @param otherNode (move) {@link addSubtree} takes ownership of the subtree
 * represented by otherNode, which may be mutated or moved to currNode. It is
 * invalid to use otherNode after this call.
 * @param demoteOtherNode
 */
function addSubtree(
  currNode: DependencyNode,
  otherNode: DependencyNode,
  demoteOtherNode: boolean
): void {
  let otherType = otherNode.accessType;
  if (demoteOtherNode) {
    otherType = isDependency(otherType)
      ? PropertyAccessType.ConditionalDependency
      : PropertyAccessType.ConditionalAccess;
  }
  currNode.accessType = merge(currNode.accessType, otherType);

  for (const [propertyName, otherChild] of otherNode.properties) {
    const currChild = currNode.properties.get(propertyName);
    if (currChild) {
      // recursively calculate currChild = union(currChild, otherChild)
      addSubtree(currChild, otherChild, demoteOtherNode);
    } else {
      // if currChild doesn't exist, we can just move otherChild
      // currChild = otherChild.
      if (demoteOtherNode) {
        demoteSubtreeToConditional(otherChild);
      }
      currNode.properties.set(propertyName, otherChild);
    }
  }
}

/**
 * Adds intersection(otherProperties) to currProperties, mutating
 * currProperties in place. i.e.
 *   currProperties = union(currProperties, intersection(otherProperties))
 *
 * Used to merge unconditional accesses from exhaustive conditional branches
 * into the parent ReactiveDeps Tree.
 * intersection(currProperties) is determined as such:
 *  - a node is present in the intersection iff it is present in all every
 *    branch
 *  - the type of an added node is `UnconditionalDependency` if it is a
 *    dependency in at least one branch (otherwise `UnconditionalAccess`)
 *
 * @param otherProperties (read-only) an array of node properties containing
 *        only unconditionally accessed nodes. Each element represents a
 *        subtree of reactive dependencies from a single CFG branch.
 *        otherProperties must represent all reachable branches.
 * @param currProperties (mutable) return by argument properties of a node
 *
 * otherProperties and currProperties must be properties of disjoint nodes
 * that represent the same dependency (identifier + path).
 */
function addSubtreeIntersection(
  otherProperties: Array<Map<string, DependencyNode>>,
  currProperties: Map<string, DependencyNode>
): void {
  invariant(
    otherProperties.length > 1,
    "[DeriveMinimalDependencies] Expected otherProperties to be at least 2 elements long."
  );

  otherProperties.forEach((properties) =>
    properties.forEach((node, _) =>
      invariant(
        !isUnconditional(node.accessType),
        "[DeriveMinimalDependencies] Expected otherProperties to only contain unconditional nodes!"
      )
    )
  );

  for (const [propertyName, currNode] of currProperties) {
    const otherNodes = mapNonNull(otherProperties, (properties) =>
      properties.get(propertyName)
    );

    // intersection(otherNodes[propertyName]) only exists if each element in
    // otherProperties accesses propertyName.
    if (otherNodes) {
      addSubtreeIntersection(
        otherNodes.map((node) => node.properties),
        currNode.properties
      );

      const isDep = otherNodes.some((tree) => isDependency(tree.accessType));
      const externalAccessType = isDep
        ? PropertyAccessType.UnconditionalDependency
        : PropertyAccessType.UnconditionalAccess;
      currNode.accessType = merge(externalAccessType, currNode.accessType);
    }
  }
}

function printSubtree(
  node: DependencyNode,
  includeAccesses: boolean
): Array<string> {
  const results: Array<string> = [];
  for (const [propertyName, propertyNode] of node.properties) {
    if (includeAccesses || isDependency(propertyNode.accessType)) {
      results.push(`${propertyName} (${propertyNode.accessType})`);
    }
    const propertyResults = printSubtree(propertyNode, includeAccesses);
    results.push(
      ...propertyResults.map((result) => `${propertyName}.${result}`)
    );
  }
  return results;
}

function mapNonNull<T extends NonNullable<V>, V, U>(
  arr: Array<U>,
  fn: (arg0: U) => T | undefined | null
): Array<T> | null {
  const result = [];
  for (let i = 0; i < arr.length; i++) {
    const element = fn(arr[i]);
    if (element) {
      result.push(element);
    } else {
      return null;
    }
  }
  return result;
}
