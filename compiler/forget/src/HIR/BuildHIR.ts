/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { NodePath, Scope } from "@babel/traverse";
import * as t from "@babel/types";
import { Expression } from "@babel/types";
import invariant from "invariant";
import { CompilerError, ErrorSeverity } from "../CompilerError";
import { Err, Ok, Result } from "../Utils/Result";
import { assertExhaustive } from "../Utils/utils";
import { Environment, EnvironmentOptions } from "./Environment";
import {
  ArrayPattern,
  BlockId,
  BranchTerminal,
  Case,
  Effect,
  GeneratedSource,
  GotoVariant,
  HIRFunction,
  Identifier,
  IfTerminal,
  InstructionKind,
  InstructionValue,
  JsxAttribute,
  makeInstructionId,
  ObjectPattern,
  ObjectProperty,
  Place,
  ReturnTerminal,
  SourceLocation,
  SpreadPattern,
  ThrowTerminal,
} from "./HIR";
import HIRBuilder from "./HIRBuilder";

// *******************************************************************************************
// *******************************************************************************************
// ************************************* Lowering to HIR *************************************
// *******************************************************************************************
// *******************************************************************************************

/**
 * Lower a function declaration into a control flow graph that models aspects of
 * control flow that are necessary for memoization. Notably, only control flow
 * that occurs at statement granularity is modeled (eg `if`, `for`, `return`
 * statements), not control flow at the expression level (ternaries or boolean
 * short-circuiting). Throw semantics are also not modeled: in general exceptions
 * are treated as exceptional conditions that invalidate memoization.
 *
 * TODO: consider modeling control-flow at expression level for even more fine-
 * grained reactivity.
 */
export function lower(
  func: NodePath<t.Function>,
  options: EnvironmentOptions | null,
  capturedRefs: t.Identifier[] = [],
  // the outermost function being compiled, in case lower() is called recursively (for lambdas)
  parent: NodePath<t.Function> | null = null,
  environment: Environment | null = null
): Result<HIRFunction, CompilerError> {
  const env = environment ?? new Environment(options);
  const builder = new HIRBuilder(env, parent ?? func, capturedRefs);
  const context: Place[] = [];

  for (const ref of capturedRefs ?? []) {
    context.push({
      kind: "Identifier",
      identifier: builder.resolveBinding(ref),
      effect: Effect.Unknown,
      loc: GeneratedSource,
    });
  }

  // Internal babel is on an older version that does not have hasNode (v7.17)
  // See https://github.com/babel/babel/pull/13940/files for impl
  // TODO: write helper function for NodePath.node != null
  let id: Identifier | null = null;
  if (func.isFunctionDeclaration() && func.get("id").node != null) {
    id = builder.resolveIdentifier(func.get("id") as NodePath<t.Identifier>);
  }
  const params: Array<Place> = [];
  func.get("params").forEach((param) => {
    if (param.isIdentifier()) {
      const identifier = builder.resolveIdentifier(param);
      if (identifier === null) {
        builder.errors.push({
          reason: `(BuildHIR::lower) Could not find binding for param '${param.node.name}'`,
          severity: ErrorSeverity.Invariant,
          nodePath: param,
        });
        return;
      }
      const place: Place = {
        kind: "Identifier",
        identifier,
        effect: Effect.Unknown,
        loc: param.node.loc ?? GeneratedSource,
      };
      params.push(place);
    } else if (param.isObjectPattern() || param.isArrayPattern()) {
      const place: Place = {
        kind: "Identifier",
        identifier: builder.makeTemporary(),
        effect: Effect.Unknown,
        loc: param.node.loc ?? GeneratedSource,
      };
      params.push(place);
      lowerAssignment(
        builder,
        param.node.loc ?? GeneratedSource,
        InstructionKind.Let,
        param,
        place
      );
    } else {
      builder.errors.push({
        reason: `(BuildHIR::lower) Handle ${param.node.type} params`,
        severity: ErrorSeverity.Todo,
        nodePath: param,
      });
    }
  });

  const body = func.get("body");
  if (body.isExpression()) {
    const fallthrough = builder.reserve("block");
    const terminal: ReturnTerminal = {
      kind: "return",
      loc: GeneratedSource,
      value: lowerExpressionToTemporary(builder, body),
      id: makeInstructionId(0),
    };
    builder.terminateWithContinuation(terminal, fallthrough);
  } else if (body.isBlockStatement()) {
    lowerStatement(builder, body);
  } else {
    builder.errors.push({
      reason: `(BuildHIR::lower) Unexpected function body kind: ${body.type}}`,
      severity: ErrorSeverity.InvalidInput,
      nodePath: body,
    });
  }

  if (builder.errors.hasErrors()) {
    return Err(builder.errors);
  }

  return Ok({
    id,
    params,
    body: builder.build(),
    context,
    generator: func.node.generator === true,
    async: func.node.async === true,
    loc: func.node.loc ?? GeneratedSource,
    env,
  });
}

/**
 * Helper to lower a statement
 */
