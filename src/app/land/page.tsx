import LandMap from "@/components/LandMap";
import { findSubstations } from "@/lib/substations";

export const metadata = {
  title: "Land — NZC AI",
  description: "Screen sites against DNO grid capacity for solar PV",
};

export const dynamic = "force-dynamic";

export default async function LandPage() {
  // Rendered server-side so the list is readable on first paint rather than
  // after a client round-trip. Filtering then goes through /api/substations.
  try {
    const { substations, containsSampleData } = await findSubstations({ limit: 5000 });
    return <LandMap initialSubstations={substations} initialHasSample={containsSampleData} />;
  } catch (err) {
    return (
      <LandMap
        initialSubstations={[]}
        initialHasSample={false}
        initialError={err instanceof Error ? err.message : "Database unavailable"}
      />
    );
  }
}
