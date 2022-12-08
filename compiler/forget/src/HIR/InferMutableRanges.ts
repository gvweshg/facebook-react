import { HIRFunction } from "./HIR";
import { inferAliases } from "./InferAlias";
import { inferAliasForFields } from "./InferAliasForFields";
import { inferMutableLifetimes } from "./InferMutableLifetimes";
import { inferMutableRangesForAlias } from "./InferMutableRangesForAlias";

export function inferMutableRanges(ir: HIRFunction) {
  // Calculate aliases
  const aliases = inferAliases(ir);

  // Infer mutable ranges for non fields
  inferMutableLifetimes(ir, false);

  // Infer mutable ranges for aliases that are not fields
  inferMutableRangesForAlias(aliases);

  // Update aliasing information of fields
  inferAliasForFields(ir, aliases);

  // Re-infer mutable ranges for all values
  inferMutableLifetimes(ir, true);

  // Re-infer mutable ranges for aliases
  inferMutableRangesForAlias(aliases);
}