function lowerStatement(
  builder: HIRBuilder,
  stmtPath: NodePath<t.Statement>,
  label: string | null = null
): undefined {
  const stmtNode = stmtPath.node;
  switch (stmtNode.type) {
    case "ThrowStatement": {
      const stmt = stmtPath as NodePath<t.ThrowStatement>;
      const value = lowerExpressionToTemporary(builder, stmt.get("argument"));
      const terminal: ThrowTerminal = {
        kind: "throw",
        value,
        id: makeInstructionId(0),
      };
      builder.terminate(terminal, "block");
      return;
    }
    case "ReturnStatement": {
      const stmt = stmtPath as NodePath<t.ReturnStatement>;
      const argument = stmt.get("argument");
      const value =
        argument.node != null
          ? lowerExpressionToTemporary(
              builder,
              argument as NodePath<t.Expression>
            )
          : null;
      const terminal: ReturnTerminal = {
        kind: "return",
        loc: stmt.node.loc ?? GeneratedSource,
        value,
        id: makeInstructionId(0),
      };
      builder.terminate(terminal, "block");
      return;
    }
    case "IfStatement": {
      const stmt = stmtPath as NodePath<t.IfStatement>;
      //  Block for code following the if
      const continuationBlock = builder.reserve("block");
      //  Block for the consequent (if the test is truthy)
      const consequentBlock = builder.enter("block", (_blockId) => {
        lowerStatement(builder, stmt.get("consequent"));
        return {
          kind: "goto",
          block: continuationBlock.id,
          variant: GotoVariant.Break,
          id: makeInstructionId(0),
        };
      });
      //  Block for the alternate (if the test is not truthy)
      let alternateBlock: BlockId;
      const alternate = stmt.get("alternate");
      if (alternate.node != null) {
        alternateBlock = builder.enter("block", (_blockId) => {
          lowerStatement(builder, alternate as NodePath<t.Statement>);
          return {
            kind: "goto",
            block: continuationBlock.id,
            variant: GotoVariant.Break,
            id: makeInstructionId(0),
          };
        });
      } else {
        //  If there is no else clause, use the continuation directly
        alternateBlock = continuationBlock.id;
      }
      const test = lowerExpressionToTemporary(builder, stmt.get("test"));
      const terminal: IfTerminal = {
        kind: "if",
        test,
        consequent: consequentBlock,
        alternate: alternateBlock,
        fallthrough: continuationBlock.id,
        id: makeInstructionId(0),
      };
      builder.terminateWithContinuation(terminal, continuationBlock);
      return;
    }
    case "BlockStatement": {
      const stmt = stmtPath as NodePath<t.BlockStatement>;
      stmt.get("body").forEach((s) => lowerStatement(builder, s));
      return;
    }
    case "BreakStatement": {
      const stmt = stmtPath as NodePath<t.BreakStatement>;
      const block = builder.lookupBreak(stmt.node.label?.name ?? null);
      builder.terminate(
        {
          kind: "goto",
          block,
          variant: GotoVariant.Break,
          id: makeInstructionId(0),
        },
        "block"
      );
      return;
    }
    case "ContinueStatement": {
      const stmt = stmtPath as NodePath<t.ContinueStatement>;
      const block = builder.lookupContinue(stmt.node.label?.name ?? null);
      builder.terminate(
        {
          kind: "goto",
          block,
          variant: GotoVariant.Continue,
          id: makeInstructionId(0),
        },
        "block"
      );
      return;
    }
    case "ForStatement": {
      const stmt = stmtPath as NodePath<t.ForStatement>;

      const testBlock = builder.reserve("loop");
      //  Block for code following the loop
      const continuationBlock = builder.reserve("block");

      const initBlock = builder.enter("loop", (_blockId) => {
        const init = stmt.get("init");
        if (!init.isVariableDeclaration()) {
          builder.errors.push({
            reason:
              "(BuildHIR::lowerStatement) Handle non-variable initialization in ForStatement",
            severity: ErrorSeverity.Todo,
            nodePath: stmt,
          });
          return { kind: "unsupported", id: makeInstructionId(0) };
        }
        lowerStatement(builder, init);
        return {
          kind: "goto",
          block: testBlock.id,
          variant: GotoVariant.Break,
          id: makeInstructionId(0),
        };
      });

      const updateBlock = builder.enter("loop", (_blockId) => {
        const update = stmt.get("update");
        if (update.node == null) {
          builder.errors.push({
            reason: `(BuildHIR::lowerStatement) Handle empty update in ForStatement`,
            severity: ErrorSeverity.Todo,
            nodePath: stmt,
          });
          return { kind: "unsupported", id: makeInstructionId(0) };
        }
        lowerExpressionToTemporary(builder, update as NodePath<t.Expression>);
        return {
          kind: "goto",
          block: testBlock.id,
          variant: GotoVariant.Break,
          id: makeInstructionId(0),
        };
      });

      const bodyBlock = builder.enter("block", (_blockId) => {
        return builder.loop(label, updateBlock, continuationBlock.id, () => {
          lowerStatement(builder, stmt.get("body"));
          return {
            kind: "goto",
            block: updateBlock,
            variant: GotoVariant.Continue,
            id: makeInstructionId(0),
          };
        });
      });

      builder.terminateWithContinuation(
        {
          kind: "for",
          loc: stmtNode.loc ?? GeneratedSource,
          init: initBlock,
          test: testBlock.id,
          update: updateBlock,
          loop: bodyBlock,
          fallthrough: continuationBlock.id,
          id: makeInstructionId(0),
        },
        testBlock
      );

      const test = stmt.get("test");
      if (test.node == null) {
        builder.errors.push({
          reason: `(BuildHIR::lowerStatement) Handle empty test in ForStatement`,
          severity: ErrorSeverity.Todo,
          nodePath: stmt,
        });
      } else {
        builder.terminateWithContinuation(
          {
            kind: "branch",
            test: lowerExpressionToTemporary(
              builder,
              test as NodePath<t.Expression>
            ),
            consequent: bodyBlock,
            alternate: continuationBlock.id,
            id: makeInstructionId(0),
          },
          continuationBlock
        );
      }
      return;
    }
    case "WhileStatement": {
      const stmt = stmtPath as NodePath<t.WhileStatement>;
      //  Block used to evaluate whether to (re)enter or exit the loop
      const conditionalBlock = builder.reserve("loop");
      //  Block for code following the loop
      const continuationBlock = builder.reserve("block");
      //  Loop body
      const loopBlock = builder.enter("block", (_blockId) => {
        return builder.loop(
          label,
          conditionalBlock.id,
          continuationBlock.id,
          () => {
            lowerStatement(builder, stmt.get("body"));
            return {
              kind: "goto",
              block: conditionalBlock.id,
              variant: GotoVariant.Continue,
              id: makeInstructionId(0),
            };
          }
        );
      });
      /**
       * The code leading up to the loop must jump to the conditional block,
       * to evaluate whether to enter the loop or bypass to the continuation.
       */
      const loc = stmt.node.loc ?? GeneratedSource;
      builder.terminateWithContinuation(
        {
          kind: "while",
          loc,
          test: conditionalBlock.id,
          loop: loopBlock,
          fallthrough: continuationBlock.id,
          id: makeInstructionId(0),
        },
        conditionalBlock
      );
      /**
       * The conditional block is empty and exists solely as conditional for
       * (re)entering or exiting the loop
       */
      const test = lowerExpressionToTemporary(builder, stmt.get("test"));
      const terminal: BranchTerminal = {
        kind: "branch",
        test,
        consequent: loopBlock,
        alternate: continuationBlock.id,
        id: makeInstructionId(0),
      };
      //  Complete the conditional and continue with code after the loop
      builder.terminateWithContinuation(terminal, continuationBlock);
      return;
    }
    case "LabeledStatement": {
      const stmt = stmtPath as NodePath<t.LabeledStatement>;
      const label = stmt.node.label.name;
      const body = stmt.get("body");
      switch (body.node.type) {
        case "ForInStatement":
        case "ForOfStatement":
        case "ForStatement":
        case "WhileStatement":
        case "DoWhileStatement": {
          // labeled loops are special because of continue, so push the label
          // down
          lowerStatement(builder, stmt.get("body"), label);
          break;
        }
        default: {
          // All other statements create a continuation block to allow `break`,
          // explicitly *don't* pass the label down
          const continuationBlock = builder.reserve("block");
          builder.label(label, continuationBlock.id, () => {
            lowerStatement(builder, stmt.get("body"));
          });
          builder.terminateWithContinuation(
            {
              kind: "goto",
              block: continuationBlock.id,
              variant: GotoVariant.Break,
              id: makeInstructionId(0),
            },
            continuationBlock
          );
        }
      }
      return;
    }
    case "SwitchStatement": {
      const stmt = stmtPath as NodePath<t.SwitchStatement>;
      //  Block following the switch
      const continuationBlock = builder.reserve("block");
      /**
       * The goto target for any cases that fallthrough, which initially starts
       * as the continuation block and is then updated as we iterate through cases
       * in reverse order.
       */
      let fallthrough = continuationBlock.id;
      /**
       * Iterate through cases in reverse order, so that previous blocks can fallthrough
       * to successors
       */
      const cases: Case[] = [];
      let hasDefault = false;
      for (let ii = stmt.get("cases").length - 1; ii >= 0; ii--) {
        const case_: NodePath<t.SwitchCase> = stmt.get("cases")[ii];
        const testExpr = case_.get("test");
        if (testExpr.node == null) {
          if (hasDefault) {
            builder.errors.push({
              reason:
                "(BuildHIR::lowerStatement) Expected at most one `default` branch in SwitchStatement, this code should have failed to parse",
              severity: ErrorSeverity.InvalidInput,
              nodePath: case_,
            });
            break;
          }
          hasDefault = true;
        }
        const block = builder.enter("block", (_blockId) => {
          return builder.switch(label, continuationBlock.id, () => {
            case_
              .get("consequent")
              .forEach((consequent) => lowerStatement(builder, consequent));
            /**
             * always generate a fallthrough to the next block, this may be dead code
             * if there was an explicit break, but if so it will be pruned later.
             */
            return {
              kind: "goto",
              block: fallthrough,
              variant: GotoVariant.Break,
              id: makeInstructionId(0),
            };
          });
        });
        let test: Place | null = null;
        if (testExpr.node != null) {
          switch (testExpr.node.type) {
            case "Identifier":
            case "StringLiteral":
            case "NumericLiteral":
            case "NullLiteral":
            case "BooleanLiteral":
            case "BigIntLiteral": {
              // ok
              break;
            }
            case "MemberExpression": {
              // A common pattern is switch statements where the case test values are properties of a global,
              // eg `case ProductOptions.Option: { ... }`
              // We therefore allow expressions where the innermost object is a global identifier, and reject
              // all other member expressions (for now).
              const test = testExpr as NodePath<t.MemberExpression>;
              let innerObject: NodePath<t.Expression> = test;
              while (innerObject.isMemberExpression()) {
                innerObject = innerObject.get("object");
              }
              if (
                innerObject.isIdentifier() &&
                builder.resolveIdentifier(innerObject) === null // null means global
              ) {
                // This is a property/computed load from a global, that's safe to evaluate as a test expression
                break;
              }
              builder.errors.push({
                reason:
                  "(BuildHIR::lowerStatement) Switch case test values must be identifiers or primitives, compound values are not yet supported",
                severity: ErrorSeverity.Todo,
                nodePath: testExpr,
              });
              break;
            }
            default: {
              builder.errors.push({
                reason:
                  "(BuildHIR::lowerStatement) Switch case test values must be identifiers or primitives, compound values are not yet supported",
                severity: ErrorSeverity.Todo,
                nodePath: testExpr,
              });
            }
          }
          test = lowerExpressionToTemporary(
            builder,
            testExpr as NodePath<t.Expression>
          );
        }
        cases.push({
          test,
          block,
        });
        fallthrough = block;
      }
      /**
       * it doesn't matter for our analysis purposes, but reverse the order of the cases
       * back to the original to make it match the original code/intent.
       */
      cases.reverse();
      /**
       * If there wasn't an explicit default case, generate one to model the fact that execution
       * could bypass any of the other cases and jump directly to the continuation.
       */
      if (!hasDefault) {
        cases.push({ test: null, block: continuationBlock.id });
      }

      const test = lowerExpressionToTemporary(
        builder,
        stmt.get("discriminant")
      );
      builder.terminateWithContinuation(
        {
          kind: "switch",
          test,
          cases,
          fallthrough: continuationBlock.id,
          id: makeInstructionId(0),
        },
        continuationBlock
      );
      return;
    }
    case "VariableDeclaration": {
      const stmt = stmtPath as NodePath<t.VariableDeclaration>;
      const nodeKind: t.VariableDeclaration["kind"] = stmt.node.kind;
      if (nodeKind === "var") {
        builder.errors.push({
          reason: `(BuildHIR::lowerStatement) Handle ${nodeKind} kinds in VariableDeclaration`,
          severity: ErrorSeverity.Todo,
          nodePath: stmt,
        });
        return;
      }
      const kind =
        nodeKind === "let" ? InstructionKind.Let : InstructionKind.Const;
      for (const declaration of stmt.get("declarations")) {
        const id = declaration.get("id");
        const init = declaration.get("init");
        if (init.node != null) {
          const value = lowerExpressionToTemporary(
            builder,
            init as NodePath<t.Expression>
          );
          lowerAssignment(
            builder,
            stmt.node.loc ?? GeneratedSource,
            kind,
            id,
            value
          );
        } else if (id.isIdentifier()) {
          const loc = stmt.node.loc ?? GeneratedSource;
          const identifier = builder.resolveIdentifier(id);
          if (identifier == null) {
            builder.errors.push({
              reason: `(BuildHIR::lowerAssignment) Could not find binding for declaration.`,
              severity: ErrorSeverity.Invariant,
              nodePath: id,
            });
          } else {
            builder.push({
              id: makeInstructionId(0),
              lvalue: buildTemporaryPlace(builder, loc),
              value: {
                kind: "DeclareLocal",
                lvalue: {
                  kind,
                  place: {
                    effect: Effect.Unknown,
                    identifier,
                    kind: "Identifier",
                    loc: id.node.loc ?? GeneratedSource,
                  },
                },
                loc: id.node.loc ?? GeneratedSource,
              },
              loc,
            });
          }
        } else {
          builder.errors.push({
            reason: `(BuildHIR::lowerStatement) Expected variable declaration to be an identifier if no initializer was provided.`,
            severity: ErrorSeverity.InvalidInput,
            nodePath: stmt,
          });
        }
      }
      return;
    }
    case "ExpressionStatement": {
      const stmt = stmtPath as NodePath<t.ExpressionStatement>;
      const expression = stmt.get("expression");
      lowerExpressionToTemporary(builder, expression);
      return;
    }
    case "DoWhileStatement": {
      const stmt = stmtPath as NodePath<t.DoWhileStatement>;
      //  Block used to evaluate whether to (re)enter or exit the loop
      const conditionalBlock = builder.reserve("loop");
      //  Block for code following the loop
      const continuationBlock = builder.reserve("block");
      //  Loop body, executed at least once uncondtionally prior to exit
      const loopBlock = builder.enter("block", (_loopBlockId) => {
        return builder.loop(
          label,
          conditionalBlock.id,
          continuationBlock.id,
          () => {
            lowerStatement(builder, stmt.get("body"));
            return {
              kind: "goto",
              block: conditionalBlock.id,
              variant: GotoVariant.Continue,
              id: makeInstructionId(0),
            };
          }
        );
      });
      // Jump to the conditional block to evaluate whether to (re)enter the loop or exit to the
      // continuation block.
      const loc = stmt.node.loc ?? GeneratedSource;
      builder.terminateWithContinuation(
        {
          kind: "do-while",
          loc,
          test: conditionalBlock.id,
          loop: loopBlock,
          fallthrough: continuationBlock.id,
          id: makeInstructionId(0),
        },
        conditionalBlock
      );
      /**
       * The conditional block is empty and exists solely as conditional for
       * (re)entering or exiting the loop
       */
      const test = lowerExpressionToTemporary(builder, stmt.get("test"));
      const terminal: BranchTerminal = {
        kind: "branch",
        test,
        consequent: loopBlock,
        alternate: continuationBlock.id,
        id: makeInstructionId(0),
      };
      //  Complete the conditional and continue with code after the loop
      builder.terminateWithContinuation(terminal, continuationBlock);
      return;
    }
    case "ForOfStatement":
    case "ForInStatement":
    case "ClassDeclaration":
    case "DebuggerStatement":
    case "DeclareClass":
    case "DeclareExportAllDeclaration":
    case "DeclareExportDeclaration":
    case "DeclareFunction":
    case "DeclareInterface":
    case "DeclareModule":
    case "DeclareModuleExports":
    case "DeclareOpaqueType":
    case "DeclareTypeAlias":
    case "DeclareVariable":
    case "EmptyStatement":
    case "EnumDeclaration":
    case "ExportAllDeclaration":
    case "ExportDefaultDeclaration":
    case "ExportNamedDeclaration":
    case "FunctionDeclaration":
    case "ImportDeclaration":
    case "InterfaceDeclaration":
    case "OpaqueType":
    case "TryStatement":
    case "TypeAlias":
    case "TSDeclareFunction":
    case "TSEnumDeclaration":
    case "TSExportAssignment":
    case "TSImportEqualsDeclaration":
    case "TSInterfaceDeclaration":
    case "TSModuleDeclaration":
    case "TSNamespaceExportDeclaration":
    case "TSTypeAliasDeclaration":
    case "WithStatement": {
      builder.errors.push({
        reason: `(BuildHIR::lowerStatement) Handle ${stmtPath.type} statements`,
        severity: ErrorSeverity.Todo,
        nodePath: stmtPath,
      });
      builder.push({
        id: makeInstructionId(0),
        lvalue: buildTemporaryPlace(
          builder,
          stmtPath.node.loc ?? GeneratedSource
        ),
        loc: stmtPath.node.loc ?? GeneratedSource,
        value: {
          kind: "UnsupportedNode",
          loc: stmtPath.node.loc ?? GeneratedSource,
          node: stmtPath.node,
        },
      });
      return;
    }
    default: {
      return assertExhaustive(
        stmtNode,
        `Unsupported statement kind '${
          (stmtNode as any as NodePath<t.Statement>).type
        }'`
      );
    }
  }
}

