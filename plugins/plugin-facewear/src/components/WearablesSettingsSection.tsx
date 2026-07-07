/**
 * Wearables settings section hosts the Even Realities management panel under
 * the app settings surface.
 */
import { lazy, Suspense } from "react";

const SmartglassesView = lazy(() =>
	import("../ui/SmartglassesView").then((m) => ({
		default: m.SmartglassesView,
	})),
);

function SectionFallback() {
	return (
		<div className="p-6 text-sm text-muted-foreground">Loading wearables…</div>
	);
}

export function WearablesSettingsSection() {
	return (
		<div className="h-full overflow-auto">
			<Suspense fallback={<SectionFallback />}>
				<SmartglassesView />
			</Suspense>
		</div>
	);
}
