/**
 * `@elizaos/ui/spatial` — shared spatial authoring primitives for plugin views.
 *
 * The public modality contracts still include `gui`, `xr`, and `tui`, but this
 * package currently ships only the DOM authoring/runtime path. XR and terminal
 * renderers can be reintroduced behind the same contracts without changing
 * plugin view declarations.
 */

export {
  type SpatialAction,
  SpatialContextProvider,
  type SpatialContextValue,
  useSpatialContext,
} from "./context.ts";
// DOM host + render context.
export {
  detectDomModality,
  SpatialSurface,
  type SpatialSurfaceProps,
  useContinuousChatClearanceActive,
  useContinuousChatCompactClearanceActive,
  useContinuousChatSideClearanceActive,
} from "./dom.tsx";
// React → IR evaluation + cross-modal state hooks.
export {
  createSpatialStateStore,
  type EvaluateOptions,
  evaluateToSpatialTree,
  isEvaluatingToIR,
  type SpatialStateStore,
  useSpatialMemo,
  useSpatialRef,
  useSpatialState,
} from "./evaluate.ts";
// Shared layout IR (the cross-modality contract).
export type {
  SpatialAgentMeta,
  SpatialAlign,
  SpatialBorder,
  SpatialBoxNode,
  SpatialButtonNode,
  SpatialDirection,
  SpatialDividerNode,
  SpatialFieldNode,
  SpatialImageNode,
  SpatialJustify,
  SpatialLength,
  SpatialModality,
  SpatialNode,
  SpatialPadding,
  SpatialSpacerNode,
  SpatialTextNode,
  SpatialTextStyle,
  SpatialTone,
} from "./ir.ts";
export { isContainer, resolvePadding } from "./ir.ts";
// Authoring vocabulary (the primitives + sugar).
export {
  Button,
  type ButtonProps,
  Card,
  Divider,
  type DividerProps,
  Escape,
  type EscapeProps,
  Field,
  type FieldProps,
  getSpatialKind,
  HStack,
  Image,
  type ImageProps,
  List,
  SPATIAL_KIND,
  Spacer,
  type SpacerProps,
  type SpatialKind,
  Stack,
  type StackProps,
  Text,
  type TextProps,
  VStack,
} from "./primitives.tsx";