function lowerExpression(
  builder: HIRBuilder,
  exprPath: NodePath<t.Expression>
): InstructionValue {
  const exprNode = exprPath.node;
  const exprLoc = exprNode.loc ?? GeneratedSource;
  switch (exprNode.type) {
    case "Identifier": {
      const expr = exprPath as NodePath<t.Identifier>;
      const place = lowerIdentifier(builder, expr);
      return {
        kind: "LoadLocal",
        place,
        loc: exprLoc,
      };
    }
    case "NullLiteral": {
      return {
        kind: "Primitive",
        value: null,
        loc: exprLoc,
      };
    }
    case "BooleanLiteral":
    case "NumericLiteral":
    case "StringLiteral": {
      const expr = exprPath as NodePath<
        t.StringLiteral | t.BooleanLiteral | t.NumericLiteral
      >;
      const value = expr.node.value;
      return {
        kind: "Primitive",
        value,
        loc: exprLoc,
      };
    }
    case "ObjectExpression": {
      const expr = exprPath as NodePath<t.ObjectExpression>;
      const propertyPaths = expr.get("properties");
      const properties: Array<ObjectProperty | SpreadPattern> = [];
      for (const propertyPath of propertyPaths) {
        if (propertyPath.isObjectProperty()) {
          const key = propertyPath.node.key;
          let keyName: string;
          if (key.type === "Identifier") {
            keyName = key.name;
          } else if (key.type === "StringLiteral") {
            keyName = key.value;
          } else {
            builder.errors.push({
              reason: `(BuildHIR::lowerExpression) Expected Identifier, got ${key.type} key in ObjectExpression`,
              severity: ErrorSeverity.InvalidInput,
              nodePath: propertyPath,
            });
            continue;
          }
          const valuePath = propertyPath.get("value");
          if (!valuePath.isExpression()) {
            builder.errors.push({
              reason: `(BuildHIR::lowerExpression) Handle ${valuePath.type} values in ObjectExpression`,
              severity: ErrorSeverity.Todo,
              nodePath: valuePath,
            });
            continue;
          }
          const value = lowerExpressionToTemporary(builder, valuePath);
          properties.push({
            kind: "ObjectProperty",
            name: keyName,
            place: value,
          });
        } else if (propertyPath.isSpreadElement()) {
          const place = lowerExpressionToTemporary(
            builder,
            propertyPath.get("argument")
          );
          properties.push({
            kind: "Spread",
            place,
          });
        } else {
          builder.errors.push({
            reason: `(BuildHIR::lowerExpression) Handle ${propertyPath.type} properties in ObjectExpression`,
            severity: ErrorSeverity.Todo,
            nodePath: propertyPath,
          });
          continue;
        }
      }
      return {
        kind: "ObjectExpression",
        properties,
        loc: exprLoc,
      };
    }
    case "ArrayExpression": {
      const expr = exprPath as NodePath<t.ArrayExpression>;
      let elements: Array<Place | SpreadPattern> = [];
      for (const element of expr.get("elements")) {
        if (element.node == null) {
          builder.errors.push({
            reason: `(BuildHIR::lowerExpression) Handle ${element.type} elements in ArrayExpression`,
            severity: ErrorSeverity.Todo,
            nodePath: element,
          });
          continue;
        } else if (element.isExpression()) {
          elements.push(lowerExpressionToTemporary(builder, element));
        } else if (element.isSpreadElement()) {
          const place = lowerExpressionToTemporary(
            builder,
            element.get("argument")
          );
          elements.push({ kind: "Spread", place });
        } else {
          builder.errors.push({
            reason: `(BuildHIR::lowerExpression) Handle ${element.type} elements in ArrayExpression`,
            severity: ErrorSeverity.Todo,
            nodePath: element,
          });
          continue;
        }
      }
      return {
        kind: "ArrayExpression",
        elements,
        loc: exprLoc,
      };
    }
    case "NewExpression": {
      const expr = exprPath as NodePath<t.NewExpression>;
      const calleePath = expr.get("callee");
      if (!calleePath.isExpression()) {
        builder.errors.push({
          reason: `(BuildHIR::lowerExpression) Expected Expression, got ${calleePath.type} in NewExpression (v8 intrinsics not supported): ${calleePath.type}`,
          severity: ErrorSeverity.InvalidInput,
          nodePath: calleePath,
        });
        return { kind: "UnsupportedNode", node: exprNode, loc: exprLoc };
      }
      const callee = lowerExpressionToTemporary(builder, calleePath);
      const args = lowerArguments(builder, expr.get("arguments"));

      return {
        kind: "NewExpression",
        callee,
        args,
        loc: exprLoc,
      };
    }
    case "OptionalCallExpression": {
      const expr = exprPath as NodePath<t.OptionalCallExpression>;
      const optional = expr.node.optional;
      const calleePath = expr.get("callee");
      const loc = expr.node.loc ?? GeneratedSource;
      const place = buildTemporaryPlace(builder, loc);
      const continuationBlock = builder.reserve(builder.currentBlockKind());

      // Lower the callee in the current block: the callee is always unconditionally evaluated
      // The test block's branch will test on this value to determine whether to evaluate the call (consequent)
      // or evaluate to undefined (alternate)
      let callee:
        | { kind: "CallExpression"; callee: Place }
        | { kind: "MethodCall"; receiver: Place; property: Place };
      if (
        calleePath.isMemberExpression() ||
        calleePath.isOptionalMemberExpression()
      ) {
        const memberExpr = lowerMemberExpression(builder, calleePath);
        const propertyPlace = buildTemporaryPlace(builder, GeneratedSource);
        builder.push({
          id: makeInstructionId(0),
          lvalue: { ...propertyPlace },
          value: memberExpr.value,
          loc: GeneratedSource,
        });
        callee = {
          kind: "MethodCall",
          receiver: memberExpr.object,
          property: propertyPlace,
        };
      } else {
        callee = {
          kind: "CallExpression",
          callee: lowerExpressionToTemporary(builder, calleePath),
        };
      }

      // block to evaluate if the callee is non-null/undefined. arguments are lowered in this block to preserve
      // the semantic of conditional evaluation depending on the callee
      const consequent = builder.enter("value", () => {
        const args = lowerArguments(builder, expr.get("arguments"));
        const temp = buildTemporaryPlace(builder, loc);
        if (callee.kind === "CallExpression") {
          builder.push({
            id: makeInstructionId(0),
            lvalue: { ...temp },
            value: {
              kind: "CallExpression",
              callee: { ...callee.callee },
              args,
              loc,
            },
            loc,
          });
        } else {
          builder.push({
            id: makeInstructionId(0),
            lvalue: { ...temp },
            value: {
              kind: "MethodCall",
              receiver: { ...callee.receiver },
              property: { ...callee.property },
              args,
              loc: exprLoc,
            },
            loc,
          });
        }
        builder.push({
          id: makeInstructionId(0),
          lvalue: buildTemporaryPlace(builder, loc),
          value: {
            kind: "StoreLocal",
            lvalue: { kind: InstructionKind.Const, place: { ...place } },
            value: { ...temp },
            loc,
          },
          loc,
        });
        return {
          kind: "goto",
          variant: GotoVariant.Break,
          block: continuationBlock.id,
          id: makeInstructionId(0),
        };
      });

      // block to evaluate if the callee is null/undefined, this sets the result of the call to undefined.
      const alternate = builder.enter("value", () => {
        const temp = buildTemporaryPlace(builder, loc);
        builder.push({
          id: makeInstructionId(0),
          lvalue: { ...temp },
          value: {
            kind: "Primitive",
            value: undefined,
            loc,
          },
          loc,
        });
        builder.push({
          id: makeInstructionId(0),
          lvalue: buildTemporaryPlace(builder, loc),
          value: {
            kind: "StoreLocal",
            lvalue: { kind: InstructionKind.Const, place: { ...place } },
            value: { ...temp },
            loc,
          },
          loc,
        });
        return {
          kind: "goto",
          variant: GotoVariant.Break,
          block: continuationBlock.id,
          id: makeInstructionId(0),
        };
      });

      const testBlock = builder.enter("value", () => {
        const testPlace =
          callee.kind === "CallExpression" ? callee.callee : callee.property;
        return {
          kind: "branch",
          test: { ...testPlace },
          consequent,
          alternate,
          id: makeInstructionId(0),
          loc,
        };
      });

      builder.terminateWithContinuation(
        {
          kind: "optional-call",
          optional,
          test: testBlock,
          fallthrough: continuationBlock.id,
          id: makeInstructionId(0),
          loc,
        },
        continuationBlock
      );

      return { kind: "LoadLocal", place, loc: place.loc };
    }
    case "CallExpression": {
      const expr = exprPath as NodePath<t.CallExpression>;
      const calleePath = expr.get("callee");
      if (!calleePath.isExpression()) {
        builder.errors.push({
          reason: `(BuildHIR::lowerExpression) Expected Expression, got ${calleePath.type} in CallExpression (v8 intrinsics not supported)`,
          severity: ErrorSeverity.InvalidInput,
          nodePath: calleePath,
        });
        return { kind: "UnsupportedNode", node: exprNode, loc: exprLoc };
      }
      if (calleePath.isMemberExpression()) {
        const memberExpr = lowerMemberExpression(builder, calleePath);
        const propertyPlace = buildTemporaryPlace(builder, GeneratedSource);
        builder.push({
          id: makeInstructionId(0),
          lvalue: { ...propertyPlace },
          value: memberExpr.value,
          loc: GeneratedSource,
        });
        const args = lowerArguments(builder, expr.get("arguments"));
        return {
          kind: "MethodCall",
          receiver: memberExpr.object,
          property: { ...propertyPlace },
          args,
          loc: exprLoc,
        };
      } else {
        const callee = lowerExpressionToTemporary(builder, calleePath);
        const args = lowerArguments(builder, expr.get("arguments"));
        return {
          kind: "CallExpression",
          callee,
          args,
          loc: exprLoc,
        };
      }
    }
    case "BinaryExpression": {
      const expr = exprPath as NodePath<t.BinaryExpression>;
      const leftPath = expr.get("left");
      if (!leftPath.isExpression()) {
        builder.errors.push({
          reason: `(BuildHIR::lowerExpression) Expected Expression, got ${leftPath.type} lval in BinaryExpression`,
          severity: ErrorSeverity.InvalidInput,
          nodePath: leftPath,
        });
        return { kind: "UnsupportedNode", node: exprNode, loc: exprLoc };
      }
      const left = lowerExpressionToTemporary(builder, leftPath);
      const right = lowerExpressionToTemporary(builder, expr.get("right"));
      const operator = expr.node.operator;
      return {
        kind: "BinaryExpression",
        operator,
        left,
        right,
        loc: exprLoc,
      };
    }
    case "SequenceExpression": {
      const expr = exprPath as NodePath<t.SequenceExpression>;
      const exprLoc = expr.node.loc ?? GeneratedSource;

      let last: Place | null = null;
      for (const item of expr.get("expressions")) {
        last = lowerExpressionToTemporary(builder, item);
      }
      if (last === null) {
        builder.errors.push({
          reason: `(BuildHIR::lowerExpression) Expected SequenceExpression to have at least one expression`,
          severity: ErrorSeverity.InvalidInput,
          nodePath: expr,
        });
        return { kind: "UnsupportedNode", node: expr.node, loc: exprLoc };
      }
      return {
        kind: "LoadLocal", // TODO: LoadTemp
        place: last,
        loc: last.loc,
      };
    }
    case "ConditionalExpression": {
      const expr = exprPath as NodePath<t.ConditionalExpression>;
      const exprLoc = expr.node.loc ?? GeneratedSource;

      //  Block for code following the if
      const continuationBlock = builder.reserve(builder.currentBlockKind());
      const testBlock = builder.reserve("value");
      const place = buildTemporaryPlace(builder, exprLoc);

      //  Block for the consequent (if the test is truthy)
      const consequentBlock = builder.enter("value", (_blockId) => {
        const consequent = lowerExpressionToTemporary(
          builder,
          expr.get("consequent")
        );
        builder.push({
          id: makeInstructionId(0),
          lvalue: buildTemporaryPlace(builder, exprLoc),
          value: {
            kind: "StoreLocal",
            lvalue: { kind: InstructionKind.Const, place: { ...place } },
            value: consequent,
            loc: exprLoc,
          },
          loc: exprLoc,
        });
        return {
          kind: "goto",
          block: continuationBlock.id,
          variant: GotoVariant.Break,
          id: makeInstructionId(0),
        };
      });
      //  Block for the alternate (if the test is not truthy)
      const alternateBlock = builder.enter("value", (_blockId) => {
        const alternate = lowerExpressionToTemporary(
          builder,
          expr.get("alternate")
        );
        builder.push({
          id: makeInstructionId(0),
          lvalue: buildTemporaryPlace(builder, exprLoc),
          value: {
            kind: "StoreLocal",
            lvalue: { kind: InstructionKind.Const, place: { ...place } },
            value: alternate,
            loc: exprLoc,
          },
          loc: exprLoc,
        });
        return {
          kind: "goto",
          block: continuationBlock.id,
          variant: GotoVariant.Break,
          id: makeInstructionId(0),
        };
      });

      builder.terminateWithContinuation(
        {
          kind: "ternary",
          fallthrough: continuationBlock.id,
          id: makeInstructionId(0),
          test: testBlock.id,
          loc: exprLoc,
        },
        testBlock
      );
      const testPlace = lowerExpressionToTemporary(builder, expr.get("test"));
      builder.terminateWithContinuation(
        {
          kind: "branch",
          test: { ...testPlace },
          consequent: consequentBlock,
          alternate: alternateBlock,
          id: makeInstructionId(0),
        },
        continuationBlock
      );
      return { kind: "LoadLocal", place, loc: place.loc };
    }
    case "LogicalExpression": {
      const expr = exprPath as NodePath<t.LogicalExpression>;
      const exprLoc = expr.node.loc ?? GeneratedSource;
      const continuationBlock = builder.reserve(builder.currentBlockKind());
      const testBlock = builder.reserve("value");
      const place = buildTemporaryPlace(builder, exprLoc);
      const leftPlace = buildTemporaryPlace(
        builder,
        expr.get("left").node.loc ?? GeneratedSource
      );
      const consequent = builder.enter("value", () => {
        builder.push({
          id: makeInstructionId(0),
          lvalue: buildTemporaryPlace(builder, leftPlace.loc),
          value: {
            kind: "StoreLocal",
            lvalue: { kind: InstructionKind.Const, place: { ...place } },
            value: { ...leftPlace },
            loc: leftPlace.loc,
          },
          loc: exprLoc,
        });
        return {
          kind: "goto",
          block: continuationBlock.id,
          variant: GotoVariant.Break,
          id: makeInstructionId(0),
        };
      });
      const alternate = builder.enter("value", () => {
        const right = lowerExpressionToTemporary(builder, expr.get("right"));
        builder.push({
          id: makeInstructionId(0),
          lvalue: buildTemporaryPlace(builder, right.loc),
          value: {
            kind: "StoreLocal",
            lvalue: { kind: InstructionKind.Const, place: { ...place } },
            value: { ...right },
            loc: right.loc,
          },
          loc: exprLoc,
        });
        return {
          kind: "goto",
          block: continuationBlock.id,
          variant: GotoVariant.Break,
          id: makeInstructionId(0),
        };
      });
      builder.terminateWithContinuation(
        {
          kind: "logical",
          fallthrough: continuationBlock.id,
          id: makeInstructionId(0),
          test: testBlock.id,
          operator: expr.node.operator,
          loc: exprLoc,
        },
        testBlock
      );
      const leftValue = lowerExpressionToTemporary(builder, expr.get("left"));
      builder.push({
        id: makeInstructionId(0),
        lvalue: { ...leftPlace },
        value: {
          kind: "LoadLocal",
          place: leftValue,
          loc: exprLoc,
        },
        loc: exprLoc,
      });
      builder.terminateWithContinuation(
        {
          kind: "branch",
          test: { ...leftPlace },
          consequent,
          alternate,
          id: makeInstructionId(0),
        },
        continuationBlock
      );
      return { kind: "LoadLocal", place, loc: place.loc };
    }
    case "AssignmentExpression": {
      const expr = exprPath as NodePath<t.AssignmentExpression>;
      const operator = expr.node.operator;

      if (operator === "=") {
        const left = expr.get("left");
        return lowerAssignment(
          builder,
          left.node.loc ?? GeneratedSource,
          InstructionKind.Reassign,
          left,
          lowerExpressionToTemporary(builder, expr.get("right"))
        );
      }

      const operators: { [key: string]: t.BinaryExpression["operator"] } = {
        "+=": "+",
        "-=": "-",
        "/=": "/",
        "%=": "%",
        "*=": "*",
        "**=": "**",
        "&=": "&",
        "|=": "|",
        ">>=": ">>",
        ">>>=": ">>>",
        "<<=": "<<",
        "^=": "^",
      };
      const binaryOperator = operators[operator];
      if (binaryOperator == null) {
        builder.errors.push({
          reason: `(BuildHIR::lowerExpression) Handle ${operator} operators in AssignmentExpression`,
          severity: ErrorSeverity.Todo,
          nodePath: expr.get("operator"),
        });
        return { kind: "UnsupportedNode", node: exprNode, loc: exprLoc };
      }
      const left = expr.get("left");
      const leftNode = left.node;
      switch (leftNode.type) {
        case "Identifier": {
          const leftExpr = left as NodePath<t.Identifier>;
          const identifier = lowerIdentifier(builder, leftExpr);
          const leftPlace = lowerExpressionToTemporary(builder, leftExpr);
          const right = lowerExpressionToTemporary(builder, expr.get("right"));
          const binaryPlace = buildTemporaryPlace(builder, exprLoc);
          builder.push({
            id: makeInstructionId(0),
            lvalue: {
              ...binaryPlace,
            },
            value: {
              kind: "BinaryExpression",
              operator: binaryOperator,
              left: leftPlace,
              right,
              loc: exprLoc,
            },
            loc: exprLoc,
          });
          const result = buildTemporaryPlace(builder, exprLoc);
          builder.push({
            id: makeInstructionId(0),
            lvalue: { ...result },
            value: {
              kind: "StoreLocal",
              lvalue: {
                place: { ...identifier },
                kind: InstructionKind.Reassign,
              },
              value: { ...binaryPlace },
              loc: exprLoc,
            },
            loc: exprLoc,
          });
          return { kind: "LoadLocal", place: identifier, loc: exprLoc };
        }
        case "MemberExpression": {
          // a.b.c += <right>
          const leftExpr = left as NodePath<t.MemberExpression>;
          const { object, property, value } = lowerMemberExpression(
            builder,
            leftExpr
          );

          // Store the previous value to a temporary
          const previousValuePlace: Place = buildTemporaryPlace(
            builder,
            exprLoc
          );
          builder.push({
            id: makeInstructionId(0),
            lvalue: {
              ...previousValuePlace,
            },
            value,
            loc: leftExpr.node.loc ?? GeneratedSource,
          });
          // Store the new value to a temporary
          const newValuePlace: Place = buildTemporaryPlace(builder, exprLoc);
          builder.push({
            id: makeInstructionId(0),
            lvalue: {
              ...newValuePlace,
            },
            value: {
              kind: "BinaryExpression",
              operator: binaryOperator,
              left: { ...previousValuePlace },
              right: lowerExpressionToTemporary(builder, expr.get("right")),
              loc: leftExpr.node.loc ?? GeneratedSource,
            },
            loc: leftExpr.node.loc ?? GeneratedSource,
          });

          // Save the result back to the property
          if (typeof property === "string") {
            return {
              kind: "PropertyStore",
              object: { ...object },
              property,
              value: { ...newValuePlace },
              loc: leftExpr.node.loc ?? GeneratedSource,
            };
          } else {
            return {
              kind: "ComputedStore",
              object: { ...object },
              property: { ...property },
              value: { ...newValuePlace },
              loc: leftExpr.node.loc ?? GeneratedSource,
            };
          }
        }
        default: {
          builder.errors.push({
            reason: `(BuildHIR::lowerExpression) Expected Identifier or MemberExpression, got ${expr.type} lval in AssignmentExpression`,
            severity: ErrorSeverity.InvalidInput,
            nodePath: expr,
          });
          return { kind: "UnsupportedNode", node: exprNode, loc: exprLoc };
        }
      }
    }
    case "OptionalMemberExpression":
    case "MemberExpression": {
      const expr = exprPath as NodePath<
        t.MemberExpression | t.OptionalMemberExpression
      >;
      const { value } = lowerMemberExpression(builder, expr);
      const place: Place = buildTemporaryPlace(builder, exprLoc);
      builder.push({
        id: makeInstructionId(0),
        lvalue: { ...place },
        value,
        loc: exprLoc,
      });
      return { kind: "LoadLocal", place, loc: place.loc };
    }
    case "JSXElement": {
      const expr = exprPath as NodePath<t.JSXElement>;
      const opening = expr.get("openingElement");
      const tag = lowerJsxElementName(builder, opening.get("name"));
      const children = expr
        .get("children")
        .map((child) => lowerJsxElement(builder, child));
      const props: Array<JsxAttribute> = [];
      for (const attribute of opening.get("attributes")) {
        if (attribute.isJSXSpreadAttribute()) {
          const argument = lowerExpressionToTemporary(
            builder,
            attribute.get("argument")
          );
          props.push({ kind: "JsxSpreadAttribute", argument });
          continue;
        }
        if (!attribute.isJSXAttribute()) {
          builder.errors.push({
            reason: `(BuildHIR::lowerExpression) Handle ${attribute.type} attributes in JSXElement`,
            severity: ErrorSeverity.Todo,
            nodePath: attribute,
          });
          continue;
        }
        const name = attribute.get("name");
        if (!name.isJSXIdentifier()) {
          builder.errors.push({
            reason: `(BuildHIR::lowerExpression) Handle ${name.type} attribute names in JSXElement`,
            severity: ErrorSeverity.Todo,
            nodePath: name,
          });
          continue;
        }
        const valueExpr = attribute.get("value");
        let value;
        if (valueExpr.isJSXElement() || valueExpr.isStringLiteral()) {
          value = lowerExpressionToTemporary(builder, valueExpr);
        } else {
          if (!valueExpr.isJSXExpressionContainer()) {
            builder.errors.push({
              reason: `(BuildHIR::lowerExpression) Handle ${valueExpr.type} attribute values in JSXElement`,
              severity: ErrorSeverity.Todo,
              nodePath: valueExpr,
            });
            continue;
          }
          const expression = valueExpr.get("expression");
          if (!expression.isExpression()) {
            builder.errors.push({
              reason: `(BuildHIR::lowerExpression) Handle ${expression.type} expressions in JSXExpressionContainer within JSXElement`,
              severity: ErrorSeverity.Todo,
              nodePath: valueExpr,
            });
            continue;
          }
          value = lowerExpressionToTemporary(builder, expression);
        }
        const prop: string = name.node.name;
        props.push({ kind: "JsxAttribute", name: prop, place: value });
      }
      return {
        kind: "JsxExpression",
        tag,
        props,
        children: children.length === 0 ? null : children,
        loc: exprLoc,
      };
    }
    case "JSXFragment": {
      const expr = exprPath as NodePath<t.JSXFragment>;
      const children = expr
        .get("children")
        .map((child) => lowerJsxElement(builder, child));
      return {
        kind: "JsxFragment",
        children,
        loc: exprLoc,
      };
    }
    case "ArrowFunctionExpression":
    case "FunctionExpression": {
      const expr = exprPath as NodePath<
        t.FunctionExpression | t.ArrowFunctionExpression
      >;
      let name: string | null = null;
      if (expr.isFunctionExpression()) {
        name = expr.get("id")?.node?.name ?? null;
      }
      const componentScope: Scope = expr.scope.parent.getFunctionParent()!;
      const captured = gatherCapturedDeps(builder, expr, componentScope);

      // TODO(gsn): In the future, we could only pass in the context identifiers
      // that are actually used by this function and it's nested functions, rather
      // than all context identifiers.
      //
      // This isn't a problem in practice because use Babel's scope analysis to
      // identify the correct references.
      const lowering = lower(
        expr,
        builder.environment.options,
        [...builder.context, ...captured.identifiers],
        builder.parentFunction,
        builder.environment
      );
      let loweredFunc: HIRFunction;
      if (lowering.isErr()) {
        lowering
          .unwrapErr()
          .details.forEach((detail) => builder.errors.pushErrorDetail(detail));
        return {
          kind: "UnsupportedNode",
          node: exprNode,
          loc: exprLoc,
        };
      }
      loweredFunc = lowering.unwrap();
      return {
        kind: "FunctionExpression",
        name,
        loweredFunc,
        dependencies: captured.refs,
        expr: expr.node,
        loc: exprLoc,
      };
    }
    case "TaggedTemplateExpression": {
      const expr = exprPath as NodePath<t.TaggedTemplateExpression>;
      if (expr.get("quasi").get("expressions").length !== 0) {
        builder.errors.push({
          reason:
            "(BuildHIR::lowerExpression) Handle tagged template with interpolations",
          severity: ErrorSeverity.Todo,
          nodePath: exprPath,
        });
        return { kind: "UnsupportedNode", node: exprNode, loc: exprLoc };
      }
      invariant(
        expr.get("quasi").get("quasis").length == 1,
        "there should be only one quasi as we don't support interpolations yet"
      );
      const value = expr.get("quasi").get("quasis").at(0)!.node.value;
      if (value.raw !== value.cooked) {
        builder.errors.push({
          reason:
            "(BuildHIR::lowerExpression) Handle tagged template where cooked value is different from raw value",
          severity: ErrorSeverity.Todo,
          nodePath: exprPath,
        });
        return { kind: "UnsupportedNode", node: exprNode, loc: exprLoc };
      }

      return {
        kind: "TaggedTemplateExpression",
        tag: lowerExpressionToTemporary(builder, expr.get("tag")),
        value,
        loc: exprLoc,
      };
    }
    case "TemplateLiteral": {
      const expr = exprPath as NodePath<t.TemplateLiteral>;
      const subexprs = expr.get("expressions");
      const quasis = expr.get("quasis");

      if (subexprs.length !== quasis.length - 1) {
        builder.errors.push({
          reason: `(BuildHIR::lowerExpression) Unexpected quasi and subexpression lengths in TemplateLiteral.`,
          severity: ErrorSeverity.InvalidInput,
          nodePath: exprPath,
        });
        return { kind: "UnsupportedNode", node: exprNode, loc: exprLoc };
      }

      if (subexprs.some((e) => !e.isExpression())) {
        builder.errors.push({
          reason: `(BuildHIR::lowerAssignment) Handle TSType in TemplateLiteral.`,
          severity: ErrorSeverity.Todo,
          nodePath: exprPath,
        });
        return { kind: "UnsupportedNode", node: exprNode, loc: exprLoc };
      }

      const subexprPlaces = subexprs.map((e) =>
        lowerExpressionToTemporary(builder, e as NodePath<t.Expression>)
      );

      return {
        kind: "TemplateLiteral",
        subexprs: subexprPlaces,
        quasis: expr.get("quasis").map((q) => q.node.value),
        loc: exprLoc,
      };
    }
    case "UnaryExpression": {
      let expr = exprPath as NodePath<t.UnaryExpression>;
      if (expr.node.operator === "delete") {
        const argument = expr.get("argument");
        if (argument.isMemberExpression()) {
          const { object, property } = lowerMemberExpression(builder, argument);
          if (typeof property === "string") {
            return {
              kind: "PropertyDelete",
              object,
              property,
              loc: exprLoc,
            };
          } else {
            return {
              kind: "ComputedDelete",
              object,
              property,
              loc: exprLoc,
            };
          }
        } else {
          builder.errors.push({
            reason: `(BuildHIR::lowerExpression) delete on a non-member expression has no semantic meaning`,
            severity: ErrorSeverity.InvalidInput,
            nodePath: expr,
          });
          return { kind: "UnsupportedNode", node: expr.node, loc: exprLoc };
        }
      } else {
        return {
          kind: "UnaryExpression",
          operator: expr.node.operator,
          value: lowerExpressionToTemporary(builder, expr.get("argument")),
          loc: exprLoc,
        };
      }
    }
    case "TypeCastExpression": {
      let expr = exprPath as NodePath<t.TypeCastExpression>;
      return {
        kind: "TypeCastExpression",
        value: lowerExpressionToTemporary(builder, expr.get("expression")),
        type: expr.get("typeAnnotation").node,
        loc: exprLoc,
      };
    }
    case "UpdateExpression": {
      let expr = exprPath as NodePath<t.UpdateExpression>;
      const argument = expr.get("argument");
      if (!argument.isIdentifier()) {
        builder.errors.push({
          reason: `(BuildHIR::lowerExpression) Handle UpdateExpression with ${argument.type} argument`,
          severity: ErrorSeverity.Todo,
          nodePath: exprPath,
        });
        return { kind: "UnsupportedNode", node: exprNode, loc: exprLoc };
      }
      if (expr.node.prefix) {
        builder.errors.push({
          reason: `(BuildHIR::lowerExpression) Handle prefix UpdateExpression`,
          severity: ErrorSeverity.Todo,
          nodePath: exprPath,
        });
        return { kind: "UnsupportedNode", node: exprNode, loc: exprLoc };
      }
      const primitiveTemp = buildTemporaryPlace(
        builder,
        expr.node.loc ?? GeneratedSource
      );
      builder.push({
        id: makeInstructionId(0),
        lvalue: { ...primitiveTemp },
        value: {
          kind: "Primitive",
          value: 1,
          loc: expr.node.loc ?? GeneratedSource,
        },
        loc: expr.node.loc ?? GeneratedSource,
      });
      const temp = buildTemporaryPlace(
        builder,
        expr.node.loc ?? GeneratedSource
      );
      const identifier = lowerIdentifier(
        builder,
        argument as NodePath<t.Identifier>
      );
      builder.push({
        id: makeInstructionId(0),
        lvalue: { ...temp },
        value: {
          kind: "BinaryExpression",
          operator: expr.node.operator === "++" ? "+" : "-",
          left: { ...identifier },
          right: { ...primitiveTemp },
          loc: exprLoc,
        },
        loc: exprLoc,
      });
      builder.push({
        id: makeInstructionId(0),
        lvalue: buildTemporaryPlace(builder, exprLoc),
        value: {
          kind: "StoreLocal",
          lvalue: { place: { ...identifier }, kind: InstructionKind.Reassign },
          value: { ...temp },
          loc: exprLoc,
        },
        loc: exprLoc,
      });
      return {
        kind: "LoadLocal",
        place: { ...identifier },
        loc: exprLoc,
      };
    }
    default: {
      builder.errors.push({
        reason: `(BuildHIR::lowerExpression) Handle ${exprPath.type} expressions`,
        severity: ErrorSeverity.Todo,
        nodePath: exprPath,
      });
      return { kind: "UnsupportedNode", node: exprNode, loc: exprLoc };
    }
  }
}

