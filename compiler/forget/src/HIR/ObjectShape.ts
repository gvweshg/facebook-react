/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import invariant from "invariant";
import { Effect, ValueKind } from "./HIR";
import {
  BuiltInType,
  FunctionType,
  ObjectType,
  PolyType,
  PrimitiveType,
} from "./Types";

/**
 * This file exports types and defaults for JavaScript object shapes. These are
 * stored and used by a Forget `Environment`. See comments in `Types.ts`,
 * `Globals.ts`, and `Environment.ts` for more details.
 */

const PRIMITIVE_TYPE: PrimitiveType = {
  kind: "Primitive",
};

let nextAnonId = 0;
// We currently use strings for anonymous ShapeIds since they are easily
// debuggable, even though `Symbol()` might be more performant
function createAnonId(): string {
  return `<generated_${nextAnonId++}>`;
}

/**
 * Add a non-hook function to an existing ShapeRegistry.
 *
 * @returns a {@link FunctionType} representing the added function.
 */
export function addFunction(
  registry: ShapeRegistry,
  properties: Iterable<[string, BuiltInType | PolyType]>,
  fn: Omit<FunctionSignature, "hookKind">
): FunctionType {
  const shapeId = createAnonId();
  addShape(registry, shapeId, properties, {
    ...fn,
    hookKind: null,
  });
  return {
    kind: "Function",
    return: fn.returnType,
    shapeId,
  };
}

/**
 * Add a hook to an existing ShapeRegistry.
 *
 * @returns a {@link FunctionType} representing the added hook function.
 */
export function addHook(
  registry: ShapeRegistry,
  properties: Iterable<[string, BuiltInType | PolyType]>,
  fn: FunctionSignature & { hookKind: HookKind }
): FunctionType {
  const shapeId = createAnonId();
  addShape(registry, shapeId, properties, fn);
  return {
    kind: "Function",
    return: fn.returnType,
    shapeId,
  };
}

/**
 * Add an object to an existing ShapeRegistry.
 *
 * @returns an {@link ObjectType} representing the added object.
 */
export function addObject(
  registry: ShapeRegistry,
  id: string | null,
  properties: Iterable<[string, BuiltInType | PolyType]>
): ObjectType {
  const shapeId = id ?? createAnonId();
  addShape(registry, shapeId, properties, null);
  return {
    kind: "Object",
    shapeId,
  };
}

function addShape(
  registry: ShapeRegistry,
  id: string,
  properties: Iterable<[string, BuiltInType | PolyType]>,
  functionType: FunctionSignature | null
): ObjectShape {
  const shape: ObjectShape = {
    properties: new Map(properties),
    functionType,
  };

  invariant(
    !registry.has(id),
    `[ObjectShape] Could not add shape to registry: name ${id} already exists.`
  );
  registry.set(id, shape);
  return shape;
}

export type HookKind =
  | "useContext"
  | "useState"
  | "useRef"
  | "useEffect"
  | "useLayoutEffect"
  | "useMemo"
  | "useCallback"
  | "Custom";

/**
 * Call signature of a function, used for type and effect inference.
 *
 * Note: Param type is not recorded since it currently does not affect inference.
 * Specifically, we currently do not:
 *  - infer types based on their usage in argument position
 *  - handle inference for overloaded / generic functions
 */
export type FunctionSignature = {
  positionalParams: Array<Effect>;
  restParam: Effect | null;
  returnType: BuiltInType | PolyType;
  returnValueKind: ValueKind;
  calleeEffect: Effect;
  hookKind: HookKind | null;
};

/**
 * Shape of an {@link FunctionType} if {@link ObjectShape.functionType} is present,
 * or {@link ObjectType} otherwise.
 *
 * Constructors (e.g. the global `Array` object) and other functions (e.g. `Math.min`)
 * are both represented by {@link ObjectShape.functionType}.
 */
export type ObjectShape = {
  properties: Map<string, BuiltInType | PolyType>;
  functionType: FunctionSignature | null;
};

/**
 * Every valid ShapeRegistry must contain ObjectShape definitions for
 * {@link BuiltInArrayId} and {@link BuiltInObjectId}, since these are the
 * the inferred types for [] and {}.
 */
export type ShapeRegistry = Map<string, ObjectShape>;
export const BuiltInArrayId = "BuiltInArray";
export const BuiltInObjectId = "BuiltInObject";

/**
 * ShapeRegistry with default definitions for built-ins.
 */
export const BUILTIN_SHAPES: ShapeRegistry = new Map();

/* Built-in array shape */
addObject(BUILTIN_SHAPES, BuiltInArrayId, [
  [
    "at",
    addFunction(BUILTIN_SHAPES, [], {
      positionalParams: [Effect.Read],
      restParam: null,
      returnType: { kind: "Poly" },
      calleeEffect: Effect.Read,
      returnValueKind: ValueKind.Mutable,
    }),
  ],
  [
    "concat",
    addFunction(BUILTIN_SHAPES, [], {
      positionalParams: [],
      restParam: Effect.Capture,
      returnType: {
        kind: "Object",
        shapeId: BuiltInArrayId,
      },
      calleeEffect: Effect.Read,
      returnValueKind: ValueKind.Mutable,
    }),
  ],
  ["length", PRIMITIVE_TYPE],
  [
    "push",
    addFunction(BUILTIN_SHAPES, [], {
      positionalParams: [],
      restParam: Effect.Capture,
      returnType: PRIMITIVE_TYPE,
      calleeEffect: Effect.Store,
      returnValueKind: ValueKind.Immutable,
    }),
  ],
  // TODO: rest of Array properties
]);

/* Built-in Object shape */
addObject(BUILTIN_SHAPES, BuiltInObjectId, [
  [
    "toString",
    addFunction(BUILTIN_SHAPES, [], {
      positionalParams: [],
      restParam: null,
      returnType: PRIMITIVE_TYPE,
      calleeEffect: Effect.Read,
      returnValueKind: ValueKind.Immutable,
    }),
  ],
  // TODO:
  // hasOwnProperty, isPrototypeOf, propertyIsEnumerable, toLocaleString, valueOf
]);

export const DefaultMutatingHook = addHook(BUILTIN_SHAPES, [], {
  positionalParams: [],
  restParam: Effect.Mutate,
  returnType: { kind: "Poly" },
  calleeEffect: Effect.Read,
  hookKind: "Custom",
  returnValueKind: ValueKind.Mutable,
});

export const DefaultNonmutatingHook = addHook(BUILTIN_SHAPES, [], {
  positionalParams: [],
  restParam: Effect.Freeze,
  returnType: { kind: "Poly" },
  calleeEffect: Effect.Read,
  hookKind: "Custom",
  returnValueKind: ValueKind.Frozen,
});
