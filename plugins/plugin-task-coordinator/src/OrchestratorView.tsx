/**
 * OrchestratorView — GUI route wrapper for the Orchestrator surface.
 *
 * The rich {@link OrchestratorWorkbench} owns live data, SSE, inspector state,
 * and mutations. This package currently ships the GUI route only.
 */

import { Escape } from "@elizaos/ui/spatial";
import { OrchestratorWorkbench } from "./OrchestratorWorkbench.tsx";

export function OrchestratorView() {
  return (
    <Escape width="100%" height="100%">
      <OrchestratorWorkbench />
    </Escape>
  );
}