function lowerArguments(
  builder: HIRBuilder,
  expr: Array<
    NodePath<
      | t.Expression
      | t.SpreadElement
      | t.JSXNamespacedName
      | t.ArgumentPlaceholder
    >
  >
): Array<Place | SpreadPattern> {
  let args: Array<Place | SpreadPattern> = [];
  for (const argPath of expr) {
    if (argPath.isSpreadElement()) {
      args.push({
        kind: "Spread",
        place: lowerExpressionToTemporary(builder, argPath.get("argument")),
      });
    } else if (argPath.isExpression()) {
      args.push(lowerExpressionToTemporary(builder, argPath));
    } else {
      builder.errors.push({
        reason: `(BuildHIR::lowerExpression) Handle ${argPath.type} arguments in CallExpression`,
        severity: ErrorSeverity.Todo,
        nodePath: argPath,
      });
    }
  }
  return args;
}

function lowerMemberExpression(
  builder: HIRBuilder,
  expr: NodePath<t.MemberExpression | t.OptionalMemberExpression>
): { object: Place; property: Place | string; value: InstructionValue } {
  const exprNode = expr.node;
  const exprLoc = exprNode.loc ?? GeneratedSource;
  const object = lowerExpressionToTemporary(builder, expr.get("object"));
  const property = expr.get("property");
  if (!expr.node.computed) {
    if (!property.isIdentifier()) {
      builder.errors.push({
        reason: `(BuildHIR::lowerMemberExpression) Handle ${property.type} property`,
        severity: ErrorSeverity.Todo,
        nodePath: property,
      });
      return {
        object,
        property: property.toString(),
        value: { kind: "UnsupportedNode", node: exprNode, loc: exprLoc },
      };
    }
    const value: InstructionValue = {
      kind: "PropertyLoad",
      object: { ...object },
      property: property.node.name,
      loc: exprLoc,
      optional: expr.node.optional ?? false,
    };
    return { object, property: property.node.name, value };
  } else {
    if (!property.isExpression()) {
      builder.errors.push({
        reason: `(BuildHIR::lowerMemberExpression) Expected Expression, got ${property.type} property`,
        severity: ErrorSeverity.InvalidInput,
        nodePath: property,
      });
      return {
        object,
        property: property.toString(),
        value: {
          kind: "UnsupportedNode",
          node: exprNode,
          loc: exprLoc,
        },
      };
    }
    if (t.isOptionalMemberExpression(expr)) {
      builder.errors.push({
        reason: `(BuildHIR::lowerMemberExpression) Handle computed OptionalMemberExpression`,
        severity: ErrorSeverity.Todo,
        nodePath: expr,
      });
    }
    const propertyPlace = lowerExpressionToTemporary(builder, property);
    const value: InstructionValue = {
      kind: "ComputedLoad",
      object: { ...object },
      property: { ...propertyPlace },
      loc: exprLoc,
    };
    return { object, property: propertyPlace, value };
  }
}

