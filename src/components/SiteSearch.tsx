"use client";

import { useCallback, useState } from "react";
import type { SearchResult } from "@/lib/site-intel/search-run";
import type { NotApplied } from "@/lib/site-intel/search-describe";

/**
 * S-07 search.
 *
 * The interface is built around what the search did NOT do. `unparsed` and
 * `notApplied` sit above the results, not below them, because a filter that
 * silently failed to run makes the list wider than the question asked - and a
 * reader who does not know that will read the extra rows as answers.
 */

interface SearchResponse {
  query: string;
  description: string;
  understood: string[];
  unparsed: string[];
  results: SearchResult[];
  applied: string[];
  notApplied: NotApplied[];
  caveats: string[];
  total: number;
  error?: string;
}

const EXAMPLES = [
  "warehouses in DN4 over 1000 sqm",
  "offices with epc below C in DN4",
  "overseas owned industrial in DN4 8DE",
  "warehouses in DN4 with substation headroom over 5 MVA",
];

export default function SiteSearch() {
  const [queryText, setQueryText] = useState("");
  const [busy, setBusy] = useState(false);
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (text: string) => {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/site-intel/search?q=${encodeURIComponent(text)}`);
      const data = (await res.json()) as SearchResponse;
      setResponse(data);
      if (data.error) setError(data.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <div className="search-page">
      <header className="search-top">
        <h1>Find sites</h1>
        <p className="search-sub">
          Ask in plain words. The question is parsed into a filter and run against the
          loaded data — nothing about a site is sent to a language model.
        </p>
      </header>

      <form
        className="search-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(queryText);
        }}
      >
        <input
          id="search-q"
          type="text"
          value={queryText}
          placeholder="warehouses in DN4 over 1000 sqm with epc below C"
          onChange={(e) => setQueryText(e.target.value)}
          autoComplete="off"
        />
        <button type="submit" disabled={busy || !queryText.trim()}>
          {busy ? "…" : "Search"}
        </button>
      </form>

      <ul className="search-examples">
        {EXAMPLES.map((example) => (
          <li key={example}>
            <button
              type="button"
              onClick={() => {
                setQueryText(example);
                void run(example);
              }}
            >
              {example}
            </button>
          </li>
        ))}
      </ul>

      {error && <p className="search-error">{error}</p>}

      {response && !response.error && (
        <>
          {response.understood.length > 0 && (
            <div className="search-understood">
              <p className="eyebrow">Understood as</p>
              <ul>
                {response.understood.map((clause) => (
                  <li key={clause}>{clause}</li>
                ))}
              </ul>
            </div>
          )}

          {response.unparsed.length > 0 && (
            <div className="search-ignored">
              <p className="search-ignored-head">Not understood, and ignored</p>
              <ul>
                {response.unparsed.map((part) => (
                  <li key={part}>&ldquo;{part}&rdquo;</li>
                ))}
              </ul>
              <p>
                These results are <strong>wider than the question asked</strong> — the
                ignored parts did not narrow anything.
              </p>
            </div>
          )}

          {response.notApplied.length > 0 && (
            <div className="search-ignored">
              <p className="search-ignored-head">Understood, but could not be applied</p>
              <ul>
                {response.notApplied.map((item) => (
                  <li key={item.clause}>
                    <strong>{item.clause}</strong> — {item.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="search-count">
            {response.total === 0
              ? "No sites matched. That reflects the loaded data, not the country."
              : `${response.total} site${response.total === 1 ? "" : "s"}`}
            {response.total >= 100 ? " (showing the first 100)" : ""}
          </p>

          {response.results.length > 0 && (
            <div className="search-results">
              {response.results.map((r) => (
                <article key={r.uarn} className="search-result">
                  <p className="sr-head">
                    <span className="sr-desc">{r.description ?? "No description"}</span>
                    <span className="sr-uarn">{r.uarn}</span>
                  </p>
                  {r.address && <p className="sr-addr">{r.address}</p>}
                  <p className="sr-meta">
                    {r.postcode ?? "—"}
                    {r.floorAreaM2
                      ? ` · ${r.floorAreaM2.toLocaleString()} m² ${r.areaBasis ?? ""}`
                      : ""}
                    {r.rateableValue ? ` · RV £${r.rateableValue.toLocaleString()}` : ""}
                    {r.epcBand ? ` · EPC ${r.epcBand}` : ""}
                    {r.gridHeadroomMva !== null ? ` · ${r.gridHeadroomMva} MVA nearby` : ""}
                    {r.overseasOwnerInPostcode ? " · overseas-owned title in postcode" : ""}
                  </p>
                </article>
              ))}
            </div>
          )}

          {response.caveats.length > 0 && (
            <div className="search-caveats">
              <p className="eyebrow">How to read these</p>
              <ul>
                {response.caveats.map((caveat) => (
                  <li key={caveat}>{caveat}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
