// View-bundle `interact` capability handler plus the GUI state loaders for the
// Hyperliquid view. Kept separate from HyperliquidView.tsx so that file exports
// only React components and stays Fast-Refresh-compatible (Vite would full-reload
// a component file that also exports a plain function). The view bundle
// re-exports `interact` via ./hyperliquid-app-view-bundle.ts.

import { client } from "@elizaos/app-core";
import "./client";
import type { HyperliquidClient } from "./client";
import { postHyperliquidCommand } from "./hyperliquid-command-client";
import type {
	HyperliquidMarketsResponse,
	HyperliquidOrdersResponse,
	HyperliquidPositionsResponse,
	HyperliquidStatusResponse,
} from "./hyperliquid-contracts";

export async function loadHyperliquidViewState(): Promise<{
	status: HyperliquidStatusResponse;
	markets: HyperliquidMarketsResponse | null;
	positions: HyperliquidPositionsResponse | null;
	orders: HyperliquidOrdersResponse | null;
}> {
	const hyperliquidClient = client as HyperliquidClient;
	const status = await hyperliquidClient.hyperliquidStatus();
	if (!status.publicReadReady) {
		return { status, markets: null, positions: null, orders: null };
	}
	const [markets, positions, orders] = await Promise.all([
		hyperliquidClient.hyperliquidMarkets(),
		hyperliquidClient.hyperliquidPositions(),
		hyperliquidClient.hyperliquidOrders(),
	]);
	return { status, markets, positions, orders };
}

export async function interact(
	capability: string,
	params?: Record<string, unknown>,
): Promise<unknown> {
	if (capability === "hyperliquid-state") {
		const state = await loadHyperliquidViewState();
		return {
			status: state.status,
			markets:
				state.markets?.markets.slice(
					0,
					typeof params?.limit === "number" ? params.limit : 25,
				) ?? [],
			positions: state.positions,
			orders: state.orders,
		};
	}

	if (capability === "hyperliquid-market") {
		const coin =
			typeof params?.coin === "string" ? params.coin.trim().toUpperCase() : "";
		if (!coin) throw new Error("coin is required");
		const state = await loadHyperliquidViewState();
		return {
			market:
				state.markets?.markets.find(
					(market) => market.name.toUpperCase() === coin,
				) ?? null,
		};
	}

	if (capability === "hyperliquid-execution-check") {
		return {
			result: await postHyperliquidCommand("/api/hyperliquid/orders/open", {
				coin: typeof params?.coin === "string" ? params.coin : "BTC",
				side: typeof params?.side === "string" ? params.side : "buy",
				size: typeof params?.size === "string" ? params.size : "0",
			}),
		};
	}

	throw new Error(`Unsupported capability "${capability}"`);
}