function lowerJsxElementName(
  builder: HIRBuilder,
  exprPath: NodePath<
    t.JSXIdentifier | t.JSXMemberExpression | t.JSXNamespacedName
  >
): Place {
  const exprNode = exprPath.node;
  const exprLoc = exprNode.loc ?? GeneratedSource;
  if (exprPath.isJSXIdentifier()) {
    const tag: string = exprPath.node.name;
    if (tag.match(/^[A-Z]/)) {
      return lowerIdentifier(builder, exprPath);
    } else {
      const place: Place = buildTemporaryPlace(builder, exprLoc);
      builder.push({
        id: makeInstructionId(0),
        value: {
          kind: "Primitive",
          value: tag,
          loc: exprLoc,
        },
        loc: exprLoc,
        lvalue: { ...place },
      });
      return place;
    }
  } else if (exprPath.isJSXMemberExpression()) {
    return lowerJsxMemberExpression(builder, exprPath);
  } else {
    builder.errors.push({
      reason: `(BuildHIR::lowerJsxElementName) Handle ${exprPath.type} tags`,
      severity: ErrorSeverity.Todo,
      nodePath: exprPath,
    });
    const place: Place = buildTemporaryPlace(builder, exprLoc);
    builder.push({
      id: makeInstructionId(0),
      value: {
        kind: "UnsupportedNode",
        node: exprNode,
        loc: exprLoc,
      },
      loc: exprLoc,
      lvalue: { ...place },
    });
    return { ...place };
  }
}

