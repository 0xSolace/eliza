/**
 * Side-effect entry point that registers wallet shell routes/widgets and
 * re-exports chain/address constants used by consumers that alias the package
 * root to this app-register module.
 */
import "./register-routes.ts";

export { getExplorerTokenUrl } from "./inventory/chainConfig.ts";
export {
  BSC_GAS_READY_THRESHOLD,
  HEX_ADDRESS_RE,
  isAvaxChainName,
  isBscChainName,
} from "./inventory/constants.ts";