function lowerJsxMemberExpression(
  builder: HIRBuilder,
  exprPath: NodePath<t.JSXMemberExpression>
): Place {
  const loc = exprPath.node.loc ?? GeneratedSource;
  const object = exprPath.get("object");
  let objectPlace: Place;
  if (object.isJSXMemberExpression()) {
    objectPlace = lowerJsxMemberExpression(builder, object);
  } else {
    invariant(
      object.isJSXIdentifier(),
      "TypeScript refinement fail: expected 'JsxIdentifier', got '%s'",
      object.node.type
    );
    objectPlace = lowerIdentifier(builder, object);
  }
  const place = buildTemporaryPlace(builder, loc);
  const property = exprPath.get("property").node.name;
  builder.push({
    id: makeInstructionId(0),
    lvalue: { ...place },
    value: {
      kind: "PropertyLoad",
      object: objectPlace,
      property,
      optional: false,
      loc,
    },
    loc,
  });
  return place;
}

function lowerJsxElement(
  builder: HIRBuilder,
  exprPath: NodePath<
    | t.JSXText
    | t.JSXExpressionContainer
    | t.JSXSpreadChild
    | t.JSXElement
    | t.JSXFragment
  >
): Place {
  const exprNode = exprPath.node;
  const exprLoc = exprNode.loc ?? GeneratedSource;
  if (exprPath.isJSXElement() || exprPath.isJSXFragment()) {
    return lowerExpressionToTemporary(builder, exprPath);
  } else if (exprPath.isJSXExpressionContainer()) {
    const expression = exprPath.get("expression");
    if (!expression.isExpression()) {
      builder.errors.push({
        reason: `(BuildHIR::lowerJsxElement) Handle ${expression.type} expressions`,
        severity: ErrorSeverity.Todo,
        nodePath: expression,
      });
      const place: Place = buildTemporaryPlace(builder, exprLoc);
      builder.push({
        id: makeInstructionId(0),
        value: {
          kind: "UnsupportedNode",
          node: exprNode,
          loc: exprLoc,
        },
        loc: exprLoc,
        lvalue: { ...place },
      });
      return { ...place };
    }
    return lowerExpressionToTemporary(builder, expression);
  } else if (exprPath.isJSXText()) {
    const place: Place = buildTemporaryPlace(builder, exprLoc);
    builder.push({
      id: makeInstructionId(0),
      value: {
        kind: "JSXText",
        value: exprPath.node.value,
        loc: exprLoc,
      },
      loc: exprLoc,
      lvalue: { ...place },
    });
    return place;
  } else {
    if (!(t.isJSXFragment(exprNode) || t.isJSXSpreadChild(exprNode))) {
      builder.errors.push({
        reason: `(BuildHIR::lowerJsxElement) Expected refinement to work, got: ${exprPath.type}`,
        severity: ErrorSeverity.InvalidInput,
        nodePath: exprPath,
      });
    }
    const place: Place = buildTemporaryPlace(builder, exprLoc);
    builder.push({
      id: makeInstructionId(0),
      value: {
        kind: "UnsupportedNode",
        node: exprNode,
        loc: exprLoc,
      },
      loc: exprLoc,
      lvalue: { ...place },
    });
    return place;
  }
}

function lowerExpressionToTemporary(
  builder: HIRBuilder,
  exprPath: NodePath<t.Expression>
): Place {
  const value = lowerExpression(builder, exprPath);
  if (value.kind === "LoadLocal" && value.place.identifier.name === null) {
    return value.place;
  }
  const exprLoc = exprPath.node.loc ?? GeneratedSource;
  const place: Place = buildTemporaryPlace(builder, exprLoc);
  builder.push({
    id: makeInstructionId(0),
    value: value,
    loc: exprLoc,
    lvalue: { ...place },
  });
  return place;
}

function lowerIdentifier(
  builder: HIRBuilder,
  exprPath: NodePath<t.Identifier | t.JSXIdentifier>
): Place {
  const exprNode = exprPath.node;
  const exprLoc = exprNode.loc ?? GeneratedSource;
  const identifier = builder.resolveIdentifier(exprPath);
  if (identifier === null) {
    const place = buildTemporaryPlace(
      builder,
      exprPath.node.loc ?? GeneratedSource
    );
    const global = builder.resolveGlobal(exprPath);
    let value: InstructionValue;
    if (global !== null) {
      value = { kind: "LoadGlobal", name: global.name, loc: place.loc };
    } else {
      value = { kind: "UnsupportedNode", node: exprPath.node, loc: place.loc };
    }
    builder.push({
      id: makeInstructionId(0),
      value,
      loc: place.loc,
      lvalue: { ...place },
    });
    return place;
  }
  const place: Place = {
    kind: "Identifier",
    identifier: identifier,
    effect: Effect.Unknown,
    loc: exprLoc,
  };
  return place;
}

/**
 * Creates a temporary Identifier and Place referencing that identifier.
 */
function buildTemporaryPlace(builder: HIRBuilder, loc: SourceLocation): Place {
  const place: Place = {
    kind: "Identifier",
    identifier: builder.makeTemporary(),
    effect: Effect.Unknown,
    loc,
  };
  return place;
}

function lowerAssignment(
  builder: HIRBuilder,
  loc: SourceLocation,
  kind: InstructionKind,
  lvaluePath: NodePath<t.LVal>,
  value: Place
): InstructionValue {
  const lvalueNode = lvaluePath.node;
  switch (lvalueNode.type) {
    case "Identifier": {
      const lvalue = lvaluePath as NodePath<t.Identifier>;
      const identifier = builder.resolveIdentifier(lvalue);
      if (identifier == null) {
        if (kind === InstructionKind.Reassign) {
          // Trying to reassign a global is not allowed
          builder.errors.push({
            reason: `(BuildHIR::lowerAssignment) Assigning to an identifier defined outside the function scope is not supported.`,
            severity: ErrorSeverity.InvalidInput,
            nodePath: lvalue,
          });
        } else {
          // Else its an internal error bc we couldn't find the binding
          builder.errors.push({
            reason: `(BuildHIR::lowerAssignment) Could not find binding for declaration.`,
            severity: ErrorSeverity.Invariant,
            nodePath: lvalue,
          });
        }
        return {
          kind: "UnsupportedNode",
          loc: lvalue.node.loc ?? GeneratedSource,
          node: lvalue.node,
        };
      }

      const temporary = buildTemporaryPlace(builder, loc);
      const place: Place = {
        kind: "Identifier",
        identifier: identifier,
        effect: Effect.Unknown,
        loc: lvalue.node.loc ?? GeneratedSource,
      };
      builder.push({
        id: makeInstructionId(0),
        lvalue: { ...temporary },
        value: {
          kind: "StoreLocal",
          lvalue: { place: { ...place }, kind },
          value,
          loc,
        },
        loc,
      });
      return { kind: "LoadLocal", place: temporary, loc: temporary.loc };
    }
    case "MemberExpression": {
      // This can only occur because of a coding error, parsers enforce this condition
      invariant(
        kind === InstructionKind.Reassign,
        "MemberExpression may only appear in an assignment expression"
      );
      const lvalue = lvaluePath as NodePath<t.MemberExpression>;
      const property = lvalue.get("property");
      const object = lowerExpressionToTemporary(builder, lvalue.get("object"));
      if (!lvalue.node.computed) {
        if (!property.isIdentifier()) {
          builder.errors.push({
            reason: `(BuildHIR::lowerAssignment) Handle ${property.type} properties in MemberExpression`,
            severity: ErrorSeverity.Todo,
            nodePath: property,
          });
          return { kind: "UnsupportedNode", node: lvalueNode, loc };
        }
        const temporary = buildTemporaryPlace(builder, loc);
        builder.push({
          id: makeInstructionId(0),
          lvalue: { ...temporary },
          value: {
            kind: "PropertyStore",
            object,
            property: property.node.name,
            value,
            loc,
          },
          loc,
        });
        return { kind: "LoadLocal", place: temporary, loc: temporary.loc };
      } else {
        if (!property.isExpression()) {
          builder.errors.push({
            reason:
              "(BuildHIR::lowerAssignment) Expected private name to appear as a non-computed property",
            severity: ErrorSeverity.InvalidInput,
            nodePath: property,
          });
          return { kind: "UnsupportedNode", node: lvalueNode, loc };
        }
        const propertyPlace = lowerExpressionToTemporary(builder, property);
        const temporary = buildTemporaryPlace(builder, loc);
        builder.push({
          id: makeInstructionId(0),
          lvalue: { ...temporary },
          value: {
            kind: "ComputedStore",
            object,
            property: propertyPlace,
            value,
            loc,
          },
          loc,
        });
        return { kind: "LoadLocal", place: temporary, loc: temporary.loc };
      }
    }
    case "ArrayPattern": {
      const lvalue = lvaluePath as NodePath<t.ArrayPattern>;
      const elements = lvalue.get("elements");
      const items: ArrayPattern["items"] = [];
      const followups: Array<{ place: Place; path: NodePath<t.LVal> }> = [];
      for (let i = 0; i < elements.length; i++) {
        const element = elements[i];
        if (element.node == null) {
          continue;
        }
        if (element.isRestElement()) {
          const argument = element.get("argument");
          if (!argument.isIdentifier()) {
            builder.errors.push({
              reason: `(BuildHIR::lowerAssignment) Handle ${argument.node.type} rest element in ArrayPattern`,
              severity: ErrorSeverity.Todo,
              nodePath: element,
            });
            continue;
          }
          const identifier = lowerIdentifier(builder, argument);
          items.push({
            kind: "Spread",
            place: identifier,
          });
        } else if (element.isIdentifier()) {
          const identifier = lowerIdentifier(builder, element);
          items.push(identifier);
        } else {
          const temp = buildTemporaryPlace(
            builder,
            element.node.loc ?? GeneratedSource
          );
          items.push({ ...temp });
          followups.push({ place: temp, path: element as NodePath<t.LVal> }); // TODO remove type cast
        }
      }
      const temporary = buildTemporaryPlace(builder, loc);
      builder.push({
        id: makeInstructionId(0),
        lvalue: { ...temporary },
        value: {
          kind: "Destructure",
          lvalue: {
            kind,
            pattern: {
              kind: "ArrayPattern",
              items,
            },
          },
          value,
          loc,
        },
        loc,
      });
      for (const { place, path } of followups) {
        lowerAssignment(builder, path.node.loc ?? loc, kind, path, place);
      }
      return { kind: "LoadLocal", place: temporary, loc: value.loc };
    }
    case "ObjectPattern": {
      const lvalue = lvaluePath as NodePath<t.ObjectPattern>;
      const propertiesPaths = lvalue.get("properties");
      const properties: ObjectPattern["properties"] = [];
      const followups: Array<{ place: Place; path: NodePath<t.LVal> }> = [];
      for (let i = 0; i < propertiesPaths.length; i++) {
        const property = propertiesPaths[i];
        if (property.isRestElement()) {
          const argument = property.get("argument");
          if (!argument.isIdentifier()) {
            builder.errors.push({
              reason: `(BuildHIR::lowerAssignment) Handle ${argument.node.type} rest element in ArrayPattern`,
              severity: ErrorSeverity.Todo,
              nodePath: argument,
            });
            continue;
          }
          const identifier = lowerIdentifier(builder, argument);
          properties.push({
            kind: "Spread",
            place: identifier,
          });
        } else {
          // TODO: this should always be true given the if/else
          if (!property.isObjectProperty()) {
            builder.errors.push({
              reason: `(BuildHIR::lowerAssignment) Handle ${property.type} properties in ObjectPattern`,
              severity: ErrorSeverity.Todo,
              nodePath: property,
            });
            continue;
          }
          const key = property.get("key");
          if (!key.isIdentifier()) {
            builder.errors.push({
              reason: `(BuildHIR::lowerAssignment) Handle ${key.type} keys in ObjectPattern`,
              severity: ErrorSeverity.Todo,
              nodePath: key,
            });
            continue;
          }
          const element = property.get("value");
          if (!element.isLVal()) {
            builder.errors.push({
              reason: `(BuildHIR::lowerAssignment) Expected object property value to be an LVal, got: ${element.type}`,
              severity: ErrorSeverity.InvalidInput,
              nodePath: element,
            });
            continue;
          }
          if (element.isIdentifier()) {
            const identifier = lowerIdentifier(builder, element);
            properties.push({
              kind: "ObjectProperty",
              name: key.node.name,
              place: identifier,
            });
          } else {
            const temp = buildTemporaryPlace(
              builder,
              element.node.loc ?? GeneratedSource
            );
            properties.push({
              kind: "ObjectProperty",
              name: key.node.name,
              place: { ...temp },
            });
            followups.push({ place: temp, path: element as NodePath<t.LVal> }); // TODO remove type cast
          }
        }
      }
      const temporary = buildTemporaryPlace(builder, loc);
      builder.push({
        id: makeInstructionId(0),
        lvalue: { ...temporary },
        value: {
          kind: "Destructure",
          lvalue: {
            kind,
            pattern: {
              kind: "ObjectPattern",
              properties,
            },
          },
          value,
          loc,
        },
        loc,
      });
      for (const { place, path } of followups) {
        lowerAssignment(builder, path.node.loc ?? loc, kind, path, place);
      }
      return { kind: "LoadLocal", place: temporary, loc: value.loc };
    }
    default: {
      builder.errors.push({
        reason: `(BuildHIR::lowerAssignment) Handle ${lvaluePath.type} assignments`,
        severity: ErrorSeverity.Todo,
        nodePath: lvaluePath,
      });
      return { kind: "UnsupportedNode", node: lvalueNode, loc };
    }
  }
}

function captureScopes({ from, to }: { from: Scope; to: Scope }): Set<Scope> {
  let scopes: Set<Scope> = new Set();
  while (from) {
    scopes.add(from);

    if (from === to) {
      break;
    }

    from = from.parent;
  }
  return scopes;
}

function gatherCapturedDeps(
  builder: HIRBuilder,
  fn: NodePath<t.FunctionExpression | t.ArrowFunctionExpression>,
  componentScope: Scope
): { identifiers: t.Identifier[]; refs: Place[] } {
  const capturedIds: Set<t.Identifier> = new Set();
  const capturedRefs: Set<Place> = new Set();

  // Capture all the scopes from the parent of this function up to and including
  // the component scope.
  const pureScopes: Set<Scope> = captureScopes({
    from: fn.scope.parent,
    to: componentScope,
  });

  function visit(path: NodePath<Expression>): void {
    // Babel has a bug where it doesn't visit the LHS of an
    // AssignmentExpression if it's an Identifier. Work around it by explicitly
    // visiting it.
    if (path.isAssignmentExpression()) {
      const left = path.get("left");
      if (left.isIdentifier()) {
        visit(left);
      }
      return;
    }

    let obj = path;
    while (obj.isMemberExpression()) {
      obj = obj.get("object");
    }

    if (!obj.isIdentifier()) {
      return;
    }

    const binding = obj.scope.getBinding(obj.node.name);
    if (binding === undefined || !pureScopes.has(binding.scope)) {
      return;
    }

    if (path.isMemberExpression()) {
      // For CallExpression, we need to depend on the receiver, not the
      // function itself.
      if (path.parent.type === "CallExpression") {
        path = path.get("object");
      }

      path.skip();
    }

    capturedIds.add(binding.identifier);
    capturedRefs.add(lowerExpressionToTemporary(builder, path));
  }

  fn.get("body").traverse({
    Expression(path) {
      visit(path);
    },
  });

  return { identifiers: [...capturedIds], refs: [...capturedRefs] };
}
